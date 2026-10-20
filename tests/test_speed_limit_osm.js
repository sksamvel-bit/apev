// OSM layer tests (mocked Overpass, no network). Run: node tests/test_speed_limit_osm.js
const fs = require('fs'), vm = require('vm');
global.window = {};
global.localStorage = { getItem: () => '', setItem: () => {} };
global.performance = { now: () => Date.now() };
vm.runInThisContext(fs.readFileSync(__dirname + '/../speed-limit.js', 'utf8'));
const SLE = window.SpeedLimitEngine;

let fails = 0;
process.on('exit', () => { if (fails) process.exitCode = 1; });
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };

// ---- synthetic map around (41.7000, 44.8000) ----
const M = 1 / 111140; // metres -> degrees lat
const ML = 1 / (111320 * Math.cos(41.73 * Math.PI / 180));
const way = (id, tags, pts) => ({ type: 'way', id, tags, geometry: pts.map(([la, lo]) => ({ lat: la, lon: lo })) });
const A = 41.730, B = 44.710; // inside the Tbilisi box but >1 km from every hand-made corridor
const overpass = (extra = []) => ({ elements: [
  // X: north-south road, maxspeed 90
  way(1, { highway: 'primary', name: 'X', maxspeed: '90' }, [[A - 300 * M, B], [A + 300 * M, B]]),
  // Y: crossing east-west road 12 m north of the test point, maxspeed 50
  way(2, { highway: 'residential', name: 'Y', maxspeed: '50 km/h' }, [[A + 12 * M, B - 300 * ML], [A + 12 * M, B + 300 * ML]]),
  // Z: motorway without maxspeed, 150 m east
  way(3, { highway: 'motorway', name: 'Z' }, [[A - 300 * M, B + 150 * ML], [A + 300 * M, B + 150 * ML]]),
  // W: residential without maxspeed, 150 m west
  way(4, { highway: 'residential', name: 'W' }, [[A - 300 * M, B - 150 * ML], [A + 300 * M, B - 150 * ML]]),
  // P: imperial tag
  way(5, { highway: 'tertiary', name: 'P', maxspeed: '30 mph' }, [[A - 300 * M, B + 60 * ML], [A + 300 * M, B + 60 * ML]]),
  // Q: unusable values
  way(6, { highway: 'tertiary', name: 'Q', maxspeed: 'signals' }, [[A - 300 * M, B + 90 * ML], [A + 300 * M, B + 90 * ML]]),
  way(7, { highway: 'tertiary', name: 'R', maxspeed: '60;80' }, [[A - 300 * M, B - 60 * ML], [A + 300 * M, B - 60 * ML]]),
  way(8, { highway: 'tertiary', name: 'U', 'maxspeed:type': 'GE:urban' }, [[A - 300 * M, B - 90 * ML], [A + 300 * M, B - 90 * ML]]),
  ...extra
] });

function mkEngine(handler) {
  const e = new SLE();
  e.calls = 0;
  e.fetchFn = async (url) => { e.calls++; return handler(url); };
  e.badgeEl = { classList: { toggle: (c, v) => { e.cls = e.cls || {}; e.cls[c] = v; } }, title: '' };
  e.valEl = { textContent: '' };
  return e;
}
const okRes = (data) => ({ ok: true, json: async () => data });

