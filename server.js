const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const https = require('https');
const vm = require('vm');
const crypto = require('crypto');
const { createRouteQuota } = require('./route-quota.js');

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
  'battery.js','weather.js','speech.js','speed-limit.js',
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
const ROUTE_QUOTA = createRouteQuota({ file: path.join(__dirname, 'routes-usage.json'), dayCap: parseInt(process.env.ROUTES_DAILY_CAP, 10) || 100, monthCap: parseInt(process.env.ROUTES_MONTHLY_CAP, 10) || 4000 });
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
  if (station.price && !station.price.includes('სტანდარტული') && !station.price.includes('უცნობი')) {
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
      station.priceSource = 'GeoCharge.ge (ქსელის მედიანა, 2026-10)';
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
    const payload = JSON.stringify(body);
    const greq = https.request({
      hostname: 'routes.googleapis.com', path: '/directions/v2:computeRoutes', method: 'POST', timeout: 10000,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Goog-Api-Key': rkey,
        'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.routeLabels,routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,routes.legs.steps.startLocation'
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
          return sendJson(502, { error: 'upstream', status: gres.statusCode, reason, message });
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
    haversineMeters,
    deduplicateStations,
    isDuplicateStation,
    enrichStationTariff,
    server
  };
}
