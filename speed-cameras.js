/**
 * speed-cameras.js - fixed speed cameras (OpenStreetMap highway=speed_camera): a warning, not a map layer (v3.10.54).
 *
 * Data: the server (/api/cameras) asks Overpass once a day and caches the result, so the browser never talks to Overpass.
 * Static OSM data only (no live police reports, not every camera is mapped). v3.10.19 drew the cameras as a map layer and
 * that cost frames on the MCU2, so now nothing is drawn: a small badge next to the speedometer (visible on our map and in
 * Google mode) and one chime/voice prompt per camera when it is ahead of the car.
 *
 * UMD: the pure helpers (parseOverpass, bearingTo, angleDiff, findAhead) are also used by the server and by the tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SpeedCameras = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STORAGE_KEY = "tesla_nav_cameras";

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
    return Math.abs(((a - b) % 360 + 540) % 360 - 180);
  }

  /**
   * Cameras AHEAD of the car: closer than maxM, within `cone` degrees of the heading, and (when OSM knows the camera's
   * direction) facing the car's direction of travel. Sorted by distance: [{cam, dist}]
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
      if (c.dir != null && angleDiff(c.dir, headingDeg) > 90) continue;   // OSM direction = traffic it watches: the other carriageway
      out.push({ cam: c, dist: d });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  /** Badge text: "📷 300 მ · 60" (rounded to 50 m; the limit only when OSM has it). */
  function badgeText(hit) {
    if (!hit) return "";
    const r = Math.max(50, Math.round(hit.dist / 50) * 50);
    return "📷 " + r + " მ" + (hit.cam.ms ? " · " + hit.cam.ms : "");
  }

  // ------------------------------------------------------------------ engine (no map, works in Node tests too)
  class SpeedCamerasEngine {
    constructor(opts = {}) {
      this.storage = opts.storage !== undefined ? opts.storage : (typeof localStorage !== "undefined" ? localStorage : null);
      let saved = null;
      try { saved = this.storage ? this.storage.getItem(STORAGE_KEY) : null; } catch (_) {}
      this.isEnabled = saved !== "0";                 // on by default
      this.cameras = [];
      this.loaded = false;
      this.warnedAt = new Map();                      // camera id -> timestamp of the last warning
      this.warnDistance = opts.warnDistance || 350;   // metres
      this.warnCone = opts.warnCone || 30;            // degrees around the heading
      this.minSpeedKmh = opts.minSpeedKmh || 15;
      this.repeatMs = opts.repeatMs || 3 * 60 * 1000;
      this.fetchFn = opts.fetchFn || ((...a) => fetch(...a));
      this.retries = 0;
      if (opts.autoLoad !== false) this.load();
    }

    async load() {
      try {
        const r = await this.fetchFn("/api/cameras", { cache: "default" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        this.cameras = Array.isArray(j.cameras) ? j.cameras : [];
        this.loaded = true;
      } catch (e) {
        // the server may still be warming up (or Overpass was down): try again a few times, quietly
        if (this.retries++ < 4 && typeof setTimeout === "function") setTimeout(() => this.load(), 30000 * this.retries);
      }
    }

    toggle() {
      this.isEnabled = !this.isEnabled;
      try { if (this.storage) this.storage.setItem(STORAGE_KEY, this.isEnabled ? "1" : "0"); } catch (_) {}
      return this.isEnabled;
    }

    /**
     * Called with every GPS fix. Returns { hit, announce }: hit = the nearest camera ahead ({cam, dist}) for the badge,
     * announce = true once per camera (again only after repeatMs, so a slow queue does not repeat it).
     */
    update(pos, headingDeg, speedKmh, now = Date.now()) {
      if (!this.isEnabled || !this.cameras.length || !(speedKmh >= this.minSpeedKmh)) return { hit: null, announce: false };
      const ahead = findAhead(this.cameras, pos, headingDeg, this.warnDistance, this.warnCone);
      if (!ahead.length) return { hit: null, announce: false };
      const hit = ahead[0];
      const last = this.warnedAt.get(hit.cam.id) || 0;
      if (now - last < this.repeatMs) return { hit, announce: false };
      this.warnedAt.set(hit.cam.id, now);
      if (this.warnedAt.size > 300) this.warnedAt.delete(this.warnedAt.keys().next().value);
      return { hit, announce: true };
    }
  }

  /** Spoken text ("სიჩქარის კამერა 300 მეტრში, ლიმიტი 60"). Tesla has no Georgian voice: there the chime is what you hear. */
  function promptText(hit) {
    const r = Math.max(50, Math.round(hit.dist / 50) * 50);
    return "ყურადღება, სიჩქარის კამერა " + r + " მეტრში" + (hit.cam.ms ? ", ლიმიტი " + hit.cam.ms : "");
  }

  return { parseOverpass, distanceM, bearingTo, angleDiff, findAhead, badgeText, promptText, SpeedCamerasEngine, STORAGE_KEY };
});

if (typeof window !== "undefined" && window.SpeedCameras) window.SpeedCamerasEngine = window.SpeedCameras.SpeedCamerasEngine;
