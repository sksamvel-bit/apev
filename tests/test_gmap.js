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
ok(/S\.vector \? \(S\.gpuOn \? 16 : 100\) : 50/.test(src) && /gfps=/.test(src), '3D map moves the camera at 10 fps (v3.10.124; 60 with the GPU camera), ?gfps=N overrides');
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
  ok(JSON.stringify(used) === JSON.stringify(['camMoves', 'close', 'focusPlace', 'gpuOn', 'isEnabled', 'isOpen', 'isVector', 'openWithDestination', 'openWithQuery', 'renderType', 'selectMap', 'shownMap', 'tilt']), 'app.js only opens Google mode (text / our destination or charger in; isOpen/isVector/gpuOn are yes/no, camMoves our own counter; tilt the camera angle in degrees, renderType VECTOR/RASTER (test table, v3.10.96/98); close only closes it; selectMap/shownMap switch maps), never reads Google data back: ' + used.join(', '));
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
    ok(steps === 8 && appS.includes('location.href = i + 1 < SUITE.length ? suiteUrl(i + 1) : "/?suite=done&map=ours&debug=1"'), "v3.10.81: the full test runs 13 variants (v3.10.83: + map at rest, v3.10.84: + raster, v3.10.85: + street-name variants, v3.10.89: + upright names, v3.10.90: CARTO row removed) one after another and ends on the table");
    ok(src.includes("if (/[?&]gmap3d=1/.test(q)) return true;") && src.includes("S.vector = /[?&]gmap3d=1/.test(location.search) ||"), "v3.10.81: ?gmap3d=1 opens Google 3D for a test without changing the saved main map");
  }
  // v3.10.80: three maps in one picker, Google 3D is the main map
  ok(G.currentMainMap() === "google3d" && JSON.stringify(G.MAP_KINDS) === JSON.stringify(["google3d", "google", "ours"]), "v3.10.93: with nothing chosen the app opens Google 3D again");
  ok(typeof G.selectMap === "function" && G.selectMap("nonsense") === false, "v3.10.80: selectMap accepts only the three maps");
  ok(src.includes('currentMainMap() !== "google";   // ?gmap3d=1'), "v3.10.80: the start opens 3D unless classic was chosen");
  { const h3 = fs.readFileSync(__dirname + "/../index.html", "utf8"); ok(["google3d", "google", "ours"].every((k) => h3.includes('data-map="' + k + '"')) && h3.includes('<option value="google3d">'), "v3.10.80: the map menu and the settings list the three maps"); }
  ok(src.includes('on("gmap-btn-vector", "click", (e) => { if (e) e.stopPropagation(); if (window.openMapPicker) window.openMapPicker(); });'), "v3.10.80: the Google side panel button opens the same map picker");
  // v3.10.77: the Google map is the main map
  ok(G.mainMapIsGoogle("") === true && G.mainMapIsGoogle("?debug=1") === true && G.mainMapIsGoogle("?gmap3d=1") === true && G.mainMapIsGoogle("?map=vector") === false, "v3.10.93: by default the app opens on Google 3D; ?map=... still opens our map");
  ok(G.mainMapIsGoogle("?map=ours") === false && G.mainMapIsGoogle("?debug=1&map=lite") === false && G.mainMapIsGoogle("?map=raster") === false,"v3.10.77: ?map=ours / ?map=lite open our map");
  const initSrc = src.slice(src.indexOf("async function init()"), src.indexOf("const api = {"));
  ok(initSrc.includes("if (S.enabled && mainMapIsGoogle(q)) autoOpen();"), "v3.10.77: Google opens by itself only when Google mode is configured");
  const openSrc = src.slice(src.indexOf("async function open()"), src.indexOf("function close()"));
  ok(/catch \(e\) \{[\s\S]*?close\(\);[\s\S]*?ჩვენს რუკაზე ხართ/.test(openSrc), "v3.10.77: no Google map (cap, network, key) -> back to our map, not an empty layer");
  ok(/window\.__setMainMapPaused && window\.map/.test(src), "v3.10.77: auto-open waits for our map so both never render at once");
  const appSrc2 = fs.readFileSync(__dirname + "/../app.js", "utf8"), html2 = fs.readFileSync(__dirname + "/../index.html", "utf8");
  ok(html2.includes('id="input-main-map"') && appSrc2.includes('localStorage.setItem("tesla_nav_main_map"'), "v3.10.77: the main map is chosen in the settings");
}

