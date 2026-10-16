// Route alternatives (preview only): query flag, filtering of near-copies / absurd routes, switching the active route.
const fs = require('fs'), vm = require('vm');
global.window = { showToast() { } };
global.AbortController = AbortController;
vm.runInThisContext(fs.readFileSync(__dirname + '/../routing.js', 'utf8'));
const RE = window.RoutingEngine;
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };

const line = (dx) => { const p = []; for (let i = 0; i <= 20; i++) p.push([44.80 + dx * Math.sin(i / 20 * Math.PI), 41.70 + i * 0.001]); return p; };
const mk = (dist, dur, dx) => ({
  distance: dist, duration: dur, geometry: { coordinates: line(dx) },
  legs: [{ steps: [{ maneuver: { type: 'depart', location: [44.80, 41.70] }, name: 'A', distance: dist, duration: dur }, { maneuver: { type: 'arrive', location: [44.80, 41.72] }, name: '', distance: 0, duration: 0 }] }]
});
const best = mk(2300, 300, 0), fast2 = mk(2900, 340, 0.004), copy = mk(2310, 302, 0.0001), slow = mk(9000, 1500, 0.01);

const urls = [];
let answer = { routes: [best, fast2, copy, slow] };
global.fetch = async (u) => { urls.push(u); return { ok: true, json: async () => answer }; };

(async () => {
  const picked = RE.pickAlternatives([best, fast2, copy, slow]);
  ok(picked.length === 1 && picked[0] === 1, 'near-copy and absurdly slow routes are dropped, the real alternative stays');

  const eng = new RE({ getSource() { return null; }, fitBounds() { }, on() { } }, null, null, null, null);
  let selected = null; eng.onRouteSelected = (r) => { selected = r; };
  await eng.calculateRoute({ lat: 41.70, lng: 44.80 }, { lat: 41.72, lng: 44.80 }, false);
  ok(/alternatives=true/.test(urls[0]), 'preview asks OSRM for alternatives');
  ok(eng.altRoutes.length === 1 && eng.altGeo.features.length === 1, 'one alternative is stored and drawn');
  ok(Math.round(eng.activeRoute.durationSeconds) === 300, 'the fastest route is active first');

  const r = eng.selectAlternative(1);
  ok(r && Math.round(eng.activeRoute.durationSeconds) === 340 && selected === r, 'tapping the alternative makes it active and notifies the UI');
  ok(eng.altRoutes.length === 1 && eng.altRoutes[0] === 0, 'the former best route becomes the grey alternative');

  await eng.calculateRoute({ lat: 41.70, lng: 44.80 }, { lat: 41.72, lng: 44.80 }, true);
  ok(/alternatives=false/.test(urls[urls.length - 1]) && eng.altRoutes.length === 0, 'navigation / reroute never requests alternatives and clears the grey lines');

  await eng.calculateRoute({ lat: 41.70, lng: 44.80 }, { lat: 41.72, lng: 44.80 }, false);
  ok(eng.altGeo.features.length === 1, 'preview shows the alternative again');
  eng.startNavigation();
  ok(eng.altGeo.features.length === 0 && eng.altRoutes.length === 0 && eng.activeRoute, 'starting navigation hides the alternatives but keeps the route');
  ok(eng.selectAlternative(1) === null, 'no switching while navigating');

  eng.clearRoute();
  ok(eng.altGeo.features.length === 0, 'clearing the route clears the alternatives');
  process.exitCode = fails ? 1 : 0;
  console.log(fails ? fails + ' route alternative tests FAILED' : '9 route alternative tests passed');
})();
