// gmap.js: pure helpers + the DOM/Google flow against a stubbed google.maps (no network, no real key).
const fs = require('fs'), vm = require('vm');
let fails = 0; process.on('exit', () => { if (fails) process.exitCode = 1; });
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };

const src = fs.readFileSync(__dirname + '/../gmap.js', 'utf8');
const G = require('../gmap.js');

const u = G.buildLoaderUrl('A B&key', 'cb');
ok(u.startsWith('https://maps.googleapis.com/maps/api/js?key=A%20B%26key') && /loading=async/.test(u) && /callback=cb/.test(u) && /language=ka/.test(u), 'loader URL: key encoded, async loading, Georgian');
ok(G.summarizeRoute(600, 4200) === '10 წთ · 4.2 კმ' && G.summarizeRoute(10, 20000) === '1 წთ · 20 კმ', 'route summary');
ok(/^https:\/\/r.*\/11\.5,41\.5;12\.5,42\.5\?/.test(G.osrmUrl('https://r/', { lat: 41.5, lng: 11.5 }, { lat: 42.5, lng: 12.5 })), 'OSRM URL is lng,lat');
ok(Math.abs(G.bearing({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 0) < 1e-6 && Math.abs(G.bearing({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 90) < 1e-6, 'bearing north/east');
ok(Math.abs(G.meters({ lat: 0, lng: 0 }, { lat: 0, lng: 0.001 }) - 111.2) < 1, 'distance ~111 m per 0.001 deg lng');
ok(G.mapStyles(false).length < G.mapStyles(true).length, 'night styles extend day styles');
ok(G.CATEGORIES.length === 1 && G.CATEGORIES[0].id === 'ev' && G.CATEGORIES.every(c => c.type && c.label), 'only the charging category is offered');

// ---- Routes API helpers ----
const pl = G.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
ok(pl.length === 3 && Math.abs(pl[0].lat - 38.5) < 1e-6 && Math.abs(pl[0].lng + 120.2) < 1e-6 && Math.abs(pl[2].lat - 43.252) < 1e-6 && Math.abs(pl[2].lng + 126.453) < 1e-6, 'polyline decoder matches Google reference example');
const resp = { routes: [
  { duration: '900s', staticDuration: '600s', distanceMeters: 5000, polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' }, routeLabels: ['DEFAULT_ROUTE'],
    legs: [{ steps: [{ distanceMeters: 100, startLocation: { latLng: { latitude: 41.7, longitude: 44.8 } }, navigationInstruction: { instructions: 'Turn left', maneuver: 'TURN_LEFT' } }, { distanceMeters: 50, startLocation: { latLng: { latitude: 41.71, longitude: 44.81 } } }] }] },
  { duration: '1000s', distanceMeters: 6000, polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' } }, { duration: '5s' } ] };
const pr = G.parseRoutesResponse(resp);
ok(pr.length === 2, 'routes without polyline are dropped');
ok(pr[0].durationSec === 900 && pr[0].delaySec === 300 && pr[0].distanceM === 5000 && pr[0].coords.length === 2, 'traffic delay = duration - staticDuration');
ok(pr[0].steps.length === 1 && pr[0].steps[0].text === 'Turn left' && pr[0].steps[0].loc.lat === 41.7, 'steps without instruction are skipped; loc parsed');
ok(pr[1].delaySec === 0 && G.parseRoutesResponse(null).length === 0, 'missing staticDuration / empty response handled');
const body = G.routesRequestBody({ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, 0);
ok(body.routingPreference === 'TRAFFIC_AWARE' && body.computeAlternativeRoutes && body.languageCode === 'ka' && !body.departureTime && body.origin.location.latLng.longitude === 2, 'request: traffic-aware, alternatives, Georgian, now');
ok(G.routesRequestBody({ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, 60).departureTime > new Date().toISOString(), 'planned departure sends a future departureTime');
const steps = [{ loc: { lat: 0, lng: 0 } }, { loc: { lat: 0, lng: 0.01 } }, { loc: { lat: 0, lng: 0.02 } }];
ok(G.nextStepIndex(steps, { lat: 0, lng: 0.0001 }, 0) === 1, 'at the first step start -> aim at the second');
ok(G.nextStepIndex(steps, { lat: 0, lng: -0.005 }, 0) === 0 && G.nextStepIndex(steps, { lat: 0, lng: 0.05 }, 0) === 2, 'before the first step -> 0; past the last -> last');
ok(G.nextStepIndex(steps, { lat: 0, lng: 0.0145 }, 1) === 2, 'between steps -> next is the nearer upcoming one');
ok(G.fmtDist(320) === '320 მ' && G.fmtDist(1500) === '1.5 კმ' && G.fmtDist(12000) === '12 კმ', 'distance format');

// ---- off-route / reroute ----
const line = [{ lat: 0, lng: 0 }, { lat: 0, lng: 0.01 }]; // ~1113 m east
ok(G.distToPolylineM({ lat: 0.0001, lng: 0.005 }, line) < 12 && G.distToPolylineM({ lat: 0.0001, lng: 0.005 }, line) > 10, 'on the line: ~11 m off');
ok(Math.abs(G.distToPolylineM({ lat: 0, lng: 0.02 }, line) - 1113) < 3, 'beyond the end: distance to the end point');
ok(G.distToPolylineM({ lat: 1, lng: 1 }, []) === Infinity, 'empty polyline -> Infinity');
const tr = G.createOffRouteTracker({ thresholdM: 45, ticks: 3, cooldownMs: 10000, maxReroutes: 2 });
let t0 = 1000000, fired = [];
for (let i = 0; i < 3; i++) fired.push(tr.update(80, t0 + i * 1000));
ok(!fired[0] && !fired[1] && fired[2], 'reroute fires after 3 consecutive off-route fixes');
ok(!tr.update(80, t0 + 3000) && !tr.update(80, t0 + 4000) && !tr.update(80, t0 + 5000), 'cooldown blocks an immediate second reroute');
tr.update(10, t0 + 6000);
let again = false; for (let i = 0; i < 3; i++) again = tr.update(80, t0 + 12000 + i * 1000);
ok(again, 'after the cooldown a new deviation reroutes again');
let third = false; for (let i = 0; i < 4; i++) third = tr.update(80, t0 + 40000 + i * 1000) || third;
ok(!third, 'per-trip reroute cap stops a loop (each reroute is a paid call)');
const tr2 = G.createOffRouteTracker({ ticks: 3 });
tr2.update(80, 1); tr2.update(80, 2); tr2.update(5, 3);
ok(!tr2.update(80, 4) && !tr2.update(80, 5), 'a fix back on the route resets the counter');
const longLine = []; for (let i = 0; i <= 400; i++) longLine.push({ lat: 0, lng: i * 0.0005 });
const nr = G.nearestOnPolyline({ lat: 0.0001, lng: 0.15 }, longLine, 290, 310);
ok(nr.i === 299 || nr.i === 300, 'windowed search finds the segment near the car');
ok(G.nearestOnPolyline({ lat: 0, lng: 0.01 }, longLine, 290, 310).d > 1000, 'a window away from the car reports far (caller then scans the whole line)');
ok(Math.abs(G.nearestOnPolyline({ lat: 0.0001, lng: 0.15 }, longLine).d - G.distToPolylineM({ lat: 0.0001, lng: 0.15 }, longLine)) < 1e-9, 'full scan == distToPolylineM');

// debounce
(async () => {
  let n = 0; const d = G.createDebouncer(() => n++, 30);
  d(); d(); d(); await new Promise(r => setTimeout(r, 80));
  ok(n === 1, 'debouncer fires once for a burst');
  d(); d.cancel(); await new Promise(r => setTimeout(r, 80));
  ok(n === 1, 'debouncer cancel works');
})();

// Compliance guards (Google terms): no Google data on MapLibre, key never logged, text goes through textContent.
ok(!/console\.(log|warn|error)\([^)]*\bkey\b/i.test(src.replace(/S\.key/g, '')), 'key is never logged');
ok(!/addSource|addLayer|setData|maplibregl\./.test(src), 'gmap.js never puts Google data on the MapLibre map (only resizes it on close)');
ok(!/innerHTML\s*=/.test(src), 'no innerHTML (Places text rendered with textContent)');
const srv = fs.readFileSync(__dirname + '/../server.js', 'utf8');
ok(/'gmap\.js'/.test(srv), 'gmap.js is in the server whitelist');
ok(/GOOGLE_MAPS_KEY/.test(srv) && !/PUBLIC_AUTH_PATHS[^;]*gmaps-config/.test(srv), '/api/gmaps-config reads env and is not a public path');
