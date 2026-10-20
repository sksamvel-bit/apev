const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const https = require('https');
const vm = require('vm');
const crypto = require('crypto');
const { createRouteQuota, createUpstashRedisAdapter } = require('./route-quota.js');
const SearchUtil = require('./search.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

// AUDIT FIX: never let one bad request kill the process
process.on('uncaughtException', e => console.error('[uncaught]', e && e.message));
process.on('unhandledRejection', e => console.error('[unhandled]', e && e.message));

// AUDIT FIX: serve ONLY these files (no server.js, *.md, cache json)
const STATIC_WHITELIST = new Set([
  'index.html','remote.html','style.css','qrcode.min.js',
  'maplibre-gl.js','maplibre-gl.css','map-gl.js',
  'app.js','routing.js','traffic.js','traffic-signals.js','chargers.js','charger-list.js','search.js','tesla-style.js',
  'battery.js','weather.js','speech.js','turn-audio.js','speed-limit.js','speed-cameras.js',
  'sim-drive.js','gmap.js',
  'manifest.json','icon.svg','icon-192.png','icon-512.png','sw.js'
]);

// Server-side Access PIN & Secret Key Protection
// Supports Multi-PIN: "pin1, pin2, pin3" (comma separated)
// - The FIRST PIN is the MASTER PIN (allows unlimited personal devices for the owner).
// - Any subsequent PINs are GUEST PINS with STRICT SINGLE-DEVICE LOCK (1 PIN = 1 Device).
const RAW_PINS = (process.env.ACCESS_PIN || '').split(',').map(s => s.trim()).filter(Boolean);
const MASTER_PIN = RAW_PINS[0] || '';
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');

// Persistent storage for single-device bindings: pin-bindings.json
const BINDINGS_FILE = path.join(PUBLIC_DIR, 'pin-bindings.json');
let pinBindings = {}; // pin -> { deviceToken, boundAt, ip, userAgent }

try {
  if (fs.existsSync(BINDINGS_FILE)) {
    pinBindings = JSON.parse(fs.readFileSync(BINDINGS_FILE, 'utf8')) || {};
  }
} catch (e) {
  console.warn('[Auth] Pin bindings load notice:', e.message);
}

function saveBindings() {
  try {
    fs.writeFileSync(BINDINGS_FILE, JSON.stringify(pinBindings, null, 2), 'utf8');
  } catch (e) {
    console.error('[Auth] Failed to save pin bindings:', e.message);
  }
}

// The cookie never contains the PIN itself, only a short one-way id derived from it.
function pinId(pin) {
  return crypto.createHash('sha256').update('pin-id:' + pin).digest('hex').slice(0, 16);
}

function signToken(pin, deviceToken) {
  const data = `${pinId(pin)}:${deviceToken}`;
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('hex');
  return `${data}:${sig}`;
}

function verifyToken(tokenStr) {
  if (!tokenStr || typeof tokenStr !== 'string') return null;
  const parts = tokenStr.split(':');
  if (parts.length !== 3) return null;
  const [id, deviceToken, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(`${id}:${deviceToken}`).digest('hex');
  const bufA = Buffer.from(sig);
  const bufB = Buffer.from(expectedSig);
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    return null;
  }
  const pin = RAW_PINS.find(p => pinId(p) === id);
  if (!pin) return null;
  return { pin, deviceToken };
}

// Real client IP. Behind Render the LAST X-Forwarded-For entry is the one the proxy appended;
// the first ones are client-controlled and must not be trusted for rate limiting.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map(x => x.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1].slice(0, 64);
  }
  return req.socket.remoteAddress || 'unknown';
}

// Failed PIN attempts rate limiter (max 5 failed attempts per IP per 5 mins)
const failedPinAttempts = new Map();

// Global brute-force guard: even with many IPs, at most 40 failures per 5 minutes in total.
let globalFails = { count: 0, expireAt: 0 };

function isRateLimited(ip) {
  if (Date.now() < globalFails.expireAt && globalFails.count >= 40) return true;
  const record = failedPinAttempts.get(ip);
  if (!record) return false;
  if (Date.now() > record.expireAt) {
    failedPinAttempts.delete(ip);
    return false;
  }
  return record.count >= 5;
}

function recordFailedAttempt(ip) {
  if (Date.now() > globalFails.expireAt) globalFails = { count: 0, expireAt: Date.now() + 5 * 60 * 1000 };
  globalFails.count++;
  if (failedPinAttempts.size > 5000) failedPinAttempts.clear();
  const record = failedPinAttempts.get(ip) || { count: 0, expireAt: Date.now() + 5 * 60 * 1000 };
  record.count++;
  record.expireAt = Date.now() + 5 * 60 * 1000;
  failedPinAttempts.set(ip, record);
}

function resetFailedAttempts(ip) {
  failedPinAttempts.delete(ip);
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const parts = c.split('=');
    if (parts.length >= 2) {
      cookies[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
  });
  return cookies;
}

function isAuthenticated(req) {
  if (RAW_PINS.length === 0) return true; // Open mode when ACCESS_PIN is not configured
  const cookies = parseCookies(req.headers.cookie);
  if (!cookies.tesla_auth) return false;
  const verified = verifyToken(cookies.tesla_auth);
  if (!verified) return false;

  const { pin, deviceToken } = verified;
  if (!RAW_PINS.includes(pin)) return false;

  // Master PIN is allowed on any device
  if (pin === MASTER_PIN) return true;

  // Guest PIN must strictly match the bound device token!
  const binding = pinBindings[pin];
  if (!binding) return false;
  return binding.deviceToken === deviceToken;
}

function attemptPinAuth(inputPin, req) {
  if (!inputPin || typeof inputPin !== 'string') {
    return { success: false, error: 'შეიყვანეთ PIN კოდი' };
  }

  const matchedPin = RAW_PINS.find(p => {
    const a = Buffer.from(p);
    const b = Buffer.from(inputPin);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });

  if (!matchedPin) {
    return { success: false, error: 'არასწორი PIN კოდი' };
  }

  // 1. MASTER PIN (Owner): unlimited devices
  if (matchedPin === MASTER_PIN) {
    const token = signToken(matchedPin, 'master');
    return { success: true, token, isMaster: true };
  }

  // 2. GUEST PIN (Single-Device Lock)
  const binding = pinBindings[matchedPin];
  const cookies = parseCookies(req.headers.cookie);
  const currentVerified = verifyToken(cookies.tesla_auth);

  if (!binding) {
    // First activation: bind to this device!
    const deviceToken = crypto.randomBytes(24).toString('hex');
    pinBindings[matchedPin] = {
      deviceToken,
      boundAt: Date.now(),
      ip: clientIp(req),
      userAgent: (req.headers['user-agent'] || '').slice(0, 120)
    };
    saveBindings();
    console.log(`[Auth] Single-device lock engaged for Guest PIN id ${pinId(matchedPin)}`);
    const token = signToken(matchedPin, deviceToken);
    return { success: true, token, isMaster: false };
  } else {
    // Already bound! Check if current device is the authorized bound device:
    if (currentVerified && currentVerified.pin === matchedPin && currentVerified.deviceToken === binding.deviceToken) {
      const token = signToken(matchedPin, binding.deviceToken);
      return { success: true, token, isMaster: false };
    }

    // A DIFFERENT device is trying to reuse this PIN!
    return {
      success: false,
      error: 'ეს PIN კოდი უკვე გააქტიურებულია სხვა მოწყობილობაზე და ვერ გადაეცემა სხვას!'
    };
  }
}

