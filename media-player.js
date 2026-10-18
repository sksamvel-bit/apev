/**
 * Media Player Engine (YouTube in the Tesla browser) - two-pane layout (v3.10.26):
 *   left : video + progress + controls (shuffle / prev / play / next / repeat) + tabs "Popular" | "History"
 *   right: YouTube search with thumbnails
 * Playback uses the official YouTube iframe (nocookie embed) controlled through postMessage; progress comes from
 * the iframe's "listening" handshake (infoDelivery). No scraping happens in the browser: search goes through /api/youtube/search.
 */

const PRESET_TRACKS = [
  { title: "Synthwave / Cyberpunk Night Drive", id: "4xDzrJKXOOY" },
  { title: "Lofi Hip Hop Radio - Beats to Drive to", id: "jfKfPfyJRdk" },
  { title: "Deep House / Chill Electronic", id: "7NOSDKb0HlU" },
  { title: "Relaxing Ambient Drive", id: "M5QGkQiXW_U" }
];

const POPULAR_QUERY = "პოპულარული მუსიკა"; // what the "Popular" tab asks the server for (cached there for 10 min)
const POPULAR_COUNT = 12;
const SEARCH_COUNT = 12;
const HISTORY_MAX = 30;
const HISTORY_KEY = "ytHistory";

function formatTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p2 = (n) => String(n).padStart(2, "0");
  return h ? h + ":" + p2(m) + ":" + p2(s) : m + ":" + p2(s);
}

function thumbUrl(id) {
  return "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg";
}

class MediaPlayerEngine {
  constructor(opts = {}) {
    const hasDoc = typeof document !== "undefined";
    this.container = opts.container || (hasDoc ? document.getElementById("media-player-card") : null);
    this.iframe = opts.iframe || (hasDoc ? document.getElementById("youtube-iframe") : null);
    this.currentTrackId = PRESET_TRACKS[0].id;
    this.currentTitle = PRESET_TRACKS[0].title;
    this.currentChannel = "";
    this.isOpen = false;
    this.isMinimized = false;
    this.isPlaying = false;
    this.isLoop = false;
    this.isShuffle = false;
    this.duration = 0;
    this.currentTime = 0;
    this.tab = "popular";

    // Playlist queue (the list you last started a track from)
    this.queue = PRESET_TRACKS.map((t) => ({ id: t.id, title: t.title, channel: "", length: "" }));
    this.queueIndex = 0;
    this.popular = [];
    this.popularAt = 0;
    this.history = this.loadHistory();

    if (typeof window !== "undefined") {
      this.initUI();
      this.initPostMessageListener();
    }
  }

  $(id) {
    return typeof document !== "undefined" ? document.getElementById(id) : null;
  }

  toast(msg, kind, ms) {
    if (typeof window !== "undefined" && window.showToast) window.showToast(msg, kind || "info", ms);
  }

  // ---------- history (localStorage, never required) ----------
  loadHistory() {
    this.storageOk = true;
    try {
      if (typeof localStorage === "undefined" || typeof window === "undefined") return [];
      const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(arr) ? arr.filter((x) => x && /^[\w-]{11}$/.test(x.id || "")).slice(0, HISTORY_MAX) : [];
    } catch (_) { this.storageOk = false; return []; }
  }

