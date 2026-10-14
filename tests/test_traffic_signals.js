// Tile-based traffic-signal engine tests (mocked Overpass + MapLibre map stub, no network).
const fs = require('fs'), vm = require('vm');

let fails = 0;
process.on('exit', () => { if (fails) process.exitCode = 1; });
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };

// ---- stubs ----
const store = {};
global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
global.window = {};
global.maplibregl = undefined;
vm.runInThisContext(fs.readFileSync(__dirname + '/../traffic-signals.js', 'utf8'));
const TSE = window.TrafficSignalsEngine;

// MapLibre-like map stub. NOTE: zoom is the MapLibre zoom (= Leaflet zoom - 1); the engine adds 1 itself.
function mkMap(zoom = 15, b = { s: 41.725, n: 41.735, w: 44.700, e: 44.720 }) {
  const src = { lastData: null, setData(d) { src.lastData = d; src.sets = (src.sets || 0) + 1; } };
  const m = { zoom, b, onCalls: 0, vis: 'visible', src, handlers: {},
    on(ev, fn) { m.onCalls++; m.handlers[ev] = fn; }, getZoom: () => m.zoom,
    getBounds: () => ({ getSouth: () => m.b.s, getNorth: () => m.b.n, getWest: () => m.b.w, getEast: () => m.b.e }),
    getSource: id => (id === 'signals-src' ? src : null),
    getLayer: id => (id === 'signals-layer' ? {} : null),
    setLayoutProperty(id, prop, v) { if (prop === 'visibility') m.vis = v; } };
  return m;
}
const okRes = d => ({ ok: true, json: async () => d });
const node = (id, lat, lon, tags) => ({ type: 'node', id, lat, lon, tags });

function mkEngine(handler, map = mkMap()) {
  for (const k of Object.keys(store)) delete store[k];
  const e = new TSE(map);
  e.calls = []; e.inflight = 0; e.maxInflight = 0;
  e.fetchFn = async (url) => {
    e.calls.push(decodeURIComponent(url));
    e.inflight++; e.maxInflight = Math.max(e.maxInflight, e.inflight);
    await new Promise(r => setTimeout(r, 5));
    e.inflight--;
    return handler(url);
  };
  return e;
}

const A = 41.7300, B = 44.7100;
const M = 1 / 111140, ML = 1 / (111320 * Math.cos(A * Math.PI / 180));

