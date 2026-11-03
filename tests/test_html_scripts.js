/**
 * v3.10.108: every inline <script> of every page must parse. `node --check` (CI) only sees .js files, so a duplicate
 * `const` in remote.html (v3.10.103) broke the whole phone page without any test noticing.
 */
const fs = require('fs'), path = require('path');
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };

const root = path.join(__dirname, '..');
const pages = fs.readdirSync(root).filter((f) => f.endsWith('.html'));
ok(pages.includes('index.html') && pages.includes('remote.html'), 'pages found: ' + pages.join(', '));
for (const page of pages) {
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
  let m, i = 0;
  while ((m = re.exec(html))) {
    if (/type=["'](?!text\/javascript|module)/.test(m[1])) continue;   // JSON / templates are not scripts
    i++;
    let err = null;
    try { new Function(m[2]); } catch (e) { err = e.message; }
    ok(!err, page + ' inline script ' + i + (err ? ': ' + err : ' parses'));
  }
}
if (fails) process.exitCode = 1;
