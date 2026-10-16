/* Unit tests for map-gl.js (MapUtil, LayerRegistry, FollowCamera). Run: node tests/test_map_gl.js */
const assert = require("assert");
const { shortestDelta, normDeg, advance, MapUtil, LayerRegistry, FollowCamera } = require("../map-gl.js");
const MapGL = require("../map-gl.js");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { console.error("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; }
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, (msg || "") + ` expected ${b} +-${eps}, got ${a}`);

// ----------------------------------------------------------------- helpers
test("shortestDelta takes the short way round 0/360", () => {
  assert.strictEqual(shortestDelta(10, 350), 20);
  assert.strictEqual(shortestDelta(350, 10), -20);
  assert.strictEqual(shortestDelta(180, 0), 180);
  near(shortestDelta(0, 359), 1, 1e-9);
  near(shortestDelta(725, 5), 0, 1e-9);
});

test("normDeg wraps into [0,360)", () => {
  assert.strictEqual(normDeg(-10), 350);
  assert.strictEqual(normDeg(370), 10);
  assert.strictEqual(normDeg(0), 0);
});

test("advance moves along the heading", () => {
  const n = advance(44.79, 41.69, 0, 100);
  near(n.lat - 41.69, 100 / 110540, 1e-9); near(n.lng, 44.79, 1e-9);
  const e = advance(44.79, 41.69, 90, 100);
  near(e.lng - 44.79, 100 / (111320 * Math.cos(41.69 * Math.PI / 180)), 1e-9); near(e.lat, 41.69, 1e-9);
});

// ----------------------------------------------------------------- MapUtil
function fakeBoundsMap(s, n, w, e, zoom) {
  return { getZoom: () => zoom, getBounds: () => ({ getSouth: () => s, getNorth: () => n, getWest: () => w, getEast: () => e }) };
}

test("leafletZoom is MapLibre zoom + 1", () => {
  assert.strictEqual(MapUtil.leafletZoom(fakeBoundsMap(0, 1, 0, 1, 14)), 15);
});

test("viewBounds.contains accepts [lat, lon] and {lat, lng}, pad widens", () => {
  const m = fakeBoundsMap(41.0, 42.0, 44.0, 45.0, 15);
  const b = MapUtil.viewBounds(m, 0);
  assert.ok(b.contains([41.5, 44.5]));
  assert.ok(b.contains({ lat: 41.5, lng: 44.5 }));
  assert.ok(!b.contains([42.05, 44.5]));
  const p = MapUtil.viewBounds(m, 0.1);
  assert.ok(p.contains([42.05, 44.5]));
  near(p.getNorth(), 42.1, 1e-9);
});

// ----------------------------------------------------------- LayerRegistry
test("LayerRegistry injects layers below the first symbol layer and never duplicates", () => {
  const reg = new LayerRegistry();
  let data = { type: "FeatureCollection", features: [] };
  reg.register("route", {
    where: "labels",
    sources: () => ({ "route-source": { type: "geojson", data } }),
    layers: () => [{ id: "route-line", type: "line", source: "route-source" }]
  });
  reg.register("sig", {
    sources: () => ({ "sig-src": { type: "geojson", data: { type: "FeatureCollection", features: [] } } }),
    layers: () => [{ id: "sig-layer", type: "symbol", source: "sig-src" }]
  });
  const style = { version: 8, sources: { a: {} }, layers: [{ id: "bg", type: "background" }, { id: "roads", type: "line" }, { id: "names", type: "symbol" }] };
  const out = reg.inject(style);
  assert.deepStrictEqual(out.layers.map(l => l.id), ["bg", "roads", "route-line", "names", "sig-layer"]);
  assert.ok(out.sources["route-source"] && out.sources["sig-src"] && out.sources.a);
  assert.strictEqual(style.layers.length, 3, "input style is not mutated");
  // injecting again into an already injected style must not duplicate
  assert.strictEqual(reg.inject(out).layers.length, out.layers.length);
  // current data is handed out on every call (route survives a style switch)
  data = { type: "Feature", geometry: { type: "LineString", coordinates: [[1, 2], [3, 4]] } };
  assert.strictEqual(reg.inject(style).sources["route-source"].data, data);
});

test("LayerRegistry with no symbol layer appends 'labels' layers at the end", () => {
  const reg = new LayerRegistry();
  reg.register("r", { where: "labels", layers: () => [{ id: "x", type: "line" }] });
  const out = reg.inject({ version: 8, sources: {}, layers: [{ id: "bg", type: "background" }] });
  assert.deepStrictEqual(out.layers.map(l => l.id), ["bg", "x"]);
});

// ------------------------------------------------------------- FollowCamera
function makeCam(opts = {}) {
  const calls = [];
  const map = {
    bearing: 0, pitch: 0,
    getBearing() { return this.bearing; }, getPitch() { return this.pitch; },
    getContainer: () => ({ clientHeight: 1000 }),
    jumpTo(cam, ev) {
      if (cam.bearing != null) this.bearing = cam.bearing;
      if (cam.pitch != null) this.pitch = cam.pitch;
      calls.push({ cam, ev });
    },
    setPadding() {}
  };
  let clock = 1000;
  const queue = [];
  const cam = new FollowCamera(map, Object.assign({
    now: () => clock,
    raf: (fn) => { queue.push(fn); return queue.length; },
    caf: () => {},
    minFrameMs: 0
  }, opts));
  const step = (ms) => { clock += ms; const fn = queue.shift(); if (fn) fn(clock); return !!fn; };
  return { cam, map, calls, step, queue, setClock: (t) => { clock = t; } };
}

test("bearing crosses north the short way (350 -> 10 never swings through 180)", () => {
  const { cam, step } = makeCam({ bearingSlowTauMs: 150 });
  cam.setFix({ lng: 44.79, lat: 41.69, headingDeg: 350, speedMs: 0 });
  step(33);                                        // first frame snaps to 350
  cam.setFix({ lng: 44.79, lat: 41.69, headingDeg: 10, speedMs: 0 });
  const seen = [];
  for (let i = 0; i < 40; i++) { step(33); seen.push(cam.bearing); }
  for (const b of seen) assert.ok(b >= 349.9 || b <= 10.1, "bearing " + b + " left the 350..10 arc");
  near(cam.bearing, 10, 0.5, "converges to the new heading");
});

test("turn is followed quickly while driving, slowly (jitter filter) while standing", () => {
  const turn = (speedMs) => {
    const { cam, step } = makeCam();
    cam.setFix({ lng: 44.79, lat: 41.69, headingDeg: 0, speedMs });
    step(33);
    cam.setFix({ lng: 44.79, lat: 41.69, headingDeg: 90, speedMs });
    for (let i = 0; i < 15; i++) step(33);   // ~0.5 s
    return cam.bearing;
  };
  const driving = turn(12), standing = turn(0);
  assert.ok(driving > 55, "driving: most of a 90 deg turn done within 0.5 s (" + driving.toFixed(1) + ")");
  assert.ok(standing < 45, "standing: GPS heading noise is damped (" + standing.toFixed(1) + ")");
});

test("dead reckoning glides forward between 1 Hz fixes and is capped at extrapMaxMs", () => {
  const { cam, step } = makeCam({ posTauMs: 1 });
  cam.setFix({ lng: 44.79, lat: 41.69, headingDeg: 90, speedMs: 20 });
  step(33);
  step(500);
  const after500 = cam.pos.lng;
  assert.ok(after500 > 44.79, "moved east");
  const m500 = (after500 - 44.79) * 111320 * Math.cos(41.69 * Math.PI / 180);
  near(m500, 20 * 0.5, 1.5, "about 10 m after 0.5 s");
  step(5000);
  const m = (cam.pos.lng - 44.79) * 111320 * Math.cos(41.69 * Math.PI / 180);
  near(m, 20 * 1.5, 1.5, "capped at 1.5 s of extrapolation (30 m)");
});

test("standing still: no extrapolation and the loop goes to sleep", () => {
  const { cam, step, queue } = makeCam({ idleFramesToSleep: 5, pitchTauMs: 1, padTauMs: 1, bearingTauMs: 1, bearingSlowTauMs: 1 });
  cam.setFix({ lng: 44.79, lat: 41.69, headingDeg: 0, speedMs: 0 });
  let frames = 0;
  while (step(33) && frames < 100) frames++;
  assert.ok(frames < 100 && queue.length === 0, "raf chain stopped after idle frames (" + frames + ")");
  cam.setFix({ lng: 44.7901, lat: 41.69, headingDeg: 0, speedMs: 0 });   // new fix wakes it again
  assert.ok(queue.length === 1);
});

test("heading-up applies pitch 45 and top padding; north-up goes to pitch 0 / bearing 0", () => {
  const { cam, calls, step } = makeCam({ pitchTauMs: 1, padTauMs: 1, bearingSlowTauMs: 1, padTopFraction: 0.3 });
  cam.setFix({ lng: 44.79, lat: 41.69, headingDeg: 90, speedMs: 0 });
  for (let i = 0; i < 60; i++) step(33);
  const last = calls[calls.length - 1].cam;
  near(last.pitch, 45, 0.5);
  near(last.padding.top, 300, 2);
  near(last.bearing, 90, 0.5);
  cam.setMode("north-up");
  for (let i = 0; i < 80; i++) step(33);
  const n = calls[calls.length - 1].cam;
  near(n.bearing, 0, 1); near(n.pitch, 0, 0.5);
  assert.deepStrictEqual(calls[0].ev, { followCamera: true });
});

test("not following: map is never moved, but the car position still glides (onFrame)", () => {
  const frames = [];
  const { cam, calls, step } = makeCam({ onFrame: (f) => frames.push(f) });
  cam.setFollowing(false);
  cam.setFix({ lng: 44.79, lat: 41.69, headingDeg: 0, speedMs: 15 });
  for (let i = 0; i < 10; i++) step(33);
  assert.strictEqual(calls.length, 0);
  assert.ok(frames.length >= 10);
  assert.ok(frames[frames.length - 1].lat > frames[0].lat, "car keeps moving north");
});

test("manual mode keeps the driver's bearing and pitch", () => {
  const { cam, map, calls, step } = makeCam();
  map.bearing = 123; map.pitch = 20;
  cam.setMode("manual");
  cam.setFix({ lng: 44.79, lat: 41.69, headingDeg: 5, speedMs: 10 });
  for (let i = 0; i < 20; i++) step(33);
  assert.ok(calls.length > 0);
  for (const c of calls) { assert.strictEqual(c.cam.bearing, undefined); assert.strictEqual(c.cam.pitch, undefined); }
  assert.strictEqual(map.bearing, 123);
});

test("recenter immediately positions the camera on the vehicle", () => {
  const { cam, map, calls } = makeCam();
  cam.setFollowing(false);
  assert.strictEqual(cam.following, false);
  cam.recenter({ lng: 44.80, lat: 41.70 }, 60, 45);
  assert.strictEqual(cam.following, true);
  near(cam.pos.lng, 44.80, 1e-6);
  near(cam.pos.lat, 41.70, 1e-6);
  near(cam.bearing, 60, 1e-6);
  near(cam.pitch, 45, 1e-6);
  assert.ok(calls.length > 0, "map camera move was called");
  const last = calls[calls.length - 1].cam;
  near(last.center[0], 44.80, 1e-6);
  near(last.center[1], 41.70, 1e-6);
});

test("a far jump (GPS just locked) snaps instead of crawling", () => {
  const { cam, step } = makeCam();
  cam.setFix({ lng: 44.70, lat: 41.60, headingDeg: 0, speedMs: 0 });
  step(33);
  cam.setFix({ lng: 44.79, lat: 41.69, headingDeg: 0, speedMs: 0 });
  step(33);
  near(cam.pos.lng, 44.79, 1e-6);
});

test("low fps (500 ms frames) still converges on the dead-reckoned target: no lag from a dt cap", () => {
  const { cam, step } = makeCam({ posTauMs: 220 });
  cam.setFix({ lng: 44.79, lat: 41.69, headingDeg: 90, speedMs: 15 });
  step(33);
  for (let i = 0; i < 3; i++) step(500);
  const tgt = 44.79 + (15 * 1.5) / (111320 * Math.cos(41.69 * Math.PI / 180));
  const lagM = (tgt - cam.pos.lng) * 111320 * Math.cos(41.69 * Math.PI / 180);
  assert.ok(lagM < 3, "lag " + lagM.toFixed(2) + " m should be < 3 m");
});

const sym = (id, sl) => ({ id, type: "symbol", source: "openmaptiles", "source-layer": sl });
test("Lite hides POI/house numbers/minor road names/shields but keeps places and major road names", () => {
  const layers = [sym("poi_r20", "poi"), sym("housenumber", "housenumber"), sym("highway-name-minor", "transportation_name"),
    sym("highway-name-path", "transportation_name"), sym("highway-shield-us", "transportation_name"), sym("water_name_point_label", "water_name"),
    sym("highway-name-major", "transportation_name"), sym("label_city", "place"), sym("label_other", "place"),
    { id: "road", type: "line", source: "openmaptiles", "source-layer": "transportation" }];
  const h = MapGL.pickLiteHidden(layers, "openmaptiles");
  for (const id of ["poi_r20", "housenumber", "highway-name-minor", "highway-name-path", "highway-shield-us", "water_name_point_label", "label_other"]) assert.ok(h.includes(id), id + " should be hidden");
  for (const id of ["highway-name-major", "label_city", "road"]) assert.ok(!h.includes(id), id + " should stay");
});

test("Lite ignores layers from other sources", () => {
  assert.deepStrictEqual(MapGL.pickLiteHidden([{ id: "x", type: "symbol", source: "route", "source-layer": "poi" }], "openmaptiles"), []);
});

test("Lite detail set = house numbers + minor street names only (not POI, shields, arrows)", () => {
  const L = [sym("poi_r20", "poi"), sym("housenumber", "housenumber"), sym("highway-name-minor", "transportation_name"),
    sym("highway-shield-us", "transportation_name"), sym("highway-name-major", "transportation_name")];
  assert.deepStrictEqual(MapGL.pickLiteDetail(L, "openmaptiles").sort(), ["highway-name-minor", "housenumber"]);
});

test("LiteGovernor fires after 5 consecutive slow moving samples, not when parked or briefly slow", () => {
  const g = new MapGL.LiteGovernor({ minFps: 6, need: 5 });
  for (let i = 0; i < 10; i++) assert.strictEqual(g.sample(2, false), false);
  for (let i = 0; i < 4; i++) assert.strictEqual(g.sample(2, true), false);
  assert.strictEqual(g.sample(15, true), false);   // recovered: counter resets
  for (let i = 0; i < 4; i++) assert.strictEqual(g.sample(2, true), false);
  assert.strictEqual(g.sample(2, true), true);
  assert.strictEqual(g.sample(2, true), false);    // fires once
});

console.log("\n" + passed + " tests passed" + (process.exitCode ? " - WITH FAILURES" : ""));
