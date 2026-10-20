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

  // Recorded distances. A spoken distance is snapped to the nearest one (480 -> 500, 190 -> 200): real prompts rarely say
  // exactly 500 m (routing.js and gmap.js speak the measured distance rounded to 10 m).
  const TIERS = [50, 100, 200, 300, 500, 800];
  function snapDistance(m) {
    if (!(m > 0) || m > 1000) return null;
    let best = TIERS[0];
    for (const t of TIERS) if (Math.abs(t - m) < Math.abs(best - m)) best = t;
    return best;
  }

  /** MANEUVER_MAP key for a prompt, for both phrasings: routing.js ("მოუხვიეთ მარჯვნივ") and Google Routes' Georgian
   *  instructions ("შეუხვიეთ მარცხნივ …", "განაგრძეთ გზა …", "გაემართეთ …", "დარჩით მარჯვნივ …"). null when unknown. */
  function maneuverOf(text) {
    const t = String(text || "");
    const side = /მარცხნივ/.test(t) ? "left" : (/მარჯვნივ/.test(t) ? "right" : "");
    if (/წრიულ|წრეზე|წრიდან/.test(t)) return "შედით წრიულ მოძრაობაზე";
    if (/მობრუნდით|შემობრუნდით|გამობრუნდით/.test(t)) return "მობრუნდით უკან";
    if (side && /ოდნავ|დარჩით|გადადით|შესასვლელ|გასასვლელ|ჩასასვლელ|ასასვლელ/.test(t)) return side === "left" ? "ოდნავ მარცხნივ" : "ოდნავ მარჯვნივ";
    if (side && /უხვიეთ/.test(t)) return side === "left" ? "მოუხვიეთ მარცხნივ" : "მოუხვიეთ მარჯვნივ";
    if (/^(იარეთ|განაგრძეთ|გააგრძელეთ|გაემართეთ)|პირდაპირ/.test(t)) return "იარეთ პირდაპირ";
    if (/^დაიწყეთ/.test(t)) return "დაიწყეთ მოძრაობა";
    return null;
  }

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
      const t = text.trim().replace(/\s+/g, " ");
      const p = this.basePath;
      if (/^მარშრუტი დაწყებულია/.test(t)) return [p + "route_started.mp3"];
      if (/მიხვედით|დანიშნულების ადგილზე/.test(t)) return [p + "arrive.mp3"];
      if (/აცდით|ახალი მარშრუტი|გადაითვალა/.test(t)) return [p + "reroute.mp3"];
      const dist = t.match(/^(\d+)\s*მეტრში[,.\s]*/);
      const man = maneuverOf(dist ? t.slice(dist[0].length) : t);
      if (dist) {
        const tier = snapDistance(parseInt(dist[1], 10));
        // A turn clip without its distance sounds like "turn now" hundreds of metres early: then say nothing (the chime still plays).
        if (!tier || !man) return [];
        const combined = COMBINED_MAP[tier + " მეტრში, " + man];
        if (combined) return [p + combined];
        return [p + DISTANCE_MAP[tier + " მეტრში"], p + MANEUVER_MAP[man]];
      }
      if (man) return [p + MANEUVER_MAP[man]];
      // a speed-camera warning has no clip of its own: the alert chime only (v3.10.66; "სიჩქარის კამერა" used to play speed_limit.mp3)
      if (t.includes("კამერა")) return [];
      if (t.includes("შუქნიშანი")) return [p + "traffic_signal.mp3"];
      if (t.includes("სიჩქარ") || t.includes("შეანელეთ")) return [p + "speed_limit.mp3"];
      if (t.includes("საცობი")) return [p + "traffic_jam.mp3"];
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
    snapDistance,
    maneuverOf,
    MANEUVER_MAP,
    COMBINED_MAP,
    DISTANCE_MAP
  };
});
