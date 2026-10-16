// Fails if package.json version and the ?v= cache-busters in index.html disagree.
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync(__dirname + '/../package.json', 'utf8')).version;
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const vs = [...new Set([...html.matchAll(/\?v=(\d+\.\d+\.\d+)/g)].map(m => m[1]))];
if (vs.length === 1 && vs[0] === pkg) { console.log('PASS  version consistent: ' + pkg); }
else { console.log('FAIL  package.json=' + pkg + ' index.html=' + JSON.stringify(vs)); process.exitCode = 1; }
const app = fs.readFileSync(__dirname + '/../app.js', 'utf8');
const m = app.match(/APP_VERSION = "(\d+\.\d+\.\d+)"/);
if (m && m[1] === pkg) { console.log('PASS  app.js APP_VERSION matches: ' + pkg); }
else { console.log('FAIL  app.js APP_VERSION=' + (m && m[1]) + ' package.json=' + pkg); process.exitCode = 1; }
// Every local <script src> in index.html must be served by server.js (STATIC_WHITELIST), otherwise it 404s in production.
const srv = fs.readFileSync(__dirname + '/../server.js', 'utf8');
const wl = (srv.match(/STATIC_WHITELIST = new Set\(\[([\s\S]*?)\]\)/) || [, ''])[1];
const allowed = new Set([...wl.matchAll(/'([^']+)'/g)].map(m => m[1]));
const scripts = [...html.matchAll(/<script src="([^"?]+)(?:\?[^"]*)?"/g)].map(m => m[1]).filter(s => !/^https?:/.test(s));
const missing = scripts.filter(s => !allowed.has(s));
if (!missing.length) { console.log('PASS  all ' + scripts.length + ' index.html scripts are in the server whitelist'); }
else { console.log('FAIL  scripts not served by server.js: ' + missing.join(', ')); process.exitCode = 1; }
