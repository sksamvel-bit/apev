/**
 * Speech Navigation Assistant
 * Provides voice prompts for maneuvers, arrival, and alerts
 */

class SpeechAssistant {
  constructor() {
    this.synth = window.speechSynthesis || null;
    this.voices = [];
    this.isMuted = false;
    this.lastPrompt = "";
    this.lastPromptTime = 0;
    this.minIntervalMs = 4000;

    this.initVoices();
  }

  initVoices() {
    if (!this.synth) return;

    const load = () => {
      this.voices = this.synth.getVoices();
    };

    load();
    if (this.synth.onvoiceschanged !== undefined) {
      this.synth.onvoiceschanged = load;
    }
  }

  speak(text) {
    if (this.isMuted || !this.synth || !text) return;

    const now = Date.now();
    if (text === this.lastPrompt && (now - this.lastPromptTime) < this.minIntervalMs) {
      return;
    }

    try {
      this.synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;

      // Check available voices for Georgian or fallback to English
      const voices = this.voices.length > 0 ? this.voices : this.synth.getVoices();
      const kaVoice = voices.find(v => v.lang.startsWith("ka"));
      const enVoice = voices.find(v => v.lang.startsWith("en-US") || v.lang.startsWith("en"));
      
      if (kaVoice) {
        utterance.voice = kaVoice;
      } else if (enVoice) {
        utterance.voice = enVoice;
      }

      this.synth.speak(utterance);
      this.lastPrompt = text;
      this.lastPromptTime = now;
    } catch (e) {
      console.warn("Speech synthesis notice:", e.message);
    }
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.isMuted && this.synth) {
      this.synth.cancel();
    }
    return this.isMuted;
  }
}

window.SpeechAssistant = SpeechAssistant;
