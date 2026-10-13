const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const https = require('https');
const vm = require('vm');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

// AUDIT FIX: never let one bad request kill the process
process.on('uncaughtException', e => console.error('[uncaught]', e && e.message));
process.on('unhandledRejection', e => console.error('[unhandled]', e && e.message));

// AUDIT FIX: serve ONLY these files (no server.js, *.md, cache json)
const STATIC_WHITELIST = new Set([
  'index.html','remote.html','style.css','leaflet.css','leaflet.js','qrcode.min.js',
  'app.js','routing.js','yandex.js','traffic.js','traffic-signals.js','chargers.js',
  'battery.js','weather.js','speech.js','media-player.js','speed-limit.js',
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

const ALLOWED_EVENT_TYPES = new Set(['destination','gps','media']);
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
  '.ico': 'image/x-icon'
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
let cachedLiveChargers = null;
let lastChargersFetch = 0;
const CHARGERS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes cache

// Load disk cache on boot if available
try {
  if (fs.existsSync(CHARGERS_CACHE_FILE)) {
    const diskData = JSON.parse(fs.readFileSync(CHARGERS_CACHE_FILE, 'utf8'));
    if (diskData && Array.isArray(diskData.stations) && diskData.stations.length > 0) {
      cachedLiveChargers = diskData.stations;
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

      return {
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
      };
    }).filter(Boolean);

    if (stations.length > 0) {
      cachedLiveChargers = stations;
      lastChargersFetch = now;
      console.log(`[EV] Successfully synced ${stations.length} live EV charging stations across Georgia!`);

      // Persist to disk for high-speed instant load & offline resilience
      fs.writeFile(CHARGERS_CACHE_FILE, JSON.stringify({
        source: 'dachar.ge & Revolt Georgia EV Network',
        count: stations.length,
        timestamp: now,
        stations: stations
      }, null, 2), (err) => {
        if (err) console.warn('[EV] Cache file write notice:', err.message);
      });
    }
    return cachedLiveChargers || [];
  } catch (err) {
    console.warn('[EV] Failed to refresh live chargers:', err.message);
    return cachedLiveChargers || [];
  }
}

// Background automatic EV chargers synchronization (every 30 mins)
setInterval(() => {
  getLiveGeorgiaChargers(true).catch(e => console.warn('[EV Auto-Sync] Error:', e.message));
}, CHARGERS_CACHE_TTL);

// Initial background sync after 3 seconds
setTimeout(() => {
  getLiveGeorgiaChargers(false).catch(() => {});
}, 3000);

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

function searchNominatimProxy(query) {
  return new Promise((resolve) => {
    const qClean = (query || '').trim().toLowerCase();
    if (!qClean || qClean.length < 2) return resolve([]);

    const cached = searchCache.get(qClean);
    if (cached && (Date.now() - cached.timestamp < SEARCH_CACHE_TTL)) {
      return resolve(cached.data);
    }

    const now = Date.now();
    const waitMs = Math.max(0, 1000 - (now - lastNominatimRequestTime));
    if (lastNominatimRequestTime - now > MAX_SEARCH_QUEUE_MS) return resolve(cached ? cached.data : []);
    lastNominatimRequestTime = now + waitMs;

    setTimeout(() => {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=ge&limit=6&addressdetails=1&accept-language=ka,en`;
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

// Resolve YouTube search query to Video ID
function resolveYouTubeQuery(query) {
  return new Promise((resolve) => {
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ka-GE,ka;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+917; SOCS=CAI'
      },
      timeout: 6000
    }, resp => {
      let body = '';
      resp.on('data', chunk => body += chunk);
      resp.on('end', () => {
        const idMatch = body.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        const titleMatch = body.match(/"title":{"runs":\[{"text":"(.*?)"/);
        if (idMatch && idMatch[1]) {
          resolve({
            success: true,
            videoId: idMatch[1],
            title: titleMatch ? titleMatch[1] : query
          });
        } else {
          resolve({ success: false, fallbackQuery: query });
        }
      });
    });
    req.on('error', err => resolve({ success: false, fallbackQuery: query, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, fallbackQuery: query, error: 'timeout' }); });
  });
}

// YouTube search RESULTS (list of videos to pick from). Parses ytInitialData from the public results page.
const ytListCache = new Map();
function parseYouTubeResults(body, max) {
  const out = [], seen = new Set();
  const push = (id, title, channel, length) => {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(id || '') || seen.has(id) || !title) return;
    seen.add(id);
    out.push({ videoId: id, title: String(title).slice(0, 140), channel: String(channel || '').slice(0, 80), length: String(length || '').slice(0, 12) });
  };
  try {
    const trimmed = body.trimStart();
    const m = trimmed[0] === '{' ? [null, trimmed] : body.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (m) {
      const data = JSON.parse(m[1]);
      const walk = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 40 || out.length >= max) return;
        if (o.videoRenderer && o.videoRenderer.videoId) {
          const v = o.videoRenderer;
          push(v.videoId,
            v.title && v.title.runs && v.title.runs[0] && v.title.runs[0].text,
            v.ownerText && v.ownerText.runs && v.ownerText.runs[0] && v.ownerText.runs[0].text,
            v.lengthText && v.lengthText.simpleText);
        }
        for (const k of Object.keys(o)) walk(o[k], depth + 1);
      };
      walk(data, 0);
    }
  } catch (_) { /* fall through to the regex fallback */ }
  if (out.length === 0) {
    const re = /"videoId":"([a-zA-Z0-9_-]{11})"[\s\S]{0,400}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g;
    let r;
    while ((r = re.exec(body)) && out.length < max) {
      let t = r[2]; try { t = JSON.parse('"' + t + '"'); } catch (_) {}
      push(r[1], t, '', '');
    }
  }
  return out.slice(0, max);
}

// Official YouTube Data API v3 (preferred when YOUTUBE_API_KEY is set; the HTML scraping above is the fallback).
// Quota: search = 100 units, videos.list = 1 unit; default 10,000 units/day = ~100 searches/day (results are cached 10 min).
const YOUTUBE_API_KEY = (process.env.YOUTUBE_API_KEY || '').trim();
function decodeHtmlEntities(t) {
  return String(t || '').replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l === 'amp') return '&'; if (l === 'lt') return '<'; if (l === 'gt') return '>';
    if (l === 'quot') return '"'; if (l === 'apos') return "'";
    const n = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
  });
}
function isoDurationToText(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return '';
  const h = (+m[1] || 0) * 24 + (+m[2] || 0), mi = +m[3] || 0, se = +m[4] || 0;
  const p2 = n => String(n).padStart(2, '0');
  return h ? `${h}:${p2(mi)}:${p2(se)}` : `${mi}:${p2(se)}`;
}
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 6000 }, resp => {
      let body = '';
      resp.on('data', c => { body += c; if (body.length > 1024 * 1024) resp.destroy(); });
      resp.on('end', () => {
        if (resp.statusCode !== 200) return reject(new Error('HTTP ' + resp.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad JSON')); }
      });
      resp.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
async function searchYouTubeApi(query) {
  const base = 'https://www.googleapis.com/youtube/v3/';
  const s = await httpsGetJson(base + 'search?part=snippet&type=video&maxResults=6&videoEmbeddable=true&safeSearch=moderate'
    + '&q=' + encodeURIComponent(query) + '&key=' + encodeURIComponent(YOUTUBE_API_KEY));
  const items = (s.items || []).filter(i => i && i.id && /^[a-zA-Z0-9_-]{11}$/.test(i.id.videoId || ''));
  if (!items.length) return { success: false, results: [] };
  let dur = {};
  try {
    const v = await httpsGetJson(base + 'videos?part=contentDetails&id=' + items.map(i => i.id.videoId).join(',')
      + '&key=' + encodeURIComponent(YOUTUBE_API_KEY));
    (v.items || []).forEach(x => { dur[x.id] = isoDurationToText(x.contentDetails && x.contentDetails.duration); });
  } catch (_) { /* durations are optional */ }
  return {
    success: true,
    results: items.map(i => ({
      videoId: i.id.videoId,
      title: decodeHtmlEntities(i.snippet && i.snippet.title).slice(0, 140),
      channel: decodeHtmlEntities(i.snippet && i.snippet.channelTitle).slice(0, 80),
      length: dur[i.id.videoId] || ''
    }))
  };
}

// Keyless JSON endpoint used by youtube.com itself (more stable than parsing the HTML page).
function searchYouTubeInnerTube(query) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00', hl: 'ka', gl: 'GE' } },
      query
    });
    const req = https.request('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+917; SOCS=CAI'
      },
      timeout: 6000
    }, resp => {
      let body = '';
      resp.on('data', c => { body += c; if (body.length > 4 * 1024 * 1024) resp.destroy(); });
      resp.on('end', () => {
        const results = resp.statusCode === 200 ? parseYouTubeResults(body, 6) : [];
        resolve({ success: results.length > 0, results });
      });
      resp.on('error', () => resolve({ success: false, results: [] }));
    });
    req.on('error', () => resolve({ success: false, results: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, results: [] }); });
    req.write(payload);
    req.end();
  });
}

function searchYouTubeList(query) {
  return new Promise((resolve) => {
    const key = query.toLowerCase();
    const hit = ytListCache.get(key);
    if (hit && Date.now() - hit.t < 10 * 60 * 1000) return resolve(hit.v);
    const done = v => {
      if (v && v.success) {
        ytListCache.set(key, { t: Date.now(), v });
        if (ytListCache.size > 100) ytListCache.delete(ytListCache.keys().next().value);
        resolve(v);
        return true;
      }
      return false;
    };
    const viaPage = () => scrapeYouTubeList(query, key, resolve);
    const viaInnerTube = () => searchYouTubeInnerTube(query).then(v => { if (!done(v)) viaPage(); }).catch(viaPage);
    if (YOUTUBE_API_KEY) {
      searchYouTubeApi(query).then(v => { if (!done(v)) viaInnerTube(); }).catch(err => {
        console.warn('[YouTube API] ' + err.message + ' - falling back');
        viaInnerTube();
      });
      return;
    }
    viaInnerTube();
  });
}

function scrapeYouTubeList(query, key, resolve) {
  {
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ka-GE,ka;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+917; SOCS=CAI'
      },
      timeout: 6000
    }, resp => {
      let body = '';
      resp.on('data', chunk => { body += chunk; if (body.length > 4 * 1024 * 1024) resp.destroy(); });
      resp.on('end', () => {
        const results = parseYouTubeResults(body, 6);
        const v = { success: results.length > 0, results };
        if (v.success) {
          ytListCache.set(key, { t: Date.now(), v });
          if (ytListCache.size > 100) ytListCache.delete(ytListCache.keys().next().value);
        }
        resolve(v);
      });
      resp.on('error', () => resolve({ success: false, results: [] }));
    });
    req.on('error', () => resolve({ success: false, results: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, results: [] }); });
  }
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

  // API Endpoint: /api/youtube/search (Resolve song or artist name to YouTube Video ID)
  if (pathname === '/api/youtube/search') {
    const q = (urlObj.searchParams.get('q') || '').trim();
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing query parameter q' }));
      return;
    }

    if (urlObj.searchParams.get('list') === '1') {
      if (searchRateLimited(clientIp(req))) {
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' });
        res.end(JSON.stringify({ success: false, results: [] }));
        return;
      }
      searchYouTubeList(q.slice(0, 120)).then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      });
      return;
    }

    resolveYouTubeQuery(q).then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    }).catch(err => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, fallbackQuery: q, error: err.message }));
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
    searchNominatimProxy(q).then(results => {
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
        const type = payload.type; // 'destination', 'gps', 'media'
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

  // AUDIT FIX: whitelist by bare file name; any directory traversal is rejected
  const name = reqPath.slice(1);
  if (!STATIC_WHITELIST.has(name)) {
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
