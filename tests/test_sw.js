// Service worker page loading (v3.10.65, audit H3): a sleeping Render server must not leave a blank screen.
// sw.js runs here against small fakes of the worker globals; the 3 s timeout is shortened to 50 ms for the test.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };

function load(fetchImpl, cache) {
  const handlers = {};
  const put = [];
  const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8').replace(/const NAV_TIMEOUT_MS = \d+;/, 'const NAV_TIMEOUT_MS = 50;');
  const ctx = {
    self: { addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting() {}, clients: { claim() {} } },
    location: { origin: 'https://apev.onrender.com' },
    caches: {
      match: async (k) => cache[typeof k === 'string' ? k : new URL(k.url).pathname] || undefined,
      open: async () => ({ put: (k, v) => put.push(v), addAll: async () => {} }),
      keys: async () => [], delete: async () => true
    },
    fetch: fetchImpl, URL, Promise, setTimeout, clearTimeout, console,
    Response: { error: () => ({ error: true }) }
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { handlers, put };
}
const res = (body, headers) => ({ status: 200, body, headers: { get: (h) => (headers || {})[h] || null }, clone() { return this; } });
function navigate(h) {
  return new Promise((resolve) => {
    h.handlers.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://apev.onrender.com/' }, respondWith: (p) => Promise.resolve(p).then(resolve), waitUntil() {} });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. sleeping server (answers after 400 ms), page in the cache -> the cached page after ~50 ms
  let h = load(() => wait(400).then(() => res('fresh')), { '/': res('cached') });
  let t0 = Date.now(), r = await navigate(h);
  ok(r.body === 'cached' && Date.now() - t0 < 300, 'slow server + cached page: the cached page is shown at once (' + (Date.now() - t0) + ' ms)');
  await wait(450);
  ok(h.put.some((x) => x.body === 'fresh'), 'the late network answer still refreshes the cache');

  // 2. fast server -> the network page
  h = load(() => Promise.resolve(res('fresh')), { '/': res('cached') });
  r = await navigate(h);
  ok(r.body === 'fresh', 'fast server: the network page is shown');

  // 3. slow server, nothing cached -> waits for the network
  h = load(() => wait(200).then(() => res('fresh')), {});
  r = await navigate(h);
  ok(r.body === 'fresh', 'nothing cached: waits for the network');

  // 4. offline -> cached page
  h = load(() => Promise.reject(new Error('offline')), { '/': res('cached') });
  r = await navigate(h);
  ok(r.body === 'cached', 'offline: the cached page');

  // 5. the PIN page is never cached as the app
  h = load(() => Promise.resolve(res('pin page', { 'X-Pin-Page': '1' })), {});
  await navigate(h); await wait(20);
  ok(h.put.length === 0, 'the PIN login page is not cached');

  // 6. v3.10.73: installing while signed out must not precache the PIN page as the app page
  const stored = {};
  {
    const handlers = {};
    const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
    const ctx = {
      self: { addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting() {}, clients: { claim() {} } },
      location: { origin: 'https://apev.onrender.com' },
      caches: { open: async () => ({ put: async (k, v) => { stored[k] = v; }, addAll: async (list) => { list.forEach((k) => { stored[k] = 'asset'; }); } }), match: async () => undefined, keys: async () => [], delete: async () => true },
      fetch: async (u) => res(u === '/' || u === '/index.html' ? 'pin page' : 'x', u === '/' || u === '/index.html' ? { 'X-Pin-Page': '1' } : {}),
      URL, Promise, setTimeout, clearTimeout, console, Response: { error: () => ({}) }
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    let done;
    handlers.install({ waitUntil: (p) => { done = p; } });
    await done;
  }
  ok(!stored['/'] && !stored['/index.html'], 'install while signed out: the PIN page is not precached as "/"');
  ok(stored['/app.js?v=' + require('../package.json').version] === 'asset', 'install still precaches the app files');

  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/'X-Pin-Page': '1'/.test(srv), 'the server marks its PIN page');

  process.exitCode = fails ? 1 : 0;
  console.log(fails ? fails + ' service worker tests FAILED' : 'service worker tests passed');
})();
