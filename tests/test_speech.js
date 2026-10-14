/**
 * Automated Unit Tests for SpeechAssistant (Authentic Georgian Voice & Audio Chimes)
 */
const assert = require("assert");
const { SpeechAssistant } = require("../speech.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    console.error(" FAIL " + name + ":", e.message);
    process.exitCode = 1;
  }
}

// Mock Web Audio API and SpeechSynthesis for Node testing
function setupMocks() {
  const chimeEvents = [];
  const spokenUtterances = [];

  class MockOscillator {
    constructor() { this.frequency = { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }; }
    connect() {}
    start() {}
    stop() {}
  }

  class MockGain {
    constructor() { this.gain = { setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }; }
    connect() {}
  }

  class MockAudioContext {
    constructor() {
      this.currentTime = 0;
      this.state = "running";
      this.destination = {};
    }
    createOscillator() { return new MockOscillator(); }
    createGain() { return new MockGain(); }
    resume() { return Promise.resolve(); }
  }

  class MockSpeechSynthesisUtterance {
    constructor(text) {
      this.text = text;
      this.lang = "";
      this.voice = null;
      this.rate = 1.0;
      this.pitch = 1.0;
    }
  }

  const mockSynth = {
    cancelled: false,
    cancel() { this.cancelled = true; },
    speak(utterance) { spokenUtterances.push(utterance); },
    getVoices() {
      return [
        { name: "Microsoft David - English (United States)", lang: "en-US" },
        { name: "Microsoft Zira - English (United States)", lang: "en-US" },
        { name: "Google US English", lang: "en-US" }
      ];
    }
  };

  global.window = {
    AudioContext: MockAudioContext,
    webkitAudioContext: MockAudioContext,
    speechSynthesis: mockSynth
  };
  global.SpeechSynthesisUtterance = MockSpeechSynthesisUtterance;

  return { chimeEvents, spokenUtterances, mockSynth };
}

test("SpeechAssistant instantiates and sets default properties", () => {
  setupMocks();
  const assistant = new SpeechAssistant();
  assert.strictEqual(assistant.isMuted, false);
  assert.strictEqual(assistant.minIntervalMs, 3500);
});

test("speak NEVER falls back to English voices when only English is installed", () => {
  const { spokenUtterances } = setupMocks();
  const assistant = new SpeechAssistant();

  assistant.speak("500 მეტრში შეუხვიეთ მარჯვნივ");

  assert.strictEqual(spokenUtterances.length, 1);
  const u = spokenUtterances[0];
  assert.strictEqual(u.lang, "ka-GE", "Utterance lang must strictly be Georgian ka-GE");
  assert.strictEqual(u.voice, null, "Utterance voice must NOT fall back to an English voice!");
});

test("speak selects Georgian voice when ka voice is present", () => {
  const { spokenUtterances, mockSynth } = setupMocks();
  mockSynth.getVoices = () => [
    { name: "Microsoft David", lang: "en-US" },
    { name: "Georgian Voice (Eka)", lang: "ka-GE" }
  ];

  const assistant = new SpeechAssistant();
  assistant.speak("შეუხვიეთ მარცხნივ");

  assert.strictEqual(spokenUtterances.length, 1);
  const u = spokenUtterances[0];
  assert.strictEqual(u.lang, "ka-GE");
  assert.ok(u.voice !== null, "Should select Georgian voice");
  assert.strictEqual(u.voice.lang, "ka-GE");
});

test("playChime triggers navigation audio cues for left, right, arrival, and alerts", () => {
  setupMocks();
  const assistant = new SpeechAssistant();
  const playedChimes = [];
  assistant.playChime = (type) => playedChimes.push(type);

  assistant.speak("100 მეტრში შეუხვიეთ მარჯვნივ ჭავჭავაძის გამზირზე");
  assert.strictEqual(playedChimes[playedChimes.length - 1], "turn-right");

  assistant.lastPromptTime = 0; // reset debounce for testing
  assistant.speak("შეუხვიეთ მარცხნივ რუსთაველის გამზირზე");
  assert.strictEqual(playedChimes[playedChimes.length - 1], "turn-left");

  assistant.lastPromptTime = 0;
  assistant.speak("მიხვედით დანიშნულების ადგილზე!");
  assert.strictEqual(playedChimes[playedChimes.length - 1], "arrive");

  assistant.lastPromptTime = 0;
  assistant.speak("ყურადღება, შუქნიშანი 150 მეტრში");
  assert.strictEqual(playedChimes[playedChimes.length - 1], "alert");
});

test("toggleMute silences both audio chimes and voice synthesis", () => {
  const { spokenUtterances } = setupMocks();
  const assistant = new SpeechAssistant();

  const isMuted = assistant.toggleMute();
  assert.strictEqual(isMuted, true);
  assert.strictEqual(assistant.isMuted, true);

  assistant.speak("შეუხვიეთ მარჯვნივ");
  assert.strictEqual(spokenUtterances.length, 0, "No speech while muted");

  assistant.toggleMute();
  assert.strictEqual(assistant.isMuted, false);
});

test("deduplicates identical prompts within minIntervalMs", () => {
  const { spokenUtterances } = setupMocks();
  const assistant = new SpeechAssistant();

  assistant.speak("გააგრძელეთ პირდაპირ");
  assistant.speak("გააგრძელეთ პირდაპირ"); // immediate repeat

  assert.strictEqual(spokenUtterances.length, 1, "Immediate duplicate should be ignored");
});

console.log("\n" + passed + " speech tests passed");
