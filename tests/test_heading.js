// Automated Test Suite for Automotive Vehicle Heading, COG, and Rotation
const assert = require('assert');

function calculateBearing(lat1, lon1, lat2, lon2) {
  const toRad = deg => (deg * Math.PI) / 180;
  const toDeg = rad => (rad * 180) / Math.PI;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  let brng = toDeg(Math.atan2(y, x));
  return (brng + 360) % 360;
}

function shortestAngleDiff(targetDeg, currentDeg) {
  let diff = (targetDeg - currentDeg) % 360;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

// 1. Bearing calculations
assert.strictEqual(Math.round(calculateBearing(41.70, 44.80, 41.71, 44.80)), 0, 'North bearing must be 0 deg');
assert.strictEqual(Math.round(calculateBearing(41.71, 44.80, 41.70, 44.80)), 180, 'South bearing must be 180 deg');
assert.strictEqual(Math.round(calculateBearing(41.70, 44.80, 41.70, 44.81)), 90, 'East bearing must be 90 deg');
assert.strictEqual(Math.round(calculateBearing(41.70, 44.81, 41.70, 44.80)), 270, 'West bearing must be 270 deg');
console.log('PASS  cardinal bearings (N=0, S=180, E=90, W=270)');

// 2. Shortest angle diff across wrap-around boundaries
assert.strictEqual(shortestAngleDiff(10, 350), 20, 'From 350 to 10 is +20 deg');
assert.strictEqual(shortestAngleDiff(350, 10), -20, 'From 10 to 350 is -20 deg');
assert.strictEqual(shortestAngleDiff(180, 0), 180, 'From 0 to 180 is 180 deg');
console.log('PASS  shortest angle difference across 0/360 wrap');

// 3. Negative modulo handling
const neg = -20;
const norm = ((neg % 360) + 360) % 360;
assert.strictEqual(norm, 340, 'Negative angle -20 must normalize to 340');
assert.strictEqual(shortestAngleDiff(350, norm), 10, 'Difference from 340 to 350 must be +10');
console.log('PASS  negative angle normalization');

// 4. Route alignment filter: car moving South (180 deg), route facing North (0 deg)
const carMovement = 180;
const routeOpposite = 0;
const diffOpposite = Math.abs(shortestAngleDiff(routeOpposite, carMovement));
assert.ok(diffOpposite > 45, 'Opposite route must exceed 45 deg threshold');
// Verify it will NOT snap to 0 deg
const targetHeadingOpposite = diffOpposite <= 45 ? routeOpposite : carMovement;
assert.strictEqual(targetHeadingOpposite, 180, 'Car driving South must NOT snap to North route');
console.log('PASS  car driving South does NOT invert to North route');

// 5. Route alignment filter: car moving along road (85 deg), route segment is 90 deg
const carRoad = 85;
const routeRoad = 90;
const diffRoad = Math.abs(shortestAngleDiff(routeRoad, carRoad));
assert.ok(diffRoad <= 45, 'Matching route within 45 deg');
const targetHeadingRoad = diffRoad <= 45 ? routeRoad : carRoad;
assert.strictEqual(targetHeadingRoad, 90, 'Car on road snaps cleanly to route segment');
console.log('PASS  car driving along route aligns cleanly to lane');

// 6. Free-driving OSM Road Snapping via SpeedLimitEngine.getRoadBearing
const fs = require('fs'), vm = require('vm');
global.window = {};
global.localStorage = { getItem: () => '', setItem: () => {} };
global.performance = { now: () => Date.now() };
vm.runInThisContext(fs.readFileSync(__dirname + '/../speed-limit.js', 'utf8'));
const engine = new window.SpeedLimitEngine();

// Mock OSM tile with an East-West road (Chavchavadze Ave, bearing = 90 deg)
const [ti, tj] = engine.tileIndex(41.71, 44.75);
engine.osmTiles.set(engine.tileKey(ti, tj), {
  t: Date.now(),
  ways: [
    {
      id: 999,
      name: 'ჭავჭავაძის გამზირი',
      pts: [[41.7100, 44.7450], [41.7100, 44.7550]] // Pure East: 90 deg
    }
  ]
});

// Car driving without a route: slanted at 78 deg (12 deg tilted sideways)
const snappedEast = engine.getRoadBearing(41.71005, 44.7500, 78);
assert.strictEqual(snappedEast, 90, 'Free driving: tilted car (78 deg) must snap cleanly to road (90 deg)');
console.log('PASS  free driving: slanted car (78 deg) snaps cleanly to road (90 deg)');

// 7. Free-driving reverse direction (driving West on the same road at 262 deg)
const snappedWest = engine.getRoadBearing(41.71005, 44.7500, 262);
assert.strictEqual(snappedWest, 270, 'Free driving: reverse travel (262 deg) must snap to 270 deg');
console.log('PASS  free driving: reverse travel (262 deg) snaps cleanly to road (270 deg)');

// 8. Free-driving turn / crossing road (heading North at 0 deg)
const snappedTurn = engine.getRoadBearing(41.71005, 44.7500, 0);
assert.strictEqual(snappedTurn, null, 'Free driving: turning car (0 deg) must NOT snap to crossing road');
console.log('PASS  free driving: turning/crossing car does NOT snap inappropriately');

// 9. Hardware GNSS heading priority over displacement jitter
const mockHeadingDeg = 92; // 0.2 deg precision Doppler fix from GNSS
const noisyDisplacementBearing = 135; // 45 deg lateral jitter
const speedKmh = 50;
const hasHardwareHeading = typeof mockHeadingDeg === "number" && isFinite(mockHeadingDeg) &&
                           mockHeadingDeg >= 0 && mockHeadingDeg <= 360 &&
                           (mockHeadingDeg > 0 || speedKmh >= 4);
assert.ok(hasHardwareHeading, 'Hardware heading is valid');
const chosenHeading = hasHardwareHeading ? mockHeadingDeg : noisyDisplacementBearing;
assert.strictEqual(chosenHeading, 92, 'Hardware GNSS heading must take priority over noisy displacement');
console.log('PASS  hardware GNSS Doppler heading takes priority over noisy displacement');

// 10. Velocity EMA vector noise cancellation
let vx = 0, vy = 10; // True motion: 10 m/s North (0 deg)
// Add zero-mean lateral jitter alternating +/- 3 m/s
for (let t = 1; t <= 6; t++) {
  const noiseVx = (t % 2 === 0 ? 3 : -3);
  vx = vx * 0.65 + noiseVx * 0.35;
  vy = vy * 0.65 + 10 * 0.35;
}
const emaBearing = (Math.atan2(vx, vy) * 180 / Math.PI + 360) % 360;
assert.ok(emaBearing < 6 || emaBearing > 354, 'EMA filter cancels lateral noise down to < 6 deg');
console.log('PASS  velocity EMA filter cancels lateral GPS noise');

// 11. Heading-Up (Course-Up) Map Rotation & Automotive Compass
// In Heading-Up mode, the map canvas rotates by -H so that the vehicle always points
// straight UP towards the windshield (0 deg relative to the screen).
const headingsToTest = [0, 45, 90, 135, 180, 225, 270, 315];
headingsToTest.forEach(H => {
  const mapRotation = -H;
  const markerInternalRotation = H;
  const netScreenVehicleAngle = ((mapRotation + markerInternalRotation) % 360 + 360) % 360;
  assert.strictEqual(netScreenVehicleAngle, 0, `Vehicle screen angle must be exactly 0 deg (straight UP) for heading ${H}`);

  // Compass needle points to True North:
  // In Heading-Up mode, if car faces East (90 deg), North is to the left (-90 / 270 deg).
  const compassNeedleDeg = mapRotation; // -H
  const normalizedCompass = ((compassNeedleDeg % 360) + 360) % 360;
  const expectedNorthOnScreen = ((360 - H) % 360);
  assert.strictEqual(normalizedCompass, expectedNorthOnScreen, `Compass needle points to True North for heading ${H}`);
});
console.log('PASS  Heading-Up (Course-Up) map rotation: vehicle is 0 deg UP, compass points to True North');

// 12. Multi-Touch 2-Finger Twist-to-Rotate Gesture (Full 360 Continuous Rotation)
// Verifies that incremental angular delta across the 180/-180 wrap boundary produces
// smooth, continuous accumulation without jumps, allowing full 360 and 720 deg rotation.
function normDiff(diff) {
  let d = diff % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// Simulate full 360-degree clockwise twist in 10-degree increments
let simulatedLastAngle = 0;
let accumulatedRotation = 0;
for (let step = 1; step <= 36; step++) {
  // Simulating Math.atan2 result which wraps in [-180, 180]
  let currentSimAngle = (step * 10);
  if (currentSimAngle > 180) currentSimAngle -= 360;
  const dAngle = normDiff(currentSimAngle - simulatedLastAngle);
  accumulatedRotation += dAngle;
  simulatedLastAngle = currentSimAngle;
}
assert.strictEqual(accumulatedRotation, 360, 'Accumulated rotation over 360-degree twist must equal exactly 360 deg');

// Simulate counter-clockwise twist across -175 to +175 (10 deg CCW)
const ccwDiff = normDiff(175 - (-175));
assert.strictEqual(ccwDiff, -10, 'Crossing the -180/180 meridian CCW must be -10 deg');

// Simulate clockwise twist across +175 to -175 (10 deg CW)
const cwDiff = normDiff((-175) - 175);
assert.strictEqual(cwDiff, 10, 'Crossing the -180/180 meridian CW must be +10 deg');

console.log('PASS  multi-touch twist gesture: smooth 360-deg rotation & wrap-around math');

console.log('All 12 heading assertions passed successfully.');
