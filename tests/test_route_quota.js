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
ok(/pathname === '\/api\/google-permit'[\s\S]*?quota\.tryConsume\(\)/.test(srv) && /routes: ROUTE_QUOTA/.test(srv), 'the permit endpoint spends one call of the SKU cap (routes = the existing route guard)');
ok(!/PUBLIC_AUTH_PATHS[^;]*google-(permit|usage)/.test(srv), '/api/google-permit and /api/google-usage are behind the PIN gate');
{
  // every cap stays under Google's free monthly usage, even if the daily cap is used up on every day of a 31-day month
  const free = {}; for (const m of srv.match(/GOOGLE_FREE_MONTHLY = \{([^}]*)\}/)[1].matchAll(/(\w+): (\d+)/g)) free[m[1]] = +m[2];
  const caps = { routes: [100, 4000] }; for (const m of srv.matchAll(/skuQuota\('(\w+)', (\d+), (\d+)\)/g)) caps[m[1]] = [+m[2], +m[3]];
  const skus = Object.keys(caps);
  ok(skus.length === 5 && skus.every((s) => free[s] > 0), 'caps for routes, mapload, autocomplete, details, nearby, each with its Google free cap');
  ok(skus.every((s) => caps[s][1] <= 0.8 * free[s] && caps[s][0] * 31 <= free[s]), 'monthly caps <= 80 % of free and daily caps x 31 days < free: ' + skus.map((s) => s + ' ' + caps[s].join('/') + ' of ' + free[s]).join(', '));
  const resets = eval('(' + srv.match(/function quotaResetDates[\s\S]*?\n\}/)[0] + ')');
  const r = resets(Date.UTC(2026, 9, 31, 21, 0));   // 01:00 on 1 November in Tbilisi
  ok(r.day === '2026-11-02' && r.month === '2026-12-01', 'reset dates follow Tbilisi time (1 Nov 01:00 -> day resets 2 Nov, month 1 Dec)');
}
{
  const f = cli.slice(cli.indexOf('async function fetchGoogleRoutes'), cli.indexOf('function fallbackNote'));
  ok(f.indexOf('permit("routes")') > -1 && f.indexOf('permit("routes")') < f.indexOf('routes.googleapis.com'), 'browser asks the server for a permit before every Routes call (cap stays server-side)');
  const pre = (call, sku) => { const i = cli.indexOf(call); return i > -1 && cli.lastIndexOf('permit("' + sku + '")', i) > cli.lastIndexOf('async function', i); };
  ok(pre('fetchAutocompleteSuggestions(', 'autocomplete') && pre('fetchFields(', 'details') && pre('searchNearby(', 'nearby'), 'search, place details and nearby search each ask for a permit first');
  const calls = [...cli.matchAll(/createMap\(/g)].map((m) => m.index).filter((i) => cli.slice(i - 9, i) !== 'function ');
  ok(calls.length === 2 && calls.every((i) => cli.lastIndexOf('permit("mapload")', i) > i - 400), 'every new Google map (open, 3D/night rebuild) asks for a map-load permit');
  ok(/fetchFields\(\{ fields: \["formattedAddress", "location"\] \}\)/.test(cli), 'place details ask only Essentials fields (no displayName = 10,000 free instead of 5,000)');
  ok(/X-Goog-Api-Key": S\.key/.test(f), 'browser Routes call uses the referrer-restricted Maps key from /api/gmaps-config');
}

// Persistent Adapter Tests (Mock)
(async () => {
  const ts = tbilisiStamp(now);
  // 1. Sync custom adapter (e.g. key-value store or database)
  let mockStore = { day: ts.day, dayCount: 2, month: ts.month, monthCount: 15 };
  let savedState = null;
  const syncAdapter = {
    name: 'mock-sync',
    load() { return Object.assign({}, mockStore); },
    save(st) { savedState = Object.assign({}, st); mockStore = Object.assign({}, st); }
  };
  const qSync = createRouteQuota({ adapter: syncAdapter, dayCap: 5, monthCap: 50, now: () => now });
  ok(qSync.tryConsume().ok, 'adapter loaded initial state and allows consumption');
  ok(savedState && savedState.dayCount === 3, 'adapter.save received updated dayCount');
  
  // Verify persistence across new instance using same adapter
  const qSync2 = createRouteQuota({ adapter: syncAdapter, dayCap: 5, monthCap: 50, now: () => now });
  ok(qSync2.tryConsume().ok, 'second instance continues from saved state');
  ok(savedState.dayCount === 4, 'second instance increments saved state');

  // 2. Async adapter (e.g. Upstash Redis / remote cloud REST)
  let asyncStore = { day: ts.day, dayCount: 4, month: ts.month, monthCount: 20 };
  const asyncAdapter = {
    name: 'mock-async',
    async load() { return Promise.resolve(Object.assign({}, asyncStore)); },
    async save(st) { asyncStore = Object.assign({}, st); return Promise.resolve(true); }
  };
  const qAsync = createRouteQuota({ adapter: asyncAdapter, dayCap: 5, monthCap: 50, now: () => now });
  await qAsync.init();
  const resAsync1 = qAsync.tryConsume();
  ok(resAsync1.ok && resAsync1.day === 5, 'async adapter hydrates state and reaches limit');
  const resAsync2 = qAsync.tryConsume();
  ok(!resAsync2.ok && resAsync2.reason === 'day', 'async adapter enforces cap when hydrated');

  // 3. Fault-tolerant error handling (failing adapter does not crash server)
  const faultyAdapter = {
    name: 'mock-faulty',
    load() { throw new Error('database connection failed'); },
    save() { throw new Error('write failed'); }
  };
  const qFaulty = createRouteQuota({ adapter: faultyAdapter, dayCap: 2, now: () => now });
  ok(qFaulty.tryConsume().ok, 'failing adapter falls back to in-memory guard without throwing');

  // 4. Upstash adapter factory validation
  const { createUpstashRedisAdapter } = require('../route-quota.js');
  ok(createUpstashRedisAdapter() === null, 'Upstash adapter returns null when env credentials missing');
  const upstash = createUpstashRedisAdapter({ url: 'https://example.upstash.io', token: 'secret' });
  ok(upstash && upstash.name === 'upstash', 'Upstash adapter instantiates cleanly with url and token');

  // 5. A call before the slow store answers: nothing is written until the store was read, then the counts are added up
  {
    let cloud = { day: ts.day, dayCount: 90, month: ts.month, monthCount: 900 }, writes = [], answer;
    const slow = { load() { return new Promise((r) => { answer = () => r(Object.assign({}, cloud)); }); }, save(st) { writes.push(Object.assign({}, st)); cloud = Object.assign({}, st); } };
    const q = createRouteQuota({ adapter: slow, dayCap: 100, now: () => now });
    ok(q.tryConsume().ok && writes.length === 0, 'early call is counted in memory but not written over the stored count');
    answer(); await q.init();
    const s = q.snapshot();
    ok(s.day === 91 && s.month === 901 && cloud.dayCount === 91, 'after the read: stored 90 + early 1 = 91 (cap not reset by a fresh instance)');
  }

  // 6. Store unreachable at start: no write ever replaces the real count, and the read is retried later
  {
    let cloud = { day: ts.day, dayCount: 99, month: ts.month, monthCount: 99 }, writes = 0, reads = 0, clock = now;
    const flaky = { load() { reads++; return reads === 1 ? Promise.reject(new Error('timeout')) : Promise.resolve(Object.assign({}, cloud)); }, save(st) { writes++; cloud = Object.assign({}, st); } };
    const q = createRouteQuota({ adapter: flaky, dayCap: 100, now: () => clock, retryMs: 60000 });
    await q.init();
    ok(q.tryConsume().ok && writes === 0 && cloud.dayCount === 99 && !q.isSynced(), 'failed read: keeps counting in memory, the stored 99 is not overwritten with 1');
    clock += 61000; q.tryConsume(); await new Promise((r) => setTimeout(r, 0));
    ok(q.isSynced() && reads === 2, 'the read is retried on a later call after retryMs');
    ok(q.snapshot().day === 101 && !q.tryConsume().ok, 'after the retry the cap counts stored 99 + 2 local calls and refuses');
  }

  // 7. Upstash adapter: an unreachable server rejects (not "empty"), so the guard cannot mistake it for a fresh store
  {
    const dead = createUpstashRedisAdapter({ url: 'https://127.0.0.1:1', token: 'x', timeoutMs: 1500 });
    let rejected = false;
    try { await dead.load(); } catch (_) { rejected = true; }
    ok(rejected, 'Upstash load rejects when the store cannot be reached');
  }

  // 8. A refused write (e.g. read-only token) shows up in status() instead of passing silently
  {
    const ro = { name: 'mock-ro', lastError: '', load() { return Promise.resolve(null); }, save() { this.lastError = 'upstash write HTTP 401: NOPERM'; return Promise.resolve(false); } };
    const q = createRouteQuota({ adapter: ro, dayCap: 5, now: () => now });
    await q.init(); await new Promise((r) => setTimeout(r, 0));
    const s1 = q.status();
    ok(s1.store === 'mock-ro' && s1.synced && /401/.test(s1.lastError) && s1.lastSavedAt === null, 'status() reports the refused write: ' + s1.lastError);
    const okStore = { name: 'mock-ok', load() { return Promise.resolve(null); }, save() { return Promise.resolve(true); } };
    const q2 = createRouteQuota({ adapter: okStore, dayCap: 5, now: () => now });
    await q2.init(); await new Promise((r) => setTimeout(r, 0));
    ok(q2.status().lastError === '' && !!q2.status().lastSavedAt, 'a successful write clears the error and records the time');
  }
})();
