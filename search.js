/**
 * search.js - pure helpers for the destination search box.
 *
 * Policy: the public Nominatim server forbids search-as-you-type, so Nominatim runs only when the driver presses Enter or
 * taps the "search online" row. While typing (v3.10.52) the list shows local sources (recent destinations, Home/Work,
 * charging stations) plus Photon suggestions (OSM, made for typeahead) through our cached server proxy /api/suggest.
 * On Enter the Nominatim results come first and the Photon rows that are not the same place are kept below them.
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

  /** Photon GeoJSON -> the Nominatim-shaped rows the search list already shows ({ display_name, lat, lon, source }). */
  function photonToResults(json) {
    const out = [];
    for (const f of (json && json.features) || []) {
      const c = f && f.geometry && f.geometry.coordinates, p = (f && f.properties) || {};
      if (!c || !isFinite(c[0]) || !isFinite(c[1])) continue;
      const street = p.street ? p.street + (p.housenumber ? " " + p.housenumber : "") : "";
      const head = p.name || street;
      if (!head) continue;
      const parts = [head, p.name ? street : "", p.district || p.locality || "", p.city || p.county || "", p.countrycode && p.countrycode !== "GE" ? p.country : ""];
      const display = [...new Set(parts.filter(Boolean).map((s) => String(s).trim()))].join(", ");
      if (out.some((o) => o.display_name === display)) continue;   // the building and its address point: one row
      out.push({ display_name: display, lat: String(c[1]), lon: String(c[0]), source: "photon" });
    }
    return out;
  }

  /** Nominatim rows first, then the Photon rows that are not the same place (same first name, or within maxM metres). */
  function mergeResults(primary, extra, maxM) {
    maxM = maxM || 60;
    const head = (r) => normalize(String(r.display_name || "").split(",")[0]);
    const out = [];
    for (const r of primary || []) if (!out.some((o) => o.display_name === r.display_name)) out.push(r);   // Nominatim repeats a place too
    for (const r of extra || []) {
      const dup = out.some((o) => head(o) === head(r) || distKm(+o.lat, +o.lon, +r.lat, +r.lon) * 1000 <= maxM);
      if (!dup) out.push(r);
    }
    return out;
  }

  /** List title: Nominatim starts addresses with the house number ("14, მერაბ კოსტავას ქუჩა, …"): show "მერაბ კოსტავას ქუჩა 14". */
  function resultTitle(r, fallback) {
    const parts = String((r && r.display_name) || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return fallback || "";
    if (/^\d+[a-zA-Zა-ჰ]?(\/\d+)?$/.test(parts[0]) && parts[1]) return parts[1] + " " + parts[0];
    return parts[0];
  }

  // ---- Google Maps share links from the phone (v3.10.53) ----
  const MAPS_SHORT_HOSTS = ["maps.app.goo.gl", "goo.gl"];

  /** "https://maps.app.goo.gl/x" (needs one redirect) or a full google.*\/maps link, else "". */
  function mapsLinkKind(text) {
    let u;
    try { u = new URL(String(text || "").trim()); } catch (_) { return ""; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    const h = u.hostname.toLowerCase();
    if (h === "maps.app.goo.gl" || (h === "goo.gl" && u.pathname.startsWith("/maps"))) return "short";
    if (/^(www\.|maps\.)?google\.[a-z.]{2,6}$/.test(h) && (h.startsWith("maps.") || u.pathname.startsWith("/maps"))) return "full";
    if (h === "consent.google.com" && u.searchParams.get("continue")) return mapsLinkKind(u.searchParams.get("continue")) ? "full" : "";
    return "";
  }

  /** Pulls the first URL out of shared text ("Prime Fit\nhttps://maps.app.goo.gl/abc"). */
  function extractUrl(text) {
    const m = String(text || "").match(/https?:\/\/[^\s<>"']+/);
    return m ? m[0].replace(/[),.]+$/, "") : "";
  }

  function coordPair(s) {
    const m = String(s || "").match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
    if (!m) return null;
    const lat = +m[1], lng = +m[2];
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
  }

  /**
   * A full Google Maps URL -> { name, lat, lng } (lat/lng null when only a name is in it), or null.
   * Order of trust: the place pin (!3d..!4d..), then q=/query=/destination=/daddr=/ll= coordinates, then the map centre (@lat,lng).
   */
  function parseMapsUrl(text) {
    let u;
    try { u = new URL(String(text || "").trim()); } catch (_) { return null; }
    if (u.hostname === "consent.google.com") return parseMapsUrl(u.searchParams.get("continue"));
    const href = decodeURIComponent(u.href.replace(/\+/g, " "));
    let name = "", pos = null;
    const place = u.pathname.match(/\/maps\/(?:place|search|dir\/[^/]*)\/([^/@]+)/);
    if (place) name = decodeURIComponent(place[1].replace(/\+/g, " ")).trim();
    const pin = href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (pin) pos = coordPair(pin[1] + "," + pin[2]);
    for (const k of ["q", "query", "destination", "daddr", "ll"]) {
      const v = u.searchParams.get(k);
      if (!v) continue;
      const c = coordPair(v);
      if (c && !pos) pos = c;
      else if (!c && !name) name = v.replace(/\+/g, " ").trim();
    }
    const at = u.pathname.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (!pos && at) pos = coordPair(at[1] + "," + at[2]);
    if (coordPair(name)) { pos = pos || coordPair(name); name = ""; }
    if (!pos && !name) return null;
    return { name: name.slice(0, 120), lat: pos ? pos.lat : null, lng: pos ? pos.lng : null };
  }

  function formatKm(km) {
    if (km == null || !isFinite(km)) return "";
    return km < 1 ? Math.round(km * 10) * 100 + " მ" : (km < 10 ? km.toFixed(1) : String(Math.round(km))) + " კმ";
  }

  return { normalize, matches, rankLocal, addRecent, sortByDistance, formatKm, distKm, photonToResults, mergeResults, resultTitle, mapsLinkKind, extractUrl, parseMapsUrl, MAPS_SHORT_HOSTS, MAX_RECENTS };
});
