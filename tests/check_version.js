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