// Telemetry log flood guard: max 20 lines per minute per IP.
const telemetryHits = new Map();
function isRateLimitedTelemetry(ip) {
  const now = Date.now();
  if (telemetryHits.size > 2000) telemetryHits.clear();
  const r = telemetryHits.get(ip);
  if (!r || now > r.expireAt) { telemetryHits.set(ip, { count: 1, expireAt: now + 60000 }); return false; }
  r.count++;
  return r.count > 20;
}

const PUBLIC_AUTH_PATHS = new Set([
  '/healthz', '/api/info', '/remote.html', '/manifest.json',
  '/icon.svg', '/icon-192.png', '/icon-512.png', '/sw.js',
  '/api/auth/pin', '/api/telemetry/error', '/api/search'
]);

function isPublicAuthPath(p) {
  if (PUBLIC_AUTH_PATHS.has(p)) return true;
  if (p.startsWith('/api/session/')) return true;
  return false;
}

// Routes API spending guard (Google cannot cap it in the console): ROUTES_DAILY_CAP (default 100) / ROUTES_MONTHLY_CAP (default 4000).
// Persistence: Upstash Redis (free cloud KV, survives deploys on Render ephemeral disk) or Render Persistent Disk / local file.
const quotaAdapter = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? createUpstashRedisAdapter({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, key: process.env.UPSTASH_REDIS_KEY || 'routes_usage_quota' })
  : null;
const quotaFile = process.env.QUOTA_FILE_PATH || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'routes-usage.json') : path.join(__dirname, 'routes-usage.json'));
const ROUTE_QUOTA = createRouteQuota({
  adapter: quotaAdapter,
  file: quotaAdapter ? null : quotaFile,
  dayCap: parseInt(process.env.ROUTES_DAILY_CAP, 10) || 100,
  monthCap: parseInt(process.env.ROUTES_MONTHLY_CAP, 10) || 4000
});
// Every paid Google call from the page needs a permit (v3.10.44), so the bill stays $0 after the free trial. Free monthly caps from
// developers.google.com/maps/billing-and-pricing/pricing (checked 2026-10-20): Dynamic Maps 10,000, Autocomplete Requests 10,000,
// Place Details Essentials 10,000 (formattedAddress+location; displayName would make it Pro = 5,000), Nearby Search Pro 5,000,
// Compute Routes Pro (TRAFFIC_AWARE) 5,000. Our caps are ~80 % of that plus a daily share; GOOGLE_CAP_<SKU>_DAY/_MONTH override.
const GOOGLE_FREE_MONTHLY = { routes: 5000, mapload: 10000, autocomplete: 10000, details: 10000, nearby: 5000 };
function skuQuota(sku, dayDefault, monthDefault) {
  const up = sku.toUpperCase();
  const adapter = quotaAdapter ? createUpstashRedisAdapter({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, key: (process.env.UPSTASH_REDIS_KEY || 'routes_usage_quota') + '_' + sku }) : null;
  return createRouteQuota({
    adapter,
    file: adapter ? null : path.join(path.dirname(quotaFile), 'google-usage-' + sku + '.json'),
    dayCap: parseInt(process.env['GOOGLE_CAP_' + up + '_DAY'], 10) || dayDefault,
    monthCap: parseInt(process.env['GOOGLE_CAP_' + up + '_MONTH'], 10) || monthDefault
  });
}
const GOOGLE_QUOTAS = {
  routes: ROUTE_QUOTA,                              // 100/day, 4,000/month (free 5,000)
  mapload: skuQuota('mapload', 300, 8000),          // free 10,000
  autocomplete: skuQuota('autocomplete', 300, 8000), // free 10,000
  details: skuQuota('details', 300, 8000),          // free 10,000 (Essentials fields only)
  nearby: skuQuota('nearby', 120, 4000)             // free 5,000
};
// Startup line in the Render log: where the counters live and whether the store answered (never prints the token)
ROUTE_QUOTA.init().then(() => {
  const s = ROUTE_QUOTA.status();
  console.log('[quota] store=' + s.store + ' synced=' + s.synced + (s.lastError ? ' error=' + s.lastError : '') +
    (quotaAdapter ? '' : (process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_TOKEN ? ' (Upstash needs BOTH UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)' : '')));
});
/** Next Tbilisi day and the first day of next month, as YYYY-MM-DD (when a day / month cap resets). */
function quotaResetDates(nowMs) {
  const d = new Date(nowMs + 4 * 3600 * 1000);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  const month = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { day: next.toISOString().slice(0, 10), month: month.toISOString().slice(0, 10) };
}
const ALLOWED_EVENT_TYPES = new Set(['destination','gps']);
const CODE_RE = /^[A-Z0-9]{12,32}$/;
const MAX_BODY = 8 * 1024;
// Behind a reverse proxy (Render) the TCP peer is the proxy, so "localhost only" can't work.
// /api/chargers/sync: localhost (without proxy header) OR ?token=<ADMIN_TOKEN env>.
function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  if (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1') return !req.headers['x-forwarded-for'];
  const tok = process.env.ADMIN_TOKEN;
  if (!tok) return false;
  try { return new URL(req.url, 'http://x').searchParams.get('token') === tok; } catch (e) { return false; }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg'
};

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const k in interfaces) {
    for (const addr of interfaces[k]) {
      if (addr.family === 'IPv4' && !addr.internal) {
        addresses.push(addr.address);
      }
    }
  }
  return addresses;
}

// In-Memory Realtime Session Hub for Phone-to-Car Pairing
// Map of code -> Set of SSE Response objects
const sessions = new Map();
const MAX_SSE_TOTAL = 300, MAX_SSE_PER_CODE = 5;
let sseTotal = 0;

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// In-Memory Live EV Chargers Cache & Persistent Disk Storage (dachar.ge / Revolt / Georgia EV aggregator)
const CHARGERS_CACHE_FILE = path.join(PUBLIC_DIR, 'chargers-cache.json');
const CHARGERS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
let cachedLiveChargers = null;
let lastChargersFetch = 0;
// Network tariff medians from GeoCharge.ge (/tarifebi/ snapshot: 2026-10-15)
// Source: https://geocharge.ge/tarifebi/
// NOTE: These are static network-level median fallback estimates for stations where
// real-time Firestore pricing is unavailable. Real station-level prices take precedence.
const GEOCHARGE_TARIFF_MEDIANS = {
  martev: { dc: 0.80, ac: 0.65, name: 'mart EV' },
  espace: { dc: 0.75, ac: 0.60, name: 'E-Space' },
  evpower: { dc: 0.76, ac: null, name: 'EV Power' },
  ecocars: { dc: 0.78, ac: 0.71, name: 'EcoCars' },
  tegeta: { dc: 1.00, ac: 0.60, name: 'Tegeta' },
  electrify: { dc: 0.57, ac: 0.45, name: 'Electrify Georgia' },
  datene: { dc: 0.69, ac: 0.69, name: 'Da-Tene' },
  solarauto: { dc: 0.70, ac: 0.70, name: 'Solar Station' },
  moveo: { dc: 0.85, ac: 0.56, name: 'MOVEO' },
  gadatene: { dc: 0.78, ac: null, name: 'Gadatene' }
};

// v3.10.58: the medians above are only the starting point. The server reads geocharge.ge/tarifebi/ (updated there daily)
// at start and once a day, keeps the last good result in tariffs-cache.json (a Render deploy starts from the snapshot above
// and refreshes within a minute), and re-prices the stations that use a median. A page it cannot read changes nothing.
const GeoChargeTariffs = require('./geocharge-tariffs.js');
const TARIFFS_FILE = path.join(PUBLIC_DIR, 'tariffs-cache.json');
const TARIFFS_REFRESH_MS = 24 * 3600 * 1000;
let tariffsUpdated = '2026-10-15';
function applyTariffs(parsed) {
  Object.assign(GEOCHARGE_TARIFF_MEDIANS, parsed.tariffs);
  tariffsUpdated = String(parsed.updated || new Date().toISOString()).slice(0, 10);
}
try {
  if (fs.existsSync(TARIFFS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(TARIFFS_FILE, 'utf8'));
    if (GeoChargeTariffs.looksValid(saved)) applyTariffs(saved);
  }
} catch (e) { console.warn('[tariffs] cache file ignored:', e.message); }

