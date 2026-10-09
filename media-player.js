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
        const videoId = this.extractYouTubeId(val);
        if (videoId) {
          this.loadVideo(videoId);
        } else {
          if (window.showToast) {
            window.showToast("გთხოვთ შეიყვანოთ სწორი YouTube ბმული ან Video ID", "error");
          } else {
            alert("გთხოვთ შეიყვანოთ სწორი YouTube ბმული ან Video ID");
          }
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
    if (url.length === 11 && !url.includes("/") && !url.includes(".")) return url;
    // Support youtube.com/watch?v=..., youtu.be/..., youtube.com/shorts/..., youtube.com/live/...
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/|live\/))([\w-]{11})/);
    return match ? match[1] : null;
  }

  loadVideo(id) {
    this.currentTrackId = id;
    if (this.iframe) {
      this.iframe.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&enablejsapi=1&origin=${window.location.origin}`;
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
