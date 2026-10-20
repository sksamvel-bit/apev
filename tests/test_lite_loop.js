/* Lite mode must not redraw the main map in a loop while the car stands (v3.10.47).
 * Runs app.js's real Lite block against a fake MapLibre map that behaves like the real one: setLayoutProperty is a no-op for
 * an unchanged value, and any change fires "styledata" on the next frame. Run: node tests/test_lite_loop.js */
const fs = require('fs'), vm = require('vm');
let fails = 0; process.on('exit', () => { if (fails) process.exitCode = 1; });
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };

const app = fs.readFileSync(__dirname + '/../app.js', 'utf8');
const start = app.indexOf('  const liteHidden = new Set();');
const endMark = 'map.on("styledata", () => { applyLite();';
const end = app.indexOf('\n', app.indexOf(endMark));
ok(start > -1 && end > start, 'found the Lite block in app.js');
const block = app.slice(start, end);

function run() {
  const layers = [
    { id: 'road_minor_label', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name', layout: { visibility: 'visible' } },
    { id: 'poi_label', type: 'symbol', source: 'openmaptiles', 'source-layer': 'poi', layout: { visibility: 'visible' } },
    { id: 'place_city', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', layout: { visibility: 'visible' } }
  ];
  const handlers = [];
  let dirty = false, styledataEvents = 0, changes = 0;
  const map = {
    getStyle: () => ({ layers }),
    getLayer: (id) => layers.find((l) => l.id === id),
    getLayoutProperty: (id, p) => (layers.find((l) => l.id === id).layout || {})[p],
    setLayoutProperty(id, p, v) {
      const l = layers.find((x) => x.id === id);
      if (l.layout[p] === v) return;          // MapLibre: unchanged value = no-op
      l.layout[p] = v; dirty = true; changes++;
    },
    on: (ev, fn) => { if (ev === 'styledata') handlers.push(fn); }
  };
  const timers = [];
  const ctx = {
    map, PERF: { lite: true }, currentSpeedKmh: 0, hnOn: null, Date, Set, sessionStorage: { setItem() {} },
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    window: { MapGL: require('../map-gl.js') }
  };
  vm.createContext(ctx);
  vm.runInContext(block + '\napplyLite();', ctx);
  // a "frame": if the style changed, MapLibre fires styledata once
  const frame = () => { if (dirty) { dirty = false; styledataEvents++; handlers.forEach((h) => h()); } };
  for (let i = 0; i < 5; i++) frame();
  const t0 = Date.now; let fake = 1e12; Date.now = () => fake;
  try {
    // the car stands: the 500 ms watcher switches the minor street names on after 2 s
    for (let i = 0; i < 6; i++) { fake += 500; timers.forEach((f) => f()); frame(); }
    const shown = map.getLayoutProperty('road_minor_label', 'visibility');
    const before = styledataEvents;
    for (let i = 0; i < 60; i++) frame();       // one second of frames while standing
    return { shown, loopEvents: styledataEvents - before, poi: map.getLayoutProperty('poi_label', 'visibility') };
  } finally { Date.now = t0; }
}

const r = run();
ok(r.shown === 'visible', 'standing: the minor street names are shown (setDetail)');
ok(r.poi === 'none', 'Lite still hides the other minor layers (POI)');
ok(r.loopEvents === 0, 'standing: no styledata loop, the map is not redrawn every frame (' + r.loopEvents + ' extra styledata events in 60 frames)');
