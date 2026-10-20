const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  GEOCHARGE_TARIFF_MEDIANS,
  haversineMeters,
  deduplicateStations,
  isDuplicateStation,
  enrichStationTariff
} = require("../server.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    console.log("FAIL  " + name + "\n      " + e.message);
    process.exitCode = 1;
  }
}

test("enrichStationTariff preserves verified Firestore price", () => {
  const station = {
    name: "Exact Station",
    operator: "chargerplus",
    power: "120 kW",
    price: "0.85 ₾/kWh"
  };
  const res = enrichStationTariff(station);
  assert.strictEqual(res.price, "0.85 ₾/kWh");
  assert.strictEqual(res.priceSource, undefined);
});

test("enrichStationTariff marks TTC (Tbilisi City Hall) AC as free", () => {
  const acStation = {
    name: "TTC Station",
    operator: "ttc",
    power: "22 kW",
    price: "სტანდარტული ტარიფი"
  };
  const res = enrichStationTariff(acStation);
  assert.strictEqual(res.price, "0.00 ₾/kWh (მერია · უფასო)");
  assert.strictEqual(res.priceSource, "თბილისის მერია (უფასო)");

  // DC (> 22 kW) should not be automatically marked free
  const dcStation = {
    name: "TTC DC Station",
    operator: "ttc",
    power: "50 kW",
    price: "სტანდარტული ტარიფი"
  };
  const resDc = enrichStationTariff(dcStation);
  assert.strictEqual(resDc.price, "სტანდარტული ტარიფი");
});

test("enrichStationTariff applies DC vs AC median rates for E-Space with estimated tag", () => {
  const dcStation = {
    name: "E-Space DC",
    operator: "espace",
    power: "120 kW",
    price: "სტანდარტული ტარიფი"
  };
  const acStation = {
    name: "E-Space AC",
    operator: "espace",
    power: "22 kW",
    price: null
  };
  assert.strictEqual(enrichStationTariff(dcStation).price, "~0.75 ₾/kWh (სავარაუდო)");
  assert.strictEqual(enrichStationTariff(acStation).price, "~0.60 ₾/kWh (სავარაუდო)");
});

test("enrichStationTariff applies Tegeta DC tariff with estimated tag", () => {
  const station = {
    name: "Tegeta DC",
    operator: "tegeta",
    power: "60 kW",
    price: "სტანდარტული ტარიფი"
  };
  assert.strictEqual(enrichStationTariff(station).price, "~1.00 ₾/kWh (სავარაუდო)");
});

test("GEOCHARGE_TARIFF_MEDIANS excludes unverified chargerplus and greencharge", () => {
  assert.strictEqual(GEOCHARGE_TARIFF_MEDIANS.chargerplus, undefined, "chargerplus should rely on exact Firestore prices");
  assert.strictEqual(GEOCHARGE_TARIFF_MEDIANS.greencharge, undefined, "greencharge is not on GeoCharge /tarifebi/");
});

test("haversineMeters calculates accurate distance in meters", () => {
  // ~111 meters for 0.001 deg lat
  const d = haversineMeters(41.7100, 44.7930, 41.7110, 44.7930);
  assert.ok(d > 105 && d < 118, "expected ~111m, got: " + d);
});

test("isDuplicateStation is operator-aware and rejects different operators at same location", () => {
  const stA = { lat: 41.716600, lng: 44.783300, operator: "martev" };
  const stB = { lat: 41.716750, lng: 44.783350, operator: "martev" }; // ~17m apart, same op
  const stDiffOp = { lat: 41.716610, lng: 44.783310, operator: "espace" }; // ~2m apart, different op
  const stFar = { lat: 41.720000, lng: 44.783300, operator: "martev" }; // ~370m apart

  assert.strictEqual(isDuplicateStation(stA, stB, 30), true, "same operator within 30m should be duplicate");
  assert.strictEqual(isDuplicateStation(stA, stDiffOp, 30), false, "different operators at same lot must NOT be duplicates");
  assert.strictEqual(isDuplicateStation(stA, stFar, 30), false, "stations far apart must not be duplicate");
});

test("deduplicateStations merges duplicate posts of same operator and keeps max power & unique types", () => {
  const list = [
    { lat: 41.716600, lng: 44.783300, operator: "martev", name: "MartEV Post 1", power: "50 kW", type: "CCS2" },
    { lat: 41.716700, lng: 44.783350, operator: "martev", name: "მართ EV სადგური", power: "120 kW", type: "Type 2, CCS2", address: "ვაჟა-ფშაველა 25" },
    { lat: 41.716610, lng: 44.783310, operator: "espace", name: "E-Space Station", power: "60 kW", type: "Type 2" }
  ];

  const deduped = deduplicateStations(list, 30);
  assert.strictEqual(deduped.length, 2, "should merge 2 martev posts into 1 and preserve 1 espace post");

  const martev = deduped.find(s => s.operator === "martev");
  assert.strictEqual(martev.power, "120 kW", "should pick max charging power");
  assert.ok(martev.type.includes("CCS2") && martev.type.includes("Type 2"), "should union connector types");
  assert.strictEqual(martev.name, "მართ EV სადგური", "should prefer Georgian name");
  assert.strictEqual(martev.address, "ვაჟა-ფშაველა 25");

  const espace = deduped.find(s => s.operator === "espace");
  assert.strictEqual(espace.power, "60 kW");
});

