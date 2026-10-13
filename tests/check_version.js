// Fails if package.json version and the ?v= cache-busters in index.html disagree.
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync(__dirname + '/../package.json', 'utf8')).version;
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const vs = [...new Set([...html.matchAll(/\?v=(\d+\.\d+\.\d+)/g)].map(m => m[1]))];
if (vs.length === 1 && vs[0] === pkg) { console.log('PASS  version consistent: ' + pkg); }
else { console.log('FAIL  package.json=' + pkg + ' index.html=' + JSON.stringify(vs)); process.exitCode = 1; }
