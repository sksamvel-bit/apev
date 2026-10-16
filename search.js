/**
 * search.js - pure helpers for the destination search box.
 *
 * Policy: the public Nominatim server forbids search-as-you-type, so typing only ever queries LOCAL sources
 * (recent destinations, saved Home/Work, charging stations); the internet geocoder runs only when the driver
 * presses Enter or taps the "search online" row. Results are ranked by distance from the car.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SearchUtil = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_RECENTS = 8;

  function normalize(s) {
    return String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
  }

  function distKm(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Every query word must be a prefix of some word of the haystack (so "tbi rus" finds "Tbilisi, Rustaveli"). */
  function matches(query, haystack) {
    const qw = normalize(query).split(" ").filter(Boolean);
    if (!qw.length) return false;
    const hw = normalize(haystack).split(/[\s,.\-/()]+/).filter(Boolean);
    return qw.every((q) => hw.some((h) => h.startsWith(q)));
  }

  /**
   * items: [{ title, subtitle?, lat, lon, kind, hay? }]. Returns the best `max`, recents first, then by distance.
   * pos: { lat, lng } of the car (optional).
   */
  function rankLocal(query, items, pos, max) {
    max = max || 6;
    const out = [];
    for (const it of items || []) {
      if (!it || !isFinite(it.lat) || !isFinite(it.lon)) continue;
      if (!matches(query, it.hay || (it.title + " " + (it.subtitle || "")))) continue;
      const km = pos && isFinite(pos.lat) ? distKm(pos.lat, pos.lng, it.lat, it.lon) : null;
      const exact = normalize(it.title).startsWith(normalize(query)) ? 0 : 1;
      out.push({ it, km, exact, pri: it.kind === "recent" || it.kind === "favorite" ? 0 : 1 });
    }
    out.sort((a, b) => a.pri - b.pri || a.exact - b.exact || (a.km == null ? 1 : b.km == null ? -1 : a.km - b.km));
    return out.slice(0, max).map((o) => Object.assign({}, o.it, { km: o.km }));
  }

  /** Newest first, no duplicates (same rounded coordinates), capped. */
  function addRecent(list, entry, max) {
    max = max || MAX_RECENTS;
    const key = (e) => e.lat.toFixed(4) + "," + e.lon.toFixed(4);
    const out = [entry].concat((list || []).filter((e) => e && isFinite(e.lat) && isFinite(e.lon) && key(e) !== key(entry)));
    return out.slice(0, max);
  }

  /** Sorts remote geocoder results (Nominatim shape) by distance from the car, keeping order when no position. */
  function sortByDistance(results, pos) {
    if (!pos || !isFinite(pos.lat)) return (results || []).slice();
    return (results || []).map((r) => Object.assign({}, r, { km: distKm(pos.lat, pos.lng, parseFloat(r.lat), parseFloat(r.lon)) }))
      .sort((a, b) => a.km - b.km);
  }

  function formatKm(km) {
    if (km == null || !isFinite(km)) return "";
    return km < 1 ? Math.round(km * 10) * 100 + " მ" : (km < 10 ? km.toFixed(1) : String(Math.round(km))) + " კმ";
  }

  return { normalize, matches, rankLocal, addRecent, sortByDistance, formatKm, distKm, MAX_RECENTS };
});
