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

// ---- voice prompts (500 / 200 / 50 m, each once, only the closest when several are crossed) ----
{
  const vc = G.createVoiceCues(), st = { text: 'მოუხვიეთ მარჯვნივ' }, said = [];
  for (let d = 900; d >= 0; d -= 20) { const t = vc.update(1, st, d, 40); if (t) said.push(t); }
  ok(said.length === 3 && /^500 მეტრში/.test(said[0]) && /^200 მეტრში/.test(said[1]) && said[2] === 'მოუხვიეთ მარჯვნივ', 'three prompts per maneuver: ' + JSON.stringify(said));
  ok(vc.update(1, st, 40, 40) === null, 'no repeat for the same maneuver');
  ok(vc.update(2, { text: 'მოუხვიეთ მარცხნივ' }, 480, 40) === '480 მეტრში, მოუხვიეთ მარცხნივ', 'next maneuver starts its own tiers (says the real distance, like routing.js)');
  const v2 = G.createVoiceCues();
  ok(v2.update(1, st, 120, 40) === '120 მეტრში, მოუხვიეთ მარჯვნივ' && v2.update(1, st, 110, 40) === null, 'already close: only the closest tier is said');
  ok(/^800 მეტრში/.test(G.createVoiceCues().update(1, st, 800, 100)), 'above 70 km/h prompts start at 800 m');
  ok(G.createVoiceCues().update(0, st, 10, 40) === null, 'no prompt for the departure step (index 0)');
  const v3 = G.createVoiceCues(); v3.update(1, st, 40, 40); v3.reset();
  ok(v3.update(1, st, 40, 40) === 'მოუხვიეთ მარჯვნივ', 'reset (after a reroute) allows the prompt again');
}
// ---- smooth car (glide), look-ahead camera, raster/vector options ----
{
  const U = require('../map-gl.js');
  const gl = G.createCarGlide(U);
  gl.setFix({ lat: 41.7, lng: 44.8, headingDeg: 0, speedMs: 10 }, 0);
  let f = null; for (let t = 50; t <= 500; t += 50) f = gl.frame(t, 50);
  const north = G.meters({ lat: 41.7, lng: 44.8 }, f);
  ok(f.lat > 41.7 && north > 2 && north < 6 && f.moving, 'glide: dead reckoning moves the arrow forward between fixes (' + north.toFixed(1) + ' m in 0.5 s at 10 m/s)');
  gl.setFix({ lat: 41.70005, lng: 44.8, headingDeg: 90, speedMs: 10 }, 1000);
  const h1 = gl.frame(1050, 50).heading;
  ok(h1 > 0 && h1 < 45, 'glide: heading turns smoothly, not in one jump (' + h1.toFixed(1) + ' deg)');
  const g2 = G.createCarGlide(U);
  g2.setFix({ lat: 41.7, lng: 44.8, headingDeg: 350, speedMs: 10 }, 0); g2.frame(50, 50);
  g2.setFix({ lat: 41.7, lng: 44.8, headingDeg: 10, speedMs: 10 }, 100);
  const h2 = g2.frame(150, 50).heading;
  ok(h2 > 350 || h2 < 10, 'glide: 350 -> 10 turns through north (' + h2.toFixed(1) + ')');
  const g3 = G.createCarGlide(U);
  g3.setFix({ lat: 41.7, lng: 44.8, headingDeg: 0, speedMs: 0 }, 0); g3.frame(50, 50);
  g3.setFix({ lat: 41.8, lng: 44.9, headingDeg: 0, speedMs: 0 }, 100);
  const j = g3.frame(150, 50);
  ok(Math.abs(j.lat - 41.8) < 1e-9 && Math.abs(j.lng - 44.9) < 1e-9, 'glide: a far jump (GPS lock) snaps instead of crawling');
  let still = true; for (let t = 200; t < 3000; t += 50) still = g3.frame(t, 50).moving;
  ok(still === false, 'glide: a standing car stops animating (the loop can sleep)');
  ok(G.createCarGlide(U).frame(0, 16) === null, 'glide: no fix -> no frame');
  const c = G.aheadPoint(U, { lat: 41.7, lng: 44.8 }, 0, 16, 800, 0.25);
  const ahead = G.meters({ lat: 41.7, lng: 44.8 }, c);
  ok(c.lat > 41.7 && Math.abs(ahead - 800 * 0.25 * 156543.03392 * Math.cos(41.7 * Math.PI / 180) / 65536) < 3, 'look-ahead: camera centre is a quarter screen ahead of the car (' + ahead.toFixed(0) + ' m at z16)');
  const r = G.mapOptions(false, true, { center: { lat: 1, lng: 2 }, zoom: 16 });
  ok(Array.isArray(r.styles) && !r.mapId && !r.renderingType, 'raster map: JSON styles, no Map ID');
  const v = G.mapOptions(true, true, { center: { lat: 1, lng: 2 }, zoom: 16, heading: 120 });
  ok(v.mapId === 'DEMO_MAP_ID' && v.renderingType === 'VECTOR' && v.colorScheme === 'DARK' && v.heading === 120 && !v.styles, 'vector map: Map ID (DEMO fallback), dark colour scheme, keeps the heading');
  ok(G.mapOptions(true, false, { center: { lat: 1, lng: 2 }, zoom: 16 }).colorScheme === 'LIGHT', 'vector map: light by day');
}
ok(/gmap-btn-night/.test(src) && /gmap-btn-vector/.test(src), 'Google panel wires the night and vector buttons');
ok(G.capText({ sku: 'details', reason: 'month', resetsOn: '2026-11-01' }) === 'Google-ის უფასო თვის ლიმიტი ამოიწურა: ადგილის დეტალები. განახლდება 2026-11-01-ს. მანამდე Google-ის ეს ფუნქცია არ იმუშავებს.', 'cap message names the feature and the reset date');
ok(G.warnText({ sku: 'mapload', month: 6400, monthCap: 8000 }) === 'Google-ის უფასო თვიური ლიმიტის 80% დაიხარჯა: Google რუკის გახსნა (6400/8000)', '80 % warning text');

