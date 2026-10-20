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
  DISTANCE_MAP
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

console.log("\n" + passed + " turn audio tests passed" + (process.exitCode ? " - WITH FAILURES" : ""));
