/* Automated Unit Tests for MediaPlayerEngine (Playlist Queue & Controls) */
const assert = require("assert");
const { PRESET_TRACKS, MediaPlayerEngine, formatTime, thumbUrl } = require("../media-player.js");

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


// ---- v3.10.26: two-pane player (progress, shuffle, history, popular/search lists) ----
test("formatTime formats m:ss and h:mm:ss, tolerates junk", () => {
  assert.strictEqual(formatTime(0), "0:00");
  assert.strictEqual(formatTime(59.9), "0:59");
  assert.strictEqual(formatTime(421), "7:01");
  assert.strictEqual(formatTime(3723), "1:02:03");
  assert.strictEqual(formatTime(undefined), "0:00");
  assert.strictEqual(formatTime(-5), "0:00");
});

test("thumbUrl points at the official ytimg host", () => {
  assert.strictEqual(thumbUrl("jfKfPfyJRdk"), "https://i.ytimg.com/vi/jfKfPfyJRdk/mqdefault.jpg");
});

test("handlePlayerMessage reads duration/currentTime from infoDelivery", () => {
  const { player } = createMockPlayer();
  player.handlePlayerMessage({ event: "infoDelivery", info: { currentTime: 59.2, duration: 420, playerState: 1 } });
  assert.strictEqual(player.currentTime, 59.2);
  assert.strictEqual(player.duration, 420);
  assert.strictEqual(player.isPlaying, true);
  player.handlePlayerMessage({ event: "onStateChange", info: 2 });
  assert.strictEqual(player.isPlaying, false);
});

test("handlePlayerMessage: channel name comes from videoData once; ended triggers next", () => {
  const { player } = createMockPlayer();
  player.handlePlayerMessage({ event: "infoDelivery", info: { videoData: { author: "JamBeats" } } });
  assert.strictEqual(player.currentChannel, "JamBeats");
  player.handlePlayerMessage({ event: "onStateChange", info: 0 });
  assert.strictEqual(player.queueIndex, 1);
  assert.strictEqual(player.currentChannel, "");
});

test("playPrev restarts the track when more than 5 s have played", () => {
  const { player, messages } = createMockPlayer();
  player.playNext();
  assert.strictEqual(player.queueIndex, 1);
  player.currentTime = 30;
  player.playPrev();
  assert.strictEqual(player.queueIndex, 1);
  assert.ok(messages.some(m => m.func === "seekTo" && m.args[0] === 0));
  player.currentTime = 2;
  player.playPrev();
  assert.strictEqual(player.queueIndex, 0);
});

test("shuffle never repeats the same queue index back-to-back", () => {
  const { player } = createMockPlayer();
  player.isShuffle = true;
  let last = player.queueIndex;
  for (let i = 0; i < 40; i++) {
    player.playNext();
    assert.notStrictEqual(player.queueIndex, last);
    assert.ok(player.queueIndex >= 0 && player.queueIndex < player.queue.length);
    last = player.queueIndex;
  }
});

test("history keeps the newest first, de-duplicates and caps at 30", () => {
  const { player } = createMockPlayer();
  player.history = [];
  const id = (n) => String(n).padStart(11, "x");
  for (let i = 0; i < 40; i++) player.addToHistory({ id: id(i), title: "t" + i });
  assert.strictEqual(player.history.length, 30);
  assert.strictEqual(player.history[0].id, id(39));
  player.addToHistory({ id: id(35), title: "again" });
  assert.strictEqual(player.history[0].id, id(35));
  assert.strictEqual(player.history.filter(h => h.id === id(35)).length, 1);
});

test("loadVideo logs to history, sets controls=0 embed url and resets progress", () => {
  const { player, fakeIframe } = createMockPlayer();
  player.history = [];
  player.duration = 99; player.currentTime = 50;
  player.queue = [{ id: "aaaaaaaaaaa", title: "Song", channel: "Chan", length: "3:21" }];
  player.queueIndex = 0;
  player.loadVideo("aaaaaaaaaaa", "Song");
  assert.strictEqual(player.history[0].id, "aaaaaaaaaaa");
  assert.strictEqual(player.history[0].channel, "Chan");
  assert.strictEqual(player.duration, 0);
  assert.ok(/youtube-nocookie\.com\/embed\/aaaaaaaaaaa\?/.test(fakeIframe.src));
  assert.ok(/controls=0/.test(fakeIframe.src) && /enablejsapi=1/.test(fakeIframe.src));
});

test("searchAndShow without a results box neither throws nor recurses", async () => {
  const { player } = createMockPlayer();
  await player.searchAndShow("some artist");
  await player.playQueryOrUrl("some artist");
});

test("server clamps the result count (n) to 1..15 and keys the cache by it", () => {
  const src = require("fs").readFileSync(__dirname + "/../server.js", "utf8");
  assert.ok(/max = Math\.min\(15, Math\.max\(1,/.test(src));
  assert.ok(/const key = query\.toLowerCase\(\) \+ '\|' \+ max;/.test(src));
});

console.log("\n" + passed + " media player tests passed");
