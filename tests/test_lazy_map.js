// v3.10.144 (perf audit A1 + Q4): our MapLibre map is built only when needed, background downloads wait for Google's first picture.
const fs = require('fs'), vm = require('vm');
let fails = 0; process.on('exit', () => { if (fails) process.exitCode = 1; });
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };
const read = (f) => fs.readFileSync(__dirname + '/../' + f, 'utf8');

const html = read('index.html'), app = read('app.js'), sw = read('sw.js'), srv = read('server.js');

// --- static wiring ---
ok(!/<script src="maplibre-gl\.js/.test(html), 'index.html no longer loads maplibre-gl.js (784 KB) at the start');
ok(/<script src="map-gl\.js/.test(html), 'map-gl.js (layer registry, camera helpers) still loads at the start');
ok(/'\/maplibre-gl\.js\?v=/.test(sw) && /'maplibre-gl\.js'/.test(srv), 'maplibre-gl.js stays precached by the service worker and served by the server (fallback offline)');
ok(app.includes('s.src = "maplibre-gl.js?v=" + APP_VERSION;'), 'app.js loads MapLibre with the same versioned URL as the precache');
{
  const dcl = app.slice(app.indexOf('document.addEventListener("DOMContentLoaded", () => {'), app.indexOf('// Clean ?key= from browser'));
  ok(!/initMap\(\)/.test(dcl) && dcl.includes('if (!deferOurMap) ensureOurMap()'), 'start: our map only through ensureOurMap(), right away unless Google opens by itself');
  ok(dcl.indexOf('installMainMapPauseStub()') < dcl.indexOf('initSubsystems()'), 'the pause switch exists before Google mode can open');
  ok(dcl.includes('setTimeout(ourMapWatchdog, 2000)'), 'a watchdog builds our map when no map shows at all');
}
ok(/function ourMapCanWait\(\)[\s\S]{0,200}gmap-loading[\s\S]{0,200}mainMapIsGoogle/.test(app), 'deferring follows the start logo rule (body.gmap-loading) and the chosen main map');
ok(/if \(!map\) await ensureOurMap\(\);[^\n]*\n\s*if \(map\) destMarker = createDestMarker/.test(app), 'a route preview on our map builds the map first');
ok(app.includes('await ensureOurMap();   // v3.10.144: our map may not exist yet'), 'the rotation test of our map builds it first; the Google test does not need it');
ok(app.includes('if (window.speedLimitEngine && !startupQuiet)'), 'no Overpass speed-limit fetch before the first Google picture');
ok(app.includes('{ later: afterFirstPicture }') && app.includes('afterFirstPicture(() => camerasEngine.load())'), 'chargers and cameras download after the first Google picture');

// --- afterFirstPicture + ensureOurMap behaviour (cut out of app.js, run with stubs) ---
const cut = (a, b) => app.slice(app.indexOf(a), app.indexOf(b));
const helpers = cut('let ourMapPromise = null;', 'function initMap() {');
(async () => {
  const listeners = {}, timers = [];
  const body = { cls: new Set(['gmap-loading']), classList: { contains: (c) => body.cls.has(c) } };
  const ctx = {
    console, Promise, location: { search: '' },
    document: { body, head: { appendChild: (s) => { ctx.appended.push(s.src); setTimeout(() => { ctx.maplibregl = {}; s.onload(); }, 0); } }, createElement: () => ({}) },
    appended: [], maplibregl: undefined,
    setTimeout: (f, ms) => setTimeout(f, ms > 50 ? 1 : ms), setInterval: (f) => { const t = setInterval(f, 5); timers.push(t); return t; }, clearInterval,
    window: { addEventListener: (ev, f) => { listeners[ev] = f; }, GMapMode: { isEnabled: () => true, mainMapIsGoogle: () => true, isOpen: () => false } },
    APP_VERSION: '9.9.9', currentMapStyle: 'openfreemap', map: null, styled: 0, inits: 0,
    trafficSignalsEngine: { attachMap(m) { ctx.sigMap = m; } }, trafficEngine: {}, chargersEngine: { attachMap(m) { ctx.chMap = m; } }, routingEngine: { setMapHidden(h) { ctx.hidden = h; } }
  };
  ctx.initMap = () => { ctx.inits++; ctx.map = { id: 'ml' }; ctx.window.__setMainMapPaused = (on) => { ctx.window.__mainMapPaused = on; ctx.realPaused = on; }; ctx.window.__mainMapPaused = false; };
  ctx.applyMapStyle = () => { ctx.styled++; };
  vm.createContext(ctx);
  vm.runInContext(helpers.replace(/\blet (ourMapPromise|startupQuiet)\b/g, 'var $1') + '\nthis.api = { ourMapCanWait, installMainMapPauseStub, ensureOurMap, afterFirstPicture, get quiet() { return startupQuiet; } };', ctx);
  // map is a top-level `let` in app.js; in the cut-out code it is a context global
  const api = ctx.api;

  ok(api.ourMapCanWait() === true, 'Google opens by itself -> our map waits');
  body.cls.delete('gmap-loading');
  ok(api.ourMapCanWait() === false, 'no start logo -> our map is built at once');
  body.cls.add('gmap-loading');

  ctx.window.routingEngine = ctx.routingEngine;
  api.installMainMapPauseStub();
  ctx.window.__setMainMapPaused(true);
  ok(ctx.window.__mainMapPaused === true && ctx.hidden === true, 'the pause switch remembers Google mode and hides the route on our (missing) map');

  // background work waits for the first picture
  let ran = 0;
  api.afterFirstPicture(() => ran++);
  ok(ran === 0 && api.quiet === true, 'while Google loads: background work waits, speed-limit fetches are quiet');
  listeners['gmap:firstpicture']();
  await new Promise((r) => setTimeout(r, 20));
  ok(ran === 1 && api.quiet === false, 'first Google picture -> background work runs once');
  body.cls.delete('gmap-loading');
  await new Promise((r) => setTimeout(r, 20));
  ok(ran === 1, '... and not a second time when the logo goes');
  let now = 0; api.afterFirstPicture(() => now++);
  ok(now === 1, 'no Google map loading -> runs at once');
  body.cls.add('gmap-loading');
  let late = 0; api.afterFirstPicture(() => late++);
  body.cls.delete('gmap-loading');   // Google closed / 20 s limit: no event, the logo just goes
  await new Promise((r) => setTimeout(r, 40));
  ok(late === 1, 'logo gone without a picture event -> background work still runs');

  // ensureOurMap: one script load, one map, engines attached, paused when Google is on top
  const [m1, m2] = await Promise.all([api.ensureOurMap(), api.ensureOurMap()]);
  ok(m1 && m1 === m2 && ctx.inits === 1 && ctx.appended.length === 1 && ctx.appended[0] === 'maplibre-gl.js?v=9.9.9', 'ensureOurMap loads the script once and builds one map');
  ok(ctx.sigMap === m1 && ctx.chMap === m1 && ctx.trafficEngine.map === m1, 'the engines made earlier get the map');
  ok(ctx.styled === 1 && ctx.realPaused === true, 'the style is applied, and the map starts paused under Google');
  ok((await api.ensureOurMap()) === m1 && ctx.inits === 1, 'later calls return the same map');
  timers.forEach(clearInterval);

  // --- engines tolerate a late map ---
  global.window = { showToast() {} };
  global.localStorage = { getItem: () => null, setItem() {} };
  let fetched = 0;
  global.fetch = async () => { fetched++; return { ok: false }; };
  vm.runInThisContext(read('chargers.js'));
  vm.runInThisContext(read('traffic-signals.js'));
  let release = null;
  const ch = new window.ChargersEngine(null, () => {}, false, { later: (fn) => { release = fn; } });
  ok(fetched === 0 && typeof release === 'function', 'chargers: the first download waits for opts.later');
  release();
  ok(fetched === 1, 'chargers: downloads when released');
  const ev = [];
  const fakeMap = { on: (e) => ev.push(e), getBounds: () => null, getZoom: () => 9 };
  ch.attachMap(fakeMap);
  ok(ch.map === fakeMap && ev.includes('moveend'), 'chargers: attachMap wires the map later');
  ch.attachMap(fakeMap);
  ok(ev.filter((e) => e === 'moveend').length === 1, 'chargers: attaching the same map twice wires it once');
  const sig = new window.TrafficSignalsEngine(null, true);
  ok(sig.map === null, 'signals: works without a map');
  ev.length = 0;
  sig.attachMap(fakeMap);
  ok(sig.map === fakeMap && ev.includes('moveend') && ev.includes('styleimagemissing'), 'signals: attachMap wires the map later');
  // timers of the engines must not keep the test alive
  setTimeout(() => process.exit(fails ? 1 : 0), 50);
})().catch((e) => { ok(false, 'lazy map test crashed: ' + (e && e.stack)); process.exit(1); });
