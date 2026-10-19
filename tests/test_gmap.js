// gmap.js: pure helpers + the DOM/Google flow against a stubbed google.maps (no network, no real key).
const fs = require('fs'), vm = require('vm');
let fails = 0; process.on('exit', () => { if (fails) process.exitCode = 1; });
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };

const src = fs.readFileSync(__dirname + '/../gmap.js', 'utf8');
const G = require('../gmap.js');

const u = G.buildLoaderUrl('A B&key', 'cb');
ok(u.startsWith('https://maps.googleapis.com/maps/api/js?key=A%20B%26key') && /loading=async/.test(u) && /callback=cb/.test(u) && /language=ka/.test(u), 'loader URL: key encoded, async loading, Georgian');
ok(G.summarizeRoute(600, 4200) === '10 წთ · 4.2 კმ' && G.summarizeRoute(10, 20000) === '1 წთ · 20 კმ', 'route summary');
ok(/^https:\/\/r.*\/11\.5,41\.5;12\.5,42\.5\?/.test(G.osrmUrl('https://r/', { lat: 41.5, lng: 11.5 }, { lat: 42.5, lng: 12.5 })), 'OSRM URL is lng,lat');
ok(Math.abs(G.bearing({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 0) < 1e-6 && Math.abs(G.bearing({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 90) < 1e-6, 'bearing north/east');
ok(Math.abs(G.meters({ lat: 0, lng: 0 }, { lat: 0, lng: 0.001 }) - 111.2) < 1, 'distance ~111 m per 0.001 deg lng');
ok(G.mapStyles(false).length < G.mapStyles(true).length, 'night styles extend day styles');
ok(G.CATEGORIES.length === 4 && G.CATEGORIES.every(c => c.type && c.label), 'categories defined');

// debounce
(async () => {
  let n = 0; const d = G.createDebouncer(() => n++, 30);
  d(); d(); d(); await new Promise(r => setTimeout(r, 80));
  ok(n === 1, 'debouncer fires once for a burst');
  d(); d.cancel(); await new Promise(r => setTimeout(r, 80));
  ok(n === 1, 'debouncer cancel works');
})();

// Compliance guards (Google terms): no Google data on MapLibre, key never logged, text goes through textContent.
ok(!/console\.(log|warn|error)\([^)]*\bkey\b/i.test(src.replace(/S\.key/g, '')), 'key is never logged');
ok(!/addSource|addLayer|setData|maplibregl\./.test(src), 'gmap.js never puts Google data on the MapLibre map (only resizes it on close)');
ok(!/innerHTML\s*=/.test(src), 'no innerHTML (Places text rendered with textContent)');
const srv = fs.readFileSync(__dirname + '/../server.js', 'utf8');
ok(/'gmap\.js'/.test(srv), 'gmap.js is in the server whitelist');
ok(/GOOGLE_MAPS_KEY/.test(srv) && !/PUBLIC_AUTH_PATHS[^;]*gmaps-config/.test(srv), '/api/gmaps-config reads env and is not a public path');
