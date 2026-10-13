const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const https = require('https');
const vm = require('vm');

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
  'manifest.json','icon.svg','icon-192.png','icon-512.png'
]);

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

// Resolve YouTube search query to Video ID
function resolveYouTubeQuery(query) {
  return new Promise((resolve) => {
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ka-GE,ka;q=0.9,en-US;q=0.8,en;q=0.7'
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

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
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

  // API Endpoint: /api/youtube/search (Resolve song or artist name to YouTube Video ID)
  if (pathname === '/api/youtube/search') {
    const q = (urlObj.searchParams.get('q') || '').trim();
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing query parameter q' }));
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

  // API Endpoint: /api/session/listen (SSE endpoint for Tesla car screen)
  if (pathname === '/api/session/listen') {
    const code = (urlObj.searchParams.get('code') || '').toUpperCase().trim();
    if (!CODE_RE.test(code)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing session code' }));
      return;
    }

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
