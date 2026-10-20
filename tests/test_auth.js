// Sign-in and the owner's devices panel (v3.10.60). Starts the real server with three PINs (master + 2 guests) and a temp
// DATA_DIR (file store, no Upstash), then checks: master-only panel, guest single-device lock, sign-out, the pre-v3.10.60
// shared master cookie, cross-site POSTs, and that devices survive a restart (what Upstash gives on Render).
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const AS = require('../auth-store.js');
const DP = require('../devices-panel.js');

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };
const PINS = ['Owner-Pin-8x', 'guestOne11', 'guestTwo22'];
const SECRET = 'test-secret-' + crypto.randomBytes(4).toString('hex');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'teslanav-auth-'));
const PORT = 3700 + Math.floor(Math.random() * 500);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
const TESLA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 Tesla/2024.44';

function req(method, p, { cookie, body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const h = Object.assign({}, headers);
    if (cookie) h.Cookie = 'tesla_auth=' + cookie;
    if (body) h['Content-Type'] = 'application/json';
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, body: d, json: j }); });
    });
    r.on('error', () => resolve({ status: 0, headers: {}, body: '', json: null }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (res) => { const c = (res.headers['set-cookie'] || [])[0] || ''; const m = /tesla_auth=([^;]+)/.exec(c); return m ? m[1] : null; };
const login = async (pin, ua, cookie) => cookieOf(await req('POST', '/api/auth/pin', { body: { pin }, headers: { 'User-Agent': ua || 'test' }, cookie }));
const isIn = async (cookie) => { const r = await req('GET', '/', { cookie }); return r.status === 200 && /app\.js/.test(r.body); };

function start() {
  const env = Object.assign({}, process.env, { PORT: String(PORT), ACCESS_PIN: PINS.join(','), AUTH_SECRET: SECRET, DATA_DIR: DATA });
  delete env.UPSTASH_REDIS_REST_URL; delete env.UPSTASH_REDIS_REST_TOKEN;
  return spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
}
async function up() { for (let i = 0; i < 50; i++) { await wait(200); if ((await req('GET', '/healthz')).status === 200) return true; } return false; }

(async () => {
  // pure helpers
  ok(AS.deviceLabel(TESLA) === 'Tesla' && AS.deviceLabel(IPHONE) === 'iPhone' && AS.deviceLabel('') === 'მოწყობილობა', 'device names from the user agent');
  ok(AS.maskIp('85.117.40.12') === '85.117.x.x' && AS.shortId('abc').length === 8, 'masked IP, short id');
  ok(DP.ago(Date.now() - 30e3) === 'ახლა' && DP.ago(Date.now() - 5 * 60e3) === '5 წთ წინ' && DP.ago(0) === '', 'relative times');
  const v = DP.rows({ masters: [{ id: 'a1', label: 'Tesla', current: true, lastSeen: Date.now() }, { id: 'legacy', label: 'ძველი', current: false }], guests: [{ id: 'guest-1', n: 1, bound: false }] });
  ok(v.masters[0].action === null && v.masters[1].action === 'გამოყვანა' && v.guests[0].action === null, 'panel rows: no button for this device or a free guest PIN');

  let srv = start();
  ok(await up(), 'server starts with three PINs');

  ok((await req('GET', '/api/admin/devices')).status === 401, 'not signed in: panel API is closed');
  const A = await login(PINS[0], TESLA);
  const B = await login(PINS[0], IPHONE);
  ok(A && B && A !== B && !A.includes(':master:'), 'each master sign-in gets its own device token');
  let d = await req('GET', '/api/admin/devices', { cookie: A });
  ok(d.status === 200 && d.json.masters.filter((m) => m.id !== 'legacy').length === 2, 'owner sees both of their devices');
  ok(d.json.masters.some((m) => m.current && m.label === 'Tesla'), 'the current device is marked');
  ok(d.json.guests.length === 2 && d.json.guests.every((g) => !g.bound), 'two guest PINs, both free');
  ok(!d.body.includes(PINS[1]) && !d.body.includes(A.split(':')[1]), 'no PIN and no device token in the panel data');

  const pinIdOf = (p) => crypto.createHash('sha256').update('pin-id:' + p).digest('hex').slice(0, 16);
  const sign = (p, t) => { const data = pinIdOf(p) + ':' + t; return data + ':' + crypto.createHmac('sha256', SECRET).update(data).digest('hex'); };
  const L = sign(PINS[0], 'master');
  ok(await isIn(L), 'a pre-v3.10.60 master cookie still works (nobody is signed out by the update)');

  const G = await login(PINS[1], IPHONE);
  ok(G && await isIn(G), 'guest 1 signs in on the first device');
  ok((await req('GET', '/api/admin/devices', { cookie: G })).status === 403, 'guest: panel data refused (403)');
  ok((await req('POST', '/api/admin/revoke-others', { cookie: G, body: {} })).status === 403, 'guest: actions refused (403)');
  ok(!(await login(PINS[1], 'other phone')), 'guest PIN on a second device is refused');
  d = await req('GET', '/api/admin/devices', { cookie: A });
  ok(d.json.guests[0].bound && d.json.guests[0].label === 'iPhone', 'owner sees guest 1 bound to an iPhone');

  ok((await req('POST', '/api/admin/revoke', { cookie: A, body: { id: 'guest-1' }, headers: { Origin: 'https://evil.example', Host: '127.0.0.1:' + PORT } })).status === 403, 'cross-site POST refused');

  srv.kill(); await wait(300);
  srv = start();
  ok(await up(), 'server restarts (a deploy)');
  ok(await isIn(A) && await isIn(G), 'after the restart: owner and guest are still signed in (the store survived)');
  ok(!(await login(PINS[1], 'other phone')), 'after the restart: the guest PIN is still bound (not free for anyone)');

  d = await req('POST', '/api/admin/revoke', { cookie: A, body: { id: 'guest-1' } });
  ok(d.status === 200 && !d.json.guests[0].bound, 'owner frees guest 1');
  ok(!(await isIn(G)), 'the freed guest device is signed out');
  const idB = (await req('GET', '/api/admin/devices', { cookie: A })).json.masters.find((m) => m.label === 'iPhone').id;
  ok((await req('POST', '/api/admin/revoke', { cookie: A, body: { id: idB } })).status === 200 && !(await isIn(B)), 'owner signs out their iPhone');
  const idA = (await req('GET', '/api/admin/devices', { cookie: A })).json.masters.find((m) => m.current).id;
  ok((await req('POST', '/api/admin/revoke', { cookie: A, body: { id: idA } })).status === 409 && await isIn(A), 'the current device cannot sign itself out from the panel');

  const r = await req('POST', '/api/admin/revoke-others', { cookie: L, body: {} });
  const L2 = cookieOf(r);
  ok(r.status === 200 && L2 && await isIn(L2), 'sign out all others from an old cookie: this device gets its own token');
  ok(!(await isIn(L)) && !(await isIn(A)), 'old shared cookies and every other device are signed out');
  ok(r.json.masters.length === 1 && r.json.masters[0].current && !r.json.masters.some((m) => m.id === 'legacy'), 'only this device is left');

  srv.kill();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (_) {}
  process.exitCode = fails ? 1 : 0;
  console.log(fails ? fails + ' auth tests FAILED' : 'auth tests passed');
})();