function refreshTariffs() {
  return new Promise((resolve) => {
    const req = https.get(GeoChargeTariffs.URL_TARIFFS, { headers: { 'User-Agent': 'TeslaNav/3.10 (+https://apev.onrender.com)' }, timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); console.warn('[tariffs] GeoCharge HTTP', res.statusCode); return resolve(false); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2 * 1024 * 1024) res.destroy(); });
      res.on('end', () => {
        const parsed = GeoChargeTariffs.parseTariffsPage(body);
        if (!GeoChargeTariffs.looksValid(parsed)) { console.warn('[tariffs] GeoCharge page not understood, keeping the previous medians'); return resolve(false); }
        applyTariffs(parsed);
        try { fs.writeFileSync(TARIFFS_FILE, JSON.stringify(parsed)); } catch (_) {}
        if (cachedLiveChargers) cachedLiveChargers = cachedLiveChargers.map(enrichStationTariff);
        console.log(`[tariffs] ${Object.keys(parsed.tariffs).length} network medians from GeoCharge (updated there ${parsed.updated || '?'})`);
        resolve(true);
      });
    });
    req.on('error', (e) => { console.warn('[tariffs] GeoCharge unavailable:', e.message); resolve(false); });
    req.on('timeout', () => { req.destroy(); });
  });
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isDuplicateStation(stA, stB, thresholdMeters = 30) {
  if (!stA || !stB || !stA.lat || !stA.lng || !stB.lat || !stB.lng) return false;
  // Strict safety check: ONLY duplicate if SAME operator AND within thresholdMeters!
  // Different operators at the same parking/location are NEVER merged!
  if (!stA.operator || !stB.operator || stA.operator.toLowerCase() !== stB.operator.toLowerCase()) return false;
  return haversineMeters(stA.lat, stA.lng, stB.lat, stB.lng) <= thresholdMeters;
}

function deduplicateStations(stations, radiusMeters = 30) {
  if (!Array.isArray(stations)) return [];
  const result = [];
  for (const st of stations) {
    if (!st || !st.lat || !st.lng) continue;
    const existing = result.find(r => isDuplicateStation(r, st, radiusMeters));

    if (existing) {
      // Keep maximum charging power
      const pExisting = parseInt(existing.power, 10) || 0;
      const pNew = parseInt(st.power, 10) || 0;
      if (pNew > pExisting) {
        existing.power = st.power;
      }
      // Merge unique connector types
      const connSet = new Set((existing.type || '').split(',').map(s => s.trim()).filter(Boolean));
      (st.type || '').split(',').map(s => s.trim()).filter(Boolean).forEach(c => connSet.add(c));
      existing.type = Array.from(connSet).join(', ');
      // Prefer Georgian address/name
      const hasGeo = /[\u10A0-\u10FF]/.test(st.name || '');
      const existingHasGeo = /[\u10A0-\u10FF]/.test(existing.name || '');
      if (hasGeo && !existingHasGeo) {
        existing.name = st.name;
        existing.address = st.address;
        existing.city = st.city;
      }
    } else {
      result.push({ ...st });
    }
  }
  return result;
}

function enrichStationTariff(station) {
  if (!station) return station;
  // If station already has a specific price per kWh (not generic), retain it
  // (a median price we set earlier is recomputed, so a new GeoCharge median reaches the stations)
  const fromMedian = typeof station.priceSource === 'string' && station.priceSource.startsWith('GeoCharge');
  if (!fromMedian && station.price && !station.price.includes('სტანდარტული') && !station.price.includes('უცნობი')) {
    return station;
  }

  // Tbilisi City Hall (TTC) municipal chargers: verified 33 AC stations (22 kW)
  if (station.operator === 'ttc') {
    const kw = parseInt(station.power, 10) || 0;
    if (kw <= 22) {
      station.price = '0.00 ₾/kWh (მერია · უფასო)';
      station.priceSource = 'თბილისის მერია (უფასო)';
      return station;
    }
  }

  const op = (station.operator || '').toLowerCase();
  const median = GEOCHARGE_TARIFF_MEDIANS[op];
  const kw = parseInt(station.power, 10) || 0;
  const isDc = kw >= 50;

  if (median) {
    const rate = isDc ? (median.dc || median.ac) : (median.ac || median.dc);
    if (rate != null) {
      station.price = `~${rate.toFixed(2)} ₾/kWh (სავარაუდო)`;
      station.priceSource = `GeoCharge.ge (ქსელის მედიანა, ${tariffsUpdated})`;
      return station;
    }
  }

  return station;
}

// Load disk cache on boot if available
try {
  if (fs.existsSync(CHARGERS_CACHE_FILE)) {
    const diskData = JSON.parse(fs.readFileSync(CHARGERS_CACHE_FILE, 'utf8'));
    if (diskData && Array.isArray(diskData.stations) && diskData.stations.length > 0) {
      cachedLiveChargers = deduplicateStations(diskData.stations.map(enrichStationTariff), 30);
      lastChargersFetch = diskData.timestamp || Date.now();
      console.log(`[EV] Loaded ${cachedLiveChargers.length} charging stations from disk cache (chargers-cache.json)`);
    }
  }
} catch (e) {
  console.warn('[EV] Disk cache read notice:', e.message);
}

function fetchFirestorePage(pageToken) {
  const tokenParam = pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '';
  const url = 'https://firestore.googleapis.com/v1/projects/dacharge-16dd6/databases/(default)/documents/stations?pageSize=300' + tokenParam;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'TeslaNav/3.0' }, timeout: 12000 }, res => {
      if (res.statusCode !== 200) {
        return reject(new Error('Firestore status ' + res.statusCode));
      }
      let body = '';
      res.setEncoding('utf8'); // decode across chunk borders: a Georgian character split between two chunks became U+FFFD
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Firestore request timed out'));
    });
  });
}


