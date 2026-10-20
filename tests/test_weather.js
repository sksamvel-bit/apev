// Weather warnings (v3.10.59): rain / snow ahead from Open-Meteo's 15-minute forecast, road ice at +3 °C, once per episode.
global.window = undefined;
const W = require('../weather.js');
const TA = require('../turn-audio.js');
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };

const times = ['15:30', '15:45', '16:00', '16:15', '16:30', '16:45', '17:00', '17:15', '17:30'].map((t) => '2026-10-20T' + t);
const meteo = (cur, mm, codes, temp) => ({
  current: { time: times[0], temperature_2m: temp == null ? 15 : temp, precipitation: cur.mm || 0, weather_code: cur.code || 3 },
  minutely_15: { time: times, precipitation: mm, weather_code: codes }
});

ok(W.precipAhead(meteo({}, [0, 0, 0, 0.6, 0.8, 0, 0, 0, 0], [3, 3, 3, 61, 61, 3, 3, 3, 3])).inMin === 45, 'dry now, rain from the 4th slot: in 45 min');
ok(W.precipAhead(meteo({}, [0, 0, 0.1, 0, 0, 0, 0, 0, 0], [3, 3, 80, 3, 3, 3, 3, 3, 3])).kind === 'rain', 'a shower code counts even with 0.1 mm');
ok(W.precipAhead(meteo({}, [0, 0.05, 0.1, 0, 0, 0, 0, 0, 0], [3, 3, 3, 3, 3, 3, 3, 3, 3])) === null, 'a trace without a rain code is not rain');
ok(W.precipAhead(meteo({ code: 61, mm: 0.5 }, [0.5, 0.5, 0, 0, 0, 0, 0, 0, 0], [61, 61, 3, 3, 3, 3, 3, 3, 3])) === null, 'already raining: no "rain ahead" warning');
const snow = W.precipAhead(meteo({}, [0, 0, 0.4, 0, 0, 0, 0, 0, 0], [3, 3, 73, 3, 3, 3, 3, 3, 3], 0));
ok(snow && snow.kind === 'snow' && snow.inMin === 30, 'snow code: snow in 30 min');
ok(W.precipAhead(null) === null && W.precipAhead({ current: {} }) === null, 'missing data: nothing');
ok(/^ყურადღება, წვიმა მოსალოდნელია დაახლოებით 45 წუთში$/.test(W.precipText({ kind: 'rain', inMin: 45 })), 'spoken text');
ok(!TA.maneuverOf(W.precipText({ kind: 'rain', inMin: 45 })), 'the Georgian clip pack plays no turn clip for it');

const eng = new W.WeatherEngine({ fetchFn: async () => ({ ok: true, json: async () => meteo({}, [0, 0, 0, 0.6, 0, 0, 0, 0, 0], [3, 3, 3, 61, 3, 3, 3, 3, 3], 2) }) });
(async () => {
  const d = await eng.fetchWeather(41.7, 44.8);
  ok(d && d.precip && d.precip.inMin === 45 && d.temp === 2, 'fetchWeather keeps the forecast warning with the current weather');
  const t0 = 1e9;
  const a1 = eng.alertsFor(d, t0);
  ok(a1.length === 2 && a1[0].kind === 'rain' && a1[1].kind === 'ice', 'first time: rain ahead + ice at +2 °C');
  ok(eng.alertsFor(d, t0 + 10 * 60000).length === 0, 'ten minutes later (same data): silent');
  ok(eng.alertsFor(d, t0 + 61 * 60000).map((a) => a.kind).join() === 'rain', 'after an hour rain is said again, ice is not (still cold)');
  eng.alertsFor({ temp: 8, tempExact: 8, precip: null }, t0 + 120 * 60000);
  ok(eng.alertsFor({ temp: 1, tempExact: 1, precip: null }, t0 + 180 * 60000).map((a) => a.kind).join() === 'ice', 'ice again after the air was warm in between');
  ok(eng.alertsFor(null).length === 0, 'no data: nothing');
  process.exitCode = fails ? 1 : 0;
  console.log(fails ? fails + ' weather tests FAILED' : 'weather tests passed');
})();