(async () => {
  // 1. numeric maxspeed on the road we drive along (heading north) beats the closer crossing road
  let e = mkEngine(() => okRes(overpass()));
  e.update(A, B, 50, 0);                         // heading 0 = north
  await e.prefetchOsm(A, B);
  let r = e.detectSpeedLimit(A, B);
  ok(r.limit === 90 && r.source === 'osm' && r.confidence === 'confirmed', 'heading-aware match: travelling north picks X=90 (not the closer crossing road Y=50)');
  e.osmHeading = 90;                             // now heading east -> Y
  r = e.detectSpeedLimit(A, B);
  ok(r.limit === 50, 'heading east picks the crossing road Y=50 ("60 km/h" style tag parsed)');

  // 2. parsing
  ok(e.parseMaxspeed('30 mph').limit === 48, 'mph converted to km/h (30 mph -> 48)');
  ok(e.parseMaxspeed('signals') === null && e.parseMaxspeed('none') === null && e.parseMaxspeed('60;80') === null, 'none / signals / lists -> unknown');
  ok(e.parseMaxspeed('GE:urban').confidence === 'estimate', 'GE:urban -> 60 as ESTIMATE only');
  ok(e.parseMaxspeed('999') === null && e.parseMaxspeed('2') === null, 'absurd values rejected');

  // 3. motorway without maxspeed inside a city box must NOT become "60"
  e = mkEngine(() => okRes(overpass()));
  e.osmHeading = 0;
  await e.prefetchOsm(A, B + 150 * ML);
  r = e.detectSpeedLimit(A, B + 150 * ML);          // on Z, inside the Tbilisi box
  ok(r.limit === null && r.source === 'unverified', 'motorway without tag inside city box -> "—" (no false 60)');
  r = e.detectSpeedLimit(A, B - 150 * ML);          // on W (residential, no tag) inside the Tbilisi box
  ok(r.limit === 60 && r.confidence === 'estimate', 'residential road without tag inside city box -> ~60 estimate');

  // 4. alarm policy
  e.currentLimit = 60; e.currentConfidence = 'estimate';
  e.updateOverspeedUI(100);
  ok(!e.cls.speeding, 'no red alarm on an ESTIMATED limit');
  e.OVERSPEED_ON_ESTIMATE = true; e.updateOverspeedUI(100);
  ok(e.cls.speeding === true, 'alarm on estimate only if explicitly enabled');
  e.OVERSPEED_ON_ESTIMATE = false; e.currentConfidence = 'confirmed'; e.updateOverspeedUI(66);
  ok(e.cls.speeding === true, 'alarm fires on CONFIRMED limit +6');
  e.updateOverspeedUI(64);
  ok(e.cls.speeding === false, 'no alarm within +5 tolerance');

  // 5. display
  e.currentLimit = 60; e.currentConfidence = 'estimate'; e.renderUI(0);
  ok(e.valEl.textContent === '~60' && e.cls.estimated === true, 'estimate is shown as "~60" with the dashed style');
  e.currentConfidence = 'confirmed'; e.renderUI(0);
  ok(e.valEl.textContent === '60' && e.cls.estimated === false, 'confirmed is shown as "60"');
  e.currentLimit = null; e.currentConfidence = 'unknown'; e.renderUI(0);
  ok(e.valEl.textContent === '—', 'unknown is shown as "—"');

  // 6. cache: second visit does not hit the network
  e = mkEngine(() => okRes(overpass()));
  await e.prefetchOsm(A, B); const c1 = e.calls;
  await e.prefetchOsm(A + 20 * M, B); 
  ok(c1 >= 1 && e.calls === c1, 'second lookup in the same tile is served from cache (no new request)');

  // 7. failure -> graceful fallback + back-off, no throw
  e = mkEngine(() => { throw new Error('offline'); });
  let threw = false;
  try { await e.prefetchOsm(41.693, 44.801); } catch (x) { threw = true; }
  const callsAfterFail = e.calls;
  await e.prefetchOsm(41.693, 44.801);
  r = e.detectSpeedLimit(41.693, 44.801);
  ok(!threw && r.limit === 60 && r.confidence === 'estimate', 'Overpass offline -> falls back to city-box estimate, no exception');
  ok(e.calls === callsAfterFail && e.osmFailUntil > Date.now(), 'back-off: no request storm after a failure');

  // 8. second endpoint is used when the first fails
  let n = 0;
  e = mkEngine(() => { n++; if (n === 1) return { ok: false, status: 429 }; return okRes(overpass()); });
  await e.prefetchOsm(A, B);
  ok(e.osmTiles.size === 1 && e.calls === 2, 'HTTP 429 on the first endpoint -> second endpoint succeeds');

  // 9. LRU bound
  e = mkEngine(() => okRes({ elements: [] }));
  e.osmMaxTiles = 3;
  for (let k = 0; k < 6; k++) await e.requestTile(8000 + k, 6400);
  ok(e.osmTiles.size === 3, 'tile cache is bounded (LRU)');

  // 10. distance tolerance
  e = mkEngine(() => okRes(overpass()));
  await e.prefetchOsm(A, B);
  r = e.osmLookup(A, B + 40 * ML + 0.0); // 40 m from X, between roads, nothing within 22 m
  ok(r === null || r.name !== 'X', 'a road 40 m away is not matched');

  // 11. initial state shows nothing guessed
  ok(new SLE().currentLimit === null && new SLE().currentConfidence === 'unknown', 'before the first fix the badge is unknown (no default 60)');

  // 12. v3.10.72 (audit M5): one alert chime when going over a confirmed limit, again only after 10 s back under it
  const chimes = [];
  window.speechAssistant = { playChime: (t) => chimes.push(t) };
  const oc = new SLE();
  ok(oc.overspeedChime(true, 0) === true && chimes.join() === 'alert', 'going over the limit: one alert chime');
  ok(oc.overspeedChime(true, 2000) === false && chimes.length === 1, 'still over: no second chime');
  oc.overspeedChime(false, 3000); oc.overspeedChime(false, 8000);
  ok(oc.overspeedChime(true, 9000) === false && chimes.length === 1, 'under the limit for only 6 s, then over again: silent');
  oc.overspeedChime(false, 10000); oc.overspeedChime(false, 21000);
  ok(oc.overspeedChime(true, 22000) === true && chimes.length === 2, 'after 11 s under the limit the next overspeed chimes again');
  const src = fs.readFileSync(__dirname + '/../speed-limit.js', 'utf8');
  ok(/this\.overspeedChime\(isOverspeeding\)/.test(src) && /alarmAllowed = this\.currentConfidence === "confirmed"/.test(src), 'the chime follows the badge: confirmed limits only');
  const srv = fs.readFileSync(__dirname + '/../server.js', 'utf8');
  ok(/Content-Security-Policy', "object-src 'none'; base-uri 'self'; frame-ancestors 'self'/.test(srv), 'a safe CSP header is sent (v3.10.72, audit L5)');
  delete window.speechAssistant;
})();