async function getLiveGeorgiaChargers(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedLiveChargers && (now - lastChargersFetch < CHARGERS_CACHE_TTL)) {
    return cachedLiveChargers;
  }

  try {
    let p1 = await fetchFirestorePage();
    let docs = [...(p1.documents || [])];
    let next = p1.nextPageToken;

    // Paginate through all records across Georgia
    while (next) {
      try {
        let pn = await fetchFirestorePage(next);
        if (pn.documents) docs.push(...pn.documents);
        next = pn.nextPageToken;
      } catch (err) {
        console.warn('[EV] Page fetch warn:', err.message);
        break;
      }
    }

    const stations = docs.map(d => {
      const f = d.fields || {};
      const lat = f.lat ? (f.lat.doubleValue || parseFloat(f.lat.stringValue || 0)) : 0;
      const lng = f.lng ? (f.lng.doubleValue || parseFloat(f.lng.stringValue || 0)) : 0;
      if (!lat || !lng) return null;

      const operator = f.operatorId ? f.operatorId.stringValue : 'EV Network';
      const city = f.cityKa ? f.cityKa.stringValue : '';
      const addr = f.addrKa ? f.addrKa.stringValue : (f.addrEn ? f.addrEn.stringValue : '');
      
      let maxKw = 0;
      let connectorTypes = [];
      let priceGEL = null;

      if (f.connectors && f.connectors.arrayValue && f.connectors.arrayValue.values) {
        f.connectors.arrayValue.values.forEach(v => {
          const cf = v.mapValue ? v.mapValue.fields : null;
          if (cf) {
            const kw = cf.kw ? parseInt(cf.kw.integerValue || cf.kw.doubleValue || 0, 10) : 0;
            if (kw > maxKw) maxKw = kw;
            const t = cf.type ? cf.type.stringValue : null;
            if (t && !connectorTypes.includes(t)) connectorTypes.push(t);
            if (cf.pricePerKwh && cf.pricePerKwh.doubleValue != null && priceGEL === null) {
              priceGEL = cf.pricePerKwh.doubleValue;
            }
          }
        });
      }

      const name = addr ? (city ? city + ', ' + addr : addr) : (city || (operator + ' Charger'));

      return enrichStationTariff({
        lat: Math.round(lat * 1000000) / 1000000,
        lng: Math.round(lng * 1000000) / 1000000,
        name: name,
        city: city,
        address: addr,
        operator: operator,
        power: maxKw ? maxKw + ' kW' : 'Standard',
        type: connectorTypes.join(', ') || 'CCS2 / Type 2',
        price: priceGEL ? priceGEL + ' ₾/kWh' : 'სტანდარტული ტარიფი',
        hours: f.openingHours && f.openingHours.stringValue ? f.openingHours.stringValue : null // AUDIT FIX: no fake 24/7
      });
    }).filter(Boolean);

    const dedupedStations = deduplicateStations(stations, 30);
    if (dedupedStations.length > 0) {
      cachedLiveChargers = dedupedStations;
      lastChargersFetch = now;
      console.log(`[EV] Successfully synced ${dedupedStations.length} live EV charging stations across Georgia (${stations.length} raw stations deduplicated)!`);

      // Persist to disk for high-speed instant load & offline resilience
      fs.writeFile(CHARGERS_CACHE_FILE, JSON.stringify({
        source: 'dachar.ge & Revolt Georgia (GPS კოორდინატები); GeoCharge.ge (ტარიფები)',
        count: dedupedStations.length,
        timestamp: now,
        stations: dedupedStations
      }, null, 2), 'utf8', (err) => {
        if (err) console.warn('[EV] Cache file write notice:', err.message);
      });
    }
    return cachedLiveChargers || [];
  } catch (err) {
    console.warn('[EV] Failed to refresh live chargers:', err.message);
    return cachedLiveChargers || [];
  }
}

// Background automatic EV chargers synchronization (every 30 mins, only when running as server)
if (require.main === module) {
  setInterval(() => {
    getLiveGeorgiaChargers(true).catch(e => console.warn('[EV Auto-Sync] Error:', e.message));
  }, CHARGERS_CACHE_TTL);

  // GeoCharge tariff medians: soon after start, then once a day
  setTimeout(() => { refreshTariffs().catch(() => {}); }, 10000);
  setInterval(() => { refreshTariffs().catch(() => {}); }, TARIFFS_REFRESH_MS);

  // Initial background sync after 3 seconds
  setTimeout(() => {
    getLiveGeorgiaChargers(false).catch(() => {});
  }, 3000);
}

// Server-side Geocoding Proxy (OSM Nominatim) with caching & rate limiting
const searchCache = new Map();
const SEARCH_CACHE_TTL = 24 * 60 * 60 * 1000;
let lastNominatimRequestTime = 0;
const MAX_SEARCH_QUEUE_MS = 8000;       // never queue more than ~8 pending Nominatim calls
const searchHits = new Map();           // per-IP: max 30 searches/minute
function searchRateLimited(ip) {
  const now = Date.now();
  if (searchHits.size > 2000) searchHits.clear();
  const r = searchHits.get(ip);
  if (!r || now > r.expireAt) { searchHits.set(ip, { count: 1, expireAt: now + 60000 }); return false; }
  r.count++;
  return r.count > 30;
}

// Typeahead suggestions (v3.10.52): Photon (photon.komoot.io, OSM, built for search-as-you-type; "please be fair"), through
// this proxy so every car shares one 24 h cache and the public server sees at most ~4 calls a second from us.
const suggestCache = new Map();
const suggestHits = new Map();
let lastPhotonRequestTime = 0;
function suggestRateLimited(ip) {
  const now = Date.now();
  if (suggestHits.size > 2000) suggestHits.clear();
  const r = suggestHits.get(ip);
  if (!r || now > r.expireAt) { suggestHits.set(ip, { count: 1, expireAt: now + 60000 }); return false; }
  r.count++;
  return r.count > 120;
}
function photonSuggest(query, bias) {
  return new Promise((resolve) => {
    const q = (query || '').trim();
    if (q.length < 3) return resolve([]);
    const key = q.toLowerCase() + (bias ? '|' + bias.lat.toFixed(1) + ',' + bias.lon.toFixed(1) : '');
    const cached = suggestCache.get(key);
    if (cached && Date.now() - cached.t < SEARCH_CACHE_TTL) return resolve(cached.data);
    // <= 4 calls a second to the public server: a call that comes too soon waits its turn (never more than ~1 s of queue)
    const now = Date.now();
    const waitMs = Math.max(0, lastPhotonRequestTime + 250 - now);
    if (waitMs > 1000) return resolve(cached ? cached.data : []);
    lastPhotonRequestTime = now + waitMs;
    setTimeout(() => photonFetch(q, bias, key, cached, resolve), waitMs);
  });
}

function photonFetch(q, bias, key, cached, resolve) {
  // Georgia and the neighbours the Nominatim search also covers (TR, AM, AZ); the car position only ranks, it does not filter
  const url = 'https://photon.komoot.io/api/?limit=6&bbox=26,36,51,44&q=' + encodeURIComponent(q) + (bias ? '&lat=' + bias.lat.toFixed(4) + '&lon=' + bias.lon.toFixed(4) : '');
  const req = https.get(url, { headers: { 'User-Agent': 'TeslaNav/3.10 (+https://apev.onrender.com; automotive navigation client)' }, timeout: 4000 }, (res) => {
    if (res.statusCode !== 200) { res.resume(); return resolve(cached ? cached.data : []); }
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      try {
        const data = SearchUtil.photonToResults(JSON.parse(body));
        suggestCache.set(key, { t: Date.now(), data });
        if (suggestCache.size > 300) suggestCache.delete(suggestCache.keys().next().value);
        resolve(data);
      } catch (_) { resolve(cached ? cached.data : []); }
    });
  });
  req.on('error', () => resolve(cached ? cached.data : []));
  req.on('timeout', () => { req.destroy(); resolve(cached ? cached.data : []); });
}

// ---- Fixed speed cameras (v3.10.54; OpenStreetMap via Overpass): fetched by the server once a day, never by the browser ----
const SpeedCameras = require('./speed-cameras.js');
const CAMERAS_FILE = path.join(PUBLIC_DIR, 'cameras-cache.json');
const CAMERAS_TTL_MS = 24 * 3600 * 1000;
const CAMERAS_QUERY = '[out:json][timeout:90];node["highway"="speed_camera"](41.0,40.0,43.6,46.8);out;'; // whole of Georgia
const CAMERAS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
let camerasCache = { t: 0, cameras: [] };
let camerasPending = null;
try {
  if (fs.existsSync(CAMERAS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CAMERAS_FILE, 'utf8'));
    if (saved && Array.isArray(saved.cameras)) camerasCache = { t: Number(saved.t) || 0, cameras: saved.cameras };
  }
} catch (e) { console.warn('[cameras] cache file ignored:', e.message); }

