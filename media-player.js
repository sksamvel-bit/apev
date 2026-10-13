/**
 * Media Player Engine (YouTube in Tesla Car)
 * Docked Picture-in-Picture YouTube & Music Player
 */

const PRESET_TRACKS = [
  { title: "Synthwave / Cyberpunk Night Drive", id: "4xDzrJKXOOY" },
  { title: "Lofi Hip Hop Radio - Beats to Drive to", id: "jfKfPfyJRdk" },
  { title: "Deep House / Chill Electronic", id: "7NOSDKb0HlU" },
  { title: "Relaxing Ambient Drive", id: "M5QGkQiXW_U" }
];

class MediaPlayerEngine {
  constructor() {
    this.container = document.getElementById("media-player-card");
    this.iframe = document.getElementById("youtube-iframe");
    this.currentTrackId = PRESET_TRACKS[0].id;
    this.isOpen = false;
    this.isMinimized = false;

    this.initUI();
  }

  initUI() {
    const selector = document.getElementById("media-preset-select");
    if (selector) {
      PRESET_TRACKS.forEach(track => {
        const opt = document.createElement("option");
        opt.value = track.id;
        opt.textContent = track.title;
        selector.appendChild(opt);
      });

      selector.addEventListener("change", (e) => {
        this.loadVideo(e.target.value);
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

  extractYouTubeId(url) {
    if (!url) return null;
    if (url.length === 11 && !url.includes("/") && !url.includes(".") && !url.includes(" ")) return url;
    // Support youtube.com/watch?v=..., youtu.be/..., youtube.com/shorts/..., youtube.com/live/...
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/|live\/))([\w-]{11})/);
    return match ? match[1] : null;
  }

  // Search: show a list of YouTube results to pick from (falls back to "play first result" if the list is unavailable)
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
    results.forEach((r) => {
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
        this.loadVideo(r.videoId);
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
      this.loadVideo(videoId);
      this.open();
      if (window.showToast) window.showToast("▶ YouTube ვიდეო ჩაირთო!", "success");
      return;
    }

    // Direct Song / Artist text search
    if (window.showToast) window.showToast(`🔍 იძებნება: "${trimmed}"...`, "info");

    try {
      const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(trimmed)}`);
      const data = await res.json();
      if (data && data.success && data.videoId) {
        this.loadVideo(data.videoId);
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
      this.iframe.src = `https://www.youtube-nocookie.com/embed?listType=search&list=${encodeURIComponent(trimmed)}&autoplay=1&enablejsapi=1&origin=${window.location.origin}&playsinline=1&controls=1&modestbranding=1&rel=0&iv_load_policy=3&disablekb=1&vq=tiny`;
    }
    this.open();
    if (window.showToast) window.showToast(`▶ იკვრება: "${trimmed}"`, "success");
  }

  loadVideo(id) {
    this.currentTrackId = id;
    if (this.iframe) {
      this.iframe.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&enablejsapi=1&origin=${window.location.origin}&playsinline=1&controls=1&modestbranding=1&rel=0&iv_load_policy=3&disablekb=1&vq=tiny`;
    }
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
    if (window.DRIVING_LOCKOUT && window.currentSpeedKmhForLock > 5) {
      if (window.showToast) window.showToast("მედია მოძრაობისას დაბლოკილია", "error");
      return;
    }
    this.isOpen = true;
    this.container.classList.add("active");
    if (!this.iframe.src || this.iframe.src === "about:blank") {
      this.loadVideo(this.currentTrackId);
    }
  }

  close() {
    this.isOpen = false;
    this.container.classList.remove("active");
    if (this.iframe) {
      this.iframe.src = "about:blank"; // Stop audio/video
    }
  }

  toggleMinimize() {
    this.isMinimized = !this.isMinimized;
    this.container.classList.toggle("minimized", this.isMinimized);
  }
}

window.MediaPlayerEngine = MediaPlayerEngine;
