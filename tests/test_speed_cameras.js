// Speed cameras (v3.10.54): Overpass parsing, "ahead of the car" logic, one warning per camera, badge text, wiring.
global.window = undefined;
const fs = require('fs');
const SC = require('../speed-cameras.js');
let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'PASS' : 'FAIL') + '  ' + m); };

const overpass = { elements: [
  { type: 'node', id: 1, lat: 41.7100, lon: 44.8000, tags: { highway: 'speed_camera', maxspeed: '60', direction: '90' } },
  { type: 'node', id: 2, lat: 41.7200, lon: 44.8000, tags: { highway: 'speed_camera' } },
  { type: 'node', id: 3, lat: 41.7300, lon: 44.8000, tags: { highway: 'speed_camera', maxspeed: '70', enforcement: 'average_speed', direction: '-30' } },
  { type: 'node', id: 4, lat: 41.7400, lon: 44.8000, tags: { highway: 'bus_stop' } },
  { type: 'way', id: 5, tags: { highway: 'speed_camera' } },
  { type: 'node', id: 6, lat: 41.7500, lon: 44.8000, tags: { highway: 'speed_camera', maxspeed: 'signals' } }
] };
const cams = SC.parseOverpass(overpass);
ok(cams.length === 4, 'only real speed-camera nodes are kept (' + cams.length + ')');
ok(cams[0].ms === 60 && cams[0].dir === 90 && !cams[0].avg, 'limit and direction are read');
ok(cams[1].ms === 0 && cams[1].dir === null, 'a camera without a limit still exists (limit 0 = unknown)');
ok(cams[2].avg === true && cams[2].dir === 330, 'average-speed flag and negative direction are normalised');
ok(cams[3].ms === 0, 'a non-numeric limit becomes unknown');
ok(SC.parseOverpass(null).length === 0 && SC.parseOverpass({}).length === 0, 'garbage input gives an empty list');

ok(Math.round(SC.angleDiff(350, 10)) === 20 && Math.round(SC.angleDiff(90, 270)) === 180, 'angle difference wraps around north');
const north = SC.bearingTo(41.70, 44.80, 41.71, 44.80);
ok(north < 1 || north > 359, 'camera straight north has bearing 0');

// car at 41.7000 heading north: one camera ~250 m ahead, one behind, one to the side, one far
const near = { id: 10, lat: 41.7023, lon: 44.8000, ms: 50, dir: null, avg: false };
const behind = { id: 11, lat: 41.6980, lon: 44.8000, ms: 50, dir: null, avg: false };
const side = { id: 12, lat: 41.7005, lon: 44.8040, ms: 50, dir: null, avg: false };
const far = { id: 13, lat: 41.7100, lon: 44.8000, ms: 50, dir: null, avg: false };
const pos = { lat: 41.7000, lng: 44.8000 };
const ahead = SC.findAhead([near, behind, side, far], pos, 0, 350, 30);
ok(ahead.length === 1 && ahead[0].cam.id === 10, 'only the camera ahead within range is found (not behind, not beside, not far)');
ok(SC.findAhead([near], pos, 180, 350, 30).length === 0, 'driving away from the camera: no warning');
ok(SC.findAhead([near], pos, null, 350, 30).length === 0, 'unknown heading: no warning');
ok(SC.findAhead([Object.assign({}, near, { dir: 180 })], pos, 0, 350, 30).length === 0, 'a camera that watches the other carriageway: no warning');
ok(SC.findAhead([Object.assign({}, near, { dir: 20 })], pos, 0, 350, 30).length === 1, 'a camera facing our direction: warning');

