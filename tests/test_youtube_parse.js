// YouTube results parser (server.js) against a synthetic ytInitialData page + the regex fallback. No network.
const fs = require('fs'), vm = require('vm');
let fails = 0; process.on('exit', () => { if (fails) process.exitCode = 1; });
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };

const src = fs.readFileSync(__dirname + '/../server.js', 'utf8');
const i = src.indexOf('function parseYouTubeResults'), j = src.indexOf('// Official YouTube Data API');
if (i < 0 || j < 0) { console.log('FAIL  parser not found in server.js'); process.exit(1); }
const ctx = {}; vm.createContext(ctx); vm.runInContext(src.slice(i, j), ctx);
const parse = ctx.parseYouTubeResults;

const vr = (id, t, ch, len) => ({ videoRenderer: { videoId: id, title: { runs: [{ text: t }] }, ownerText: { runs: [{ text: ch }] }, lengthText: { simpleText: len } } });
const data = { contents: { a: [vr('aaaaaaaaaaa', 'Song One', 'Chan A', '3:21'), { x: vr('bbbbbbbbbbb', 'Song <b>Two</b>', 'Chan B', '4:00') }, vr('aaaaaaaaaaa', 'Dup', 'X', '1:00'), vr('bad', 'Short id', 'X', '1:00')] } };
const page = '<html><script>var ytInitialData = ' + JSON.stringify(data) + ';</script></html>';
let r = parse(page, 6);
ok(r.length === 2, 'two valid unique videos parsed (duplicate and bad id dropped)');
ok(r[0].videoId === 'aaaaaaaaaaa' && r[0].title === 'Song One' && r[0].channel === 'Chan A' && r[0].length === '3:21', 'fields extracted');
ok(r[1].title === 'Song <b>Two</b>', 'title kept raw (client renders it with textContent, no HTML injection)');
ok(parse(page, 1).length === 1, 'max limit respected');
const fb = parse('..."videoId":"ccccccccccc","thumbnail":{},"title":{"runs":[{"text":"Fallback \\"Q\\""}]}...', 6);
ok(fb.length === 1 && fb[0].videoId === 'ccccccccccc' && fb[0].title === 'Fallback "Q"', 'regex fallback works when ytInitialData is missing');
ok(parse('<html>nothing</html>', 6).length === 0, 'empty page -> empty list');

// ---- official-API helpers ----
const k = src.indexOf('function decodeHtmlEntities'), l = src.indexOf('function httpsGetJson');
const ctx2 = {}; vm.createContext(ctx2); vm.runInContext(src.slice(k, l), ctx2);
ok(ctx2.decodeHtmlEntities('Rock &amp; Roll &#39;24 &quot;x&quot; &lt;b&gt;') === 'Rock & Roll \'24 "x" <b>', 'API titles: HTML entities decoded');
ok(ctx2.isoDurationToText('PT3M21S') === '3:21' && ctx2.isoDurationToText('PT1H2M3S') === '1:02:03' && ctx2.isoDurationToText('PT45S') === '0:45', 'ISO-8601 durations formatted');
ok(ctx2.isoDurationToText('') === '' && ctx2.isoDurationToText('garbage') === '', 'bad duration -> empty string');
ok(!/console\.(log|warn|error)\([^)]*YOUTUBE_API_KEY/.test(src), 'API key is never logged');

// ---- InnerTube answers raw JSON (no ytInitialData wrapper) ----
const rawJson = JSON.stringify({ contents: { x: [vr('ddddddddddd', 'Raw JSON Song', 'Chan D', '2:02')] } });
const rj = parse(rawJson, 6);
ok(rj.length === 1 && rj[0].videoId === 'ddddddddddd' && rj[0].length === '2:02', 'raw JSON response (InnerTube) is parsed too');
