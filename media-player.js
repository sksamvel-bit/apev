/**
 * Media Player Engine (YouTube in Tesla Car)
 * Docked Picture-in-Picture YouTube & Music Player with Auto-Advance Queue & Controls
 */

const PRESET_TRACKS = [
  { title: "Synthwave / Cyberpunk Night Drive", id: "4xDzrJKXOOY" },
  { title: "Lofi Hip Hop Radio - Beats to Drive to", id: "jfKfPfyJRdk" },
  { title: "Deep House / Chill Electronic", id: "7NOSDKb0HlU" },
  { title: "Relaxing Ambient Drive", id: "M5QGkQiXW_U" }
];

class MediaPlayerEngine {
  constructor(opts = {}) {
    this.container = opts.container || (typeof document !== "undefined" ? document.getElementById("media-player-card") : null);
    this.iframe = opts.iframe || (typeof document !== "undefined" ? document.getElementById("youtube-iframe") : null);
    this.currentTrackId = PRESET_TRACKS[0].id;
    this.currentTitle = PRESET_TRACKS[0].title;
    this.isOpen = false;
    this.isMinimized = false;
    this.isPlaying = false;
    this.isLoop = false;

    // Playlist Queue
    this.queue = PRESET_TRACKS.map(t => ({ id: t.id, title: t.title }));
    this.queueIndex = 0;

    if (typeof window !== "undefined") {
      this.initUI();
      this.initPostMessageListener();
    }
  }

