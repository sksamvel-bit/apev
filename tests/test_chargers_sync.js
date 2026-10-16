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

console.log("\n" + passed + " chargers sync tests passed" + (process.exitCode ? " - WITH FAILURES" : ""));
