const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  GEOCHARGE_TARIFF_MEDIANS,
  haversineMeters,
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

test("enrichStationTariff marks TTC (Tbilisi City Hall) as free", () => {
  const station = {
    name: "TTC Station",
    operator: "ttc",
    power: "22 kW",
    price: "სტანდარტული ტარიფი"
  };
  const res = enrichStationTariff(station);
  assert.strictEqual(res.price, "0.00 ₾/kWh (უფასო)");
  assert.strictEqual(res.priceSource, "GeoCharge.ge / მერია");
});

test("enrichStationTariff applies DC vs AC median rates for E-Space", () => {
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
  assert.strictEqual(enrichStationTariff(dcStation).price, "~0.75 ₾/kWh");
  assert.strictEqual(enrichStationTariff(acStation).price, "~0.60 ₾/kWh");
});

test("enrichStationTariff applies Tegeta DC tariff", () => {
  const station = {
    name: "Tegeta DC",
    operator: "tegeta",
    power: "60 kW",
    price: "სტანდარტული ტარიფი"
  };
  assert.strictEqual(enrichStationTariff(station).price, "~1.00 ₾/kWh");
});

test("haversineMeters calculates accurate distance in meters", () => {
  // ~111 meters for 0.001 deg lat
  const d = haversineMeters(41.7100, 44.7930, 41.7110, 44.7930);
  assert.ok(d > 105 && d < 118, "expected ~111m, got: " + d);
});

test("isDuplicateStation detects spatial duplicates within 50m", () => {
  const st1 = { lat: 41.716600, lng: 44.783300, operator: "martev" };
  const st2 = { lat: 41.716750, lng: 44.783350, operator: "martev" }; // ~17m apart
  const stFar = { lat: 41.720000, lng: 44.783300, operator: "martev" }; // ~370m apart
  assert.strictEqual(isDuplicateStation(st1, st2, 50), true);
  assert.strictEqual(isDuplicateStation(st1, stFar, 50), false);
});

test("chargers-cache.json has 100% price coverage with GeoCharge attribution", () => {
  const cachePath = path.join(__dirname, "../chargers-cache.json");
  const data = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.ok(data.source.includes("GeoCharge.ge"), "source must attribute GeoCharge.ge");
  assert.ok(Array.isArray(data.stations) && data.stations.length >= 600, "expected 600+ stations");
  
  let unpriced = 0;
  for (const s of data.stations) {
    if (!s.price || s.price.includes("სტანდარტული") || s.price.includes("უცნობი")) {
      unpriced++;
    }
  }
  assert.strictEqual(unpriced, 0, "found stations without pricing: " + unpriced);
});

console.log("\n" + passed + " chargers sync tests passed" + (process.exitCode ? " - WITH FAILURES" : ""));
