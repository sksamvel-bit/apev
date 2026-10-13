const fs = require('fs'), vm = require('vm');
const log = []; const spoken = []; const hud = [];
const mkLayer = () => ({ addTo() { return this }, setLatLngs() { }, getBounds() { return { getSouth: () => 0, getWest: () => 0, getNorth: () => 1, getEast: () => 1 } } });
global.L = { polyline: () => mkLayer() };
global.window = { showToast: (m) => log.push('toast:' + m) };
global.AbortController = AbortController;
vm.runInThisContext(fs.readFileSync(__dirname + '/../routing.js', 'utf8'));
const RE = window.RoutingEngine;

// synthetic route: north 2.2km along lng 44.80, then east ~1.7km
const pts = []; for (let la = 41.70; la <= 41.72001; la += 0.0002) pts.push([44.80, la]);
for (let lo = 44.80; lo <= 44.82001; lo += 0.0002) pts.push([lo, 41.72]);
const geo = { coordinates: pts };
function hav(a, b, c, d) { const R = 6371000, t = x => x * Math.PI / 180; const dl = t(c - a), dn = t(d - b); const q = Math.sin(dl / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(dn / 2) ** 2; return 2 * R * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q)); }
let total = 0; for (let i = 1; i < pts.length; i++) total += hav(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]);
const osrm = {
  routes: [{
    distance: total, duration: total / 10, geometry: geo, legs: [{
      steps: [
        { maneuver: { type: 'depart', location: [44.80, 41.70] }, name: 'ჭავჭავაძე', distance: 2222, duration: 200 },
        { maneuver: { type: 'turn', modifier: 'right', location: [44.80, 41.72] }, name: 'აბაშიძე', distance: 1700, duration: 170 },
        { maneuver: { type: 'arrive', location: [44.82, 41.72] }, name: '', distance: 0, duration: 0 }]
    }]
  }]
};
let failNext = false;
global.fetch = async () => { if (failNext) throw new Error('network down'); return { ok: true, json: async () => osrm }; };

(async () => {
  const eng = new RE({ fitBounds() { log.push('fitBounds') }, removeLayer() { } }, null, null, { speak: t => spoken.push(t) }, null);
  eng.onManeuverUpdate = d => hud.push(d); eng.onSummaryUpdate = () => { }; let arrived = 0; eng.onArrival = () => arrived++;
  await eng.calculateRoute({ lat: 41.70, lng: 44.80 }, { lat: 41.72, lng: 44.82 }, true);
  const ok = (c, m) => { if (!c) global.__fails = (global.__fails || 0) + 1; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };
  process.on('exit', () => { if (global.__fails) process.exitCode = 1; });
  console.log('stepRouteDist:', eng.stepRouteDist.map(Math.round), 'total', Math.round(total));
  spoken.length = 0;
  // drive north, 1 fix/sec at 50 km/h (~14 m)
  const lat0 = 41.70; let lastHud;
  for (let m = 0; m <= 3900; m += 14) {
    const la = lat0 + Math.min(m, 2222) / 111139; const lo = 44.80 + (m > 2222 ? (m - 2222) / (111139 * Math.cos(41.72 * Math.PI / 180)) : 0);
    eng.updateVehiclePosition({ lat: la, lng: lo }, 50, m > 2222 ? 90 : 0);
  }
  console.log('spoken:', spoken);
  ok(spoken.some(s => /^\d+ მეტრში, მოუხვიეთ მარჯვნივ/.test(s)), 'far/mid approach announcement before the turn');
  ok(spoken.filter(s => s === 'მოუხვიეთ მარჯვნივ აბაშიძე-ზე').length === 1, '"now" announcement exactly once');
  ok(eng.currentStepIndex >= 1, 'advanced past depart');
  // ---- skipped fixes: jump from 1000 m straight to 2400 m (past the turn) ----
  const e2 = new RE({ fitBounds() { }, removeLayer() { } }, null, null, { speak: () => { } }, null); e2.onManeuverUpdate = d => lastHud = d; e2.onSummaryUpdate = () => { };
  await e2.calculateRoute({ lat: 41.70, lng: 44.80 }, { lat: 41.72, lng: 44.82 }, true);
  e2.updateVehiclePosition({ lat: 41.70 + 1000 / 111139, lng: 44.80 }, 90, 0);
  e2.updateVehiclePosition({ lat: 41.72, lng: 44.80 + 300 / (111139 * Math.cos(41.72 * Math.PI / 180)) }, 90, 90);
  ok(e2.currentStepIndex === 2 && lastHud.icon === 'arrive', 'GPS jump past the turn -> HUD moves on (old 30 m logic would stay stuck)');
  // ---- distance shown is along the route ----
  const e3 = new RE({ fitBounds() { }, removeLayer() { } }, null, null, null, null); e3.onManeuverUpdate = d => lastHud = d; e3.onSummaryUpdate = () => { };
  await e3.calculateRoute({ lat: 41.70, lng: 44.80 }, { lat: 41.72, lng: 44.82 }, true);
  e3.updateVehiclePosition({ lat: 41.70 + 1000 / 111139, lng: 44.80 }, 50, 0);
  console.log('HUD at 1000 m driven ->', lastHud.distanceStr, lastHud.instruction);
  ok(/1\.[12] კმ/.test(lastHud.distanceStr), 'distance to turn ~1.2 km (route progress)');
  // ---- arrival ----
  ok(arrived === 1, 'onArrival fired exactly once');
  // ---- failure keeps route ----
  const before = eng.activeRoute; failNext = true; let threw = false;
  try { await eng.calculateRoute({ lat: 41.71, lng: 44.80 }, { lat: 41.72, lng: 44.82 }, true, { fit: false, silent: true }); } catch (e) { threw = true; }
  ok(threw && eng.activeRoute === before && eng.steps.length === 3, 'network failure -> old route and steps preserved');
  failNext = false;
  // ---- silent reroute: no "route started" voice, no fitBounds ----
  spoken.length = 0; log.length = 0;
  await eng.calculateRoute({ lat: 41.71, lng: 44.80 }, { lat: 41.72, lng: 44.82 }, true, { fit: false, silent: true });
  ok(!spoken.some(s => /დაწყებულია/.test(s)) && !log.includes('fitBounds') && eng.isNavigating, 'silent reroute: no restart voice, no map re-fit, still navigating');
  // ---- high speed uses larger tiers ----
  const sp = []; const e4 = new RE({ fitBounds() { }, removeLayer() { } }, null, null, { speak: t => sp.push(t) }, null); e4.onManeuverUpdate = () => { }; e4.onSummaryUpdate = () => { };
  await e4.calculateRoute({ lat: 41.70, lng: 44.80 }, { lat: 41.72, lng: 44.82 }, true); sp.length = 0;
  for (let m = 1000; m <= 2200; m += 28) e4.updateVehiclePosition({ lat: 41.70 + m / 111139, lng: 44.80 }, 100, 0);
  console.log('100 km/h prompts:', sp);
  ok(sp.length >= 2 && /^[78]\d0 მეტრში|^[3]\d0 მეტრში|^[89]\d მეტრში|^[12]\d\d მეტრში/.test(sp[0]), 'high-speed prompts fire earlier');
})();
