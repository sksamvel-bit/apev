const assert = require("assert");
const { SimDriveEngine } = require("../sim-drive.js");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    console.error(" FAIL " + name + ":", e.message);
    process.exitCode = 1;
  }
}

// Reset mock DOM & window before each test
function resetMock() {
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
}

(async function runAll() {
  resetMock();
  await test("SimDriveEngine instantiates cleanly", () => {
    const engine = new SimDriveEngine();
    assert.strictEqual(engine.isSimulating, false);
  });

  resetMock();
  await test("start activates simulation and sets window.isSimulatingDrive", async () => {
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

  resetMock();
  await test("runStep advances distance along coordinates", async () => {
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

  resetMock();
  await test("arrival stops simulation when reaching total distance", async () => {
    const engine = new SimDriveEngine();
    let arrivalCalled = false;
    window.routingEngine.onArrival = () => { arrivalCalled = true; };

    await engine.start();
    engine.currentDistance = 600; // past 500m
    engine.runStep();

    assert.strictEqual(engine.isSimulating, false);
    assert.strictEqual(arrivalCalled, true);
  });

  resetMock();
  await test("stop cleans up timer and resets simulation state", async () => {
    const engine = new SimDriveEngine();
    await engine.start();
    assert.strictEqual(engine.isSimulating, true);
    engine.stop();
    assert.strictEqual(engine.isSimulating, false);
    assert.strictEqual(window.isSimulatingDrive, false);
    assert.strictEqual(engine.timer, null);
  });

  resetMock();
  await test("lookahead steering smoothly turns across a 90-degree corner", async () => {
    const engine = new SimDriveEngine();
    // 90 degree bend: North from 0 to 100m, then East from 100m to 250m
    window.routingEngine.activeRoute.coordinates = [
      [41.7000, 44.7500], // 0m
      [41.7009, 44.7500], // 100m (North)
      [41.7009, 44.7518]  // 250m (East)
    ];
    window.routingEngine.cumDist = [0, 100, 250];
    window.routingEngine.calculateBearing = (lat1, lon1, lat2, lon2) => {
      const dLng = (lon2 - lon1) * Math.PI / 180;
      const l1 = lat1 * Math.PI / 180;
      const l2 = lat2 * Math.PI / 180;
      const y = Math.sin(dLng) * Math.cos(l2);
      const x = Math.cos(l1) * Math.sin(l2) - Math.sin(l1) * Math.cos(l2) * Math.cos(dLng);
      return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    };

    const headings = [];
    window.routingEngine.onPositionUpdate = (st) => {
      headings.push(st.heading);
    };

    await engine.start();
    // Start near the corner (85m)
    engine.currentDistance = 85;
    for (let i = 0; i < 6; i++) {
      engine.runStep();
    }

    assert(headings.length >= 6);
    for (let k = 1; k < headings.length; k++) {
      const delta = Math.abs(((headings[k] - headings[k-1] + 540) % 360) - 180);
      assert(delta <= 18, `Turn step ${k} exceeded rate limit: delta=${delta}`);
    }
    engine.stop();
  });

  console.log("\n" + passed + " sim drive tests passed");
})();
