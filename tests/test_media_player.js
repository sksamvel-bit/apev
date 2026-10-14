/* Automated Unit Tests for MediaPlayerEngine (Playlist Queue & Controls) */
const assert = require("assert");
const { PRESET_TRACKS, MediaPlayerEngine } = require("../media-player.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    console.error("FAIL  " + name + "\n      " + e.message);
    process.exitCode = 1;
  }
}

// Mock iframe and container for Node.js testing
function createMockPlayer() {
  const messages = [];
  const fakeIframe = {
    src: "",
    contentWindow: {
      postMessage: (msg) => { messages.push(JSON.parse(msg)); }
    }
  };
  const fakeContainer = {
    classList: {
      classes: new Set(),
      add(c) { this.classes.add(c); },
      remove(c) { this.classes.delete(c); },
      toggle(c, force) {
        if (force === undefined) {
          if (this.classes.has(c)) this.classes.delete(c); else this.classes.add(c);
        } else if (force) this.classes.add(c); else this.classes.delete(c);
      },
      contains(c) { return this.classes.has(c); }
    }
  };
  const player = new MediaPlayerEngine({ container: fakeContainer, iframe: fakeIframe });
  return { player, messages, fakeIframe, fakeContainer };
}

test("initializes with preset tracks queue", () => {
  const { player } = createMockPlayer();
  assert.strictEqual(player.queue.length, PRESET_TRACKS.length);
  assert.strictEqual(player.queueIndex, 0);
  assert.strictEqual(player.currentTrackId, PRESET_TRACKS[0].id);
  assert.strictEqual(player.isLoop, false);
});

test("playNext advances track and loops to start at queue end", () => {
  const { player } = createMockPlayer();
  assert.strictEqual(player.queueIndex, 0);
  
  player.playNext();
  assert.strictEqual(player.queueIndex, 1);
  assert.strictEqual(player.currentTrackId, PRESET_TRACKS[1].id);

  player.playNext();
  assert.strictEqual(player.queueIndex, 2);

  player.playNext();
  assert.strictEqual(player.queueIndex, 3);

  // Wrap around
  player.playNext();
  assert.strictEqual(player.queueIndex, 0);
  assert.strictEqual(player.currentTrackId, PRESET_TRACKS[0].id);
});

test("playPrev steps backwards and wraps around", () => {
  const { player } = createMockPlayer();
  assert.strictEqual(player.queueIndex, 0);

  // From 0 to end
  player.playPrev();
  assert.strictEqual(player.queueIndex, PRESET_TRACKS.length - 1);
  assert.strictEqual(player.currentTrackId, PRESET_TRACKS[PRESET_TRACKS.length - 1].id);

  player.playPrev();
  assert.strictEqual(player.queueIndex, PRESET_TRACKS.length - 2);
});

test("onVideoEnded triggers auto-advance to next track when not looping", () => {
  const { player } = createMockPlayer();
  assert.strictEqual(player.queueIndex, 0);
  
  player.onVideoEnded();
  assert.strictEqual(player.queueIndex, 1);
  assert.strictEqual(player.currentTrackId, PRESET_TRACKS[1].id);
});

test("loop mode repeats the current track on video ended", () => {
  const { player, messages } = createMockPlayer();
  player.isLoop = true;
  assert.strictEqual(player.queueIndex, 0);

  player.onVideoEnded();
  // Index must not change
  assert.strictEqual(player.queueIndex, 0);
  // PostMessages seekTo 0 and playVideo must be sent
  assert.ok(messages.some(m => m.func === "seekTo"));
  assert.ok(messages.some(m => m.func === "playVideo"));
});

test("sendCommand sends formatted JSON postMessage to iframe", () => {
  const { player, messages } = createMockPlayer();
  player.sendCommand("pauseVideo");
  assert.strictEqual(messages.length, 1);
  assert.strictEqual(messages[0].event, "command");
  assert.strictEqual(messages[0].func, "pauseVideo");
});

test("extractYouTubeId correctly extracts ID from different URL patterns", () => {
  const { player } = createMockPlayer();
  assert.strictEqual(player.extractYouTubeId("jfKfPfyJRdk"), "jfKfPfyJRdk");
  assert.strictEqual(player.extractYouTubeId("https://www.youtube.com/watch?v=jfKfPfyJRdk"), "jfKfPfyJRdk");
  assert.strictEqual(player.extractYouTubeId("https://youtu.be/jfKfPfyJRdk"), "jfKfPfyJRdk");
  assert.strictEqual(player.extractYouTubeId("https://www.youtube.com/shorts/jfKfPfyJRdk"), "jfKfPfyJRdk");
  assert.strictEqual(player.extractYouTubeId("https://www.youtube.com/live/jfKfPfyJRdk"), "jfKfPfyJRdk");
  assert.strictEqual(player.extractYouTubeId("invalid query text"), null);
});

console.log("\n" + passed + " media player tests passed");