  initUI() {
    const selector = document.getElementById("media-preset-select");
    if (selector) {
      PRESET_TRACKS.forEach((track) => {
        const opt = document.createElement("option");
        opt.value = track.id;
        opt.textContent = track.title;
        selector.appendChild(opt);
      });

      selector.addEventListener("change", (e) => {
        const chosenId = e.target.value;
        const idx = PRESET_TRACKS.findIndex(t => t.id === chosenId);
        this.queue = PRESET_TRACKS.map(t => ({ id: t.id, title: t.title }));
        this.queueIndex = idx !== -1 ? idx : 0;
        const chosen = this.queue[this.queueIndex];
        this.loadVideo(chosen.id, chosen.title);
      });
    }

    // Playback Controls (Prev, Play/Pause, Next, Loop)
    const prevBtn = document.getElementById("media-btn-prev");
    if (prevBtn) {
      prevBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.playPrev();
      });
    }

    const nextBtn = document.getElementById("media-btn-next");
    if (nextBtn) {
      nextBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.playNext(false);
      });
    }

    const playPauseBtn = document.getElementById("media-btn-play-pause");
    if (playPauseBtn) {
      playPauseBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.togglePlayPause();
      });
    }

    const loopBtn = document.getElementById("media-btn-loop");
    if (loopBtn) {
      loopBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleLoop();
      });
    }

    const customBtn = document.getElementById("media-load-custom-btn");
    const customInput = document.getElementById("media-custom-url-input");
    if (customBtn && customInput) {
      customBtn.addEventListener("click", () => {
        const val = customInput.value.trim();
        if (val) {
          this.searchAndShow(val);
        } else {
          if (window.showToast) window.showToast("ჩაწერეთ სიმღერა ან YouTube ლინკი", "info");
        }
      });

      customInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          const val = customInput.value.trim();
          if (val) this.searchAndShow(val);
        }
      });
    }

    const minBtn = document.getElementById("media-min-btn");
    if (minBtn) {
      minBtn.addEventListener("click", () => this.toggleMinimize());
    }

    const closeBtn = document.getElementById("media-close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => this.close());
    }
  }

  initPostMessageListener() {
    window.addEventListener("message", (e) => {
      let data = e.data;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch (_) { return; }
      }
      if (!data) return;

      // YouTube IFrame API sends event: "onStateChange" or info.playerState
      let state = null;
      if (data.event === "onStateChange" && typeof data.info === "number") {
        state = data.info;
      } else if (data.info && typeof data.info.playerState === "number") {
        state = data.info.playerState;
      }

      if (state === 0) {
        // YT.PlayerState.ENDED = 0
        this.onVideoEnded();
      } else if (state === 1) {
        // YT.PlayerState.PLAYING = 1
        this.isPlaying = true;
        this.updatePlayPauseUI(true);
      } else if (state === 2) {
        // YT.PlayerState.PAUSED = 2
        this.isPlaying = false;
        this.updatePlayPauseUI(false);
      }
    });
  }

  sendCommand(func, args = "") {
    if (!this.iframe || !this.iframe.contentWindow) return;
    const msg = JSON.stringify({
      event: "command",
      func: func,
      args: args
    });
    this.iframe.contentWindow.postMessage(msg, "*");
  }

  onVideoEnded() {
    if (this.isLoop) {
      this.sendCommand("seekTo", [0, true]);
      this.sendCommand("playVideo");
      if (typeof window !== "undefined" && window.showToast) window.showToast("🔂 განმეორება", "info", 1500);
      return;
    }
    // Auto-advance to next track in queue!
    this.playNext(true);
  }

  playNext(autoAdvance = false) {
    if (!this.queue || this.queue.length === 0) {
      this.queue = PRESET_TRACKS.map(t => ({ id: t.id, title: t.title }));
    }
    if (this.queueIndex < this.queue.length - 1) {
      this.queueIndex++;
    } else {
      this.queueIndex = 0;
    }
    const track = this.queue[this.queueIndex];
    if (track) {
      this.loadVideo(track.id, track.title);
      if (typeof window !== "undefined" && window.showToast) {
        window.showToast(`${autoAdvance ? "⏭️ შემდეგი ვიდეო" : "⏭️ შემდეგი"}: ${track.title}`, "info", 3000);
      }
    }
  }

  playPrev() {
    if (!this.queue || this.queue.length === 0) {
      this.queue = PRESET_TRACKS.map(t => ({ id: t.id, title: t.title }));
    }
    if (this.queueIndex > 0) {
      this.queueIndex--;
    } else {
      this.queueIndex = this.queue.length - 1;
    }
    const track = this.queue[this.queueIndex];
    if (track) {
      this.loadVideo(track.id, track.title);
      if (typeof window !== "undefined" && window.showToast) {
        window.showToast(`⏮️ წინა: ${track.title}`, "info", 3000);
      }
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
    const btn = typeof document !== "undefined" ? document.getElementById("media-btn-loop") : null;
    if (btn) btn.classList.toggle("active", this.isLoop);
    if (typeof window !== "undefined" && window.showToast) {
      window.showToast(this.isLoop ? "🔂 განმეორება ჩაირთო" : "➡️ ავტო-შემდეგი ჩაირთო", "info", 2000);
    }
  }

  updatePlayPauseUI(isPlaying) {
    const btn = typeof document !== "undefined" ? document.getElementById("media-btn-play-pause") : null;
    if (btn) {
      btn.textContent = isPlaying ? "⏸️" : "▶️";
      btn.title = isPlaying ? "დაპაუზება" : "დაკვრა";
    }
  }

  updateTrackTitle(title) {
    this.currentTitle = title || "";
    const el = typeof document !== "undefined" ? document.getElementById("media-track-title") : null;
    if (el) {
      el.textContent = this.currentTitle || "YouTube Music";
      el.title = this.currentTitle || "";
    }
    // Also sync preset selector if present
    const sel = typeof document !== "undefined" ? document.getElementById("media-preset-select") : null;
    if (sel && this.currentTrackId) {
      sel.value = this.currentTrackId;
    }
  }

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
    const box = document.getElementById("media-results");
    if (!box) { this.playQueryOrUrl(q); return; }
    box.textContent = "🔍 " + q + "...";
    box.classList.add("show");
    try {
      const res = await fetch("/api/youtube/search?list=1&q=" + encodeURIComponent(q));
      const data = await res.json();
      if (data && data.success && Array.isArray(data.results) && data.results.length) {
        this.renderResults(box, data.results);
        return;
      }
    } catch (err) {
      console.warn("YouTube list search fallback:", err);
    }
    box.classList.remove("show");
    box.textContent = "";
    this.playQueryOrUrl(q);
  }

  renderResults(box, results) {
    box.textContent = "";
    results.forEach((r, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "media-result";
      const t = document.createElement("span");
      t.className = "media-result-title";
      t.textContent = r.title;
      const m = document.createElement("span");
      m.className = "media-result-meta";
      m.textContent = [r.channel, r.length].filter(Boolean).join(" · ");
      btn.appendChild(t);
      btn.appendChild(m);
      btn.addEventListener("click", () => {
        // Enqueue all search results so the driver can next/prev through the search list!
        this.queue = results.map(item => ({ id: item.videoId, title: item.title }));
        this.queueIndex = idx;
        this.loadVideo(r.videoId, r.title);
        this.open();
        box.classList.remove("show");
        box.textContent = "";
        const inp = document.getElementById("media-custom-url-input");
        if (inp) inp.value = "";
      });
      box.appendChild(btn);
    });
    box.classList.add("show");
  }

  async playQueryOrUrl(input) {
    if (!input) return;
    const trimmed = input.trim();
    const videoId = this.extractYouTubeId(trimmed);

    if (videoId) {
      this.queue = [{ id: videoId, title: "YouTube Video" }];
      this.queueIndex = 0;
      this.loadVideo(videoId, "YouTube Video");
      this.open();
      if (window.showToast) window.showToast("▶ YouTube ვიდეო ჩაირთო!", "success");
      return;
    }

    if (window.showToast) window.showToast(`🔍 იძებნება: "${trimmed}"...`, "info");

    try {
      const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(trimmed)}`);
      const data = await res.json();
      if (data && data.success && data.videoId) {
        this.queue = [{ id: data.videoId, title: data.title || trimmed }];
        this.queueIndex = 0;
        this.loadVideo(data.videoId, data.title || trimmed);
        this.open();
        if (window.showToast) {
          window.showToast(`▶ ${data.title || trimmed}`, "success", 4000);
        }
        return;
      }
    } catch (err) {
      console.warn("YouTube search resolver fallback:", err);
    }

    // Embed search fallback
    if (this.iframe) {
      const origin = (typeof window !== "undefined" && window.location && window.location.origin) ? window.location.origin : "";
      this.iframe.src = `https://www.youtube-nocookie.com/embed?listType=search&list=${encodeURIComponent(trimmed)}&autoplay=1&enablejsapi=1&origin=${encodeURIComponent(origin)}&playsinline=1&controls=1&modestbranding=1&rel=0&iv_load_policy=3&disablekb=1&vq=tiny`;
    }
    this.open();
    this.updateTrackTitle(trimmed);
    if (window.showToast) window.showToast(`▶ იკვრება: "${trimmed}"`, "success");
  }

  loadVideo(id, title = "") {
    this.currentTrackId = id;
    if (title) {
      this.updateTrackTitle(title);
    } else {
      const found = PRESET_TRACKS.find(t => t.id === id);
      if (found) this.updateTrackTitle(found.title);
    }
    if (this.iframe) {
      const origin = (typeof window !== "undefined" && window.location && window.location.origin) ? window.location.origin : "";
      this.iframe.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&enablejsapi=1&origin=${encodeURIComponent(origin)}&playsinline=1&controls=1&modestbranding=1&rel=0&iv_load_policy=3&disablekb=1&vq=tiny`;
    }
    this.isPlaying = true;
    this.updatePlayPauseUI(true);
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
    return this.isOpen;
  }

  open() {
    if (typeof window !== "undefined" && window.DRIVING_LOCKOUT && window.currentSpeedKmhForLock > 5) {
      if (window.showToast) window.showToast("მედია მოძრაობისას დაბლოკილია", "error");
      return;
    }
    this.isOpen = true;
    if (this.container) this.container.classList.add("active");
    if (this.iframe && (!this.iframe.src || this.iframe.src === "about:blank")) {
      const track = this.queue[this.queueIndex] || PRESET_TRACKS[0];
      this.loadVideo(track.id, track.title);
    }
  }

  close() {
    this.isOpen = false;
    this.isPlaying = false;
    if (this.container) this.container.classList.remove("active");
    if (this.iframe) {
      this.iframe.src = "about:blank"; // Stop audio/video
    }
    this.updatePlayPauseUI(false);
  }

  toggleMinimize() {
    this.isMinimized = !this.isMinimized;
    if (this.container) this.container.classList.toggle("minimized", this.isMinimized);
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { PRESET_TRACKS, MediaPlayerEngine };
} else {
  window.PRESET_TRACKS = PRESET_TRACKS;
  window.MediaPlayerEngine = MediaPlayerEngine;
}
