/**
 * Turn-by-Turn Audio Navigation Engine (turn-audio.js)
 * High-clarity authentic Georgian navigation voice prompts
 * Pre-rendered audio clips for 100% offline & in-car reliability on Tesla Model 3.
 */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.TurnAudioEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {

  const BASE_AUDIO_PATH = "/audio/";

  // Exact maneuver mappings
  const MANEUVER_MAP = {
    "მოუხვიეთ მარცხნივ": "turn_left.mp3",
    "მოუხვიეთ მარჯვნივ": "turn_right.mp3",
    "ოდნავ მარცხნივ": "slight_left.mp3",
    "ოდნავ მარჯვნივ": "slight_right.mp3",
    "იარეთ პირდაპირ": "straight.mp3",
    "მობრუნდით უკან": "uturn.mp3",
    "შედით წრიულ მოძრაობაზე": "roundabout.mp3",
    "დაიწყეთ მოძრაობა": "depart.mp3",
    "მარშრუტი დაწყებულია": "route_started.mp3",
    "მიხვედით დანიშნულების ადგილზე": "arrive.mp3",
    "მარშრუტს აცდით. ახალი მარშრუტი ითვლება": "reroute.mp3"
  };

  // Pre-combined high-frequency distance + turn clips (single smooth audio)
  const COMBINED_MAP = {
    "500 მეტრში, მოუხვიეთ მარცხნივ": "in_500m_turn_left.mp3",
    "500 მეტრში, მოუხვიეთ მარჯვნივ": "in_500m_turn_right.mp3",
    "300 მეტრში, მოუხვიეთ მარცხნივ": "in_300m_turn_left.mp3",
    "300 მეტრში, მოუხვიეთ მარჯვნივ": "in_300m_turn_right.mp3",
    "200 მეტრში, მოუხვიეთ მარცხნივ": "in_200m_turn_left.mp3",
    "200 მეტრში, მოუხვიეთ მარჯვნივ": "in_200m_turn_right.mp3",
    "100 მეტრში, მოუხვიეთ მარცხნივ": "in_100m_turn_left.mp3",
    "100 მეტრში, მოუხვიეთ მარჯვნივ": "in_100m_turn_right.mp3",
    "50 მეტრში, მოუხვიეთ მარცხნივ": "in_50m_turn_left.mp3",
    "50 მეტრში, მოუხვიეთ მარჯვნივ": "in_50m_turn_right.mp3"
  };

  const DISTANCE_MAP = {
    "800 მეტრში": "in_800m.mp3",
    "500 მეტრში": "in_500m.mp3",
    "300 მეტრში": "in_300m.mp3",
    "200 მეტრში": "in_200m.mp3",
    "100 მეტრში": "in_100m.mp3",
    "50 მეტრში": "in_50m.mp3"
  };

  class TurnAudioEngine {
    constructor(options = {}) {
      this.basePath = options.basePath || BASE_AUDIO_PATH;
      this.audioCache = new Map();
      this.currentAudio = null;
      this.isMuted = false;
      this.queue = [];
      this.isPlayingQueue = false;
    }

    /**
     * Resolves Georgian text prompt into an array of audio filenames.
     * @param {string} text
     * @returns {string[]} array of audio filenames
     */
    resolveAudio(text) {
      if (!text || typeof text !== "string") return [];
      const trimmed = text.trim();

      // 1. Direct Combined match
      for (const [key, file] of Object.entries(COMBINED_MAP)) {
        if (trimmed.startsWith(key)) {
          return [this.basePath + file];
        }
      }

      // 2. Exact or prefix match in Maneuver Map
      for (const [key, file] of Object.entries(MANEUVER_MAP)) {
        if (trimmed.startsWith(key) || trimmed === key) {
          return [this.basePath + file];
        }
      }

      // 3. Alerts
      if (trimmed.includes("შუქნიშანი")) {
        return [this.basePath + "traffic_signal.mp3"];
      }
      if (trimmed.includes("სიჩქარ") || trimmed.includes("შეანელეთ")) {
        return [this.basePath + "speed_limit.mp3"];
      }
      if (trimmed.includes("საცობი") || trimmed.includes("საცობია")) {
        return [this.basePath + "traffic_jam.mp3"];
      }
      if (trimmed.includes("აცდით") || trimmed.includes("ახალი მარშრუტი")) {
        return [this.basePath + "reroute.mp3"];
      }
      if (trimmed.includes("მიხვედით") || trimmed.includes("დანიშნულების ადგილზე")) {
        return [this.basePath + "arrive.mp3"];
      }

      // 4. Distance + Maneuver chaining
      // E.g., "800 მეტრში, იარეთ პირდაპირ ჭავჭავაძის გამზირზე"
      const distMatch = trimmed.match(/^(\d+\s*მეტრში)/);
      if (distMatch) {
        const distKey = distMatch[1].replace(/\s+/g, " ");
        const distFile = DISTANCE_MAP[distKey];
        const rest = trimmed.slice(distMatch[0].length).replace(/^[,.\s]+/, "");
        
        let maneuverFile = null;
        for (const [key, file] of Object.entries(MANEUVER_MAP)) {
          if (rest.startsWith(key)) {
            maneuverFile = file;
            break;
          }
        }

        const res = [];
        if (distFile) res.push(this.basePath + distFile);
        if (maneuverFile) res.push(this.basePath + maneuverFile);
        if (res.length > 0) return res;
      }

      return [];
    }

    /**
     * Plays a sequence of audio URLs
     * @param {string} text Prompt in Georgian
     * @param {Function} [onDone] Optional callback when playback completes
     * @returns {boolean} true if audio cue was found and started
     */
    play(text, onDone) {
      if (this.isMuted) return false;
      const urls = this.resolveAudio(text);
      if (urls.length === 0) return false;

      // In browser environment, play through HTML5 Audio element
      if (typeof window !== "undefined" && typeof Audio !== "undefined") {
        this.stop();
        this.queue = [...urls];
        this.isPlayingQueue = true;

        const playNext = () => {
          if (!this.isPlayingQueue || this.queue.length === 0) {
            this.isPlayingQueue = false;
            this.currentAudio = null;
            if (typeof onDone === "function") onDone();
            return;
          }

          const url = this.queue.shift();
          try {
            let audio = this.audioCache.get(url);
            if (!audio) {
              audio = new Audio(url);
              audio.preload = "auto";
              this.audioCache.set(url, audio);
            }

            this.currentAudio = audio;
            audio.currentTime = 0;
            audio.onended = () => playNext();
            audio.onerror = () => playNext();
            const p = audio.play();
            if (p && typeof p.catch === "function") {
              p.catch(() => playNext());
            }
          } catch (e) {
            playNext();
          }
        };

        playNext();
        return true;
      }

      // If outside browser (e.g. Node tests), invoke onDone synchronously
      if (typeof onDone === "function") onDone();
      return true;
    }

    stop() {
      this.isPlayingQueue = false;
      this.queue = [];
      if (this.currentAudio) {
        try {
          this.currentAudio.pause();
          this.currentAudio.currentTime = 0;
        } catch (_) {}
        this.currentAudio = null;
      }
    }

    setMuted(muted) {
      this.isMuted = !!muted;
      if (this.isMuted) this.stop();
      return this.isMuted;
    }
  }

  return {
    TurnAudioEngine,
    MANEUVER_MAP,
    COMBINED_MAP,
    DISTANCE_MAP
  };
});
