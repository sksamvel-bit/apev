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

// ---- Photon typeahead (v3.10.52) ----
const photonSample = { features: [
  { geometry: { coordinates: [44.7678, 41.7225] }, properties: { name: "პრაიმ ფიტი", street: "ვაჟა-ფშაველას გამზირი", housenumber: "71", district: "საბურთალო", city: "თბილისი", countrycode: "GE" } },
  { geometry: { coordinates: [44.79, 41.69] }, properties: { street: "შოთა რუსთაველის გამზირი", housenumber: "12", city: "თბილისი", countrycode: "GE" } },
  { geometry: { coordinates: [43.5, 40.1] }, properties: { name: "Yerevan Mall", city: "Yerevan", country: "Armenia", countrycode: "AM" } },
  { geometry: { coordinates: [44.8, 41.7] }, properties: {} },
  { geometry: null, properties: { name: "broken" } }
] };

test("photonToResults: Photon GeoJSON becomes the rows the list already shows", () => {
  const r = S.photonToResults(photonSample);
  assert.strictEqual(r.length, 3, "nameless and geometry-less features are skipped");
  assert.strictEqual(r[0].display_name, "პრაიმ ფიტი, ვაჟა-ფშაველას გამზირი 71, საბურთალო, თბილისი");
  assert.strictEqual(r[0].lat, "41.7225"); assert.strictEqual(r[0].lon, "44.7678"); assert.strictEqual(r[0].source, "photon");
  assert.strictEqual(r[1].display_name, "შოთა რუსთაველის გამზირი 12, თბილისი", "an address without a name leads with street + number");
  assert.strictEqual(r[2].display_name, "Yerevan Mall, Yerevan, Armenia", "the country is named outside Georgia");
  assert.deepStrictEqual(S.photonToResults(null), []);
  const twice = { features: [photonSample.features[1], { geometry: { coordinates: [44.79001, 41.69001] }, properties: photonSample.features[1].properties }] };
  assert.strictEqual(S.photonToResults(twice).length, 1, "the same address twice (building + address point) is one row");
});

test("mergeResults: Nominatim first, Photon rows only when they are another place", () => {
  const nom = [{ display_name: "71, ვაჟა-ფშაველას გამზირი, საბურთალო", lat: "41.72252", lon: "44.76782" }];
  const pho = S.photonToResults(photonSample);
  const m = S.mergeResults(nom, pho);
  assert.strictEqual(m[0], nom[0], "Nominatim keeps the first place");
  assert.ok(!m.some((r) => r.display_name.startsWith("პრაიმ ფიტი")), "the same building from Photon (within 60 m) is dropped");
  assert.ok(m.some((r) => r.display_name.startsWith("შოთა რუსთაველის")), "a different place from Photon is kept");
  assert.strictEqual(S.mergeResults([], pho).length, 3);
  assert.strictEqual(S.mergeResults([{ display_name: "Yerevan Mall, x", lat: "0", lon: "0" }], pho).filter((r) => r.display_name.startsWith("Yerevan Mall")).length, 1, "same first name = same place");
});

test("server: /api/suggest is a cached, throttled Photon proxy behind the PIN gate", () => {
  const fs = require("fs");
  const srv = fs.readFileSync(__dirname + "/../server.js", "utf8");
  assert.ok(srv.includes("pathname === '/api/suggest'") && !/PUBLIC_AUTH_PATHS[^;]*suggest/.test(srv), "endpoint exists and is not public");
  assert.ok(srv.includes("photon.komoot.io") && srv.includes("SearchUtil.photonToResults"), "proxies Photon and returns the list shape");
  assert.ok(srv.includes("suggestCache") && srv.includes("lastPhotonRequestTime + 250") && srv.includes("suggestRateLimited"), "24 h cache, <= 4 calls/s to Photon, per-client limit");
  const app = fs.readFileSync(__dirname + "/../app.js", "utf8");
  assert.ok(app.includes("suggestTimer = setTimeout(() => runSuggest(query), 350)") && app.includes("query.length >= 3"), "the page asks after a 350 ms pause and 3+ letters");
  assert.ok(app.includes("SearchUtil.mergeResults(nominatim, photon)"), "Enter merges Nominatim with the typed suggestions");
});

test("resultTitle: street + house number instead of a bare number; Nominatim repeats merged", () => {
  assert.strictEqual(S.resultTitle({ display_name: "14, მერაბ კოსტავას ქუჩა, ვერა, თბილისი" }), "მერაბ კოსტავას ქუჩა 14");
  assert.strictEqual(S.resultTitle({ display_name: "12ა, რუსთაველის გამზირი" }), "რუსთაველის გამზირი 12ა");
  assert.strictEqual(S.resultTitle({ display_name: "სტამბა, 14, მერაბ კოსტავას ქუჩა" }), "სტამბა");
  assert.strictEqual(S.resultTitle({ display_name: "" }, "q"), "q");
  const twice = [{ display_name: "14, მერაბ კოსტავას ქუჩა, ვერა", lat: "41.7", lon: "44.8" }, { display_name: "14, მერაბ კოსტავას ქუჩა, ვერა", lat: "41.7", lon: "44.8" }];
  assert.strictEqual(S.mergeResults(twice, []).length, 1);
});

