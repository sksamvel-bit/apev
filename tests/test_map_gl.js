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

test("pause() stops all frames (Google mode covers the map) and resume() continues from the latest fix", () => {
  const { cam, calls, step, queue } = makeCam();
  cam.setFix({ lng: 44.79, lat: 41.69, headingDeg: 0, speedMs: 10 });
  step(33);
  cam.pause();
  queue.length = 0;                                // the fake caf does not drop queued frames
  const before = calls.length;
  cam.setFix({ lng: 44.80, lat: 41.70, headingDeg: 0, speedMs: 10 });
  cam.setFollowing(true); cam.setMode("north-up");
  assert.strictEqual(queue.length, 0, "no frame scheduled while paused");
  assert.strictEqual(calls.length, before, "no jumpTo while paused");
  cam.resume();
  assert.strictEqual(queue.length, 1, "resume schedules a frame");
  step(33);
  const last = calls[calls.length - 1].cam.center;
  near(last[0], 44.80, 1e-6, "jumps to the fix that arrived while paused");
});

test("GPU camera (?cam=gpu, v3.10.78): few real draws, the compositor turns and moves the picture in between", () => {
  const jumps = [];
  const el = { style: { transform: "", transformOrigin: "" } };
  // a flat map: 1 px = 1e-5 deg, centre of the container at (500, 400)
  const fake = { c: [44.8, 41.7], b: 0, getPitch: () => 0, getBearing() { return this.b; },
    jumpTo(cam) { jumps.push(cam); this.c = cam.center; if (cam.bearing != null) this.b = cam.bearing; },
    project(ll) { return { x: 500 + (ll[0] - this.c[0]) / 1e-5, y: 400 - (ll[1] - this.c[1]) / 1e-5 }; } };
  const cam = new FollowCamera(fake, { gpu: { el, renderEveryMs: 250, maxAngle: 12 }, raf: () => 1, caf() {}, now: () => 0 });
  const camAt = (lng, bearing) => ({ center: [lng, 41.7], bearing, padding: { top: 100 } });
  assert.strictEqual(cam.gpuStep(0, camAt(44.8, 0)), true); assert.strictEqual(jumps.length, 1, "first frame: a real draw");
  cam.gpuStep(100, camAt(44.80005, 5));
  assert.strictEqual(jumps.length, 1, "100 ms later and 5 deg turned: no draw");
  assert.ok(/rotate\(-5\.00deg\) translate\(-5\.0px,0\.0px\)/.test(el.style.transform), "the picture is turned back 5 deg and moved 5 px: " + el.style.transform);
  assert.strictEqual(el.style.transformOrigin, "500.0px 400.0px", "turned around the car");
  cam.gpuStep(150, camAt(44.80005, 20));
  assert.strictEqual(jumps.length, 2, "turned more than 12 deg: drawn again (labels upright)");
  assert.strictEqual(el.style.transform, "", "a fresh draw needs no transform");
  cam.gpuStep(420, camAt(44.8001, 21));
  assert.strictEqual(jumps.length, 3, "250 ms since the last draw: drawn again");
  fake.getPitch = () => 30;
  assert.strictEqual(cam.gpuStep(430, camAt(44.8001, 21)), false, "a tilted map is not handled (CSS cannot turn a 3D view)");
  fake.getPitch = () => 0;
  cam.gpuStep(440, camAt(44.80012, 22)); cam.setFollowing(false);
  assert.strictEqual(el.style.transform, "", "the driver takes the map: transform cleared");
  assert.strictEqual(new FollowCamera(fake, {}).gpuStep(0, camAt(44.8, 0)), false, "without ?cam=gpu nothing changes");
});

test("lightStyle (?map=lite, v3.10.76): keeps what a driver needs, drops the heavy layers", () => {
  const ids = ["background", "natural_earth", "park", "park_outline", "landuse_residential", "landcover_wood", "water", "waterway_river",
    "road_minor_casing", "road_minor", "road_trunk_primary_casing", "road_trunk_primary", "road_motorway", "bridge_street", "tunnel_minor",
    "road_major_rail", "building", "building-3d", "poi_r1", "poi_r20", "highway-name-minor", "highway-name-major", "highway-shield-non-us",
    "label_city", "label_country_1", "road_one_way_arrow", "housenumber", "aeroway_runway", "boundary_2", "water_name_line_label"];
  const style = { version: 8, sources: { openmaptiles: {} }, glyphs: "g", sprite: "s", layers: ids.map((id) => ({ id })) };
  const kept = MapGL.lightStyle(style).layers.map((l) => l.id);
  for (const k of ["background", "park", "landcover_wood", "water", "waterway_river", "road_minor", "road_trunk_primary_casing", "road_trunk_primary",
    "road_motorway", "bridge_street", "tunnel_minor", "highway-name-minor", "highway-name-major", "label_city", "road_one_way_arrow", "housenumber"]) {
    assert.ok(kept.includes(k), "keeps " + k);
  }
  for (const d of ["natural_earth", "park_outline", "landuse_residential", "road_minor_casing", "road_major_rail", "building", "building-3d",
    "poi_r1", "poi_r20", "highway-shield-non-us", "label_country_1", "aeroway_runway", "boundary_2", "water_name_line_label"]) {
    assert.ok(!kept.includes(d), "drops " + d);
  }
  const out = MapGL.lightStyle(style);
  assert.strictEqual(out.glyphs, "g"); assert.strictEqual(out.sprite, "s"); assert.strictEqual(style.layers.length, ids.length, "the original style is not changed");
});

