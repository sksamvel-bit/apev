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

console.log('All 5 heading assertions passed successfully.');