function overpassPost(endpoint, query) {
  return new Promise((resolve, reject) => {
    const body = 'data=' + encodeURIComponent(query);
    const u = new URL(endpoint);
    const req = https.request({
      method: 'POST', hostname: u.hostname, path: u.pathname, timeout: 100000,   // the public server needs ~45 s for this (measured 2026-10-20)
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'TeslaNav/3.10 (+https://apev.onrender.com)' }
    }, resp => {
      let data = '';
      resp.setEncoding('utf8');
      resp.on('data', c => { data += c; if (data.length > 5 * 1024 * 1024) resp.destroy(); });
      resp.on('end', () => {
        if (resp.statusCode !== 200) return reject(new Error('HTTP ' + resp.statusCode));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad JSON')); }
      });
      resp.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

async function getSpeedCameras() {
  if (camerasCache.cameras.length && Date.now() - camerasCache.t < CAMERAS_TTL_MS) return camerasCache;
  if (camerasPending) return camerasPending;
  camerasPending = (async () => {
    let lastErr = null;
    for (const ep of CAMERAS_ENDPOINTS) {
      try {
        const cams = SpeedCameras.parseOverpass(await overpassPost(ep, CAMERAS_QUERY));
        if (cams.length) {
          camerasCache = { t: Date.now(), cameras: cams };
          try { fs.writeFileSync(CAMERAS_FILE, JSON.stringify(camerasCache)); } catch (_) {}
          console.log(`[cameras] ${cams.length} speed cameras loaded from ${new URL(ep).hostname}`);
          return camerasCache;
        }
      } catch (e) { lastErr = e; }
    }
    console.warn('[cameras] Overpass unavailable, serving the previous list:', lastErr && lastErr.message);
    camerasCache.t = Date.now() - CAMERAS_TTL_MS + 15 * 60 * 1000; // try again in 15 minutes
    return camerasCache;
  })().finally(() => { camerasPending = null; });
  return camerasPending;
}

// Google Maps share links from the phone (v3.10.53). A short link (maps.app.goo.gl) is resolved by reading only its redirect
// Location header (no Google page is downloaded, no Google API is called); the coordinates come from the URL itself.
// A link that holds only a place name falls back to our Nominatim search.
const mapsLinkCache = new Map();
function resolveShortMapsLink(link, hops) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(link); } catch (_) { return resolve(''); }
    if (SearchUtil.mapsLinkKind(u.href) !== 'short' || hops > 4) return resolve('');
    const req = https.request({ method: 'GET', hostname: u.hostname, path: u.pathname + u.search, timeout: 5000,
      headers: { 'User-Agent': 'TeslaNav/3.10 (+https://apev.onrender.com)' } }, (res) => {
      res.resume();   // only the redirect header is used; the body is never read
      const loc = res.headers.location;
      if (res.statusCode < 300 || res.statusCode >= 400 || !loc) return resolve('');
      const next = new URL(loc, u).href;
      const kind = SearchUtil.mapsLinkKind(next);
      if (kind === 'full') return resolve(next);
      if (kind === 'short') return resolveShortMapsLink(next, hops + 1).then(resolve);
      resolve('');
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}
async function resolveMapsLink(text, bias) {
  const link = SearchUtil.extractUrl(text);
  const kind = SearchUtil.mapsLinkKind(link);
  if (!kind) return { error: 'not_maps_link' };
  const cached = mapsLinkCache.get(link);
  if (cached && Date.now() - cached.t < SEARCH_CACHE_TTL) return cached.data;
  const full = kind === 'full' ? link : await resolveShortMapsLink(link, 0);
  const p = full ? SearchUtil.parseMapsUrl(full) : null;
  let data;
  if (p && p.lat != null) data = { name: p.name || 'Google Maps-ის ადგილი', lat: p.lat, lng: p.lng, approx: false };
  else if (p && p.name) {
    const r = (await searchNominatimProxy(p.name, bias))[0];
    data = r ? { name: p.name, lat: parseFloat(r.lat), lng: parseFloat(r.lon), approx: true, address: r.display_name } : { error: 'not_found', name: p.name };
  } else data = { error: full ? 'no_place' : 'unresolved' };
  if (!data.error || data.error === 'not_found') {
    mapsLinkCache.set(link, { t: Date.now(), data });
    if (mapsLinkCache.size > 200) mapsLinkCache.delete(mapsLinkCache.keys().next().value);
  }
  return data;
}

function searchNominatimProxy(query, bias) {
  return new Promise((resolve) => {
    // the result depends on the bias area, so it is part of the cache key (rounded to ~10 km)
    const biasKey = bias ? '|' + bias.lat.toFixed(1) + ',' + bias.lon.toFixed(1) : '';
    const qClean = (query || '').trim().toLowerCase() + biasKey;
    if (!query || query.trim().length < 2) return resolve([]);

    const cached = searchCache.get(qClean);
    if (cached && (Date.now() - cached.timestamp < SEARCH_CACHE_TTL)) {
      return resolve(cached.data);
    }

    const now = Date.now();
    const waitMs = Math.max(0, 1000 - (now - lastNominatimRequestTime));
    if (lastNominatimRequestTime - now > MAX_SEARCH_QUEUE_MS) return resolve(cached ? cached.data : []);
    lastNominatimRequestTime = now + waitMs;

    setTimeout(() => {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=ge,am,tr,az&limit=6&addressdetails=1&accept-language=ka,en${bias ? `&viewbox=${(bias.lon - 0.5).toFixed(3)},${(bias.lat + 0.4).toFixed(3)},${(bias.lon + 0.5).toFixed(3)},${(bias.lat - 0.4).toFixed(3)}` : ''}`;   // viewbox = soft bias (not bounded) towards the car
      const req = https.get(url, {
        headers: {
          'User-Agent': 'TeslaNav/3.9 (+https://apev.onrender.com; automotive navigation client)'
        },
        timeout: 8000
      }, res => {
        if (res.statusCode !== 200) {
          return resolve(cached ? cached.data : []);
        }
        let body = '';
        res.setEncoding('utf8'); // keep multi-byte (Georgian) characters intact across chunks
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (Array.isArray(data)) {
              searchCache.set(qClean, { timestamp: Date.now(), data });
              if (searchCache.size > 200) {
                const oldest = searchCache.keys().next().value;
                searchCache.delete(oldest);
              }
              resolve(data);
            } else {
              resolve([]);
            }
          } catch (e) {
            resolve([]);
          }
        });
      });
      req.on('error', () => resolve(cached ? cached.data : []));
      req.on('timeout', () => { req.destroy(); resolve(cached ? cached.data : []); });
    }, waitMs);
  });
}

const PIN_LOGIN_HTML = `<!DOCTYPE html>
<html lang="ka">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Tesla Nav - PIN დაცვა</title>
  <style>
    body {
      margin: 0; background: #0f1115; color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center; height: 100vh; overflow: hidden;
    }
    .pin-card {
      background: #181b20; border: 1px solid #2a2f38; border-radius: 16px; padding: 28px 24px; width: 320px;
      text-align: center; box-shadow: 0 12px 36px rgba(0,0,0,0.6);
    }
    .pin-logo { font-size: 2.2rem; margin-bottom: 8px; }
    .pin-title { font-size: 1.2rem; font-weight: 700; margin-bottom: 6px; }
    .pin-desc { font-size: 0.85rem; color: #94a3b8; margin-bottom: 20px; }
    .pin-input {
      width: 100%; box-sizing: border-box; background: #0b0c0e; border: 2px solid #334155; border-radius: 10px;
      color: #fff; font-size: 1.6rem; text-align: center; letter-spacing: 8px; padding: 12px; margin-bottom: 16px; outline: none;
    }
    .pin-input:focus { border-color: #e82127; }
    .pin-btn {
      width: 100%; background: #e82127; color: #fff; border: none; border-radius: 10px; padding: 14px;
      font-size: 1rem; font-weight: 600; cursor: pointer; transition: background 0.2s;
    }
    .pin-btn:hover { background: #c5161b; }
    .pin-err { color: #f87171; font-size: 0.85rem; margin-top: 12px; min-height: 18px; }
  </style>
</head>
<body>
  <div class="pin-card">
    <div class="pin-logo">🔒</div>
    <div class="pin-title">Tesla Nav</div>
    <div class="pin-desc">შეიყვანეთ PIN კოდი წვდომისთვის</div>
    <input type="password" id="pin" class="pin-input" maxlength="12" autofocus placeholder="••••">
    <button id="btn" class="pin-btn">შესვლა</button>
    <div id="err" class="pin-err"></div>
  </div>
  <script>
    const pinEl = document.getElementById('pin');
    const errEl = document.getElementById('err');
    const btnEl = document.getElementById('btn');
    async function submitPin() {
      errEl.textContent = '';
      const pin = pinEl.value.trim();
      if (!pin) return;
      btnEl.disabled = true;
      try {
        const res = await fetch('/api/auth/pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          window.location.reload();
        } else {
          errEl.textContent = data.error || 'არასწორი PIN კოდი';
          pinEl.value = '';
          pinEl.focus();
        }
      } catch (e) {
        errEl.textContent = 'კავშირის შეცდომა';
      } finally {
        btnEl.disabled = false;
      }
    }
    btnEl.addEventListener('click', submitPin);
    pinEl.addEventListener('keypress', (e) => { if (e.key === 'Enter') submitPin(); });
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  let urlObj, pathname;
  try {
    urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pathname = decodeURIComponent(urlObj.pathname); // AUDIT FIX: malformed URI used to crash the server
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('400 Bad Request');
    return;
  }
  // AUDIT FIX: no wildcard CORS (same-origin only); basic hardening headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=15552000');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check endpoint (for keep-alive pings / UptimeRobot)
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  // Telemetry: client window.onerror error logging
  if (pathname === '/api/telemetry/error') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2048) req.destroy(); });
      req.on('end', () => {
        try {
          const errData = JSON.parse(body);
          const clean = v => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);
          if (!isRateLimitedTelemetry(clientIp(req))) {
            console.warn('[Telemetry Error]', clean(errData.message), 'at', clean(errData.filename), clean(errData.lineno));
          }
        } catch (_) {}
        res.writeHead(204);
        res.end();
      });
      return;
    }
  }

  // Authentication: PIN submission
  if (pathname === '/api/auth/pin') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }
    const ip = clientIp(req);
    if (isRateLimited(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ძალიან ბევრი მცდელობა. გთხოვთ სცადოთ 5 წუთში.' }));
      return;
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 512) req.destroy(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const result = attemptPinAuth(parsed && parsed.pin, req);
        if (result.success) {
          resetFailedAttempts(ip);
          const isHttps = req.headers['x-forwarded-proto'] === 'https';
          const cookieHeader = `tesla_auth=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${isHttps ? '; Secure' : ''}`;
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': cookieHeader
          });
          res.end(JSON.stringify({ success: true }));
        } else {
          recordFailedAttempt(ip);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: result.error }));
        }
      } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'არასწორი მოთხოვნა' }));
      }
    });
    return;
  }

  // URL Key Authentication check: ?key=... sets cookie and 302 redirects to strip key from URL/Referer
  if (RAW_PINS.length > 0 && urlObj.searchParams.has('key')) {
    const keyParam = urlObj.searchParams.get('key');
    const keyIp = clientIp(req);
    if (isRateLimited(keyIp)) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Too many attempts. Try again in 5 minutes.');
      return;
    }
    const result = attemptPinAuth(keyParam, req);
    if (result.success) resetFailedAttempts(keyIp); else recordFailedAttempt(keyIp);
    if (result.success) {
      const isHttps = req.headers['x-forwarded-proto'] === 'https';
      const cookieHeader = `tesla_auth=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${isHttps ? '; Secure' : ''}`;
      urlObj.searchParams.delete('key');
      const cleanUrl = (urlObj.pathname + (urlObj.search ? urlObj.search : '')).replace(/^[\/\\]+/, '/'); // no open redirect (//evil.com)
      res.writeHead(302, {
        'Location': cleanUrl || '/',
        'Set-Cookie': cookieHeader
      });
      res.end();
      return;
    } else {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body style="background:#0f1115;color:#f87171;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="background:#181b20;padding:24px;border-radius:12px;border:1px solid #334155;text-align:center;max-width:360px;"><h2>🔒 წვდომა შეზღუდულია</h2><p style="color:#cbd5e1;">${result.error}</p><a href="/" style="color:#e82127;">მთავარ გვერდზე დაბრუნება</a></div></body></html>`);
      return;
    }
  }

  // Auth Gatekeeper: if ACCESS_PIN is set and route is protected and user is not authenticated
  if (RAW_PINS.length > 0 && !isPublicAuthPath(pathname) && !isAuthenticated(req)) {
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PIN_LOGIN_HTML);
      return;
    }
    if (pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  // API Endpoint: /api/route - Google Routes API (traffic-aware) through the server, with a hard daily/monthly call cap.
  // Why server-side: the console cannot cap Routes API spend, and the key stays off the browser. GET ?from=lat,lng&to=lat,lng&depart=minutes.
  // Behind the PIN gate. Answers 429 {error:'cap'} when the cap is used up (the page then falls back to OSRM), 503 when no key is set.
  if (pathname === '/api/route') {
    const rkey = (process.env.GOOGLE_ROUTES_KEY || '').trim();
    res.setHeader('Cache-Control', 'no-store');
    const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    if (!rkey) return sendJson(503, { error: 'no-key' });
    const pt = (v) => { const m = /^(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(String(v || '')); if (!m) return null; const lat = +m[1], lng = +m[2]; return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { latitude: lat, longitude: lng } : null; };
    const q = new URL(req.url, 'http://x').searchParams;
    const from = pt(q.get('from')), to = pt(q.get('to'));
    const depart = Math.min(Math.max(parseInt(q.get('depart') || '0', 10) || 0, 0), 24 * 60);
    if (!from || !to) return sendJson(400, { error: 'bad-coordinates' });
    const gate = ROUTE_QUOTA.tryConsume();
    if (!gate.ok) return sendJson(429, { error: 'cap', reason: gate.reason });
    const body = {
      origin: { location: { latLng: from } }, destination: { location: { latLng: to } },
      travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', computeAlternativeRoutes: true, languageCode: 'ka', units: 'METRIC'
    };
    if (depart > 0) body.departureTime = new Date(Date.now() + depart * 60000 + 30000).toISOString();
    // ?try=noalt,en,unaware,nosteps (diagnostics, each still counts against the cap): strip parts of the request one by one
    // to find which one makes Google answer 503 "Deadline expired" for Georgia.
    const tries = new Set(String(q.get('try') || '').split(',').filter((t) => ['noalt', 'en', 'unaware', 'nosteps'].includes(t)));
    if (tries.has('noalt')) body.computeAlternativeRoutes = false;
    if (tries.has('en')) body.languageCode = 'en';
    if (tries.has('unaware')) body.routingPreference = 'TRAFFIC_UNAWARE';
    const fieldMask = 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.routeLabels' +
      (tries.has('nosteps') ? '' : ',routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,routes.legs.steps.startLocation');
    const payload = JSON.stringify(body);
    const greq = https.request({
      hostname: 'routes.googleapis.com', path: '/directions/v2:computeRoutes', method: 'POST', timeout: 10000,
      // IPv4 only: the same request and key work from a desktop (200 in ~0.1 s) but answer 503 "Deadline expired" from Render;
      // Render's Alpine container may reach Google over IPv6, the one network difference we can control from here
      family: 4,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Goog-Api-Key': rkey,
        'X-Goog-FieldMask': fieldMask
      }
    }, (gres) => {
      const chunks = []; let size = 0;
      gres.on('data', (c) => { size += c.length; if (size < 2 * 1024 * 1024) chunks.push(c); });
      gres.on('end', () => {
        if (gres.statusCode !== 200) {
          // pass Google's own reason on (e.g. PERMISSION_DENIED + "Routes API has not been used in project..."); it never contains the key
          let reason = '', message = '';
          try { const e = JSON.parse(Buffer.concat(chunks).toString('utf8')).error || {}; reason = String(e.status || ''); message = String(e.message || '').slice(0, 300); } catch (_) {}
          console.warn('[route] Google answered HTTP ' + gres.statusCode + (reason ? ' ' + reason : '') + (message ? ': ' + message : ''));
          return sendJson(502, { error: 'upstream', status: gres.statusCode, reason, message, tried: [...tries] });
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(Buffer.concat(chunks));
      });
    });
    greq.on('timeout', () => greq.destroy(new Error('timeout')));
    greq.on('error', (e) => { console.warn('[route] upstream error: ' + (e && e.message)); if (!res.headersSent) sendJson(502, { error: 'upstream' }); });
    greq.end(payload);
    return;
  }

  // API Endpoint: /api/google-permit?sku=routes|mapload|autocomplete|details|nearby - one paid Google call from the page = one permit.
  // (/api/route-permit = sku routes, kept for older pages.) The page calls Google itself (Routes answers 503 "Deadline expired" from
  // Render), the caps stay here. Behind the PIN gate. 200 {ok,sku,day,month,dayCap,monthCap,warn,resetsOn} | 429 {error:'cap',...}.
  if (pathname === '/api/google-permit' || pathname === '/api/route-permit') {
    res.setHeader('Cache-Control', 'no-store');
    const sendJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    const sku = pathname === '/api/route-permit' ? 'routes' : new URL(req.url, 'http://x').searchParams.get('sku');
    const quota = Object.prototype.hasOwnProperty.call(GOOGLE_QUOTAS, sku) ? GOOGLE_QUOTAS[sku] : null;
    if (!quota) return sendJson(400, { error: 'bad-sku' });
    const gate = quota.tryConsume();
    const snap = quota.snapshot();
    const resets = quotaResetDates(Date.now());
    if (!gate.ok) {
      console.warn('[google-cap] ' + sku + ' ' + gate.reason + ' cap reached (' + (gate.reason === 'day' ? snap.dayCap : snap.monthCap) + ')');
      return sendJson(429, { error: 'cap', sku, reason: gate.reason, day: snap.day, month: snap.month, dayCap: snap.dayCap, monthCap: snap.monthCap, resetsOn: gate.reason === 'day' ? resets.day : resets.month });
    }
    return sendJson(200, { ok: true, sku, day: gate.day, month: gate.month, dayCap: snap.dayCap, monthCap: snap.monthCap, warn: gate.month >= 0.8 * snap.monthCap, resetsOn: resets.month });
  }

  // API Endpoint: /api/google-usage - this month's counts against our caps and Google's free caps (behind the PIN gate).
  if (pathname === '/api/google-usage') {
    const out = {};
    for (const sku of Object.keys(GOOGLE_QUOTAS)) out[sku] = Object.assign(GOOGLE_QUOTAS[sku].snapshot(), { googleFreeMonthly: GOOGLE_FREE_MONTHLY[sku] });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    const storage = { upstashUrlSet: !!process.env.UPSTASH_REDIS_REST_URL, upstashTokenSet: !!process.env.UPSTASH_REDIS_REST_TOKEN };
    for (const sku of Object.keys(GOOGLE_QUOTAS)) storage[sku] = GOOGLE_QUOTAS[sku].status();
    res.end(JSON.stringify({ resets: quotaResetDates(Date.now()), usage: out, storage }));
    return;
  }

  // API Endpoint: /api/gmaps-config - hands the (referrer-restricted) Google Maps browser key to the signed-in page.
  // Behind the PIN gate above (not a public path). The key is never logged. Without GOOGLE_MAPS_KEY the Google mode stays off.
  if (pathname === '/api/gmaps-config') {
    const key = (process.env.GOOGLE_MAPS_KEY || '').trim();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    // GOOGLE_MAP_ID (optional): a vector Map ID from Google Cloud for the heading-up test map; without it the page uses DEMO_MAP_ID
    const mapId = (process.env.GOOGLE_MAP_ID || '').trim();
    res.end(JSON.stringify(key ? { enabled: true, key, mapId } : { enabled: false }));
    return;
  }

  // API Endpoint: /api/info (Network info and IP)
  if (pathname === '/api/info') {
    const hostHeader = String(req.headers.host || '');
    const lanHost = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostHeader);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    // expose internal IPs only when accessed over a private network
    res.end(JSON.stringify(lanHost
      ? { port: PORT, localIps: getLocalIpAddresses(), host: hostHeader }
      : { host: hostHeader }));
    return;
  }

  // API Endpoint: /api/chargers/live (Live 600+ EV stations across Georgia from dachar.ge aggregator)
  if (pathname === '/api/chargers/live') {
    getLiveGeorgiaChargers().then(stations => {
      const payload = JSON.stringify({
        source: 'dachar.ge (Live Georgia EV Network)',
        count: stations.length,
        timestamp: lastChargersFetch,
        stations: stations
      });

      const acceptEncoding = req.headers['accept-encoding'] || '';
      if (/\bgzip\b/.test(acceptEncoding)) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Cache-Control': 'public, max-age=600'
        });
        zlib.gzip(Buffer.from(payload), (err, zipped) => {
          if (err) {
            res.end(payload);
          } else {
            res.end(zipped);
          }
        });
      } else {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=600'
        });
        res.end(payload);
      }
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message, stations: [] }));
    });
    return;
  }

  // API Endpoint: /api/chargers/sync (Manual/Force trigger EV Chargers synchronization)
  if (pathname === '/api/chargers/sync') {
    if (!isLocal(req)) { res.writeHead(403); res.end('Forbidden'); return; } // AUDIT FIX: local only
    getLiveGeorgiaChargers(true).then(stations => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: true,
        count: stations.length,
        timestamp: lastChargersFetch,
        message: `Synced ${stations.length} stations across Georgia`
      }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  // API Endpoint: /api/search (Server-side geocoding proxy with 24h cache & 1s rate-limiting)
  if (pathname === '/api/search') {
    const q = (urlObj.searchParams.get('q') || '').trim().slice(0, 200);
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify([]));
      return;
    }
    if (searchRateLimited(clientIp(req))) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' });
      res.end(JSON.stringify([]));
      return;
    }
    const bLat = parseFloat(urlObj.searchParams.get('lat')), bLon = parseFloat(urlObj.searchParams.get('lon'));
    const bias = (Math.abs(bLat) <= 90 && Math.abs(bLon) <= 180) ? { lat: bLat, lon: bLon } : null;
    searchNominatimProxy(q, bias).then(results => {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=86400'
      });
      res.end(JSON.stringify(results));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify([]));
    });
    return;
  }

  // API Endpoint: /api/suggest?q=&lat=&lon= - Photon typeahead (behind the PIN gate like /api/search); [] on any problem.
  // API Endpoint: /api/cameras (fixed speed cameras, OSM data cached 24 h; behind the PIN gate)
  if (pathname === '/api/cameras') {
    getSpeedCameras().then(c => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=3600' });
      res.end(JSON.stringify({ updated: c.t, cameras: c.cameras }));
    }).catch(() => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ updated: 0, cameras: [] }));
    });
    return;
  }

  // API Endpoint: /api/maps-link?url=&lat=&lon= - a shared Google Maps link -> { name, lat, lng } (behind the PIN gate)
  if (pathname === '/api/maps-link') {
    const link = (urlObj.searchParams.get('url') || '').trim().slice(0, 1000);
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (suggestRateLimited(clientIp(req))) return send(429, { error: 'rate_limited' });
    const bLat = parseFloat(urlObj.searchParams.get('lat')), bLon = parseFloat(urlObj.searchParams.get('lon'));
    const bias = (Math.abs(bLat) <= 90 && Math.abs(bLon) <= 180) ? { lat: bLat, lon: bLon } : null;
    resolveMapsLink(link, bias).then((d) => send(d.error && d.error !== 'not_found' ? 400 : 200, d)).catch(() => send(500, { error: 'failed' }));
    return;
  }

  if (pathname === '/api/suggest') {
    const q = (urlObj.searchParams.get('q') || '').trim().slice(0, 200);
    const sendRows = (code, rows) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(rows)); };
    if (q.length < 3) return sendRows(200, []);
    if (suggestRateLimited(clientIp(req))) return sendRows(429, []);
    const bLat = parseFloat(urlObj.searchParams.get('lat')), bLon = parseFloat(urlObj.searchParams.get('lon'));
    const bias = (Math.abs(bLat) <= 90 && Math.abs(bLon) <= 180) ? { lat: bLat, lon: bLon } : null;
    photonSuggest(q, bias).then((rows) => sendRows(200, rows));
    return;
  }

  // API Endpoint: /api/session/listen (SSE endpoint for Tesla car screen)
  if (pathname === '/api/session/listen') {
    const code = (urlObj.searchParams.get('code') || '').toUpperCase().trim();
    if (!CODE_RE.test(code)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing session code' }));
      return;
    }

    if (sseTotal >= MAX_SSE_TOTAL || (sessions.get(code) && sessions.get(code).size >= MAX_SSE_PER_CODE)) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '30' });
      res.end(JSON.stringify({ error: 'Too many open connections' }));
      return;
    }
    sseTotal++;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    if (!sessions.has(code)) {
      sessions.set(code, new Set());
    }
    const clientSet = sessions.get(code);
    clientSet.add(res);

    sendSSE(res, 'init', { status: 'listening', code: code });

    // Keep-alive heartbeat every 15 seconds
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseTotal = Math.max(0, sseTotal - 1);
      clientSet.delete(res);
      if (clientSet.size === 0) {
        sessions.delete(code);
      }
    });
    return;
  }

  // API Endpoint: /api/session/status (Check if a car screen is listening)
  if (pathname === '/api/session/status') {
    const code = (urlObj.searchParams.get('code') || '').toUpperCase().trim();
    const hasListeners = CODE_RE.test(code) && sessions.has(code) && sessions.get(code).size > 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: code, active: hasListeners }));
    return;
  }

  // API Endpoint: /api/session/send (Phone sends destination or GPS to car screen)
  if (pathname === '/api/session/send' && req.method === 'POST') {
    let bodyStr = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      bodyStr += chunk;
      if (bodyStr.length > MAX_BODY && !tooBig) {
        tooBig = true;
        res.writeHead(413);
        res.end();
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      try {
        const payload = JSON.parse(bodyStr || '{}');
        const code = (payload.code || '').toUpperCase().trim();
        const type = payload.type; // 'destination', 'gps'
        const data = payload.data;

        if (!CODE_RE.test(code) || !ALLOWED_EVENT_TYPES.has(type) || typeof data !== 'object' || data === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid payload: valid code, allowed type, and data object required' }));
          return;
        }

        // coordinates must be sane for gps / destination events
        if ((type === 'gps' || type === 'destination') &&
            !(Math.abs(Number(data.lat)) <= 90 && Math.abs(Number(data.lng)) <= 180)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid coordinates' }));
          return;
        }

        const listeners = sessions.get(code);
        if (!listeners || listeners.size === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Car screen is not connected or session expired' }));
          return;
        }

        for (const clientRes of listeners) {
          sendSSE(clientRes, type, data);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, receivers: listeners.size }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Malformed JSON payload' }));
      }
    });
    return;
  }

  // Static File Serving (with Native Gzip Compression & HTTP Caching)
  let reqPath = pathname;
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

  // AUDIT FIX: whitelist by bare file name or audio pack file; any directory traversal is rejected
  const name = reqPath.slice(1);
  const isAudioFile = name.startsWith('audio/') && /^[a-z0-9_\-\.\/]+$/i.test(name) && !name.includes('..');
  if (!STATIC_WHITELIST.has(name) && !isAudioFile) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const filePath = path.join(PUBLIC_DIR, name);
  const ext = path.extname(filePath).toLowerCase();

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const acceptEncoding = req.headers['accept-encoding'] || '';
    const canGzip = /\bgzip\b/.test(acceptEncoding) && (
      ext === '.html' || ext === '.css' || ext === '.js' || ext === '.json' || ext === '.svg'
    );

    // Caching headers: no-cache for app code (HTML, JS, CSS) to ensure instant Tesla updates
    const isCode = ext === '.html' || ext === '.js' || ext === '.css';
    const cacheControl = isCode
      ? 'no-cache, no-store, must-revalidate, max-age=0'
      : 'public, max-age=86400, stale-while-revalidate=3600';

    const headers = {
      'Content-Type': contentType,
      'Cache-Control': cacheControl
    };

    if (name === 'sw.js') {
      headers['Service-Worker-Allowed'] = '/';
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    }

    if (canGzip) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      const rawStream = fs.createReadStream(filePath);
      const gzip = zlib.createGzip({ level: 6 });
      rawStream.pipe(gzip).pipe(res);
    } else {
      headers['Content-Length'] = stats.size;
      res.writeHead(200, headers);
      const rawStream = fs.createReadStream(filePath);
      rawStream.pipe(res);
    }
  });
});

