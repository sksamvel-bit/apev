const assert = require("assert");
const S = require("../search.js");
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok  " + name); } catch (e) { console.log("FAIL  " + name + "\n      " + e.message); process.exitCode = 1; } }

test("matches: every query word is a prefix of some word", () => {
  assert.ok(S.matches("tbi rus", "Tbilisi, Rustaveli Avenue"));
  assert.ok(S.matches("რუსთ", "რუსთაველის გამზირი"));
  assert.ok(!S.matches("rustaveli xyz", "Rustaveli Avenue"));
  assert.ok(!S.matches("", "anything"));
});

const pos = { lat: 41.7166, lng: 44.7833 };
const items = [
  { title: "Tegeta Motors Charger", subtitle: "Tbilisi", lat: 41.80, lon: 44.90, kind: "charger" },
  { title: "Tegeta Near", subtitle: "Tbilisi", lat: 41.72, lon: 44.79, kind: "charger" },
  { title: "Tegeta Home", subtitle: "", lat: 41.90, lon: 44.95, kind: "recent" },
  { title: "Other", subtitle: "", lat: 41.72, lon: 44.79, kind: "charger" },
  { title: "Broken", lat: NaN, lon: 1, kind: "charger" },
];

test("rankLocal: recents first, then nearest; non-matching and invalid dropped", () => {
  const r = S.rankLocal("teg", items, pos);
  assert.deepStrictEqual(r.map((x) => x.title), ["Tegeta Home", "Tegeta Near", "Tegeta Motors Charger"]);
  assert.ok(r[1].km < r[2].km);
});

test("rankLocal caps results", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ title: "Spot " + i, lat: 41.7 + i / 1000, lon: 44.8, kind: "charger" }));
  assert.strictEqual(S.rankLocal("spot", many, pos, 5).length, 5);
});

test("addRecent: newest first, de-duplicates by coordinates, caps at 8", () => {
  let l = [];
  for (let i = 0; i < 12; i++) l = S.addRecent(l, { title: "p" + i, lat: 41 + i / 100, lon: 44 });
  assert.strictEqual(l.length, 8);
  assert.strictEqual(l[0].title, "p11");
  l = S.addRecent(l, { title: "again", lat: 41.08, lon: 44 });
  assert.strictEqual(l.length, 8);
  assert.strictEqual(l[0].title, "again");
  assert.strictEqual(l.filter((e) => e.lat === 41.08).length, 1);
});

test("sortByDistance orders Nominatim-shaped results by km; no position keeps order", () => {
  const res = [{ lat: "41.90", lon: "44.9" }, { lat: "41.72", lon: "44.79" }];
  assert.strictEqual(S.sortByDistance(res, pos)[0].lat, "41.72");
  assert.strictEqual(S.sortByDistance(res, null)[0].lat, "41.90");
});

test("formatKm", () => {
  assert.strictEqual(S.formatKm(0.43), "400 მ");
  assert.strictEqual(S.formatKm(3.14), "3.1 კმ");
  assert.strictEqual(S.formatKm(null), "");
});

console.log("\n" + passed + " search tests passed" + (process.exitCode ? " - WITH FAILURES" : ""));
