/**
 * map-gl.js - MapLibre GL helpers for Tesla Nav
 *
 *  MapUtil        Leaflet-equivalent zoom and padded view bounds (the engines were written against Leaflet).
 *  LayerRegistry  Custom sources/layers (route line, signals, traffic tiles) that survive a map.setStyle().
 *  FollowCamera   Smooth follow camera: 30 fps, dead-reckoning between 1 Hz GPS fixes, shortest-path bearing.
 *
 * Pure logic only (no DOM access except through the map object), so it is unit-testable in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MapGL = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const RAD = Math.PI / 180;

  function shortestDelta(to, from) {
    let d = (to - from) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  function normDeg(a) {
    a %= 360;
    return a < 0 ? a + 360 : a;
  }

  /** Move a point `meters` along `headingDeg` (flat-earth approximation, fine for < 100 m). */
  function advance(lng, lat, headingDeg, meters) {
    const r = headingDeg * RAD;
    const dLat = (meters * Math.cos(r)) / 110540;
    const dLng = (meters * Math.sin(r)) / (111320 * Math.cos(lat * RAD));
    return { lng: lng + dLng, lat: lat + dLat };
  }

  // ------------------------------------------------------------------ MapUtil
  const MapUtil = {
    /** MapLibre uses 512 px tiles, Leaflet 256 px: the same view is one zoom level lower in MapLibre. */
    leafletZoom(map) {
      return map.getZoom() + 1;
    },

    /** Bounds of the visible area (+ pad fraction) with a Leaflet-like contains([lat, lon]). */
    viewBounds(map, pad = 0) {
      const b = map.getBounds();
      let s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
      const dLat = (n - s) * pad, dLng = (e - w) * pad;
      s -= dLat; n += dLat; w -= dLng; e += dLng;
      return {
        getSouth: () => s, getNorth: () => n, getWest: () => w, getEast: () => e,
        contains(p) {
          const lat = Array.isArray(p) ? p[0] : p.lat;
          const lon = Array.isArray(p) ? p[1] : (p.lng != null ? p.lng : p.lon);
          return lat >= s && lat <= n && lon >= w && lon <= e;
        }
      };
    },

    /** Run fn at most once per `ms` (trailing edge). Camera-driven moves fire 'moveend' every frame. */
    throttle(fn, ms) {
      let timer = null;
      return function () {
        if (timer) return;
        timer = setTimeout(() => { timer = null; fn(); }, ms);
        if (timer && typeof timer.unref === "function") timer.unref();
      };
    }
  };

  // ------------------------------------------------------------ LayerRegistry
  class LayerRegistry {
    constructor() {
      this.defs = new Map();
    }

    /**
     * def = {
     *   sources: () => ({ id: sourceSpec }),   // called again on every style switch, so it can hand out CURRENT data
     *   layers:  () => [layerSpec],
     *   where:   "labels" (insert below the first symbol layer) | "top" (default)
     * }
     */
    register(id, def) { this.defs.set(id, def); }
    unregister(id) { this.defs.delete(id); }

    /** Returns a copy of `style` with all registered sources/layers merged in. */
    inject(style) {
      const out = Object.assign({}, style);
      out.sources = Object.assign({}, style.sources);
      out.layers = (style.layers || []).slice();
      for (const def of this.defs.values()) {
        const srcs = def.sources ? def.sources() : {};
        for (const k of Object.keys(srcs)) if (!out.sources[k]) out.sources[k] = srcs[k];
        const lyrs = def.layers ? def.layers() : [];
        for (const l of lyrs) {
          if (out.layers.some(x => x.id === l.id)) continue;
          const idx = def.where === "labels" ? out.layers.findIndex(x => x.type === "symbol") : -1;
          if (idx >= 0) out.layers.splice(idx, 0, l);
          else out.layers.push(l);
        }
      }
      return out;
    }
  }

  // -------------------------------------------------------------- FollowCamera
  const perfNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  class FollowCamera {
    /**
     * opts: minFrameMs (33 = 30 fps), posTauMs, bearingTauMs, bearingSlowTauMs, pitchTauMs, extrapMaxMs,
     *       padTopFraction (car sits lower on screen), raf/caf/now (injectable for tests),
     *       onFrame({lng, lat, bearing, pitch, speedMs, headingDeg}) called every frame with the displayed car state.
     */
    constructor(map, opts = {}) {
      this.map = map;
      this.minFrameMs = opts.minFrameMs != null ? opts.minFrameMs : 33;
      this.posTauMs = opts.posTauMs != null ? opts.posTauMs : 220;
      this.bearingTauMs = opts.bearingTauMs != null ? opts.bearingTauMs : 260;          // driving: follow the turn quickly
      this.bearingSlowTauMs = opts.bearingSlowTauMs != null ? opts.bearingSlowTauMs : 900; // crawling/standing: ignore GPS heading jitter
      this.pitchTauMs = opts.pitchTauMs != null ? opts.pitchTauMs : 450;
      this.padTauMs = opts.padTauMs != null ? opts.padTauMs : 500;
      this.extrapMaxMs = opts.extrapMaxMs != null ? opts.extrapMaxMs : 1500;
      this.padTopFraction = opts.padTopFraction != null ? opts.padTopFraction : 0.30;
      this.idleFramesToSleep = opts.idleFramesToSleep != null ? opts.idleFramesToSleep : 45;
      this.now = opts.now || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
      this.raf = opts.raf || ((fn) => requestAnimationFrame(fn));
      this.caf = opts.caf || ((id) => cancelAnimationFrame(id));
      this.onFrame = opts.onFrame || null;

      this.mode = "heading-up";    // heading-up | north-up | manual
      this.following = true;
      this.headingPitch = opts.headingPitch != null ? opts.headingPitch : 45;

      this.fix = null;             // {lng, lat, headingDeg, speedMs, t}
      this.pos = null;             // displayed car position
      this.bearing = 0;            // displayed camera bearing
      this.pitch = 0;
      this.padTop = 0;

      this._rafId = null;
      this._last = 0;
      this._idle = 0;
      this._applied = null;
      this.frameCount = 0;         // diagnostics: animation frames actually processed
      this.jumpMs = 0;             // diagnostics: moving average of map.jumpTo() cost
      this.cbMs = 0;               // diagnostics: moving average of the onFrame callback cost
    }

    /** Latest GPS fix. headingDeg should already be smoothed by the caller (continuous heading). */
    setFix(f) {
      this.fix = { lng: f.lng, lat: f.lat, headingDeg: f.headingDeg, speedMs: f.speedMs || 0, t: this.now() };
      if (!this.pos) this.pos = { lng: f.lng, lat: f.lat };
      if (f.headingDeg != null && isFinite(f.headingDeg) && this._firstBearing !== true) {
        this._firstBearing = true;
        if (this.mode === "heading-up") this.bearing = normDeg(f.headingDeg);
      }
      this.wake();
    }

    setMode(mode) {
      if (mode !== this.mode) { this.mode = mode; this.wake(); }
    }

    setFollowing(on) {
      this.following = !!on;
      this._applied = null;
      if (this.following) this.wake();
    }

    /** Immediately centers and orients the camera on the vehicle. */
    recenter(coords, bearing, pitch) {
      this.following = true;
      if (coords) {
        this.pos = { lng: coords.lng, lat: coords.lat };
        if (!this.fix) {
          this.fix = { lng: coords.lng, lat: coords.lat, headingDeg: bearing != null ? bearing : 0, speedMs: 0, t: this.now() };
        } else {
          this.fix.lng = coords.lng;
          this.fix.lat = coords.lat;
          if (bearing != null && isFinite(bearing)) this.fix.headingDeg = bearing;
        }
      }
      if (bearing != null && isFinite(bearing)) this.bearing = normDeg(bearing);
      if (pitch != null && isFinite(pitch)) this.pitch = pitch;
      const h = this.map && this.map.getContainer ? this.map.getContainer().clientHeight : 0;
      this.padTop = this.mode === "heading-up" ? Math.round(h * this.padTopFraction) : 0;
      this._idle = 0;
      this._applied = null;

      const targetCenter = this.pos ? [this.pos.lng, this.pos.lat] : (coords ? [coords.lng, coords.lat] : null);
      if (targetCenter && this.map) {
        const cam = {
          center: targetCenter,
          bearing: this.bearing,
          pitch: this.pitch,
          padding: { top: Math.round(this.padTop), bottom: 0, left: 0, right: 0 }
        };
        if (this.map.easeTo) {
          this._easingUntil = this.now() + 450;
          this.map.easeTo(Object.assign({}, cam, { duration: 400 }));
        } else if (this.map.jumpTo) {
          this.map.jumpTo(cam, { followCamera: true });
        }
      }
      this.wake();
    }

    /** Take the current camera state from the map (after a manual gesture or a fitBounds). */
    syncFromMap() {
      const m = this.map;
      this.bearing = m.getBearing();
      this.pitch = m.getPitch();
      this._applied = null;
    }

    /** fitBounds / flyTo must not add up with our follow padding. */
    clearPadding() {
      this.padTop = 0;
      if (this.map.setPadding) this.map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
      this._applied = null;
    }

    targetBearing() {
      if (this.mode === "north-up") return 0;
      if (this.mode === "heading-up" && this.fix && this.fix.headingDeg != null && isFinite(this.fix.headingDeg)) return this.fix.headingDeg;
      return null; // manual: leave the map alone
    }

    targetPitch() {
      if (this.mode === "heading-up") return this.headingPitch;
      if (this.mode === "north-up") return 0;
      return null;
    }

    wake() {
      this._idle = 0;
      if (this._rafId == null) this._rafId = this.raf((ts) => this.tick(ts));
    }

    stop() {
      if (this._rafId != null) { this.caf(this._rafId); this._rafId = null; }
    }

    /** One animation frame (exposed for tests). `ts` is a rAF timestamp on the same clock as now(). */
    tick(ts) {
      this._rafId = null;
      if (!this.fix) { return; }
      if (this._easingUntil && ts < this._easingUntil) {
        this._rafId = this.raf((t) => this.tick(t));
        return;
      }
      this._easingUntil = 0;
      if (ts - this._last < this.minFrameMs) { this._rafId = this.raf((t) => this.tick(t)); return; }
      const dt = Math.min(1000, this._last ? ts - this._last : 16);   // real frame time: a 100 ms cap made smoothing lag at 1-3 fps
      this._last = ts;
      this.frameCount++;

      // 1) where the car should be right now (dead reckoning between fixes)
      const fix = this.fix;
      const age = Math.max(0, Math.min(this.extrapMaxMs, ts - fix.t));
      let tgt = { lng: fix.lng, lat: fix.lat };
      if (fix.speedMs > 1 && fix.headingDeg != null && isFinite(fix.headingDeg)) {
        tgt = advance(fix.lng, fix.lat, fix.headingDeg, fix.speedMs * age / 1000);
      }
      let dLng, dLat;
      if (Math.abs(tgt.lng - this.pos.lng) > 0.003 || Math.abs(tgt.lat - this.pos.lat) > 0.003) {
        dLng = tgt.lng - this.pos.lng; dLat = tgt.lat - this.pos.lat;   // far away (GPS just locked): snap
      } else {
        const kp = 1 - Math.exp(-dt / this.posTauMs);
        dLng = (tgt.lng - this.pos.lng) * kp; dLat = (tgt.lat - this.pos.lat) * kp;
      }
      this.pos.lng += dLng; this.pos.lat += dLat;

      // 2) camera bearing / pitch / padding
      let changed = Math.abs(dLng) > 1e-9 || Math.abs(dLat) > 1e-9;
      let tb = null, tp = null;
      if (this.following) {
        tb = this.targetBearing();
        if (tb != null) {
          const d = shortestDelta(tb, this.bearing);
          if (Math.abs(d) > 0.02) {
            const tau = fix.speedMs > 3 ? this.bearingTauMs : this.bearingSlowTauMs;
            this.bearing = normDeg(this.bearing + d * (1 - Math.exp(-dt / tau)));
            changed = true;
          }
        } else {
          this.bearing = this.map.getBearing();
        }
        tp = this.targetPitch();
        if (tp != null) {
          const d = tp - this.pitch;
          if (Math.abs(d) > 0.05) { this.pitch += d * (1 - Math.exp(-dt / this.pitchTauMs)); changed = true; }
        } else {
          this.pitch = this.map.getPitch();
        }
        const h = this.map.getContainer ? this.map.getContainer().clientHeight : 0;
        const tpad = this.mode === "heading-up" ? Math.round(h * this.padTopFraction) : 0;
        if (Math.abs(tpad - this.padTop) > 0.5) {
          this.padTop += (tpad - this.padTop) * (1 - Math.exp(-dt / this.padTauMs));
          changed = true;
        }
        // 3) apply to the map only while following
        const cam = { center: [this.pos.lng, this.pos.lat], padding: { top: Math.round(this.padTop), bottom: 0, left: 0, right: 0 } };
        if (tb != null) cam.bearing = this.bearing;
        if (tp != null) cam.pitch = this.pitch;
        const p0 = perfNow();
        this.map.jumpTo(cam, { followCamera: true });
        this.jumpMs += (perfNow() - p0 - this.jumpMs) * 0.2;
      } else {
        // the driver is looking around: mirror the map so that resuming eases from where it is now
        this.bearing = this.map.getBearing();
        this.pitch = this.map.getPitch();
      }
      if (this.onFrame) {
        const c0 = perfNow();
        this.onFrame({ lng: this.pos.lng, lat: this.pos.lat, bearing: this.bearing, pitch: this.pitch, speedMs: fix.speedMs, headingDeg: fix.headingDeg });
        this.cbMs += (perfNow() - c0 - this.cbMs) * 0.2;
      }

      // 4) sleep when nothing moves (saves GPU on the Tesla)
      if (changed || fix.speedMs > 1) this._idle = 0; else this._idle++;
      if (this._idle < this.idleFramesToSleep) this._rafId = this.raf((t) => this.tick(t));
    }
  }

  // ------------------------------------------------------------------ Lite mode
  // The car's Atom CPU spends most of its frame time placing labels. Lite keeps place names and major-road names
  // and hides everything else that is text/icon on the base map.
  const LITE_KEEP_ROAD = /motorway|trunk|primary|secondary|highway-name-major|major/i;
  const LITE_DROP_ROAD = /minor|path|track|service|shield|one_?way|arrow|pedestrian|footway|cycle/i;
  const LITE_DROP_SRC = /^(poi|housenumber|aerodrome_label|mountain_peak|water_name|waterway|park|aeroway|building)$/;

  /** Ids of base-map symbol layers to hide in Lite mode. `layers` is map.getStyle().layers. */
  function pickLiteHidden(layers, source) {
    const out = [];
    for (const l of layers || []) {
      if (!l || l.type !== "symbol") continue;
      if (source && l.source !== source) continue;
      const sl = l["source-layer"] || "";
      const id = String(l.id || "");
      let hide;
      if (sl === "place") hide = /other|hamlet|suburb|neighbo|island|isolated/i.test(id);
      else if (LITE_DROP_SRC.test(sl)) hide = true;
      else if (sl === "transportation_name" || sl === "transportation") hide = LITE_DROP_ROAD.test(id) || !LITE_KEEP_ROAD.test(id);
      else hide = /poi|housenumber|peak|airport|water|park|shield|oneway|arrow/i.test(id);
      if (hide) out.push(l.id);
    }
    return out;
  }

  /** Subset of the Lite-hidden layers that is shown again while the car is standing: house numbers and minor street names. */
  function pickLiteDetail(layers, source) {
    const hidden = new Set(pickLiteHidden(layers, source));
    return (layers || []).filter((l) => hidden.has(l.id) &&
      (l["source-layer"] === "housenumber" || (l["source-layer"] === "transportation_name" && !/shield|one_?way|arrow/i.test(l.id)))).map((l) => l.id);
  }

  /** Decides when to switch Lite on automatically: `need` consecutive moving samples below `minFps`. */
  function LiteGovernor(opts) {
    opts = opts || {};
    this.minFps = opts.minFps || 6;
    this.need = opts.need || 5;
    this.low = 0;
    this.fired = false;
  }
  LiteGovernor.prototype.sample = function (fps, moving) {
    if (this.fired) return false;
    if (!moving) { this.low = 0; return false; }
    this.low = fps < this.minFps ? this.low + 1 : 0;
    if (this.low >= this.need) { this.fired = true; return true; }
    return false;
  };

  return { shortestDelta, normDeg, advance, MapUtil, LayerRegistry, FollowCamera, pickLiteHidden, pickLiteDetail, LiteGovernor };
});
