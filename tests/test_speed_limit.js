const fs = require('fs'), vm = require('vm');

global.window = {};
global.localStorage = {
  getItem: () => '',
  setItem: () => {}
};
global.performance = { now: () => Date.now() };

vm.runInThisContext(fs.readFileSync(__dirname + '/../speed-limit.js', 'utf8'));
const SpeedLimitEngine = window.SpeedLimitEngine;

const engine = new SpeedLimitEngine();

const ok = (c, m) => console.log((c ? 'PASS' : 'FAIL') + '  ' + m);

// Test 1: Davit Aghmashenebeli Alley (80 km/h)
const r1 = engine.detectSpeedLimit(41.780, 44.773);
console.log('Digomi Alley:', r1);
ok(r1.limit === 80, 'Aghmashenebeli Alley detected as 80 km/h');

// Test 2: Kakheti Highway (80 km/h)
const r2 = engine.detectSpeedLimit(41.678, 44.912);
console.log('Kakheti Highway:', r2);
ok(r2.limit === 80, 'Kakheti Highway detected as 80 km/h');

// Test 3: Tbilisi-Rustavi Highway (80 km/h)
const r3 = engine.detectSpeedLimit(41.600, 44.935);
console.log('Tbilisi-Rustavi:', r3);
ok(r3.limit === 80, 'Tbilisi-Rustavi Highway detected as 80 km/h');

// Test 4: Right Embankment (70 km/h)
const r4 = engine.detectSpeedLimit(41.725, 44.788);
console.log('Right Bank Sanapiro:', r4);
ok(r4.limit === 70, 'Right Bank Sanapiro detected as 70 km/h');

// Test 5: Left Embankment (70 km/h)
const r5 = engine.detectSpeedLimit(41.730, 44.792);
console.log('Left Bank Sanapiro:', r5);
ok(r5.limit === 70, 'Left Bank Sanapiro detected as 70 km/h');

// Test 6: Marshal Gelovani Ave (70 km/h)
const r6 = engine.detectSpeedLimit(41.756, 44.776);
console.log('Marshal Gelovani:', r6);
ok(r6.limit === 70, 'Marshal Gelovani Ave detected as 70 km/h');

// Test 7: Heroes Square / Chabua Amirejibi Highway (70 km/h)
const r7 = engine.detectSpeedLimit(41.715, 44.765);
console.log('Chabua Amirejibi Highway:', r7);
ok(r7.limit === 70, 'Chabua Amirejibi Highway detected as 70 km/h');

// Test 8: E60 Autobahn (110 km/h)
const r8 = engine.detectSpeedLimit(41.980, 44.320);
console.log('E60 Autobahn:', r8);
ok(r8.limit === 110, 'E60 Autobahn detected as 110 km/h');

// Test 9: Tbilisi City Center - Freedom Square (60 km/h)
const r9 = engine.detectSpeedLimit(41.693, 44.801);
console.log('Freedom Square:', r9);
ok(r9.limit === 60, 'Freedom Square detected as 60 km/h');

// Test 10: Non-Urban Highway - Gombori (90 km/h)
const r10 = engine.detectSpeedLimit(41.850, 45.200);
console.log('Gombori Pass:', r10);
ok(r10.limit === 90, 'Non-Urban regional road detected as 90 km/h');

// Test 11: Active Route Step Matching
const mockRouting = {
  isNavigating: true,
  activeRoute: {},
  currentStepIndex: 0,
  steps: [{ name: 'კახეთის გზატკეცილი', distance: 2000, duration: 100 }]
};
const routeEngine = new SpeedLimitEngine(mockRouting);
const r11 = routeEngine.detectSpeedLimit(41.700, 44.800);
console.log('Route step override:', r11);
ok(r11.limit === 80, 'Route step overrides speed limit accurately');

// Test 12: Route Step Living Street Matching (20 km/h)
mockRouting.steps = [{ name: 'ჭავჭავაძის I შესახვევი', distance: 200, duration: 50 }];
const r12 = routeEngine.detectSpeedLimit(41.700, 44.800);
console.log('Living street:', r12);
ok(r12.limit === 20, 'Living street detected as 20 km/h');