// engine: one announcement, the badge stays while the camera is ahead, silence until the repeat time
const store = { v: {}, getItem(k) { return this.v[k] == null ? null : this.v[k]; }, setItem(k, v) { this.v[k] = String(v); } };
const eng = new SC.SpeedCamerasEngine({ storage: store, autoLoad: false });
ok(eng.isEnabled === true, 'on by default');
eng.cameras = [near, far]; eng.loaded = true;
const t0 = 1000000;
let r = eng.update(pos, 0, 50, t0);
ok(r.hit && r.hit.cam === near && r.announce === true, 'first approach: badge + announcement');
ok(SC.badgeText(r.hit) === '📷 250 მ · 50', 'badge text: ' + SC.badgeText(r.hit));
ok(/სიჩქარის კამერა 250 მეტრში, ლიმიტი 50/.test(SC.promptText(r.hit)) && /^ყურადღება/.test(SC.promptText(r.hit)), 'spoken text starts with ყურადღება (alert chime): ' + SC.promptText(r.hit));
r = eng.update(pos, 0, 50, t0 + 5000);
ok(r.hit && r.announce === false, 'a few seconds later: badge still shown, not spoken again');
ok(eng.update(pos, 0, 50, t0 + 4 * 60 * 1000).announce === true, 'announced again on a later pass');
ok(eng.update(pos, 0, 5, t0 + 10 * 60 * 1000).hit === null, 'standing in a queue (<15 km/h): nothing');
ok(SC.badgeText(null) === '', 'no camera: empty badge');
ok(eng.toggle() === false && store.v[SC.STORAGE_KEY] === '0', 'switching off is remembered');
ok(eng.update(pos, 0, 50, t0 + 20 * 60 * 1000).hit === null, 'switched off: nothing');
ok(new SC.SpeedCamerasEngine({ storage: store, autoLoad: false }).isEnabled === false, 'stays off after a reload');

// the Georgian clip pack must not read "300 მეტრში" in the camera prompt as a turn
const TA = require('../turn-audio.js');
ok(!TA.maneuverOf(SC.promptText(r.hit || { dist: 300, cam: near })), 'turn-audio finds no manoeuvre in the camera prompt (no wrong clip)');
const taEng = new TA.TurnAudioEngine();
ok(JSON.stringify(taEng.resolveAudio(SC.promptText({ dist: 250, cam: near }))) === '[]', 'the camera prompt plays no clip at all (it used to play speed_limit.mp3; audit M1)');
ok(taEng.resolveAudio('შეანელეთ სიჩქარე').length === 1, 'a real speed prompt still plays its clip');

// wiring: no map layer any more, the server proxies Overpass, the page shows a badge in the always-visible HUD
const app = fs.readFileSync(__dirname + '/../app.js', 'utf8');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const srv = fs.readFileSync(__dirname + '/../server.js', 'utf8');
const src = fs.readFileSync(__dirname + '/../speed-cameras.js', 'utf8');
ok(!/addLayer|layerRegistry|addImage/.test(src), 'speed-cameras.js draws nothing on the map');
ok(app.includes('checkSpeedCameras({ lat, lng }, speed)') && app.includes('new SpeedCamerasEngine()'), 'app.js checks every GPS fix');
ok(/class="car-hud-stats"[\s\S]{0,600}id="camera-badge"/.test(html) && html.includes('id="btn-toggle-cameras"'), 'badge sits in the speedometer HUD (shown in Google mode too), dock has a toggle');
ok(srv.includes("pathname === '/api/cameras'") && srv.includes("'speed-cameras.js'") && !/PUBLIC_AUTH_PATHS[^;]*cameras/.test(srv), '/api/cameras exists behind the PIN gate, the file is whitelisted');

// v3.10.68 (audit H2/M4): working Overpass mirrors, longer waits, cameras kept in Upstash, a stale list served at once
const sl = fs.readFileSync(__dirname + '/../speed-limit.js', 'utf8'), ts = fs.readFileSync(__dirname + '/../traffic-signals.js', 'utf8');
ok(![srv, sl, ts].some((x) => /kumi.systems/.test(x)), 'the dead overpass.kumi.systems mirror is gone everywhere');
ok([sl, ts].every((x) => x.includes('overpass.private.coffee') && x.includes('ctrl.abort(), 20000')), 'speed limit + signals: two mirrors, 20 s wait');
ok(srv.includes('_cameras') && srv.includes('CAMERAS_STORE.save(camerasCache)') && srv.includes('if (has) { refreshCameras(); return camerasCache; }'), 'cameras: kept in Upstash, a stale list answers at once');
process.exitCode = fails ? 1 : 0;
console.log(fails ? fails + ' speed camera tests FAILED' : 'speed camera tests passed');