const HOST = process.env.HOST || '0.0.0.0'; // set HOST=127.0.0.1 to keep it private
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    if (RAW_PINS.length === 0) console.warn('[Security] ACCESS_PIN is not set: the site is OPEN to everyone. Set ACCESS_PIN (and AUTH_SECRET) in production.');
    if (!process.env.AUTH_SECRET && RAW_PINS.length > 0) console.warn('[Security] AUTH_SECRET is not set: logins are invalidated on every restart. Set AUTH_SECRET in production.');
    const localIps = getLocalIpAddresses();
    console.log('====================================================');
    console.log('⚡ Tesla Model 3 Navigation Web Server is Running! ⚡');
    console.log('====================================================');
    console.log(`Local Access:   http://localhost:${PORT}`);
    if (localIps.length > 0) {
      console.log('\n🚗 Open in Tesla Model 3 Browser (via Wi-Fi / Hotspot):');
      localIps.forEach(ip => {
        console.log(`👉 http://${ip}:${PORT}`);
      });
    } else {
      console.log(`Network Access: http://<your-ip>:${PORT}`);
    }
    console.log('====================================================');
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GEOCHARGE_TARIFF_MEDIANS,
    applyTariffs,
    haversineMeters,
    deduplicateStations,
    isDuplicateStation,
    enrichStationTariff,
    server
  };
}
