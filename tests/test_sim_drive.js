const assert = require("assert");
const { SimDriveEngine } = require("../sim-drive.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    console.error(" FAIL " + name + ":", e.message);
    process.exitCode = 1;
  }
}

// Mock DOM & window
global.window = {
  isSimulatingDrive: false,
  currentPos: { lat: 41.70, lng: 44.75 },
  routingEngine: {
    activeRoute: {
      coordinates: [
        [41.7000, 44.7500],
        [41.7010, 44.7510],
        [41.7020, 44.7520]
      ],
      distanceMeters: 500
    },
    cumDist: [0, 250, 500],
    calculateBearing: (lat1, lon1, lat2, lon2) => 45,
    haversineMeters: () => 250,
    updateVehiclePosition: (pos, spd, hdg) => null,
    onPositionUpdate: null,
    onArrival: null
  },
  showToast: () => {}
};

global.document = {
  readyState: "complete",
  getElementById: (id) => null
};

test("SimDriveEngine instantiates cleanly", () => {
  const engine = new SimDriveEngine();
  assert.strictEqual(engine.isSimulating, false);
});

test("start activates simulation and sets window.isSimulatingDrive", async () => {
  const engine = new SimDriveEngine();
  let positionUpdated = false;
  window.routingEngine.onPositionUpdate = (st) => {
    positionUpdated = true;
    assert(st.pos.lat >= 41.7000);
    assert(st.heading === 45);
    assert(st.speed > 0);
  };

  await engine.start();
  assert.strictEqual(engine.isSimulating, true);
  assert.strictEqual(window.isSimulatingDrive, true);
  assert.strictEqual(positionUpdated, true);
  engine.stop();
});

test("runStep advances distance along coordinates", async () => {
  const engine = new SimDriveEngine();
  let lastLat = 0;
  window.routingEngine.onPositionUpdate = (st) => {
    lastLat = st.pos.lat;
  };

  await engine.start();
  const initLat = lastLat;
  engine.runStep();
  assert(lastLat > initLat, "Vehicle should advance forward along the route");
  engine.stop();
});

test("arrival stops simulation when reaching total distance", async () => {
  const engine = new SimDriveEngine();
  let arrivalCalled = false;
  window.routingEngine.onArrival = () => { arrivalCalled = true; };

  await engine.start();
  engine.currentDistance = 600; // past 500m
  engine.runStep();

  assert.strictEqual(engine.isSimulating, false);
  assert.strictEqual(arrivalCalled, true);
});

test("stop cleans up timer and resets simulation state", async () => {
  const engine = new SimDriveEngine();
  await engine.start();
  assert.strictEqual(engine.isSimulating, true);
  engine.stop();
  assert.strictEqual(engine.isSimulating, false);
  assert.strictEqual(window.isSimulatingDrive, false);
  assert.strictEqual(engine.timer, null);
});

console.log("\n" + passed + " sim drive tests passed");
