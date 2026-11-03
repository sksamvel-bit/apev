/**
 * Speech Navigation Assistant (speech.js)
 * Provides authentic Georgian voice navigation prompts (Web Speech API)
 * and Tesla-style high-clarity directional navigation audio chimes (Web Audio API).
 * Strictly Georgian - Zero English fallback!
 */

class SpeechAssistant {
  constructor(options = {}) {
    this.synth = (typeof window !== "undefined" && window.speechSynthesis) ? window.speechSynthesis : null;
    this.audioCtx = null;
    this.turnAudio = (options && options.turnAudio) || null;
    if (!this.turnAudio && typeof window !== "undefined" && window.TurnAudioEngine) {
      try {
        const TAE = window.TurnAudioEngine.TurnAudioEngine || window.TurnAudioEngine;
        if (typeof TAE === "function") {
          this.turnAudio = new TAE();
        }
      } catch (_) {}
    }
    this.voices = [];
    this.isMuted = false;
    this.lastPrompt = "";
    this.lastPromptTime = 0;
    this.minIntervalMs = 3500;
    // v3.10.107 (ISO 16951): what is being said now and what waits behind it
    this.busyPrio = 9;
    this.busyUntil = 0;
    this.pending = null;
    this.pendingTimer = null;

    this.initVoices();
  }

  initVoices() {
    if (!this.synth) return;

    const load = () => {
      try {
        this.voices = this.synth.getVoices() || [];
      } catch (_) {
        this.voices = [];
      }
    };

    load();
    if (typeof this.synth.onvoiceschanged !== "undefined") {
      this.synth.onvoiceschanged = load;
    }
  }