// v3.10.99: Google's road-shield placeholder is removed from the turn text; the driven part of the route is cut off
{
  const r = G.parseRoutesResponse({ routes: [{ polyline: { encodedPolyline: '_p~iF~ps|U' }, legs: [{ steps: [
    { navigationInstruction: { instructions: 'გააგრძელეთ პირდაპირ ვაჟა-ფშაველას გამზირი-ით და დარჩით {1/}-ზე' }, startLocation: { latLng: { latitude: 1, longitude: 2 } } },
    { navigationInstruction: { instructions: 'მოუხვიეთ მარჯვნივ {2/}' }, startLocation: { latLng: { latitude: 1, longitude: 2 } } }] }] }] });
  ok(r[0].steps[0].text === 'გააგრძელეთ პირდაპირ ვაჟა-ფშაველას გამზირი-ით' && r[0].steps[1].text === 'მოუხვიეთ მარჯვნივ', 'v3.10.99: "{1/}" placeholder removed from Google turn text');
  ok(/function trimPassed\([\s\S]*?setPath\(path\)/.test(src) && /nr\.d <= OFF_ROUTE_M\) \{\s*trimPassed\(pos, rt\.coords, nr\.i\)/.test(src), 'v3.10.99: chosen route line starts at the car (driven part hidden), only while on the route');
  ok(/i === S\.trimSeg && now - \(S\.trimAt \|\| 0\) < 3000/.test(src), 'v3.10.99: setPath throttled (new segment or every 3 s)');
}

// v3.10.100: speed / limit badges do not overlap the Google route card
ok(/body\.gmap-open:has\(#gmap-card\.show\) \.car-hud-stats \{ visibility: hidden; \}/.test(fs.readFileSync(__dirname + '/../style.css', 'utf8')), 'v3.10.100: speed HUD hidden while the Google route card is open');

// v3.10.101: turn arrow in the banner + arrival strip (time · min · km)
{
  const tl = G.maneuverIcon('TURN_LEFT'), trr = G.maneuverIcon('TURN_RIGHT');
  ok(tl.left === true && trr.left === false && tl.d === trr.d && /^M/.test(trr.d), 'v3.10.101: left turn = mirrored right arrow');
  ok(G.maneuverIcon('UTURN_LEFT').left === true && G.maneuverIcon('ROUNDABOUT_LEFT').left === false, 'v3.10.101: U-turn left mirrored; roundabout one shape (counter-clockwise traffic)');
  ok(G.maneuverIcon('MANEUVER_UNSPECIFIED') === null && G.maneuverIcon('') === null, 'v3.10.101: unknown maneuver -> no icon');
  const L = [{ lat: 0, lng: 0 }, { lat: 0, lng: 0.01 }, { lat: 0, lng: 0.02 }], c = G.routeCum(L);
  ok(Math.abs(c[2] - 2226) < 5 && Math.abs(G.remainingOnRoute(L, c, { lat: 0.0001, lng: 0.015 }, 1) - 556) < 5, 'v3.10.101: metres left along the route from the car');
  ok(G.remainingOnRoute(L, c, { lat: 0, lng: 0 }, -1) === c[2], 'v3.10.101: no match yet -> whole route');
  const e = G.etaInfo(1113, 2226, 1200, new Date(2026, 10, 3, 10, 0).getTime());
  ok(e.arrive === '10:10' && e.dur === '10 წთ' && e.dist === '1.1 კმ', 'v3.10.101: half the route left -> half the traffic ETA');
  ok(G.etaInfo(10, 10, 4500, 0).dur === '1 სთ 15 წთ', 'v3.10.101: hours shown above 60 min');
  const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
  ok(html.includes('id="gmap-nav-icon"') && html.includes('id="gmap-eta-time"') && html.includes('id="gmap-eta-rest"'), 'v3.10.101: banner icon + arrival strip markup');
  ok(/if \(eta\) eta\.classList\.remove\("show"\)/.test(src), 'v3.10.101: arrival strip hidden when navigation stops');
}

// v3.10.102: Google route line thin + see-through, no white casing, so the traffic colours under it stay visible
ok(/strokeColor: "#3e6ae1", strokeOpacity: 0\.7, strokeWeight: 4/.test(src) && !/strokeColor: "#ffffff", strokeOpacity: 1, strokeWeight: 10/.test(src), 'v3.10.102: route line does not hide Google traffic');

// v3.10.104: navigation survives a reload, OSRM fallback drivable, turn distance along the route, arrival by route left
{
  const L = [{ lat: 0, lng: 0 }, { lat: 0, lng: 0.01 }, { lat: 0.01, lng: 0.01 }]; // east ~1113 m, then north ~1113 m
  const c = G.routeCum(L);
  const al = G.stepAlongs(L, c, [{ loc: { lat: 0, lng: 0 } }, { loc: { lat: 0, lng: 0.01 } }, { loc: { lat: 0.005, lng: 0.01 } }]);
  ok(Math.abs(al[0]) < 1 && Math.abs(al[1] - c[1]) < 2 && Math.abs(al[2] - (c[1] + 556)) < 5, 'v3.10.104: maneuver points measured along the route');
  ok(G.distToStep(800, 1700, 500) === 1200 && G.distToStep(800, 1700, null) === 800, 'v3.10.104: turn distance along the route when on it, straight line otherwise');
  ok(G.distToStep(800, 900, 500) === 800, 'v3.10.104: along shorter than straight line (wrong match on a loop) -> straight line');
  ok(G.hasArrived(25, null) && G.hasArrived(120, 20) && !G.hasArrived(120, 80) && !G.hasArrived(120, null), 'v3.10.104: arrival by 30 m to the place or 30 m of route left');
  const now = 1e12, saved = JSON.stringify({ name: 'X', address: 'A', lat: 41.7, lng: 44.8, t: now - 60000 });
  ok(G.parseSavedNav(saved, now).lat === 41.7 && G.parseSavedNav(saved, now + 11 * 60e3) === null && G.parseSavedNav('{bad', now) === null && G.parseSavedNav(null, now) === null, 'v3.10.105: saved navigation fresh for 10 min only, junk ignored');
  ok(/localStorage\.setItem\(NAV_KEY/.test(src) && /if \(was\) \{ try \{ localStorage\.removeItem\(NAV_KEY\)/.test(src) && /setInterval\(syncCar, 250\)\);\s*resumeSavedNav\(\);/.test(src), 'v3.10.104: saved on start, cleared on stop, resumed when the Google map opens');
  ok(/\$\("gmap-card-start"\)\.hidden = false;/.test(src), 'v3.10.104: start button also for the OSRM fallback route');
}

// v3.10.105: review fixes (resume, next maneuver along the route, alternatives, search race, status timer, error texts)
{
  ok(G.nextStepAlong([0, 300, 900], 100, 0) === 1 && G.nextStepAlong([0, 300, 900], 297, 1) === 1 && G.nextStepAlong([0, 300, 900], 306, 1) === 2, 'v3.10.105: next maneuver by metres along the route (switches 5 m after it)');
  ok(G.nextStepAlong([0, 300, 900], 100, 2) === 2 && G.nextStepAlong([0, 300, 900], 2000, 0) === 2 && G.nextStepAlong([0, null, 900], 100, 0) === -1, 'v3.10.105: never back, last at the end, unplaced maneuver -> old method');
  ok(/if \(Date\.now\(\) - \(S\.navSavedAt \|\| 0\) > 30000\) saveNav\(\);/.test(src) && /meters\(S\.carPos, saved\) < NAV_NEAR_M/.test(src), 'v3.10.105: navigation refreshed every 30 s; not resumed within 300 m of the place');
  ok(/if \(i === S\.routeIdx \|\| S\.navigating\) return;/.test(src) && /saveNav\(\);\s*drawRoutes\(\);/.test(src) && /if \(was && S\.map && S\.routes\.length\) drawRoutes\(\);/.test(src), 'v3.10.105: grey alternatives hidden while navigating, back after stop');
  ok(/if \(seq !== S\.sugSeq\) return;/.test(src), 'v3.10.105: an older search answer never replaces a newer one');
  ok(/clearTimeout\(S\.statusTimer\);/.test(src) && !/setTimeout\(\(\) => setStatus\(""\), \d+\)/.test(src.replace('S.statusTimer = setTimeout(() => setStatus(""), ms)', '')), 'v3.10.105: one status timer (no stray timers hiding newer texts)');
  ok(/setStatus\("მარშრუტი ვერ გადაითვალა/.test(src), 'v3.10.105: a failed reroute does not leave "გადაითვალა..." on the screen');
  ok(/AbortError" \? "timeout" : "network"/.test(src) && /code === "timeout"/.test(src) && /code === "network"/.test(src), 'v3.10.105: Google timeout / no network get their own text');
}

// v3.10.106: docs/NAV_STANDARDS.md sizes (1 CSS px ~ 0.26 mm in the car): secondary text >= 0.95rem, close buttons 48x48
{
  const css = fs.readFileSync(__dirname + '/../style.css', 'utf8');
  ok(/#gmap-nav-text \{ font-size: 0\.95rem;/.test(css) && /\.gmap-nav-signal \{[^}]*font-size: 0\.95rem;/.test(css) && /\.gmap-route-note \{[^}]*font-size: 0\.95rem;/.test(css), 'v3.10.106: banner text, signal, traffic delay >= 3.8 mm (S2)');
  ok(/\.gmap-result-main \{ font-size: 1\.25rem;/.test(css) && /#gmap-card-title \{ font-size: 1\.25rem;/.test(css), 'v3.10.106: search result name and card title >= 5 mm (S1)');
  ok(/#gmap-nav-stop \{[^}]*width: 48px; height: 48px;/.test(css) && /\.gmap-card-x \{[^}]*width: 48px; height: 48px;/.test(css), 'v3.10.106: close buttons 12x12 mm (S4)');
  ok(fs.existsSync(__dirname + '/../docs/NAV_STANDARDS.md'), 'docs/NAV_STANDARDS.md exists (the rules every version is checked against)');
}

// v3.10.107 (EU HMI principles: system status): GPS stopped while driving -> red dot + toast; no internet -> 📵
{
  const appSrc = fs.readFileSync(__dirname + '/../app.js', 'utf8');
  const m = /const GPS_LOST_MS = \d+;\s*function gpsLost\([^)]*\) \{[^}]*\}/.exec(appSrc);
  ok(!!m, 'v3.10.107: gpsLost() is in app.js');
  const gpsLost = m && new Function(m[0] + '; return gpsLost;')();
  ok(gpsLost && gpsLost(1000, 20000, 40, false) && !gpsLost(1000, 10000, 40, false), 'v3.10.107: no new fix for 15 s at 40 km/h = GPS lost');
  ok(gpsLost && !gpsLost(1000, 60000, 3, false) && !gpsLost(0, 60000, 40, false) && !gpsLost(1000, 60000, 40, true), 'v3.10.107: not when standing, before the first fix, or in the test drive');
  const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
  ok(/id="net-offline"[^>]*hidden/.test(html) && /addEventListener\("offline"/.test(appSrc) && /addEventListener\("online"/.test(appSrc), 'v3.10.107: 📵 shown while offline');
  ok(/id="input-limit-chime"/.test(html) && /localStorage\.setItem\("limit_chime"/.test(appSrc), 'v3.10.107: the limit-change ping can be switched off in the settings');
}

// v3.10.109: the rest of NAV_STANDARDS S2/S4 (side panels, charger list, top chips, QR window)
{
  const css = fs.readFileSync(__dirname + '/../style.css', 'utf8');
  ok(/\.gmap-side \.gmap-btn \{ width: 70px;/.test(css) && /width: 62px;\s*height: 36px;\s*min-width: 62px;/.test(css), 'v3.10.109/114: side panel buttons have the area of 47x47 px (Google 70x32, ours 62x36)');
  ok(/\.cd-meta \{ font-size: 0\.95rem;/.test(css) && /\.cd-dist \{ font-size: 0\.95rem;/.test(css) && /\.weather-chip \{[^}]*font-size: 0\.95rem;/.test(css) && /\.battery-chip \{[^}]*font-size: 0\.95rem;/.test(css), 'v3.10.109: charger list and top chips >= 3.8 mm');
  const appSrc = fs.readFileSync(__dirname + '/../app.js', 'utf8');
  ok(/width: 170,[^\n]*\n\s*height: 170,/.test(appSrc), 'v3.10.109: the pairing QR fits the 601 px screen');
}

// v3.10.110: Google map zoom by speed (house numbers from zoom 18), manual zoom kept 60 s, ?gzoom=0 off
{
  ok(G.autoZoom(0, 17) === 18 && G.autoZoom(40, 17) === 17 && G.autoZoom(90, 17) === 16, 'v3.10.110: standing 18, town 17, fast 16');
  ok(G.autoZoom(18, 18) === 18 && G.autoZoom(25, 18) === 17 && G.autoZoom(60, 16) === 16 && G.autoZoom(50, 16) === 17, 'v3.10.110: hysteresis around 12-20 and 55-65 km/h');
  ok(/S\.manualZoomAt = Date\.now\(\); S\.map\.setZoom\(S\.map\.getZoom\(\) \+ 1\)/.test(src) && /Date\.now\(\) - \(S\.manualZoomAt \|\| 0\) < 60000/.test(src) && /S\.manualZoomAt = 0;/.test(src), 'v3.10.110: + / − keeps the driver zoom for 60 s, ◎ returns to the speed zoom');
  const appSrc = fs.readFileSync(__dirname + '/../app.js', 'utf8');
  ok(/S\.noAutoZoom = \/\[\?&\]gzoom=0/.test(src) && !/q: "gmap3d=1"/.test(appSrc), 'v3.10.110: ?gzoom=0; the fps suite rows keep a fixed zoom');
}

// v3.10.111: compass on the Google map (turns with the map; a tap = north up / heading up)
{
  const html = fs.readFileSync(__dirname + '/../index.html', 'utf8'), css = fs.readFileSync(__dirname + '/../style.css', 'utf8');
  ok(/id="gmap-compass"[\s\S]*?id="gmap-compass-rose"/.test(html) && /\.gmap-compass \{[^}]*width: 48px; height: 48px;/.test(css), 'v3.10.111: compass markup, 48 px touch target');
  ok(/updateCompass\(headingUp \? f\.heading : mapHeading\)/.test(src) && /if \(a === S\.compassDeg\) return;/.test(src), 'v3.10.111: compass follows the map heading, only on a 1 degree change');
  ok(/const headingUp = S\.vector && S\.follow && !S\.northUp;/.test(src) && /localStorage\.setItem\("gmapNorthUp"/.test(src), 'v3.10.111: north-up mode stops the map turning, remembered');
}

// v3.10.112 (design "ე"): the Google side panel hides while driving; edge tab, compass and round ◎ stay
{
  const html = fs.readFileSync(__dirname + '/../index.html', 'utf8'), css = fs.readFileSync(__dirname + '/../style.css', 'utf8');
  ok(G.sideShouldHide(true, 40, 9000) && !G.sideShouldHide(true, 40, 5000) && !G.sideShouldHide(true, 5, 60000) && !G.sideShouldHide(false, 40, 60000), 'v3.10.112: hides after 8 s without a touch at > 10 km/h, never while standing');
  ok(/id="gmap-side-tab"/.test(html) && /id="gmap-fab-me"/.test(html) && /\.gmap-side-tab \{[^}]*width: 48px;/.test(css) && /\.gmap-fab-me \{[^}]*width: 52px; height: 52px;/.test(css), 'v3.10.112: edge tab 48 px touch area, round ◎ 52 px');
  ok(/#gmap-layer\.side-closed \.gmap-side \{ transform: translateX/.test(css) && !/side-closed[^}]*backdrop-filter/.test(css), 'v3.10.112: the panel slides with a transform only (no blur, no re-layout)');
  ok(/S\.sideFixed = \/\[\?&\]gside=fixed/.test(src) && /setInterval\(sideTick, 1000\)/.test(src), 'v3.10.112: ?gside=fixed keeps it open; checked once a second');
}

// v3.10.113: panel style 3 (coloured categories): line icons instead of emoji, one colour per kind of function
{
  const css = fs.readFileSync(__dirname + '/../style.css', 'utf8');
  ok(/function setPanelIcon\(b, name, tone\)/.test(src) && /createElementNS\(NS, "path"\)/.test(src) && !/setPanelIcon[\s\S]{0,600}innerHTML/.test(src), 'v3.10.113: icons are built with DOM calls (no innerHTML)');
  for (const k of ['traffic', 'night', 'map', 'locate', 'plus', 'minus', 'bolt', 'list', 'camera', 'volume', 'volumeOff', 'phone', 'settings', 'close']) ok(new RegExp('\\n\\s+' + k + ': "M').test(src), 'v3.10.113: icon ' + k);
  ok(/data-tone="green"\] \{ color: #22c55e; \}/.test(css) && /\.gmap-side \.gmap-btn\.active \{ background: color-mix\(in srgb, currentColor 18%, transparent\);/.test(css), 'v3.10.113: colour per category, active = soft tint of its own colour');
}

// v3.10.114: compass on top of the panel column (same place open or hidden); panel below it still fits 601 px
{
  const css = fs.readFileSync(__dirname + '/../style.css', 'utf8');
  ok(/\.gmap-compass \{ position: absolute; top: 72px; right: 25px;/.test(css) && !/side-closed \.gmap-compass \{/.test(css), 'v3.10.114: compass above the panel, never beside it');
  ok(/\.gmap-side \{ top: 128px; right: 10px; gap: 2px;[^}]*max-height: calc\(100vh - 140px\)/.test(css) && /\.gmap-side \.gmap-btn \{ width: 70px; height: 42px; min-height: 32px;/.test(css), 'v3.10.114: panel under the compass, 70x32 buttons (area of 47x47)');
}

// v3.10.115: home / work / recent places under the Google search; "then …" when two maneuvers come close
{
  const a = { name: 'A', lat: 41.7, lng: 44.8 }, b = { name: 'B', lat: 41.72, lng: 44.8 }, a2 = { name: 'A (2)', lat: 41.70001, lng: 44.80001 };
  let l = G.addRecent([], a); l = G.addRecent(l, b); l = G.addRecent(l, a2);
  ok(l.length === 2 && l[0].name === 'A (2)' && l[1].name === 'B', 'v3.10.115: recents newest first, the same spot (< 60 m) only once');
  let big = []; for (let i = 0; i < 8; i++) big = G.addRecent(big, { name: 'P' + i, lat: 41 + i * 0.01, lng: 44 });
  ok(big.length === 5 && big[0].name === 'P7', 'v3.10.115: at most 5 recents');
  ok(G.thenPhrase('TURN_LEFT') === 'მარცხნივ' && G.thenPhrase('TURN_SLIGHT_RIGHT') === 'ოდნავ მარჯვნივ' && G.thenPhrase('ROUNDABOUT_LEFT') === 'წრეზე' && G.thenPhrase('UTURN_LEFT') === 'მობრუნება' && G.thenPhrase('STRAIGHT') === '' && G.thenPhrase('') === '', 'v3.10.115: "then" words for the next maneuver');
  ok(G.thenIsClose(80) && !G.thenIsClose(200) && !G.thenIsClose(NaN), 'v3.10.115: "then" only when the next maneuver is < 150 m after this one');
  ok(/function showQuickList\(\)/.test(src) && /goFav\("home"\)/.test(src) && /S\.pendingFav = \{ kind, text \}/.test(src) && /speak\(thenTxt \? t \+ ", შემდეგ " \+ thenTxt : t\)/.test(src), 'v3.10.115: quick list wired, home/work coordinates learned once, "then" also spoken');
}

// v3.10.116: weather along the route (Open-Meteo for points along the line, place names from /api/reverse)
{
  const line = []; for (let i = 0; i <= 100; i++) line.push({ lat: 41.7 + i * 0.009, lng: 44.8 });   // ~100 km north
  const cum = G.routeCum(line);
  const pts = G.routeWeatherPoints(line, cum, 7200);
  ok(pts.length >= 4 && pts.length <= 8 && Math.abs(pts[pts.length - 1].alongM - cum[cum.length - 1]) < 1 && Math.abs(pts[pts.length - 1].etaSec - 7200) < 1, 'v3.10.116: points along a 100 km route, the last one at the end with the full ETA');
  ok(pts.every((p, i) => i === 0 || p.alongM > pts[i - 1].alongM), 'v3.10.116: points in route order');
  const short = []; for (let i = 0; i <= 10; i++) short.push({ lat: 41.7 + i * 0.001, lng: 44.8 });
  ok(G.routeWeatherPoints(short, G.routeCum(short), 600).length === 0, 'v3.10.116: no check for city trips under 25 km');
  ok(G.weatherHazard(73, -3, 1).text === 'თოვლი' && G.weatherHazard(61, -1, 0.5).text === 'მოყინვის საფრთხე' && G.weatherHazard(95, 15, 2).sev === 3 && G.weatherHazard(45, 8, 0).text === 'ნისლი' && G.weatherHazard(0, 18, 0) === null, 'v3.10.116: snow, ice, storm, fog; fine weather -> null');
  const t = G.hazardText(G.weatherHazard(73, -3, 1), 'ქუმლისციხე', -3.2, 120000, new Date(2026, 10, 3, 13, 40).getTime());
  ok(t === '🌨️ ქუმლისციხესთან თოვლი, -3° (≈ 13:40)' && G.nearForm('გუდაური') === 'გუდაურთან' && G.nearForm('მცხეთა') === 'მცხეთასთან' && G.nearForm('Stepantsminda') === 'Stepantsminda-თან' && /~120 კმ-ში/.test(G.hazardText(G.weatherHazard(45, 5, 0), '', 5, 120000, 0)), 'v3.10.116: warning text with and without a place name');
  const srv5 = fs.readFileSync(__dirname + '/../server.js', 'utf8');
  ok(/pathname === '\/api\/reverse'/.test(srv5) && /reverse\?format=json&zoom=14/.test(srv5) && !/PUBLIC_AUTH_PATHS[^;]*reverse/.test(srv5), 'v3.10.116: /api/reverse (Nominatim zoom 14, behind the PIN gate, 1 request a second)');
}

// v3.10.117: a trip planned on the phone waits on the server (Upstash) and opens in the car near its time
{
  const now = new Date(2026, 10, 3, 20, 0).getTime();
  ok(G.whenText(new Date(2026, 10, 3, 21, 5).getTime(), now) === 'დღეს 21:05' && G.whenText(new Date(2026, 10, 4, 9, 0).getTime(), now) === 'ხვალ 09:00' && G.whenText(new Date(2026, 10, 6, 9, 0).getTime(), now) === '6 ნოემბერს 09:00', 'v3.10.117: today / tomorrow / date text');
  ok(G.planState(now + 3 * 3600e3, now) === 'later' && G.planState(now + 60 * 60e3, now) === 'now' && G.planState(now - 60 * 60e3, now) === 'now' && G.planState(now - 4 * 3600e3, now) === 'gone', 'v3.10.117: used from 90 min before until 3 h after');
  ok(/setTimeout\(checkPlannedTrip, 4000\)/.test(src) && /method: "DELETE"/.test(src) && /routeToPlace\(Math\.max\(0, Math\.round\(\(p\.departAt - Date\.now\(\)\) \/ 60000\)\)\)/.test(src), 'v3.10.117: checked on open, route with the departure forecast, then cleared');
  const srv6 = fs.readFileSync(__dirname + '/../server.js', 'utf8');
  ok(/pathname === '\/api\/session\/plan'/.test(srv6) && /_plans', timeoutMs: 6000/.test(srv6) && /departAt > now \+ PLAN_AHEAD_MS/.test(srv6) && /MAX_PLANS/.test(srv6), 'v3.10.117: server keeps one plan per code in Upstash, up to 7 days ahead, capped');
  const rem = fs.readFileSync(__dirname + '/../remote.html', 'utf8');
  ok(/id="phone-depart"/.test(rem) && /async function deliver\(dest, label\)/.test(rem) && (rem.match(/await deliver\(/g) || []).length === 3, 'v3.10.117: phone: "now" or a chosen time for all three kinds of result');
  ok(/if \(b\.textContent !== want\) b\.textContent = want;/.test(rem), 'v3.10.117: the label observer changes text only on a change (no endless loop)');
  ok(fs.readFileSync(__dirname + '/../.gitignore', 'utf8').includes('trip-plans.json'), 'v3.10.117: the local plans file stays out of git');
}

// v3.10.118: hazards on the Google nav banner; our traffic lights drawn on the Google map
{
  ok(G.hazardLine({ kind: 'bump', distanceMeters: 96 }) === '🔺 ბარიერი 100 მეტრში' && G.hazardLine({ kind: 'rail', distanceMeters: 204 }) === '🚂 გადასასვლელი 200 მეტრში' && G.hazardLine({ kind: 'school', distanceMeters: 50 }) === '🏫 სკოლა მარშრუტზე, შეანელე', 'v3.10.118: banner lines for bump / railway crossing / school');
  ok(/updateHazards\(pos, fix\.headingDeg\)/.test(src) && /h\.kind === "bump" && h\.distanceMeters > 120/.test(src), 'v3.10.118: hazards each fix while navigating; a bump chimes only near (120 m)');
  ok(/function updateSignalMarkers\(pos, force\)/.test(src) && /\.slice\(0, 8\)/.test(src) && /o\.d < 500/.test(src) && /getZoom\(\) \|\| 0\) >= 15/.test(src) && /S\.noSigMarkers = !\/\[\?&\]gsig=1/.test(src), 'v3.10.118/122: at most 8 traffic lights within 500 m ahead, from zoom 15; off unless ?gsig=1');
  const srv7 = fs.readFileSync(__dirname + '/../server.js', 'utf8');
  ok(/OVERPASS_HAZ_RE\.exec/.test(srv7), 'v3.10.118: the server accepts the combined traffic light + hazards tile');
}

// v3.10.119 (live test 2026-11-03): no two voice prompts for the same turn a second apart
{
  const v = G.createVoiceCues();
  const st = { text: 'მოუხვიეთ მარცხნივ' };
  ok(v.update(3, st, 210, 50) === null && /^200 მეტრში/.test(v.update(3, st, 200, 50) || ''), 'v3.10.119: at 210 m silent, at 200 m "200 მეტრში …" (was both)');
  const v2 = G.createVoiceCues();
  ok(v2.update(4, st, 52, 50) === null && v2.update(4, st, 48, 50) === 'მოუხვიეთ მარცხნივ', 'v3.10.119: at 52 m silent, then only the bare instruction');
  const v3 = G.createVoiceCues();
  ok(/^480 მეტრში/.test(v3.update(5, st, 480, 50) || ''), 'v3.10.119: far from the next tier the prompt is still said');
}

// v3.10.121: a tap on the Google map opens the place card for that point (Google mode is the start map, the tap was only on ours)
{
  ok(/tapPlace\(e && e\.latLng\)/.test(src) && /if \(S\.sideOpen && !S\.sideFixed\) \{ setSideOpen\(false\); return; \}/.test(src), 'v3.10.121: a map tap closes the open side panel, otherwise marks a destination');
  ok(/if \(!ll \|\| S\.navigating/.test(src) && /tap: true/.test(src) && /if \(!p\.tap\) rememberPlace/.test(src), 'v3.10.121: not while navigating; a tapped point stays out of the recents');
  ok(/\/api\/reverse\?lat=/.test(src.slice(src.indexOf('function tapPlace'))), 'v3.10.121: the area name comes from our OSM reverse, not Google');
}

// v3.10.123: traffic auto-pause while driving freely on a slow car (the layer costs 30-50% fps on the MCU2)
{
  const g = G.createTrafficGovernor();
  let t = 0, cam = 0, p = false;
  for (; t <= 20000; t += 1000) { cam += 4; p = g.update(t, 40, cam); if (t === 14000) ok(p === false, 'v3.10.123: 14 s fast at 4 cam/s: traffic still shown'); }
  ok(p === true, 'v3.10.123: 15+ s above 15 km/h at 4 cam/s pauses traffic');
  for (let k = 0; k < 4; k++, t += 1000) p = g.update(t, 3, cam);
  ok(p === true, 'v3.10.123: 4 s standing: still paused (no flicker at a short stop)');
  for (let k = 0; k < 4; k++, t += 1000) p = g.update(t, 3, cam);
  ok(p === false, 'v3.10.123: 6+ s below 7 km/h shows traffic again');
  const f = G.createTrafficGovernor();
  let c2 = 0, p2 = false;
  for (let t2 = 0; t2 <= 40000; t2 += 1000) { c2 += 20; p2 = p2 || f.update(t2, 60, c2); }
  ok(p2 === false, 'v3.10.123: a fast car (20 cam/s, MCU3) never pauses traffic');
  const h = G.createTrafficGovernor();
  let c3 = 0, p3 = false;
  for (let t3 = 0; t3 <= 40000; t3 += 1000) { c3 += 4; p3 = p3 || h.update(t3, 10, c3); }
  ok(p3 === false, 'v3.10.123: slow city traffic (10 km/h) keeps the layer');
  ok(/trafficTick\(S\.lastKmh\)/.test(src) && /S\.trafficManual = true/.test(src) && /gtrafficauto=0/.test(src), 'v3.10.123: runs per fix; a tap on the paused button shows it for the visit; ?gtrafficauto=0 turns it off');
}
{
  ok(/gzoom=\(1\[4-9\]\|20\)/.test(src) && /zoom: S\.fixedZoom \|\| 16/.test(src), 'v3.10.123: ?gzoom=N (14..20) fixes the zoom for the fps suite');
}
{
  ok(/S\.trafficOn = localStorage\.getItem\("gmapTraffic2"\) === "1"/.test(src) && /gtraffic=1\(&\|\$\)/.test(src), 'v3.10.124: traffic off by default (new key), ?gtraffic=1 forces it on');
  ok(/S\.gpuOn \? 16 : 100\) : 50\)/.test(src), 'v3.10.124: 3D camera 10/s by default');
}
