// Starts the real server and checks the security/regression behaviour we fixed during the audit.
// Run: node tests/smoke_server.js   (exit code 1 on any FAIL)
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 3200 + Math.floor(Math.random() * 500);
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };

function req(method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    if (body) r.write(body);
    r.end();
  });
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { await wait(200); up = (await req('GET', '/')).status === 200; }
  ok(up, 'server starts and serves /');

  for (const f of ['/server.js', '/package.json', '/.git/config', '/chargers-cache.json', '/README.md', '/MASTER_HISTORY_AND_ARCHITECTURE.md', '/FULL_CONVERSATION_TRANSCRIPT.md', '/conversation-logs/transcript.jsonl']) {
    ok((await req('GET', f)).status === 404, f + ' is not served (404)');
  }
  ok((await req('GET', '/%E0%A4%A')).status === 400, 'malformed URI -> 400');
  ok((await req('GET', '/index.html')).status === 200, 'server still alive after the malformed URI');
  const info = await req('GET', '/api/info', { headers: { Host: 'apev.onrender.com' } });
  ok(info.status === 200 && !/localIps|10\.|192\.168\./.test(info.body), '/api/info does not leak internal IPs on a public host');
  ok(!('access-control-allow-origin' in (await req('GET', '/api/info')).headers), 'no wildcard CORS header');
  ok((await req('GET', '/api/chargers/sync', { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status === 403, '/api/chargers/sync is closed without a token');
  const st = await req('GET', '/api/session/status?code=AB12');
  ok(st.status === 400 || /"active"\s*:\s*false/.test(st.body), 'short session code never reports an active session');
  const code = 'ABCDEF1234567890';
  const send = (obj) => req('POST', '/api/session/send', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  ok((await send({ code, type: 'x\nevent: gps', data: { a: 1 } })).status === 400, 'unknown event type rejected (SSE injection)');
  ok((await send({ code, type: 'gps', data: { lat: 999, lng: 44 } })).status === 400, 'invalid coordinates rejected');
  const big = await req('POST', '/api/session/send', { headers: { 'Content-Type': 'application/json' }, body: '{"code":"x","pad":"' + 'a'.repeat(20000) + '"}' });
  ok(big.status === 413 || big.status === 0, 'oversized body rejected');

  srv.kill();
  process.exit(fails ? 1 : 0);
})();
