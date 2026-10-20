/**
 * Automated Unit Tests for TurnAudioEngine (turn-audio.js)
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  TurnAudioEngine,
  MANEUVER_MAP,
  COMBINED_MAP,
  DISTANCE_MAP,
  snapDistance,
  maneuverOf
} = require("../turn-audio.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    console.log("FAIL  " + name + "\n      " + e.message);
    process.exitCode = 1;
  }
}

test("TurnAudioEngine instantiates cleanly with default audio path", () => {
  const engine = new TurnAudioEngine();
  assert.strictEqual(engine.basePath, "/audio/");
  assert.strictEqual(engine.isMuted, false);
});

test("resolveAudio maps single maneuvers to correct MP3 files", () => {
  const engine = new TurnAudioEngine();
  assert.deepStrictEqual(engine.resolveAudio("მოუხვიეთ მარცხნივ"), ["/audio/turn_left.mp3"]);
  assert.deepStrictEqual(engine.resolveAudio("მოუხვიეთ მარჯვნივ"), ["/audio/turn_right.mp3"]);
  assert.deepStrictEqual(engine.resolveAudio("იარეთ პირდაპირ"), ["/audio/straight.mp3"]);
  assert.deepStrictEqual(engine.resolveAudio("მიხვედით დანიშნულების ადგილზე"), ["/audio/arrive.mp3"]);
  assert.deepStrictEqual(engine.resolveAudio("მარშრუტს აცდით. ახალი მარშრუტი ითვლება"), ["/audio/reroute.mp3"]);
});

test("resolveAudio maps combined distance cues to single seamless audio files", () => {
  const engine = new TurnAudioEngine();
  assert.deepStrictEqual(engine.resolveAudio("500 მეტრში, მოუხვიეთ მარცხნივ"), ["/audio/in_500m_turn_left.mp3"]);
  assert.deepStrictEqual(engine.resolveAudio("200 მეტრში, მოუხვიეთ მარჯვნივ"), ["/audio/in_200m_turn_right.mp3"]);
  assert.deepStrictEqual(engine.resolveAudio("50 მეტრში, მოუხვიეთ მარცხნივ"), ["/audio/in_50m_turn_left.mp3"]);
  assert.deepStrictEqual(engine.resolveAudio("100 მეტრში, მოუხვიეთ მარჯვნივ ჭავჭავაძის გამზირზე"), ["/audio/in_100m_turn_right.mp3"]);
});

test("resolveAudio maps safety and traffic alerts", () => {
  const engine = new TurnAudioEngine();
  assert.deepStrictEqual(engine.resolveAudio("ყურადღება, შუქნიშანი წინ"), ["/audio/traffic_signal.mp3"]);
  assert.deepStrictEqual(engine.resolveAudio("შეანელეთ სვლა, სიჩქარის შეზღუდვა"), ["/audio/speed_limit.mp3"]);
  assert.deepStrictEqual(engine.resolveAudio("წინ საცობია"), ["/audio/traffic_jam.mp3"]);
});

test("resolveAudio chains distance and maneuver when not pre-combined", () => {
  const engine = new TurnAudioEngine();
  const chained = engine.resolveAudio("800 მეტრში, იარეთ პირდაპირ");
  assert.deepStrictEqual(chained, ["/audio/in_800m.mp3", "/audio/straight.mp3"]);
});

test("setMuted silences playback and prevents resolving audio execution", () => {
  const engine = new TurnAudioEngine();
  engine.setMuted(true);
  assert.strictEqual(engine.isMuted, true);
  const played = engine.play("მოუხვიეთ მარცხნივ");
  assert.strictEqual(played, false);
});

test("all audio files referenced in maps exist on disk and exceed 5KB", () => {
  const audioDir = path.join(__dirname, "..", "audio");
  assert.ok(fs.existsSync(audioDir), "audio directory must exist");

  const allFiles = new Set([
    ...Object.values(MANEUVER_MAP),
    ...Object.values(COMBINED_MAP),
    ...Object.values(DISTANCE_MAP),
    "traffic_signal.mp3",
    "speed_limit.mp3",
    "traffic_jam.mp3"
  ]);

  for (const filename of allFiles) {
    const fullPath = path.join(audioDir, filename);
    assert.ok(fs.existsSync(fullPath), `Audio file ${filename} missing on disk!`);
    const size = fs.statSync(fullPath).size;
    assert.ok(size > 5000, `Audio file ${filename} too small: ${size} bytes`);
  }
});

// ---- real prompts (v3.10.49): Google Routes' Georgian wording and the measured distances routing.js / gmap.js speak ----
test("Google mode prompts from the car (photos 2026-10-20) find their clips", () => {
  const engine = new TurnAudioEngine();
  const files = (t) => engine.resolveAudio(t).map((u) => u.replace("/audio/", ""));
  assert.deepStrictEqual(files("480 მეტრში, შეუხვიეთ მარცხნივ სიმონ კანდელაკის ქუჩაზე"), ["in_500m_turn_left.mp3"]);
  assert.deepStrictEqual(files("შეუხვიეთ მარცხნივ სიმონ კანდელაკის ქუჩაზე"), ["turn_left.mp3"]);
  assert.deepStrictEqual(files("190 მეტრში, შეუხვიეთ მარჯვნივ თინა იოსებიძის ქუჩაზე"), ["in_200m_turn_right.mp3"]);
  assert.deepStrictEqual(files("განაგრძეთ გზა გ. სააკაძის მოედანი-ზე"), ["straight.mp3"]);
  assert.deepStrictEqual(files("გაემართეთ გიორგი სააკაძის მოედანი-ზე"), ["straight.mp3"]);
  assert.deepStrictEqual(files("780 მეტრში, განაგრძეთ გზა"), ["in_800m.mp3", "straight.mp3"]);
  assert.deepStrictEqual(files("დარჩით მარჯვნივ რუსთაველის გამზირისკენ"), ["slight_right.mp3"]);
  assert.deepStrictEqual(files("მარშრუტი გადაითვალა"), ["reroute.mp3"]);
  assert.deepStrictEqual(files("დანიშნულების ადგილზე მიხვედით"), ["arrive.mp3"]);
  assert.deepStrictEqual(files("მარშრუტი დაწყებულია. გაემართეთ ჩრდილოეთით"), ["route_started.mp3"]);
});

test("main map (routing.js) measured distances keep their distance", () => {
  const engine = new TurnAudioEngine();
  const files = (t) => engine.resolveAudio(t).map((u) => u.replace("/audio/", ""));
  assert.deepStrictEqual(files("490 მეტრში, მოუხვიეთ მარჯვნივ აბაშიძე-ზე"), ["in_500m_turn_right.mp3"]);
  assert.deepStrictEqual(files("80 მეტრში, ოდნავ მარცხნივ"), ["in_100m.mp3", "slight_left.mp3"]);
  assert.deepStrictEqual(files("მოუხვიეთ მარჯვნივ აბაშიძე-ზე"), ["turn_right.mp3"]);
  assert.deepStrictEqual(files("მარშრუტს აცდით. ახალი მარშრუტი ითვლება."), ["reroute.mp3"]);
});

test("never a turn clip without its distance (would sound like 'turn now' far too early)", () => {
  const engine = new TurnAudioEngine();
  assert.deepStrictEqual(engine.resolveAudio("1500 მეტრში, შეუხვიეთ მარჯვნივ"), []);
  assert.deepStrictEqual(engine.resolveAudio("300 მეტრში, უცნობი მანევრი"), []);
  assert.strictEqual(snapDistance(480), 500);
  assert.strictEqual(snapDistance(45), 50);
  assert.strictEqual(snapDistance(1200), null);
  assert.strictEqual(maneuverOf("მკვეთრად შეუხვიეთ მარცხნივ"), "მოუხვიეთ მარცხნივ");
});

test("every prompt gmap.js voice cues produce for a left turn resolves to a clip", () => {
  const engine = new TurnAudioEngine();
  const G = require("../gmap.js");
  const vc = G.createVoiceCues(), step = { text: "შეუხვიეთ მარცხნივ სიმონ კანდელაკის ქუჩაზე" };
  const said = [];
  for (let d = 900; d >= 0; d -= 7) { const t = vc.update(1, step, d, 40); if (t) said.push(t); }
  assert.strictEqual(said.length, 3);
  said.forEach((t) => assert.ok(engine.resolveAudio(t).length > 0, "no clip for: " + t));
});

console.log("\n" + passed + " turn audio tests passed" + (process.exitCode ? " - WITH FAILURES" : ""));