// ---- 3D load: camera dead-band, fps meter ----
{
  const p = { lat: 41.7, lng: 44.8, heading: 90 };
  ok(G.cameraNeedsUpdate(null, p, 1, 1), 'camera: first frame always moves');
  ok(!G.cameraNeedsUpdate(p, { lat: 41.700003, lng: 44.8, heading: 90.4 }, 1, 1), 'camera: under 1 m and 1 deg -> skipped (no vector re-render)');
  ok(G.cameraNeedsUpdate(p, { lat: 41.70002, lng: 44.8, heading: 90 }, 1, 1), 'camera: 2 m move -> updated');
  ok(G.cameraNeedsUpdate(p, { lat: 41.7, lng: 44.8, heading: 92 }, 1, 1), 'camera: 2 deg turn -> updated');
  ok(G.cameraNeedsUpdate({ lat: 41.7, lng: 44.8, heading: 359.5 }, { lat: 41.7, lng: 44.8, heading: 1 }, 1, 1), 'camera: turn across north counts the short way (1.5 deg)');
  ok(!G.cameraNeedsUpdate({ lat: 41.7, lng: 44.8, heading: null }, { lat: 41.7, lng: 44.8, heading: null }, 1, 1), 'camera: classic map (no heading) only moves on distance');
  const m = G.createFpsMeter(); let out = null;
  m.tick(0); for (let t = 100; t <= 1000; t += 100) { const v = m.tick(t); if (v != null) out = v; }
  ok(out != null && Math.abs(out - 10) < 0.01, 'fps meter: 10 frames in 1 s -> 10 fps');
}
ok(/S\.vector \? \(S\.gpuOn \? 16 : 100\) : 50/.test(src) && /gfps=/.test(src), '3D map moves the camera at 10 fps (classic 20; 60 with the GPU camera, v3.10.79), ?gfps=N overrides');
ok(G.scaledBoxStyle(0) === 'position:absolute;inset:0' && G.scaledBoxStyle(1) === 'position:absolute;inset:0', 'gscale off: the map fills the screen at full resolution');
ok(/width:75%;height:75%;transform:scale\(1\.3333\)/.test(G.scaledBoxStyle(0.75)), 'gscale 0.75: 75% box stretched x1.333 back to full screen');
{
  const css = fs.readFileSync(__dirname + '/../style.css', 'utf8');
  ok(/body\.gmap-open #map-viewport \{ visibility: hidden; \}/.test(css) && /body\.gmap-open \.top-bar/.test(css), 'Google mode switches the main UI off underneath (no hidden compositing)');
}
ok(/__setMainMapPaused\(true\)/.test(src) && /__setMainMapPaused\(false\)/.test(src), 'Google mode pauses the main map on open and resumes it on close');
ok(/__gmapNavigating = true/.test(src) && /__gmapNavigating = false/.test(src), 'Google navigation marks itself so routing.js stays quiet');

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

// ---- main map -> Google mode shortcuts (v3.10.50): one direction only (Google results never come back to MapLibre) ----
{
  const appSrc = fs.readFileSync(__dirname + '/../app.js', 'utf8');
  const used = [...new Set([...appSrc.matchAll(/GMapMode\.(\w+)/g)].map((m) => m[1]))].sort();
  ok(JSON.stringify(used) === JSON.stringify(['camMoves', 'close', 'focusPlace', 'gpuOn', 'isEnabled', 'isOpen', 'isVector', 'openWithDestination', 'openWithQuery', 'selectMap', 'shownMap']), 'app.js only opens Google mode (text / our destination or charger in; isOpen/isVector/gpuOn are yes/no, camMoves our own counter; close only closes it; selectMap/shownMap switch maps), never reads Google data back: ' + used.join(', '));
  ok(typeof G.openWithQuery === 'function' && typeof G.openWithDestination === 'function' && typeof G.isEnabled === 'function', 'gmap.js exports the two shortcuts and isEnabled');
  const owq = src.slice(src.indexOf('async function openWithQuery'), src.indexOf('async function openWithDestination'));
  const owd = src.slice(src.indexOf('async function openWithDestination'), src.indexOf('// ---------- open / close'));
  ok(/await open\(\)/.test(owq) && /suggest\(q\)/.test(owq), 'search shortcut opens Google mode and runs the normal (permit-counted) autocomplete');
  ok(/await open\(\)/.test(owd) && /showPlace\(/.test(owd) && /routeToPlace\(\)/.test(owd), 'route shortcut shows our destination and computes the routes in Google mode');
  ok(/GMapMode\.isEnabled\(\)[\s\S]{0,200}Google-ში ძებნა/.test(appSrc), 'the "Google-ში ძებნა" row appears only when Google mode is enabled');
  const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
  ok(/id="btn-preview-google"[^>]*hidden/.test(html), 'the route card button starts hidden (shown only when Google mode is enabled)');
}

// ---- our features on the Google map (v3.10.51): chargers, speed + limit badge, traffic lights ----
{
  const list = [{ lat: 41.70, lon: 44.80, name: 'far' }, { lat: 41.7151, lon: 44.8272, name: 'near' }, { lat: 41.72, lon: 44.83, name: 'mid' }, { lat: NaN, lon: 1 }];
  const got = G.nearestChargers(list, { lat: 41.7151, lng: 44.8271 }, 2, 8000).map((s) => s.name);
  ok(JSON.stringify(got) === '["near","mid"]', 'nearest chargers: sorted by distance, limited to n, bad records skipped: ' + got.join(','));
  ok(G.nearestChargers(list, { lat: 41.7151, lng: 44.8271 }, 5, 100).length === 1, 'nearest chargers: radius limit');
  const tc = src.slice(src.indexOf('function toggleCategory'), src.indexOf('// ---------- shortcuts'));
  ok(tc.includes('chargersEngine') && !tc.includes('searchNearby') && !tc.includes('permit('), '⚡ chip uses our charger data (free), not Google Places');
  ok(src.includes('findUpcomingSignal(pos, headingDeg, routeLatLngs())') && src.includes('fetchSignalsAlongRoute(ll)'), 'traffic lights ahead on the Google route come from our signals engine (prefetched along the route)');
  const css = fs.readFileSync(__dirname + '/../style.css', 'utf8');
  ok(css.includes('body.gmap-open .car-hud-stats { z-index: 950; bottom: 72px; }') && !css.includes('body.gmap-open #route-preview-card, body.gmap-open .car-hud-stats'), 'speed + limit badge stay visible in Google mode, above the map (z 950 > 900) and clear of the Google logo');
  ok(css.includes("body.gmap-open .top-bar { z-index: 950; }") && !/body.gmap-open .top-bar,/.test(css) && css.includes("body.gmap-open .top-bar .search-container { display: none; }"), "v3.10.55: weather, battery and clock stay on top in Google mode, our search gives way to the Google one");
  ok(src.includes("dockSearch(true)") && src.includes("dockSearch(false)") && src.includes("bar.insertBefore(top"), "v3.10.55: the Google search moves into the top bar on open and back on close");
  ok(JSON.stringify(G.SIDE_PROXIES.map((p) => p.target)) === JSON.stringify(["btn-chargers-list", "btn-toggle-cameras", "btn-toggle-voice", "btn-remote-phone", "btn-settings"]) && src.includes("b.dataset.cat = cat.id") && !src.includes("b.className = \"gmap-chip\""), "v3.10.56: ⚡ moved to the side panel, with the list, cameras, phone and settings of the main dock");
  const appSrc = fs.readFileSync(__dirname + "/../app.js", "utf8");
  ok(appSrc.includes("window.GMapMode.focusPlace({") && appSrc.includes("GMapMode.isOpen()) { window.GMapMode.openWithDestination") && css.includes("body.gmap-open #chargers-drawer { z-index: 950; }"), "v3.10.56: the charger list works over the Google map (tap = Google card, მარშრუტი = Google route)");
  const cm = src.slice(src.indexOf("function createMap"), src.indexOf("function applyTraffic"));
  ok(cm.includes("if (S.maps[key]) {") && !cm.includes("box.textContent = \"\"") && src.includes("const kept = S.maps && S.maps[mapKey(") && src.includes("if (!kept) { try { await permit(\"mapload\")"), "v3.10.59: 3D / night toggles reuse the kept map (at most 3 maps = bounded WebGL contexts, no extra map loads)");
  ok(G.mapKey(false, true) === "raster" && G.mapKey(true, false) === "vector-light" && G.mapKey(true, true) === "vector-dark", "v3.10.59: one map per look (raster night is a style, not a new map)");
  // v3.10.79: GPU camera on the Google 3D map (?gcam=gpu)
  {
    const prev = { t: 0, heading: 0, center: { lat: 41.7, lng: 44.8 } };
    const view = { zoom: 16, w: 1160, h: 900, hVis: 600 };
    ok(G.gpuPlan(null, { t: 0, heading: 0, pos: prev.center }, view, {}).draw === true, "v3.10.79: first frame moves Google's camera");
    const p = G.gpuPlan(prev, { t: 100, heading: 5, pos: { lat: 41.7, lng: 44.8 } }, view, {});
    ok(!p.draw && p.theta === -5 && p.ox === 580 && p.oy === 600 && Math.abs(p.tx) < 1e-9 && Math.abs(p.ty - 150) < 1e-9, "v3.10.79: 100 ms / 5 deg later the drawn picture is turned back 5 deg around the car (shown 25% below the centre)");
    const mpp = 156543.03392 * Math.cos(41.7 * Math.PI / 180) / Math.pow(2, 16);
    const north = G.gpuPlan(prev, { t: 100, heading: 0, pos: { lat: 41.7 + 10 * mpp / 111320, lng: 44.8 } }, view, {});
    ok(Math.abs(north.ty - 160) < 0.01 && Math.abs(north.tx) < 0.01, "v3.10.79: the car 10 px further north (heading 0) -> the picture moves 10 px down");
    ok(G.gpuPlan(prev, { t: 260, heading: 1, pos: prev.center }, view, {}).draw && G.gpuPlan(prev, { t: 50, heading: 13, pos: prev.center }, view, {}).draw, "v3.10.79: Google redraws after 250 ms or a 12+ deg turn");
    ok(src.includes('S.gpuOn = /[?&]gcam=gpu/.test(q)') && src.includes("if (!S.follow) { S.lastCam = null; gpuReset(); return; }") && /S\.open = false;\n\s*gpuReset\(\);/.test(src), "v3.10.79: only with ?gcam=gpu; panning by hand and closing undo the transform");
    const css = fs.readFileSync(__dirname + "/../style.css", "utf8");
    ok(/body\.gcam-gpu #gmap-canvas \.gm-style div:has\(> a\[href\*="maps\.google\.com\/maps"\]\) \{ left: calc\(16\.67%/.test(css) && /div:has\(> \.gm-style-cc\)/.test(css), "v3.10.79: Google's logo and credit are brought back into view on the oversized map (Google terms)");
    ok(src.includes("function gpuLogo(el, theta)") && src.includes('"rotate(" + (-theta).toFixed(2) + "deg)"'), "v3.10.79: the logo is kept upright while the picture turns");
  }
  // v3.10.81: the full test (10 variants in a row, one table)
  {
    const appS = fs.readFileSync(__dirname + "/../app.js", "utf8");
    const steps = (appS.slice(appS.indexOf("const SUITE = ["), appS.indexOf("const suiteUrl")).match(/\{ name: /g) || []).length;
    ok(steps === 13 && appS.includes('location.href = i + 1 < SUITE.length ? suiteUrl(i + 1) : "/?suite=done&map=ours&debug=1"'), "v3.10.81: the full test runs 13 variants (v3.10.83: + map at rest, v3.10.84: + raster) one after another and ends on the table");
    ok(src.includes("if (/[?&]gmap3d=1/.test(q)) return true;") && src.includes("S.vector = /[?&]gmap3d=1/.test(location.search) ||"), "v3.10.81: ?gmap3d=1 opens Google 3D for a test without changing the saved main map");
  }
  // v3.10.80: three maps in one picker, Google 3D is the main map
  ok(G.currentMainMap() === "google3d" && JSON.stringify(G.MAP_KINDS) === JSON.stringify(["google3d", "google", "ours"]), "v3.10.80: with nothing chosen the app opens Google 3D");
  ok(typeof G.selectMap === "function" && G.selectMap("nonsense") === false, "v3.10.80: selectMap accepts only the three maps");
  ok(src.includes('currentMainMap() !== "google";   // ?gmap3d=1'), "v3.10.80: the start opens 3D unless classic was chosen");
  { const h3 = fs.readFileSync(__dirname + "/../index.html", "utf8"); ok(["google3d", "google", "ours"].every((k) => h3.includes('data-map="' + k + '"')) && h3.includes('<option value="google3d">'), "v3.10.80: the map menu and the settings list the three maps"); }
  ok(src.includes('on("gmap-btn-vector", "click", (e) => { if (e) e.stopPropagation(); if (window.openMapPicker) window.openMapPicker(); });'), "v3.10.80: the Google side panel button opens the same map picker");
  // v3.10.77: the Google map is the main map
  ok(G.mainMapIsGoogle("") === true && G.mainMapIsGoogle("?debug=1") === true, "v3.10.77: by default the app opens on the Google map");
  ok(G.mainMapIsGoogle("?map=ours") === false && G.mainMapIsGoogle("?debug=1&map=lite") === false && G.mainMapIsGoogle("?map=raster") === false,"v3.10.77: ?map=ours / ?map=lite open our map");
  const initSrc = src.slice(src.indexOf("async function init()"), src.indexOf("const api = {"));
  ok(initSrc.includes("if (S.enabled && mainMapIsGoogle(q)) autoOpen();"), "v3.10.77: Google opens by itself only when Google mode is configured");
  const openSrc = src.slice(src.indexOf("async function open()"), src.indexOf("function close()"));
  ok(/catch \(e\) \{[\s\S]*?close\(\);[\s\S]*?ჩვენს რუკაზე ხართ/.test(openSrc), "v3.10.77: no Google map (cap, network, key) -> back to our map, not an empty layer");
  ok(/window\.__setMainMapPaused && window\.map/.test(src), "v3.10.77: auto-open waits for our map so both never render at once");
  const appSrc2 = fs.readFileSync(__dirname + "/../app.js", "utf8"), html2 = fs.readFileSync(__dirname + "/../index.html", "utf8");
  ok(html2.includes('id="input-main-map"') && appSrc2.includes('localStorage.setItem("tesla_nav_main_map"'), "v3.10.77: the main map is chosen in the settings");
}