console.log("\n" + passed + " tests passed" + (process.exitCode ? " - WITH FAILURES" : ""));
test("debug HUD stays cheap and the bench records long tasks (v3.10.82)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "app.js"), "utf8");
  const s = src.indexOf("(function setupDebugHud() {");
  const hud = src.slice(s, src.indexOf("\n})();", s));
  assert.ok(s > 0 && hud.length > 1000, "HUD found");
  assert.ok(!/getStyle\(\)/.test(hud), "HUD never copies the whole style");
  assert.ok(/__benchActive/.test(hud), "HUD pauses during the bench");
  assert.ok(/PerformanceObserver/.test(src) && /type: "longtask"/.test(src), "long tasks are observed");
  assert.ok(/tile\.openstreetmap\.org/.test(src) && src.includes('if (MAP_RASTER && styleKey === "openfreemap")') && hud.includes('q: "map=raster"'), "?map=raster: OSM picture tiles, measured in the full test (v3.10.84)");
  assert.ok(hud.includes('q: "map=lite&labels=points"') && hud.includes('q: "map=lite&labels=major"') && src.includes('/^line/.test(String(l.layout["symbol-placement"]'), "street-name variants hide only the labels along the roads (v3.10.85)");
  assert.ok(/res\.longPct/.test(hud) && /res\.gpsMsPerS/.test(hud), "bench stores long-task % and GPS cost");
});

test("phone pairing code survives a browser restart for 30 days (v3.10.86)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "app.js"), "utf8");
  const s = src.indexOf("function getOrGenerateSessionCode()");
  const fn = src.slice(s, src.indexOf("\n}", s));
  assert.ok(fn.includes("localStorage.getItem(REMOTE_CODE_KEY") && fn.includes("localStorage.setItem(REMOTE_CODE_KEY") && !fn.includes("sessionStorage"), "kept in localStorage");
  assert.ok(/const REMOTE_CODE_DAYS = 30;/.test(src) && fn.includes("REMOTE_CODE_DAYS * 864e5"), "renewed after 30 days");
  assert.ok(fn.includes("getRandomValues"), "still a 64-bit random code");
});

test("our map is the picture (raster) map by default, vector only on request (v3.10.87)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "app.js"), "utf8");
  assert.ok(src.includes('return m !== "vector" && m !== "lite";'), "raster unless ?map=vector / ?map=lite");
  assert.ok(src.includes('paint: rasterPaint(!!window.__night)') && src.includes('map.setPaintProperty("osm-raster-layer", k, v)'), "night is a raster paint change");
  assert.ok(src.includes('"© Esri © OpenStreetMap" : "© OpenStreetMap";'), "OSM credit is shown");
  const css = require("fs").readFileSync(require("path").join(__dirname, "..", "style.css"), "utf8");
  assert.ok(css.includes(".map-raster.map-style-openfreemap.night-mode-active .maplibregl-canvas { filter: none; }"), "no per-frame CSS night filter on the picture map");
});

test("label-free base: CARTO only with a key (it shows API KEY REQUIRED without), Esri otherwise (v3.10.90)", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "app.js"), "utf8");
  assert.ok(src.includes('carto("rastertiles/voyager_nolabels")') && src.includes('carto("rastertiles/dark_nolabels")') && src.includes("@2x.png?key=${encodeURIComponent(key)}"), "CARTO tiles always carry the key");
  assert.ok(src.includes('sources: key ? {') && src.includes('esri("World_Light_Gray_Base")') && src.includes('esri("World_Dark_Gray_Base")'), "no key: Esri gray canvas");
  assert.ok(src.includes('fetch("/api/tiles-config"') && !src.includes('tiles=carto"'), "key from the server, ?tiles=carto gone");
  assert.ok(src.includes('map.setLayoutProperty("carto-night-layer", "visibility", enable ? "visible" : "none")'), "night switches the visible layer");
  const srv = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes("pathname === '/api/tiles-config'") && srv.includes("process.env.CARTO_BASEMAPS_KEY"), "server hands out the key from the env, never from the repo");
});

test("upright street names: one label per street piece, big roads first, no repeats nearby (v3.10.89)", () => {
  const c = { lat: 41.7151, lng: 44.8271 };
  const line = (dLat0, dLng0, dLat1, dLng1) => [[c.lat + dLat0, c.lng + dLng0], [c.lat + dLat1, c.lng + dLng1]];
  const ways = [
    { name: "რუსთაველის გამზირი", highway: "primary", pts: line(0, -0.003, 0, 0.003) },
    { name: "რუსთაველის გამზირი", highway: "primary", pts: line(0.0005, -0.003, 0.0005, 0.003) },   // same name 55 m away: dropped
    { name: "პატარა ქუჩა", highway: "residential", pts: line(0.002, 0, 0.0021, 0) },               // ~11 m long: dropped
    { name: "ჭავჭავაძის გამზირი", highway: "secondary", pts: line(-0.004, -0.002, -0.004, 0.002) },
    { name: "", highway: "primary", pts: line(0.001, 0, 0.002, 0) },                               // no name
    { name: "შორეული ქუჩა", highway: "residential", pts: line(0.05, 0, 0.051, 0) }                 // 5 km away
  ];
  const fc = MapGL.streetLabelFeatures(ways, c);
  const names = fc.features.map((f) => f.properties.name);
  assert.deepStrictEqual(names, ["რუსთაველის გამზირი", "ჭავჭავაძის გამზირი"]);
  assert.strictEqual(fc.features[0].properties.rank, 4);
  near(fc.features[0].geometry.coordinates[0], c.lng, 1e-5, "label sits in the middle of the street");
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "app.js"), "utf8");
  assert.ok(src.includes('"text-rotation-alignment": "viewport"') && src.includes('"rastertiles/voyager_nolabels"') && src.includes('q: "labels=upright"'), "upright, over label-free tiles, in the full test");
});