  initAudioContext() {
    if (this.audioCtx) return this.audioCtx;
    if (typeof window === "undefined") return null;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      try {
        this.audioCtx = new AudioCtx();
      } catch (e) {
        console.warn("SpeechAssistant: AudioContext init error:", e.message);
      }
    }
    return this.audioCtx;
  }

  /**
   * Plays navigation acoustic tone cues (Tesla / Apple Maps style)
   * @param {"turn-right"|"turn-left"|"arrive"|"alert"|"straight"|"default"} type
   */
  playChime(type) {
    if (this.isMuted) return;
    try {
      const ctx = this.initAudioContext();
      if (!ctx) return;
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }

      const now = ctx.currentTime;

      if (type === "turn-right") {
        // Ascending harmonic chime: A4 (440Hz) -> D5 (587.3Hz)
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        gain.gain.setValueAtTime(0.001, now);
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(587.33, now + 0.12);
        gain.gain.linearRampToValueAtTime(0.25, now + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.36);
      } else if (type === "turn-left") {
        // Descending harmonic chime: D5 (587.3Hz) -> A4 (440Hz)
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        gain.gain.setValueAtTime(0.001, now);
        osc.frequency.setValueAtTime(587.33, now);
        osc.frequency.exponentialRampToValueAtTime(440, now + 0.12);
        gain.gain.linearRampToValueAtTime(0.25, now + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.36);
      } else if (type === "arrive") {
        // Celebratory triad arpeggio (C5 -> E5 -> G5)
        const notes = [523.25, 659.25, 783.99];
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const start = now + idx * 0.11;
          osc.type = "triangle";
          osc.frequency.setValueAtTime(freq, start);
          gain.gain.setValueAtTime(0.001, start);
          gain.gain.linearRampToValueAtTime(0.24, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, start + 0.32);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(start);
          osc.stop(start + 0.33);
        });
      } else if (type === "alert" || type === "signal") {
        // Warning/Signal double ping
        [0, 0.14].forEach((offset) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const start = now + offset;
          osc.type = "sine";
          osc.frequency.setValueAtTime(739.99, start);
          gain.gain.setValueAtTime(0.001, start);
          gain.gain.linearRampToValueAtTime(0.22, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, start + 0.15);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(start);
          osc.stop(start + 0.16);
        });
      } else {
        // Subtle confirmation ping (C5 523.25Hz)
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        gain.gain.setValueAtTime(0.001, now);
        osc.frequency.setValueAtTime(523.25, now);
        gain.gain.linearRampToValueAtTime(0.18, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.29);
      }
    } catch (e) {
      console.warn("SpeechAssistant chime playback notice:", e.message);
    }
  }

  /**
   * v3.10.107 (ISO 16951): 1 = safety (speed camera, speed, ice, rain, traffic light, "ყურადღება"), 2 = a maneuver right now
   * (no distance in the text) or the arrival, 3 = everything else (early "500 მეტრში ...", route recalculated, ...).
   */
  static priorityOf(text) {
    const t = String(text || "");
    if (/ყურადღება|კამერ|სიჩქარ|ყინულ|წვიმ|თოვ|შუქნიშან/.test(t)) return 1;
    if (/მიხვედით/.test(t)) return 2;
    if (!/მეტრში|კილომეტრში/.test(t) && /მოუხვიეთ|შეუხვიეთ|შემობრუნდით|გადაუხვიეთ|წრეზე|წრიდან|გამოდით|დარჩით/.test(t)) return 2;
    return 3;
  }

  /** Rough length of a prompt (Georgian TTS ~13 characters a second) when the end event does not come. */
  static estimateMs(text) { return 1200 + String(text || "").length * 75; }

  /**
   * Speaks prompt in Georgian and plays contextual directional chime.
   * Strictly Georgian locale (ka-GE) - NEVER falls back to English TTS!
   * v3.10.107: a new prompt never cuts off a more important one that is still being said (a turn prompt used to stop a
   * speed-camera warning half-way); it waits and follows it, or is dropped when it is 6 s old by then.
   * @param {string} text
   * @param {number} [prio] 1..3, see priorityOf
   */
  speak(text, prio) {
    if (this.isMuted || !text) return;

    const now = Date.now();
    if (text === this.lastPrompt && (now - this.lastPromptTime) < this.minIntervalMs) {
      return;
    }
    const p = prio || SpeechAssistant.priorityOf(text);
    if (this.busyUntil > now && this.busyPrio < p) {
      if (!this.pending || p <= this.pending.prio) this.pending = { text, prio: p, t: now };
      this.schedulePending(this.busyUntil - now);
      return;
    }
    this.sayNow(text, p, now);
  }

  schedulePending(ms) {
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => this.flushPending(), Math.max(50, ms));
  }

  flushPending() {
    const now = Date.now();
    if (this.busyUntil > now) { this.schedulePending(this.busyUntil - now); return; }
    const q = this.pending;
    this.pending = null;
    if (q && !this.isMuted && now - q.t <= 6000) this.sayNow(q.text, q.prio, now);
  }

  /** The prompt is over (audio clip or TTS end event): the next one may start at once. */
  doneSpeaking(token) {
    if (token !== this.speakToken) return;
    this.busyUntil = 0;
    if (this.pending) this.schedulePending(50);
  }

  sayNow(text, prio, now) {
    const token = this.speakToken = (this.speakToken || 0) + 1;
    this.busyPrio = prio;
    this.busyUntil = now + SpeechAssistant.estimateMs(text);

    // 1. Play directional chime cue
    const lower = text.toLowerCase();
    if (lower.includes("მარჯვნივ")) {
      this.playChime("turn-right");
    } else if (lower.includes("მარცხნივ")) {
      this.playChime("turn-left");
    } else if (lower.includes("მიხვედით") || lower.includes("დანიშნულების")) {
      this.playChime("arrive");
    } else if (lower.includes("შუქნიშანი") || lower.includes("სიჩქარე") || lower.includes("აცდით") || lower.includes("ყურადღება")) {
      this.playChime("alert");
    } else {
      this.playChime("default");
    }

    // 2. Pre-rendered authentic Georgian navigation voice audio pack
    let audioPlayed = false;
    if (this.turnAudio && typeof this.turnAudio.play === "function") {
      try {
        audioPlayed = this.turnAudio.play(text, () => this.doneSpeaking(token));
      } catch (e) {
        console.warn("SpeechAssistant turnAudio notice:", e.message);
      }
    }

    // 3. Georgian TTS Voice Synthesis (Zero English fallback: only if audio clip not played and Georgian voice exists)
    if (!audioPlayed && this.synth) {
      try {
        this.synth.cancel();
        if (typeof SpeechSynthesisUtterance !== "undefined") {
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.rate = 1.0;
          utterance.pitch = 1.0;
          utterance.lang = "ka-GE"; // Exclusively Georgian locale

          const voices = this.voices.length > 0 ? this.voices : (this.synth.getVoices ? this.synth.getVoices() : []);
          const kaVoice = voices.find(v => {
            const l = (v.lang || "").toLowerCase();
            const n = (v.name || "").toLowerCase();
            return l.startsWith("ka") || l === "ka-ge" || n.includes("georgian") || n.includes("ქართული");
          });

          if (kaVoice) {
            utterance.voice = kaVoice;
            utterance.onend = () => this.doneSpeaking(token);
            utterance.onerror = () => this.doneSpeaking(token);
            this.synth.speak(utterance);
          }
          // Intentionally NO English fallback: if Georgian voice is not installed in OS,
          // do NOT call this.synth.speak(), because Windows/Chromium will fall back to
          // Microsoft David or English system voice. The directional audio chime provides
          // the clear high-fidelity cue without annoying English gibberish!
        }
      } catch (e) {
        console.warn("SpeechAssistant speak error:", e.message);
      }
    }

    this.lastPrompt = text;
    this.lastPromptTime = now;
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.turnAudio && typeof this.turnAudio.setMuted === "function") {
      this.turnAudio.setMuted(this.isMuted);
    }
    if (this.isMuted) { this.pending = null; this.busyUntil = 0; clearTimeout(this.pendingTimer); }
    if (this.isMuted && this.synth) {
      try {
        this.synth.cancel();
      } catch (_) {}
    }
    return this.isMuted;
  }
}

if (typeof window !== "undefined") {
  window.SpeechAssistant = SpeechAssistant;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { SpeechAssistant };
}
