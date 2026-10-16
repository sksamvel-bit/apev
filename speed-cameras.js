/**
 * speed-cameras.js - fixed speed cameras (OpenStreetMap highway=speed_camera) as a flat map layer + a voice warning.
 *
 * Data: the server (/api/cameras) asks Overpass once a day and caches the result, so the browser never talks to Overpass.
 * Static OSM data only (no live police reports). The layer is a single GeoJSON symbol layer (cheap on the Atom MCU2);
 * each camera is drawn as a small sign with its limit, the sign image is generated on demand.
 *
 * UMD: the pure helpers (parseOverpass, bearingTo, angleDiff, findAhead) are also used by the server and by the tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SpeedCameras = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LAYER_ID = "speed-cameras-layer";
  const SOURCE_ID = "speed-cameras-src";

  // ------------------------------------------------------------------ pure helpers
  /** Overpass JSON -> [{id, lat, lon, ms (limit km/h or 0), dir (deg or null), avg (bool)}] */
  function parseOverpass(json) {
    const out = [];
    const els = json && Array.isArray(json.elements) ? json.elements : [];
    for (const e of els) {
      if (!e || e.type !== "node" || typeof e.lat !== "number" || typeof e.lon !== "number") continue;
      const tags = e.tags || {};
      if (tags.highway !== "speed_camera") continue;
      const ms = parseInt(String(tags.maxspeed || "").replace(/[^0-9]/g, ""), 10);
      const dirN = parseFloat(tags.direction);
      out.push({
        id: e.id,
        lat: e.lat,
        lon: e.lon,
        ms: ms > 0 && ms <= 150 ? ms : 0,
        dir: isFinite(dirN) ? ((dirN % 360) + 360) % 360 : null,
        avg: tags.enforcement === "average_speed"
      });
    }
    return out;
  }

  function toRad(d) { return d * Math.PI / 180; }

  function distanceM(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function bearingTo(lat1, lon1, lat2, lon2) {
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  /** Smallest absolute difference between two compass angles (0..180). */
  function angleDiff(a, b) {
    const d = Math.abs(((a - b) % 360 + 540) % 360 - 180);
    return d;
  }

  /**
   * Cameras that are AHEAD of the car: closer than maxM, within `cone` degrees of the heading.
   * Returns the list sorted by distance: [{cam, dist}]
   */
  function findAhead(cameras, pos, headingDeg, maxM, cone) {
    const out = [];
    if (!cameras || !pos || headingDeg == null || isNaN(headingDeg)) return out;
    const dLat = maxM / 111139 + 0.0005, dLon = dLat / Math.cos(toRad(pos.lat));
    for (const c of cameras) {
      if (Math.abs(c.lat - pos.lat) > dLat || Math.abs(c.lon - pos.lng) > dLon) continue; // cheap pre-filter
      const d = distanceM(pos.lat, pos.lng, c.lat, c.lon);
      if (d > maxM || d < 15) continue;
      if (angleDiff(bearingTo(pos.lat, pos.lng, c.lat, c.lon), headingDeg) > cone) continue;
      out.push({ cam: c, dist: d });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  function toGeoJSON(cameras) {
    return {
      type: "FeatureCollection",
      features: (cameras || []).map((c) => ({
        type: "Feature",
        properties: { id: c.id, ms: c.ms, avg: c.avg ? 1 : 0 },
        geometry: { type: "Point", coordinates: [c.lon, c.lat] }
      }))
    };
  }

  // ------------------------------------------------------------------ engine (browser only)
  class SpeedCamerasEngine {
    constructor(map, startEnabled = true, opts = {}) {
      this.map = map;
      this.isEnabled = !!startEnabled;
      this.cameras = [];
      this.loaded = false;
      this.warnedAt = new Map();   // camera id -> timestamp of the last warning
      this.warnDistance = opts.warnDistance || 350;   // metres
      this.warnCone = opts.warnCone || 30;            // degrees around the heading
      this.minSpeedKmh = opts.minSpeedKmh || 15;
      this.repeatMs = opts.repeatMs || 3 * 60 * 1000;
      this.fetchFn = opts.fetchFn || ((...a) => fetch(...a));
      this.retries = 0;

      this.registerMapLayers();
      if (map && typeof map.on === "function") {
        // setStyle() drops images: MapLibre asks again for the sign it needs
        map.on("styleimagemissing", (e) => { if (e.id && e.id.indexOf("cam-") === 0) this.addIcon(e.id); });
      }
      this.load();
    }

    async load() {
      try {
        const r = await this.fetchFn("/api/cameras", { cache: "default" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        this.cameras = Array.isArray(j.cameras) ? j.cameras : [];
        this.loaded = true;
        this.pushData();
      } catch (e) {
        // try again a few times (server may still be warming up); a missing layer is not worth an error toast
        if (this.retries++ < 4 && typeof setTimeout === "function") setTimeout(() => this.load(), 30000 * this.retries);
      }
    }

    registerMapLayers() {
      const reg = typeof window !== "undefined" ? window.layerRegistry : null;
      if (!reg) return;
      reg.register("speed-cameras", {
        sources: () => ({ [SOURCE_ID]: { type: "geojson", data: toGeoJSON(this.cameras) } }),
        layers: () => [{
          id: LAYER_ID,
          type: "symbol",
          source: SOURCE_ID,
          minzoom: 12,
          layout: {
            "icon-image": ["concat", "cam-", ["to-string", ["get", "ms"]]],
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "icon-pitch-alignment": "viewport",
            "icon-rotation-alignment": "viewport",
            visibility: this.isEnabled ? "visible" : "none"
          }
        }]
      });
    }

    pushData() {
      const m = this.map;
      if (!m || typeof m.getSource !== "function") return;
      const src = m.getSource(SOURCE_ID);
      if (src && typeof src.setData === "function") src.setData(toGeoJSON(this.cameras));
    }

    /** Round red sign with the limit (or a lens when the limit is unknown). id = "cam-60" / "cam-0". */
    addIcon(id) {
      const m = this.map;
      if (!m || typeof m.addImage !== "function" || typeof document === "undefined") return;
      if (typeof m.hasImage === "function" && m.hasImage(id)) return;
      const n = parseInt(id.slice(4), 10) || 0;
      const S = 44, c = document.createElement("canvas");
      c.width = c.height = S;
      const g = c.getContext("2d");
      g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
      g.fillStyle = "#ffffff"; g.fill();
      g.lineWidth = 5; g.strokeStyle = "#dc2626"; g.stroke();
      g.fillStyle = "#111827";
      g.textAlign = "center"; g.textBaseline = "middle";
      if (n > 0) {
        g.font = "bold " + (n >= 100 ? 15 : 19) + "px sans-serif";
        g.fillText(String(n), S / 2, S / 2 + 1);
      } else {
        g.beginPath(); g.arc(S / 2, S / 2, 6, 0, Math.PI * 2); g.fillStyle = "#dc2626"; g.fill();
      }
      m.addImage(id, g.getImageData(0, 0, S, S), { pixelRatio: 2 });
    }

    toggle() {
      this.isEnabled = !this.isEnabled;
      const m = this.map;
      if (m && typeof m.getLayer === "function" && m.getLayer(LAYER_ID)) {
        m.setLayoutProperty(LAYER_ID, "visibility", this.isEnabled ? "visible" : "none");
      }
      return this.isEnabled;
    }

    /**
     * Called with every GPS fix. Speaks once per camera when it is ahead within warnDistance,
     * and again only after repeatMs (so a slow queue does not repeat it).
     * speakFn(text) is injected (SpeechAssistant.speak). Returns the camera announced, or null.
     */
    update(pos, headingDeg, speedKmh, speakFn, now = Date.now()) {
      if (!this.isEnabled || !this.cameras.length || !(speedKmh >= this.minSpeedKmh)) return null;
      const ahead = findAhead(this.cameras, pos, headingDeg, this.warnDistance, this.warnCone);
      if (!ahead.length) return null;
      const { cam, dist } = ahead[0];
      const last = this.warnedAt.get(cam.id) || 0;
      if (now - last < this.repeatMs) return null;
      this.warnedAt.set(cam.id, now);
      if (this.warnedAt.size > 300) this.warnedAt.delete(this.warnedAt.keys().next().value);
      if (typeof speakFn === "function") {
        const r = Math.max(50, Math.round(dist / 50) * 50);
        speakFn(`${r} მეტრში სიჩქარის კამერა` + (cam.ms ? `, ლიმიტი ${cam.ms}` : ""));
      }
      return cam;
    }
  }

  return { parseOverpass, distanceM, bearingTo, angleDiff, findAhead, toGeoJSON, SpeedCamerasEngine, LAYER_ID, SOURCE_ID };
});

if (typeof window !== "undefined" && window.SpeedCameras) window.SpeedCamerasEngine = window.SpeedCameras.SpeedCamerasEngine;
