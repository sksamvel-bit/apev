// Routing + signals engines together: route calculation prefetches along the route, alerts follow the route.
const fs = require('fs'), vm = require('vm');
let fails = 0; process.on('exit', () => { if (fails) process.exitCode = 1; });
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };

const store = {};
global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
global.window = { showToast() {} };
vm.runInThisContext(fs.readFileSync(__dirname + '/../routing.js', 'utf8'));
vm.runInThisContext(fs.readFileSync(__dirname + '/../traffic-signals.js', 'utf8'));

const A = 41.7300, B = 44.7100, M = 1 / 111140, ML = 1 / (111320 * Math.cos(A * Math.PI / 180));
const pts = []; for (let k = 0; k <= 30; k++) pts.push([B, A + k * 50 * M]);           // 1.5 km north, [lon, lat]
const osrm = { routes: [{ distance: 1500, duration: 150, geometry: { coordinates: pts }, legs: [{ steps: [
  { maneuver: { type: 'depart', location: [B, A] }, name: 'X', distance: 1500, duration: 150 },
  { maneuver: { type: 'arrive', location: [B, A + 1500 * M] }, name: '', distance: 0, duration: 0 }] }] }] };
const sigsJson = { elements: [
  { type: 'node', id: 1, lat: A + 400 * M, lon: B },                // on the route
  { type: 'node', id: 2, lat: A + 380 * M, lon: B + 70 * ML }       // on a cross street, 70 m east
] };
const overpassCalls = [];
global.fetch = async (url) => {
  if (String(url).includes('overpass')) { overpassCalls.push(url); return { ok: true, json: async () => sigsJson }; }
  return { ok: true, json: async () => osrm };
};

(async () => {
  const sigEngine = new window.TrafficSignalsEngine({ on() {}, getZoom: () => 9, getBounds: () => null });
  const boundsCalls = 0;
  const eng = new window.RoutingEngine({ fitBounds() {}, getSource() { return null; }, getLayer() { return null; } }, null, sigEngine, { speak() {} }, null);
  eng.onManeuverUpdate = () => {}; eng.onSummaryUpdate = () => {};
  await eng.calculateRoute({ lat: A, lng: B }, { lat: A + 1500 * M, lng: B }, true);
  await new Promise(r => setTimeout(r, 50));
  ok(overpassCalls.length >= 1 && boundsCalls === 0, 'route calculation prefetches signal tiles along the route (not the old bounding-box call)');
  ok(sigEngine.signals.length === 2, 'signals of the route tiles are loaded (de-duplicated across tiles)');

  const up = eng.updateVehiclePosition({ lat: A + 150 * M, lng: B }, 40, 0);
  ok(up && Math.abs(up.distanceMeters - 250) < 8, 'driving north: the alert is the signal ON the route, ~250 m ahead');
  const up2 = eng.updateVehiclePosition({ lat: A + 330 * M, lng: B }, 40, 0);
  ok(up2 && Math.abs(up2.distanceMeters - 70) < 8, 'later the same on-route signal is ~70 m ahead (the cross-street signal never alerts)');
})();