// ---- Google Maps share links (v3.10.53) ----
test("mapsLinkKind: only Google Maps links, short ones need a redirect", () => {
  assert.strictEqual(S.mapsLinkKind("https://maps.app.goo.gl/AbC123xyz"), "short");
  assert.strictEqual(S.mapsLinkKind("https://goo.gl/maps/AbC123"), "short");
  assert.strictEqual(S.mapsLinkKind("https://www.google.com/maps/place/X/@41.7,44.8,15z"), "full");
  assert.strictEqual(S.mapsLinkKind("https://maps.google.com/?q=41.7,44.8"), "full");
  assert.strictEqual(S.mapsLinkKind("https://www.google.ge/maps/search/pizza"), "full");
  assert.strictEqual(S.mapsLinkKind("https://goo.gl/other"), "", "a goo.gl link that is not maps");
  assert.strictEqual(S.mapsLinkKind("https://evil.com/maps/x"), "");
  assert.strictEqual(S.mapsLinkKind("https://google.com.evil.com/maps"), "");
  assert.strictEqual(S.mapsLinkKind("ftp://maps.app.goo.gl/x"), "");
  assert.strictEqual(S.mapsLinkKind("not a link"), "");
});

test("extractUrl: the link out of shared text", () => {
  assert.strictEqual(S.extractUrl("Prime Fit\nhttps://maps.app.goo.gl/AbC123."), "https://maps.app.goo.gl/AbC123");
  assert.strictEqual(S.extractUrl("nothing here"), "");
});

test("parseMapsUrl: the place pin wins over the map centre, names are read", () => {
  const p = S.parseMapsUrl("https://www.google.com/maps/place/Prime+Fit/@41.72,44.76,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x1!8m2!3d41.7225!4d44.7678!16s");
  assert.strictEqual(p.name, "Prime Fit");
  assert.strictEqual(p.lat, 41.7225); assert.strictEqual(p.lng, 44.7678);
  const c = S.parseMapsUrl("https://www.google.com/maps/@41.70,44.80,15z");
  assert.strictEqual(c.lat, 41.7); assert.strictEqual(c.name, "");
  const q = S.parseMapsUrl("https://maps.google.com/?q=41.6938,44.8015");
  assert.deepStrictEqual([q.lat, q.lng], [41.6938, 44.8015]);
  const n = S.parseMapsUrl("https://maps.google.com/maps?q=%E1%83%97%E1%83%91%E1%83%98%E1%83%9A%E1%83%98%E1%83%A1%E1%83%98+Mall&ftid=0x1:0x2");
  assert.strictEqual(n.name, "თბილისი Mall"); assert.strictEqual(n.lat, null, "name only: coordinates come from our search");
  const d = S.parseMapsUrl("https://www.google.com/maps/dir/?api=1&destination=41.65,44.95");
  assert.strictEqual(d.lat, 41.65);
  const geo = S.parseMapsUrl("https://www.google.com/maps/place/41%C2%B042'00.0%22N/@41.7,44.8,17z");
  assert.strictEqual(geo.lat, 41.7);
  const consent = S.parseMapsUrl("https://consent.google.com/m?continue=" + encodeURIComponent("https://www.google.com/maps/place/X/@41.7,44.8,15z/data=!3d41.71!4d44.81") + "&gl=GE");
  assert.deepStrictEqual([consent.name, consent.lat, consent.lng], ["X", 41.71, 44.81]);
  assert.strictEqual(S.parseMapsUrl("https://www.google.com/maps"), null);
  assert.strictEqual(S.parseMapsUrl("garbage"), null);
});

test("server + phone: /api/maps-link resolves only goo.gl redirects, the car opens it in Google mode", () => {
  const fs = require("fs");
  const srv = fs.readFileSync(__dirname + "/../server.js", "utf8");
  assert.ok(srv.includes("pathname === '/api/maps-link'") && !/PUBLIC_AUTH_PATHS[^;]*maps-link/.test(srv), "endpoint exists and is not public");
  assert.ok(srv.includes("method: 'GET', hostname: u.hostname") && srv.includes("res.resume();   // only the redirect header") && srv.includes("SearchUtil.mapsLinkKind(u.href) !== 'short'"), "only the redirect of a short-link host is read, never a Google page");
  const remote = fs.readFileSync(__dirname + "/../remote.html", "utf8");
  assert.ok(remote.includes("/api/maps-link?url=") && remote.includes("source: 'gmaps'"), "the phone resolves the link and marks it");
  const app = fs.readFileSync(__dirname + "/../app.js", "utf8");
  assert.ok(app.includes('payload.source === "gmaps" && window.GMapMode && window.GMapMode.isEnabled()'), "the car opens a Google link in Google mode");
});

console.log("\n" + passed + " search tests passed" + (process.exitCode ? " - WITH FAILURES" : ""));
