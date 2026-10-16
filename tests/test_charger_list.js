const assert = require("assert");
const CL = require("../charger-list.js");
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok  " + name); } catch (e) { console.log("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; } }

test("parsePowerKw reads kW from messy strings", () => {
  assert.strictEqual(CL.parsePowerKw("150 kW"), 150);
  assert.strictEqual(CL.parsePowerKw("22kW AC"), 22);
  assert.strictEqual(CL.parsePowerKw("7,4 kW"), 7.4);
  assert.strictEqual(CL.parsePowerKw(null), 0);
  assert.strictEqual(CL.parsePowerKw("fast"), 0);
});

test("haversine: Freedom Square to Rustaveli metro ~ 0.9 km and symmetric", () => {
  const d = CL.haversineKm(41.7100, 44.7930, 41.7166, 44.7833);
  assert.ok(d > 0.8 && d < 1.2, "d=" + d);
  assert.ok(Math.abs(d - CL.haversineKm(41.7166, 44.7833, 41.7100, 44.7930)) < 1e-9);
});

const pos = { lat: 41.7166, lng: 44.7833 };
const S = [
  { name: "far", lat: 41.80, lon: 44.90, power: "150 kW" },
  { name: "near-ac", lat: 41.7170, lon: 44.7840, power: "22 kW" },
  { name: "mid-dc", lat: 41.7300, lon: 44.7900, power: "50 kW" },
  { name: "bad", lat: NaN, lon: 44.7, power: "50 kW" },
];

test("buildList sorts nearest first and skips invalid coordinates", () => {
  const r = CL.buildList(S, pos);
  assert.deepStrictEqual(r.map((x) => x.st.name), ["near-ac", "mid-dc", "far"]);
});

test("fastOnly keeps >= 50 kW only", () => {
  const r = CL.buildList(S, pos, { fastOnly: true });
  assert.deepStrictEqual(r.map((x) => x.st.name), ["mid-dc", "far"]);
});

test("buildList caps the number of rows", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ name: "s" + i, lat: 41.7 + i * 1e-4, lon: 44.78, power: "50 kW" }));
  assert.strictEqual(CL.buildList(many, pos).length, CL.MAX_ROWS);
  assert.strictEqual(CL.buildList(many, pos, { max: 5 }).length, 5);
});

test("formatDistance: metres under 1 km, one decimal under 10 km", () => {
  assert.strictEqual(CL.formatDistance(0.43), "400 მ");
  assert.strictEqual(CL.formatDistance(2.46), "2.5 კმ");
  assert.strictEqual(CL.formatDistance(37.2), "37 კმ");
});

console.log("\n" + passed + " charger list tests passed" + (process.exitCode ? " - WITH FAILURES" : ""));
