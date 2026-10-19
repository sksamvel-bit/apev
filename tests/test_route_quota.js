// Routes API spending guard + the /api/route proxy contract in server.js. No network.
const fs = require('fs'), os = require('os'), path = require('path');
let fails = 0; process.on('exit', () => { if (fails) process.exitCode = 1; });
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };
const { createRouteQuota, tbilisiStamp } = require('../route-quota.js');

let now = Date.UTC(2026, 9, 19, 10, 0, 0);
const q = createRouteQuota({ dayCap: 3, monthCap: 5, now: () => now });
ok(q.tryConsume().ok && q.tryConsume().ok && q.tryConsume().ok, 'first 3 calls allowed');
let r = q.tryConsume();
ok(!r.ok && r.reason === 'day', '4th call refused by the day cap');
now += 24 * 3600 * 1000;
ok(q.tryConsume().ok && q.tryConsume().ok, 'next day: counter reset (calls 4-5 of the month)');
r = q.tryConsume();
ok(!r.ok && r.reason === 'month', 'month cap refuses even on a fresh day');
now = Date.UTC(2026, 10, 2, 10, 0, 0);
ok(q.tryConsume().ok, 'next month: reset');
ok(tbilisiStamp(Date.UTC(2026, 9, 19, 20, 30, 0)).day === '2026-10-20', 'day rolls over at midnight Tbilisi time (UTC+4)');

const f = path.join(os.tmpdir(), 'rq-test-' + process.pid + '.json');
const a = createRouteQuota({ file: f, dayCap: 2, monthCap: 9, now: () => now });
a.tryConsume(); a.tryConsume();
const b = createRouteQuota({ file: f, dayCap: 2, monthCap: 9, now: () => now });
ok(!b.tryConsume().ok, 'counters survive a restart (file)');
try { fs.unlinkSync(f); } catch (_) {}
ok(createRouteQuota({ file: '/nonexistent-dir/x.json', dayCap: 1, now: () => now }).tryConsume().ok, 'unwritable file does not break the guard');

const srv = fs.readFileSync(__dirname + '/../server.js', 'utf8');
ok(/pathname === '\/api\/route'/.test(srv) && /GOOGLE_ROUTES_KEY/.test(srv), 'server has /api/route using GOOGLE_ROUTES_KEY');
ok(!/PUBLIC_AUTH_PATHS[^;]*api\/route/.test(srv), '/api/route is behind the PIN gate');
ok(!/console\.(log|warn|error)\([^)]*ROUTES_KEY/.test(srv), 'routes key is never logged');
ok(!/'route-quota\.js'/.test(srv.match(/STATIC_WHITELIST = new Set\(\[([\s\S]*?)\]\)/)[1]), 'route-quota.js is not served to browsers');
const cli = fs.readFileSync(__dirname + '/../gmap.js', 'utf8');
ok(/pathname === '\/api\/route-permit'/.test(srv) && !/PUBLIC_AUTH_PATHS[^;]*route-permit/.test(srv), 'server has /api/route-permit behind the PIN gate');
ok(/route-permit[\s\S]*?ROUTE_QUOTA\.tryConsume\(\)/.test(srv), 'the permit endpoint spends one call of the daily/monthly cap');
{
  const f = cli.slice(cli.indexOf('async function fetchGoogleRoutes'), cli.indexOf('function fallbackNote'));
  ok(f.indexOf('/api/route-permit') > -1 && f.indexOf('/api/route-permit') < f.indexOf('routes.googleapis.com'), 'browser asks the server for a permit before every Routes call (cap stays server-side)');
  ok(/X-Goog-Api-Key": S\.key/.test(f), 'browser Routes call uses the referrer-restricted Maps key from /api/gmaps-config');
}