test("chargers-cache.json has verified price coverage with GeoCharge attribution", () => {
  const cachePath = path.join(__dirname, "../chargers-cache.json");
  const data = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.ok(data.source.includes("GeoCharge.ge"), "source must attribute GeoCharge.ge");
  assert.ok(Array.isArray(data.stations) && data.stations.length >= 500, "expected 500+ deduplicated stations");
  
  let unpriced = 0;
  for (const s of data.stations) {
    if (!s.price || s.price.includes("სტანდარტული") || s.price.includes("უცნობი")) {
      unpriced++;
    }
  }
  // Only the 12 unverified GreenCharge stations lack pricing; all other 558 stations have verified/median prices
  assert.strictEqual(unpriced, 12, "expected exactly 12 unverified greencharge stations without pricing: " + unpriced);
});

// ---- v3.10.58: GeoCharge medians refreshed daily ----
const GT = require("../geocharge-tariffs.js");
const samplePage = `<p>ბოლო განახლება: 2026-10-20 09:02</p><table><thead><tr><th>ქსელი</th></tr></thead><tbody>
<tr><td><a href="/qselebi/mart-ev/">mart EV</a></td><td>189</td><td>0.55 .. 0.80 <span>(მედიანა 0.80)</span></td><td>0.50 .. 0.65 <span>(მედიანა 0.65)</span></td><td>—</td></tr>
<tr><td><a href="/qselebi/charger-plus/">Charger Plus (ჩარჯერ პლუს)</a></td><td>59</td><td>—</td><td>—</td><td>59</td></tr>
<tr><td><a href="/qselebi/moveo/">MOVEO (მოვეო)</a></td><td>11</td><td>0.70 .. 0.95 <span>(მედიანა 0.80)</span></td><td>0.56 .. 0.56 <span>(მედიანა 0.56)</span></td><td>—</td></tr>
<tr><td><a href="/qselebi/ev-power-ge/">EV Power (ივი პაუერ)</a></td><td>61</td><td>0.76 .. 0.95 <span>(მედიანა 0.76)</span></td><td>—</td><td>—</td></tr>
<tr><td><a href="/qselebi/electrify-georgia/">Electrify Georgia</a></td><td>28</td><td>(მედიანა 0.57)</td><td>(მედიანა 0.45)</td><td>—</td></tr>
<tr><td><a href="/qselebi/new-net/">New Net</a></td><td>3</td><td>(მედიანა 7.50)</td><td>(მედიანა 0.40)</td><td>—</td></tr>
</tbody></table>`;

test("parseTariffsPage reads the medians by network link, skips networks without prices and absurd values", () => {
  const p = GT.parseTariffsPage(samplePage);
  assert.strictEqual(p.updated, "2026-10-20 09:02");
  assert.deepStrictEqual(p.tariffs.martev, { dc: 0.8, ac: 0.65, name: "mart EV" });
  assert.deepStrictEqual(p.tariffs.moveo, { dc: 0.8, ac: 0.56, name: "MOVEO" });
  assert.strictEqual(p.tariffs.evpower.ac, null);
  assert.strictEqual(p.tariffs.electrify.dc, 0.57);
  assert.strictEqual(p.tariffs.chargerplus, undefined, "no published price: no median (station prices stay)");
  assert.deepStrictEqual([p.tariffs.newnet.dc, p.tariffs.newnet.ac], [null, 0.4], "a value above 2 GEL is a data error");
  assert.ok(GT.looksValid(p));
  assert.ok(!GT.looksValid(GT.parseTariffsPage("<html>maintenance</html>")), "a page we do not understand is not used");
});

test("a new median re-prices the stations that used the old one, never a station with its own price", () => {
  GEOCHARGE_TARIFF_MEDIANS.moveo = { dc: 0.85, ac: 0.56, name: "MOVEO" };   // the snapshot, whatever tariffs-cache.json holds locally
  const old = enrichStationTariff({ operator: "moveo", power: "60 kW", price: "სტანდარტული ტარიფი" });
  assert.strictEqual(old.price, "~0.85 ₾/kWh (სავარაუდო)");
  const { applyTariffs } = require("../server.js");
  applyTariffs(GT.parseTariffsPage(samplePage));
  const again = enrichStationTariff(old);
  assert.strictEqual(again.price, "~0.80 ₾/kWh (სავარაუდო)");
  assert.ok(again.priceSource.includes("2026-10-20"), again.priceSource);
  const own = enrichStationTariff({ operator: "moveo", power: "60 kW", price: "0.90 ₾/kWh" });
  assert.strictEqual(own.price, "0.90 ₾/kWh");
});

console.log("\n" + passed + " chargers sync tests passed" + (process.exitCode ? " - WITH FAILURES" : ""));
