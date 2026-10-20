// Overpass tile cache (v3.10.69, audit H2): the car asks our server first; the server accepts only the two tile queries.
global.window = undefined;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };
const { overpassTileKey } = require('../server.js');

// the real queries the browser builds: capture them through the injectable fetchFn
function capture(file, cls, call) {
  const ctx = { window: {}, document: { getElementById: () => null }, localStorage: { getItem: () => null, setItem() {} }, console, setTimeout, clearTimeout, AbortController, Date, Math, JSON, Map, Set, Promise, URL, encodeURIComponent };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8') + '\nthis.__C = ' + cls + ';', ctx);
  const urls = [];
  return call(ctx.__C, (u) => { urls.push(u); return Promise.resolve({ ok: true, json: async () => ({ elements: [] }) }); }).then(() => urls);
}

(async () => {
  const sl = await capture('speed-limit.js', 'SpeedLimitEngine', (C, f) => { const e = new C(); e.fetchFn = f; return e.fetchTile(8343, 6397); });
  const ts = await capture('traffic-signals.js', 'TrafficSignalsEngine', (C, f) => { const e = new C(null, true); e.fetchFn = f; return e.fetchTile(4171, 3198); });
  ok(sl.length === 1 && sl[0].startsWith('/api/overpass?data='), 'speed limit tiles ask our server first: ' + (sl[0] || '').slice(0, 40));
  ok(ts.length === 1 && ts[0].startsWith('/api/overpass?data='), 'traffic light tiles ask our server first');
  const qSl = decodeURIComponent(sl[0].split('data=')[1]), qTs = decodeURIComponent(ts[0].split('data=')[1]);
  ok(!!overpassTileKey(qSl), 'the server accepts the real speed-limit tile query');
  ok(!!overpassTileKey(qTs), 'the server accepts the real traffic-light tile query');
  ok(overpassTileKey(qSl.replace('[timeout:20]', '[timeout:10]')) === overpassTileKey(qSl), 'old and new clients share one cache entry (timeout ignored)');

  ok(overpassTileKey('[out:json];node(41,44,42,45);out;') === null, 'any other query is refused (no open proxy)');
  ok(overpassTileKey(qTs.replace('traffic_signals', 'speed_camera')) === null, 'another tag is refused');
  ok(overpassTileKey('[out:json][timeout:20];node[highway=traffic_signals](41.0,44.0,42.0,45.0);out 500;') === null, 'a big box is refused');
  ok(overpassTileKey('[out:json][timeout:20];node[highway=traffic_signals](10.0,10.0,10.01,10.01);out 500;') === null, 'a box outside the region is refused');
  ok(overpassTileKey(qTs + 'out;') === null && overpassTileKey('') === null && overpassTileKey(null) === null, 'extra statements / empty: refused');

  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(srv.includes("pathname === '/api/overpass'") && !/PUBLIC_AUTH_PATHS[^;]*overpass/.test(srv), '/api/overpass is behind the PIN gate');
  ok(/overpassActive < 2/.test(srv) && /OVERPASS_STALE_MS/.test(srv), 'at most 2 Overpass calls at a time; a stale tile beats no tile');

  // end to end against a fake Overpass: first request fetched, the next ones from the cache, a dead Overpass -> 502
  const http = require('http');
  const { spawn } = require('child_process');
  let calls = 0, slow = 0;
  const fake = http.createServer((req, res) => {
    calls++;
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ elements: [{ type: 'node', id: 1, lat: 41.695, lon: 44.795 }] })); }, slow);
  }).listen(0);
  await new Promise((r) => fake.on('listening', r));
  const PORT = 4300 + Math.floor(Math.random() * 400);
  const env = Object.assign({}, process.env, { PORT: String(PORT), OVERPASS_ENDPOINTS: 'http://127.0.0.1:' + fake.address().port + '/api/interpreter' });
  delete env.ACCESS_PIN;
  const srvProc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  const get = (p) => new Promise((resolve) => {
    const t0 = Date.now();
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => resolve({ status: r.statusCode, body: d, ms: Date.now() - t0 })); }).on('error', () => resolve({ status: 0 }));
  });
  for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 200)); if ((await get('/healthz')).status === 200) break; }
  const url = '/api/overpass?data=' + encodeURIComponent(qTs);
  slow = 300;
  const [a, b] = await Promise.all([get(url), get(url)]);
  ok(a.status === 200 && b.status === 200 && calls === 1, 'two cars asking the same tile at once: one Overpass call (' + calls + ')');
  ok(JSON.parse(a.body).elements.length === 1, 'the Overpass answer is passed through');
  const c = await get(url);
  ok(c.status === 200 && calls === 1 && c.ms < 200, 'the next request comes from the cache (' + c.ms + ' ms, Overpass calls still ' + calls + ')');
  ok((await get('/api/overpass?data=' + encodeURIComponent('[out:json];node(1,1,2,2);out;'))).status === 400, 'a foreign query: 400');
  fake.close();
  const other = '/api/overpass?data=' + encodeURIComponent(qTs.replace('41.', '42.').replace('41.', '42.'));
  const d = await get(other);
  ok(d.status === 502, 'Overpass down and nothing cached: 502 (the car then tries the public mirrors)');
  srvProc.kill();

  process.exitCode = fails ? 1 : 0;
  console.log(fails ? fails + ' overpass tests FAILED' : 'overpass tests passed');
})();