(async () => {
  // ---- 1. query shape: tile bbox, no "out 50" truncation ----
  let e = mkEngine(() => okRes({ elements: [] }));
  await e.requestTile(...e.tileIndex(A, B));
  const q = e.calls[0];
  ok(/node\[highway=traffic_signals\]/.test(q) && /out 500;/.test(q) && !/out 50;/.test(q), 'query asks for traffic_signals nodes with out 500 (old code: out 50)');
  const m = q.match(/\(([\d.]+),([\d.]+),([\d.]+),([\d.]+)\)/);
  ok(m && +m[1] <= A && +m[3] >= A && +m[2] <= B && +m[4] >= B, 'bbox of the request contains the car position');

  // ---- 2. nothing is truncated ----
  const many = []; for (let k = 0; k < 120; k++) many.push(node(k, A + (k % 10) * 0.0004, B + Math.floor(k / 10) * 0.0004, {}));
  e = mkEngine(() => okRes({ elements: many }));
  await e.requestTile(...e.tileIndex(A, B));
  ok(e.signals.length === 120, 'all 120 signals of the tile are kept (old code kept at most 50 per route)');

  // ---- 3. route-aware alerts ----
  const route = [[A - 500 * M, B], [A + 1000 * M, B]];          // straight north along lng=B
  const sigs = [
    node(1, A + 200 * M, B, {}),                                // S1 on the route, 200 m ahead
    node(2, A + 120 * M, B + 60 * ML, {}),                      // S2 cross street 60 m east
    node(3, A - 100 * M, B, {}),                                // S3 behind the car
    node(4, A + 150 * M, B - 45 * ML, {})                       // S4 parallel street 45 m west
  ];
  e = mkEngine(() => okRes({ elements: sigs }));
  await e.ensureAround(A, B, 0);
  let r = e.findUpcomingSignal({ lat: A, lng: B }, 0, route);
  ok(r && Math.abs(r.distanceMeters - 200) < 5, 'on a route: the alert is the signal ON the route (200 m), not the crossing/parallel ones');
  r = e.findUpcomingSignal({ lat: A, lng: B }, 0, null);
  ok(r && r.distanceMeters < 150, 'without a route the old heading-only behaviour remains (picks the closer cross-street signal)');
  r = e.findUpcomingSignal({ lat: A + 400 * M, lng: B }, 0, route);
  ok(r === null, 'signals behind the car never alert');
  r = e.findUpcomingSignal({ lat: A, lng: B + 800 * ML }, 0, route);
  ok(r === null || r.distanceMeters > 0, 'car far from the route line falls back without crashing');

  // ---- 4. cache / LRU / persistence ----
  e = mkEngine(() => okRes({ elements: sigs }));
  await e.requestTile(...e.tileIndex(A, B)); const n1 = e.calls.length;
  await e.requestTile(...e.tileIndex(A, B));
  ok(n1 === 1 && e.calls.length === 1, 'second request for the same tile is served from cache');
  e.savePersisted();
  ok(JSON.parse(store['sig_tiles_v1']) && Object.keys(JSON.parse(store['sig_tiles_v1'])).length === 1, 'tiles are persisted to localStorage');
  const e2 = new TSE(mkMap());   // does NOT clear the store: simulates a browser restart / reverse gear
  e2.fetchFn = async () => { throw new Error('should not be called'); };
  ok(e2.signals.length === 4, 'after a restart the signals are available instantly from storage (no network)');
  e = mkEngine(() => okRes({ elements: [] })); e.maxTiles = 3;
  for (let k = 0; k < 6; k++) await e.requestTile(5000 + k, 3200);
  ok(e.tiles.size === 3, 'tile cache is bounded (LRU)');

  // ---- 5. failures ----
  e = mkEngine(() => { throw new Error('offline'); });
  let threw = false; try { await e.requestTile(...e.tileIndex(A, B)); } catch (x) { threw = true; }
  const c = e.calls.length; await e.requestTile(...e.tileIndex(A, B));
  ok(!threw && e.calls.length === c && e.failUntil > Date.now(), 'Overpass offline: no exception and back-off (no request storm)');
  let n = 0; e = mkEngine(() => { n++; return n === 1 ? { ok: false, status: 429 } : okRes({ elements: sigs }); });
  await e.requestTile(...e.tileIndex(A, B));
  ok(e.tiles.size === 1 && e.calls.length === 2, 'HTTP 429 on the first endpoint -> second endpoint succeeds');

  // ---- 6. route prefetch: nearest first, max 2 in flight ----
  e = mkEngine(() => okRes({ elements: [] }));
  const long = []; for (let k = 0; k <= 120; k++) long.push([A + k * 100 * M, B]);   // 12 km north
  await e.fetchSignalsAlongRoute(long);
  const firstBbox = e.calls[0].match(/\(([\d.]+),/);
  ok(e.tiles.size >= 10 && e.tiles.size <= 14, 'a 12 km route loads ~11-12 tiles (' + e.tiles.size + ')');
  ok(e.maxInflight <= 2, 'never more than 2 Overpass requests in flight (max ' + e.maxInflight + ')');
  ok(firstBbox && +firstBbox[1] <= A, 'tiles are requested starting at the car (nearest first)');
  e = mkEngine(() => okRes({ elements: [] }));
  const huge = []; for (let k = 0; k <= 4000; k++) huge.push([A + k * 100 * M, B]);   // 400 km
  await e.fetchSignalsAlongRoute(huge);
  ok(e.tiles.size <= 40, 'a 400 km route is capped (' + e.tiles.size + ' tiles <= 40)');

  // ---- 7. map layer: culled to the viewport, zoom-gated, toggle keeps the data ----
  const dense = []; for (let k = 0; k < 400; k++) dense.push(node(k, 41.7255 + (k % 20) * 0.00045, 44.7005 + Math.floor(k / 20) * 0.00095, {}));
  const map = mkMap(15);
  e = mkEngine(() => okRes({ elements: dense }), map);
  await e.updateViewport();
  const nDrawn = map.src.lastData ? map.src.lastData.features.length : -1;
  ok(nDrawn > 0 && nDrawn <= 150, 'at most 150 signals are drawn (' + nDrawn + ' of 400)');
  ok(map.src.lastData.features[0].geometry.type === 'Point' && Math.abs(map.src.lastData.features[0].geometry.coordinates[1] - 41.7) < 0.1, 'GeoJSON points are [lon, lat]');
  map.zoom = 12; await e.updateViewport();
  ok(map.src.lastData.features.length === 0, 'Leaflet-equivalent zoom < 15 (MapLibre 13): nothing drawn');
  map.zoom = 15; await e.updateViewport();
  const before = map.src.lastData.features.length;
  const setsBefore = map.src.sets;
  await e.updateViewport();
  ok(map.src.sets === setsBefore, 'unchanged view: the source is not re-uploaded');
  e.toggle();
  ok(map.vis === 'none', 'toggle off hides the layer');
  e.toggle();
  ok(before > 0 && map.vis === 'visible' && e.visibleCount === before, 'toggle on shows it again with the same data');
  ok(map.onCalls >= 1, 'engine subscribes to map events itself');
  map.handlers.moveend(); map.handlers.moveend(); map.handlers.moveend();
  ok(!!e._viewTimer, 'moveend (fires every frame while following) arms ONE throttle timer');
  clearTimeout(e._viewTimer); e._viewTimer = null;
})();
