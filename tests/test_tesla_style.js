const assert = require("assert");
const T = require("../tesla-style.js");
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok  " + name); } catch (e) { console.log("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; } }

const src = {
  version: 8, sources: { openmaptiles: {} },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#f8f4f0" } },
    { id: "water", type: "fill", source: "openmaptiles", "source-layer": "water", paint: { "fill-color": "#aaf" } },
    { id: "park", type: "fill", source: "openmaptiles", "source-layer": "park", paint: { "fill-color": "#afa", "fill-pattern": "x" } },
    { id: "building", type: "fill", source: "openmaptiles", "source-layer": "building", paint: { "fill-color": "#ccc", "fill-outline-color": "#000" } },
    { id: "building-3d", type: "fill-extrusion", source: "openmaptiles", "source-layer": "building", paint: {} },
    { id: "road_motorway_casing", type: "line", source: "openmaptiles", "source-layer": "transportation", paint: { "line-color": "#f00", "line-width": 8 } },
    { id: "road_motorway", type: "line", source: "openmaptiles", "source-layer": "transportation", paint: { "line-color": "#f00", "line-width": 6 } },
    { id: "road_secondary", type: "line", source: "openmaptiles", "source-layer": "transportation", paint: { "line-color": "#f00" } },
    { id: "road_minor", type: "line", source: "openmaptiles", "source-layer": "transportation", paint: { "line-color": "#f00" } },
    { id: "railway", type: "line", source: "openmaptiles", "source-layer": "transportation", paint: { "line-color": "#f00" } },
    { id: "boundary_state", type: "line", source: "openmaptiles", "source-layer": "boundary", paint: {} },
    { id: "label_city", type: "symbol", source: "openmaptiles", "source-layer": "place", layout: { "text-field": "{name}" }, paint: { "text-color": "#000" } },
  ]
};
const by = (s, id) => s.layers.find((l) => l.id === id);

test("day palette: roads white, casing grey, water bluish, flat buildings, no boundaries", () => {
  const s = T.apply(src, false);
  assert.strictEqual(by(s, "road_motorway").paint["line-color"], T.PALETTE.day.hwy);
  assert.strictEqual(by(s, "road_motorway_casing").paint["line-color"], T.PALETTE.day.casing);
  assert.strictEqual(by(s, "water").paint["fill-color"], T.PALETTE.day.water);
  assert.strictEqual(by(s, "building").paint["fill-color"], T.PALETTE.day.building);
  assert.strictEqual(by(s, "building-3d").layout.visibility, "none");
  assert.strictEqual(by(s, "boundary_state").layout.visibility, "none");
  assert.strictEqual(by(s, "background").paint["background-color"], T.PALETTE.day.land);
});

test("night palette is dark (native, no CSS filter) and labels get a matching halo", () => {
  const s = T.apply(src, true);
  assert.strictEqual(by(s, "background").paint["background-color"], T.PALETTE.night.land);
  assert.strictEqual(by(s, "label_city").paint["text-halo-color"], T.PALETTE.night.halo);
  assert.strictEqual(by(s, "road_minor").paint["line-color"], T.PALETTE.night.minor);
});

test("widths, fill-pattern and outline handling; input style is not mutated", () => {
  const before = JSON.stringify(src);
  const s = T.apply(src, false);
  assert.strictEqual(by(s, "road_motorway").paint["line-width"], 6);
  assert.ok(!("fill-pattern" in by(s, "park").paint));
  assert.ok(!("fill-outline-color" in by(s, "building").paint));
  assert.strictEqual(JSON.stringify(src), before);
});

test("roadClass", () => {
  assert.strictEqual(T.roadClass("road_trunk_casing"), "casing");
  assert.strictEqual(T.roadClass("highway-primary"), "hwy");
  assert.strictEqual(T.roadClass("road_secondary_tertiary"), "major");
  assert.strictEqual(T.roadClass("road_path_pedestrian"), "path");
  assert.strictEqual(T.roadClass("road_service"), "minor");
});

test("diff: day->night changes only paint colors, same layer ids, and back again is the inverse", () => {
  const base = { version: 8, layers: [
    { id: "bg", type: "background", paint: { "background-color": "#fff" } },
    { id: "road_minor", type: "line", "source-layer": "transportation", paint: { "line-color": "#000" } },
    { id: "poi", type: "symbol", "source-layer": "poi", layout: {}, paint: {} }
  ] };
  const d = T.diff(base, false, true);
  assert.ok(d.length > 0);
  assert.ok(d.every((c) => ["bg", "road_minor", "poi"].includes(c.id)));
  assert.ok(d.find((c) => c.id === "bg" && c.prop === "background-color" && c.value === T.PALETTE.night.land));
  assert.strictEqual(T.diff(base, true, true).length, 0);
  const back = T.diff(base, true, false);
  assert.ok(back.find((c) => c.id === "bg" && c.value === T.PALETTE.day.land));
});

console.log("\n" + passed + " tesla style tests passed" + (process.exitCode ? " - WITH FAILURES" : ""));