  saveHistory() {
    try {
      if (typeof localStorage !== "undefined" && typeof window !== "undefined") {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history));
        this.storageOk = localStorage.getItem(HISTORY_KEY) !== null;
      }
    } catch (_) { this.storageOk = false; /* private mode / quota: history then lives only until the page is closed */ }
  }

  addToHistory(item) {
    if (!item || !item.id) return;
    this.history = [{ id: item.id, title: item.title || "", channel: item.channel || "", length: item.length || "" }]
      .concat(this.history.filter((h) => h.id !== item.id)).slice(0, HISTORY_MAX);
    this.saveHistory();
    this.updateHistoryCount();
    if (this.tab === "history") this.renderList("media-list", this.history, "history");
  }

  updateHistoryCount() {
    const th = this.$("media-tab-history");
    if (th) th.textContent = this.history.length ? "ისტორია (" + this.history.length + ")" : "ისტორია";
  }

  // ---------- UI wiring ----------
  initUI() {
    const on = (id, ev, fn) => { const el = this.$(id); if (el) el.addEventListener(ev, fn); return el; };

    on("media-btn-prev", "click", (e) => { e.stopPropagation(); this.playPrev(); });
    on("media-btn-next", "click", (e) => { e.stopPropagation(); this.playNext(false); });
    on("media-btn-play-pause", "click", (e) => { e.stopPropagation(); this.togglePlayPause(); });
    on("media-btn-loop", "click", (e) => { e.stopPropagation(); this.toggleLoop(); });
    on("media-btn-shuffle", "click", (e) => { e.stopPropagation(); this.toggleShuffle(); });
    on("media-tap-layer", "click", () => this.togglePlayPause());
    on("media-close-btn", "click", () => this.close());

    on("media-progress", "click", (e) => {
      if (!this.duration) return;
      const r = e.currentTarget.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
      this.sendCommand("seekTo", [f * this.duration, true]);
      this.updateProgress(f * this.duration, this.duration);
    });

    this.updateHistoryCount();
    on("media-tab-popular", "click", () => this.showTab("popular"));
    on("media-tab-history", "click", () => this.showTab("history"));

    const input = this.$("media-custom-url-input");
    const go = () => { const v = input && input.value.trim(); if (v) this.searchAndShow(v); else this.toast("ჩაწერეთ სიმღერა ან YouTube ლინკი", "info"); };
    on("media-load-custom-btn", "click", go);
    if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

    // Ask the embedded player to report progress/state to us (needs a fresh handshake after every src change).
    if (this.iframe && this.iframe.addEventListener) {
      this.iframe.addEventListener("load", () => {
        if (this.iframe.src && this.iframe.src !== "about:blank" && this.iframe.contentWindow) {
          try { this.iframe.contentWindow.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), "*"); } catch (_) { /* ignore */ }
        }
      });
    }
  }

  initPostMessageListener() {
    window.addEventListener("message", (e) => {
      if (this.iframe && this.iframe.contentWindow && e.source && e.source !== this.iframe.contentWindow) return;
      let data = e.data;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch (_) { return; }
      }
      if (!data) return;
      this.handlePlayerMessage(data);
    });
  }

  /** Handles one decoded message from the YouTube iframe (separate from the DOM event so it can be unit-tested). */
  handlePlayerMessage(data) {
    let state = null;
    if (data.event === "onStateChange" && typeof data.info === "number") {
      state = data.info;
    } else if (data.info && typeof data.info === "object" && typeof data.info.playerState === "number") {
      state = data.info.playerState;
    }

    if (data.info && typeof data.info === "object") {
      const i = data.info;
      if (typeof i.duration === "number" && i.duration > 0) this.duration = i.duration;
      if (typeof i.currentTime === "number") this.currentTime = i.currentTime;
      if (typeof i.duration === "number" || typeof i.currentTime === "number") this.updateProgress(this.currentTime, this.duration);
      if (i.videoData && i.videoData.author && !this.currentChannel) {
        this.currentChannel = String(i.videoData.author).slice(0, 80);
        this.updateTrackTitle(this.currentTitle);
      }
    }

    if (state === 0) {
      this.onVideoEnded();
    } else if (state === 1) {
      this.isPlaying = true;
      this.updatePlayPauseUI(true);
    } else if (state === 2) {
      this.isPlaying = false;
      this.updatePlayPauseUI(false);
    }
  }

  sendCommand(func, args = "") {
    if (!this.iframe || !this.iframe.contentWindow) return;
    const msg = JSON.stringify({ event: "command", func: func, args: args });
    this.iframe.contentWindow.postMessage(msg, "*");
  }

  // ---------- queue / transport ----------
  onVideoEnded() {
    if (this.isLoop) {
      this.sendCommand("seekTo", [0, true]);
      this.sendCommand("playVideo");
      this.toast("🔂 განმეორება", "info", 1500);
      return;
    }
    this.playNext(true);
  }

  ensureQueue() {
    if (!this.queue || this.queue.length === 0) {
      this.queue = PRESET_TRACKS.map((t) => ({ id: t.id, title: t.title, channel: "", length: "" }));
      this.queueIndex = 0;
    }
  }

  playNext(autoAdvance = false) {
    this.ensureQueue();
    if (this.isShuffle && this.queue.length > 1) {
      let n = this.queueIndex;
      while (n === this.queueIndex) n = Math.floor(Math.random() * this.queue.length);
      this.queueIndex = n;
    } else if (this.queueIndex < this.queue.length - 1) {
      this.queueIndex++;
    } else {
      this.queueIndex = 0;
    }
    const track = this.queue[this.queueIndex];
    if (track) {
      this.loadVideo(track.id, track.title);
      this.toast((autoAdvance ? "⏭️ შემდეგი ვიდეო: " : "⏭️ შემდეგი: ") + track.title, "info", 2500);
    }
  }

  playPrev() {
    this.ensureQueue();
    // Like every player: after a few seconds "previous" restarts the track.
    if (this.currentTime > 5) {
      this.sendCommand("seekTo", [0, true]);
      this.currentTime = 0;
      this.updateProgress(0, this.duration);
      return;
    }
    if (this.queueIndex > 0) this.queueIndex--; else this.queueIndex = this.queue.length - 1;
    const track = this.queue[this.queueIndex];
    if (track) {
      this.loadVideo(track.id, track.title);
      this.toast("⏮️ წინა: " + track.title, "info", 2500);
    }
  }

  togglePlayPause() {
    if (this.isPlaying) {
      this.sendCommand("pauseVideo");
      this.isPlaying = false;
      this.updatePlayPauseUI(false);
    } else {
      this.sendCommand("playVideo");
      this.isPlaying = true;
      this.updatePlayPauseUI(true);
    }
  }

  toggleLoop() {
    this.isLoop = !this.isLoop;
    const btn = this.$("media-btn-loop");
    if (btn) btn.classList.toggle("active", this.isLoop);
    this.toast(this.isLoop ? "🔂 განმეორება ჩაირთო" : "➡️ ავტო-შემდეგი ჩაირთო", "info", 2000);
  }

  toggleShuffle() {
    this.isShuffle = !this.isShuffle;
    const btn = this.$("media-btn-shuffle");
    if (btn) btn.classList.toggle("active", this.isShuffle);
    this.toast(this.isShuffle ? "🔀 შემთხვევითი რიგი ჩაირთო" : "🔀 შემთხვევითი რიგი გამოირთო", "info", 2000);
  }

  // ---------- rendering ----------
  updatePlayPauseUI(isPlaying) {
    const btn = this.$("media-btn-play-pause");
    if (btn) {
      btn.classList.toggle("is-playing", !!isPlaying);
      btn.title = isPlaying ? "დაპაუზება" : "დაკვრა";
      btn.setAttribute("aria-label", btn.title);
    }
    if (this.container && this.container.classList) this.container.classList.toggle("paused", !isPlaying);
  }

  updateProgress(cur, dur) {
    const fill = this.$("media-progress-fill"), tc = this.$("media-time-cur"), td = this.$("media-time-dur");
    if (fill) fill.style.width = (dur > 0 ? Math.min(100, (cur / dur) * 100) : 0).toFixed(1) + "%";
    if (tc) tc.textContent = formatTime(cur);
    if (td) td.textContent = dur > 0 ? formatTime(dur) : "--:--";
  }

  updateTrackTitle(title) {
    this.currentTitle = title || "";
    const el = this.$("media-track-title");
    if (el) { el.textContent = this.currentTitle || "YouTube"; el.title = this.currentTitle || ""; }
    const ch = this.$("media-track-channel");
    if (ch) ch.textContent = this.currentChannel || "";
    this.markActive();
  }

  markActive() {
    if (typeof document === "undefined") return;
    document.querySelectorAll("#media-player-card .media-item").forEach((b) => {
      b.classList.toggle("active", b.dataset.id === this.currentTrackId);
    });
  }

  /** Renders a list of {id,title,channel,length} into #boxId; clicking an item makes that list the queue. */
  renderList(boxId, items, source) {
    const box = this.$(boxId);
    if (!box) return;
    box.textContent = "";
    if (!items || !items.length) {
      const empty = document.createElement("div");
      empty.className = "media-empty";
      empty.textContent = source === "history"
        ? (this.storageOk === false ? "ბრაუზერი მეხსიერებას არ აძლევს საიტს: ისტორია მხოლოდ ამ გვერდის გახსნამდე ინახება" : "ისტორია ცარიელია: აქ გამოჩნდება ის, რასაც დაუკრავთ")
        : "შედეგი ვერ მოიძებნა";
      box.appendChild(empty);
      return;
    }
    items.forEach((r, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "media-item" + (r.id === this.currentTrackId ? " active" : "");
      btn.dataset.id = r.id;
      const img = document.createElement("img");
      img.className = "media-thumb";
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = thumbUrl(r.id);
      const txt = document.createElement("span");
      txt.className = "media-item-text";
      const t = document.createElement("span");
      t.className = "media-item-title";
      t.textContent = r.title;
      const m = document.createElement("span");
      m.className = "media-item-meta";
      m.textContent = r.channel || "";
      txt.appendChild(t);
      txt.appendChild(m);
      const dur = document.createElement("span");
      dur.className = "media-item-dur";
      dur.textContent = r.length || "";
      btn.appendChild(img);
      btn.appendChild(txt);
      btn.appendChild(dur);
      btn.addEventListener("click", () => {
        this.queue = items.map((x) => ({ id: x.id, title: x.title, channel: x.channel || "", length: x.length || "" }));
        this.queueIndex = idx;
        this.loadVideo(r.id, r.title);
        this.open();
      });
      box.appendChild(btn);
    });
  }

  showTab(tab) {
    this.tab = tab === "history" ? "history" : "popular";
    const tp = this.$("media-tab-popular"), th = this.$("media-tab-history");
    if (tp) tp.classList.toggle("active", this.tab === "popular");
    if (th) th.classList.toggle("active", this.tab === "history");
    if (this.tab === "history") this.renderList("media-list", this.history, "history");
    else this.loadPopular();
  }

  async loadPopular(force) {
    const box = this.$("media-list");
    if (!box) return;
    const fresh = this.popular.length && Date.now() - this.popularAt < 10 * 60 * 1000;
    if (fresh && !force) { this.renderList("media-list", this.popular, "popular"); return; }
    box.textContent = "";
    const wait = document.createElement("div");
    wait.className = "media-empty";
    wait.textContent = "იტვირთება...";
    box.appendChild(wait);
    let list = null;
    try {
      const res = await fetch("/api/youtube/search?list=1&n=" + POPULAR_COUNT + "&q=" + encodeURIComponent(POPULAR_QUERY));
      const data = await res.json();
      if (data && data.success && Array.isArray(data.results) && data.results.length) {
        list = data.results.map((r) => ({ id: r.videoId, title: r.title, channel: r.channel, length: r.length }));
      }
    } catch (err) {
      console.warn("YouTube popular list fallback:", err);
    }
    if (!list) list = PRESET_TRACKS.map((t) => ({ id: t.id, title: t.title, channel: "", length: "" }));
    else { this.popular = list; this.popularAt = Date.now(); }
    if (this.tab === "popular") this.renderList("media-list", list, "popular");
  }

  // ---------- search ----------
  extractYouTubeId(url) {
    if (!url) return null;
    if (url.length === 11 && !url.includes("/") && !url.includes(".") && !url.includes(" ")) return url;
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/|live\/))([\w-]{11})/);
    return match ? match[1] : null;
  }

  async searchAndShow(input) {
    const q = (input || "").trim();
    if (!q) return;
    if (this.extractYouTubeId(q)) { this.playQueryOrUrl(q); return; }
    const box = this.$("media-search-results");
    if (!box) return;
    box.textContent = "";
    const wait = document.createElement("div");
    wait.className = "media-empty";
    wait.textContent = "🔍 " + q + "...";
    box.appendChild(wait);
    try {
      const res = await fetch("/api/youtube/search?list=1&n=" + SEARCH_COUNT + "&q=" + encodeURIComponent(q));
      const data = await res.json();
      if (data && data.success && Array.isArray(data.results) && data.results.length) {
        this.renderList("media-search-results", data.results.map((r) => ({ id: r.videoId, title: r.title, channel: r.channel, length: r.length })), "search");
        return;
      }
    } catch (err) {
      console.warn("YouTube list search fallback:", err);
    }
    box.textContent = "";
    this.renderList("media-search-results", [], "search");
  }

  async playQueryOrUrl(input) {
    if (!input) return;
    const trimmed = input.trim();
    const videoId = this.extractYouTubeId(trimmed);
    if (videoId) {
      this.queue = [{ id: videoId, title: "YouTube Video", channel: "", length: "" }];
      this.queueIndex = 0;
      this.loadVideo(videoId, "YouTube Video");
      this.open();
      this.toast("▶ YouTube ვიდეო ჩაირთო!", "success");
      return;
    }
    this.searchAndShow(trimmed);
  }

  // ---------- playback ----------
  loadVideo(id, title = "") {
    this.currentTrackId = id;
    this.duration = 0;
    this.currentTime = 0;
    const item = (this.queue || []).find((q) => q.id === id) || {};
    const preset = PRESET_TRACKS.find((t) => t.id === id);
    const name = title || item.title || (preset && preset.title) || "";
    this.currentChannel = item.channel || "";
    this.updateTrackTitle(name);
    this.updateProgress(0, 0);
    if (this.iframe) {
      const origin = (typeof window !== "undefined" && window.location && window.location.origin) ? window.location.origin : "";
      this.iframe.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&enablejsapi=1&origin=${encodeURIComponent(origin)}&playsinline=1&controls=0&modestbranding=1&rel=0&iv_load_policy=3&disablekb=1&fs=0&vq=tiny`;
    }
    this.isPlaying = true;
    this.updatePlayPauseUI(true);
    this.addToHistory({ id, title: name, channel: this.currentChannel, length: item.length || "" });
  }

  toggle() {
    if (this.isOpen) this.close(); else this.open();
    return this.isOpen;
  }

  open() {
    if (typeof window !== "undefined" && window.DRIVING_LOCKOUT && window.currentSpeedKmhForLock > 5) {
      this.toast("მედია მოძრაობისას დაბლოკილია", "error");
      return;
    }
    this.isOpen = true;
    if (this.container) this.container.classList.add("active");
    if (typeof document !== "undefined") this.showTab(this.tab);
    if (this.iframe && (!this.iframe.src || this.iframe.src === "about:blank")) {
      const track = this.queue[this.queueIndex] || PRESET_TRACKS[0];
      this.loadVideo(track.id, track.title);
    }
  }

  close() {
    this.isOpen = false;
    this.isPlaying = false;
    if (this.container) this.container.classList.remove("active");
    if (this.iframe) this.iframe.src = "about:blank"; // stop audio/video
    this.updatePlayPauseUI(false);
    const btn = this.$("btn-toggle-media");
    if (btn) btn.classList.remove("active");
  }

  toggleMinimize() {
    this.isMinimized = !this.isMinimized;
    if (this.container) this.container.classList.toggle("minimized", this.isMinimized);
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { PRESET_TRACKS, MediaPlayerEngine, formatTime, thumbUrl };
} else {
  window.PRESET_TRACKS = PRESET_TRACKS;
  window.MediaPlayerEngine = MediaPlayerEngine;
}
