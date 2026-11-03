/**
 * gmap.js - "Google mode" (v3.11.0): the Google map with the city traffic layer and Google Places search, like tmap.ge.
 *
 * Why a separate mode and not a layer on the MapLibre map: Google's terms forbid showing Google data (traffic tiles, Places
 * results) on a non-Google map, so everything that comes from Google lives on the Google map, and our own data (the OSRM route,
 * the car position) is drawn on top of it, which is allowed. The mode is opt-in: it needs GOOGLE_MAPS_KEY on the server
 * (/api/gmaps-config, behind the access PIN); without the key the dock button stays hidden and nothing is loaded from Google.
 *
 * The Google script is loaded only when the driver opens the mode. Since v3.10.93 it is the start map: the vector (3D, heading-up)
 * map by default, the classic raster map as an option (?map / map menu); our MapLibre map is the automatic fallback. Routes, search
 * and rerouting come from Google (Routes API, Places API New), with OSRM only when Google cannot answer.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GMapMode = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TBILISI = { lat: 41.7151, lng: 44.8271 };
  const OFF_ROUTE_M = 45; // farther than this from the route line counts as an off-route fix
  const OSRM_SERVERS = [
    "https://router.project-osrm.org/route/v1/driving/",
    "https://routing.openstreetmap.de/routed-car/route/v1/driving/"
  ];
  const CATEGORIES = [
    { id: "ev", label: "⚡ დამუხტვა", type: "electric_vehicle_charging_station" } // fuel/food/parking removed at Samvel's request (v3.10.34)
  ];

  /** Main dock buttons repeated on the Google side panel (v3.10.56): our data and our settings, never Google data on our map. */
  const SIDE_PROXIES = [
    { icon: "📋", ikey: "list", tone: "amber", title: "დამტენების სია", target: "btn-chargers-list", activeClass: "active" },
    { icon: "📷", ikey: "camera", tone: "red", title: "სიჩქარის კამერები", target: "btn-toggle-cameras", activeClass: "signals-active" },
    { icon: "🔊", iconOff: "🔇", ikey: "volume", ikeyOff: "volumeOff", tone: "teal", title: "ხმოვანი ნავიგაცია", target: "btn-toggle-voice", activeClass: "active" },
    { icon: "📱", ikey: "phone", tone: "gray", title: "ტელეფონით მართვა", target: "btn-remote-phone" },
    { icon: "⚙️", ikey: "settings", tone: "gray", title: "პარამეტრები", target: "btn-settings" }
  ];

  /** v3.10.113 (Samvel, panel style 3 "coloured categories"): one line-icon set instead of emoji (emoji differ per system
   *  and look like stickers). 24x24, 2 px round strokes, drawn in currentColor; the colour comes from the button's data-tone. */
  const PANEL_ICONS = {
    traffic: "M9 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM12 6.2a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6zM12 10.7a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6zM12 15.2a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z",
    night: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
    map: "M12 4l9 4.5-9 4.5-9-4.5zM3 12.5l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5",
    locate: "M12 5a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM12 10.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3zM12 2v3M12 19v3M2 12h3M19 12h3",
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    bolt: "M13 3L5 14h6l-1 7 8-11h-6z",
    list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
    camera: "M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM12 9.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z",
    volume: "M4 10v4h4l5 4V6L8 10zM16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11",
    volumeOff: "M4 10v4h4l5 4V6L8 10zM17 10l4 4M21 10l-4 4",
    phone: "M9 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM11 18h2",
    settings: "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1",
    close: "M6 6l12 12M18 6L6 18"
  };
  /** Puts icon `name` into button `b` (DOM only, no innerHTML); tone = the colour family in style.css. */
  function setPanelIcon(b, name, tone) {
    if (!b || !PANEL_ICONS[name] || typeof document === "undefined") return;
    const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), path = document.createElementNS(NS, "path");
    [["viewBox", "0 0 24 24"], ["width", "22"], ["height", "22"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"]].forEach(([k, v]) => svg.setAttribute(k, v));
    path.setAttribute("d", PANEL_ICONS[name]);
    svg.appendChild(path);
    b.textContent = "";
    b.appendChild(svg);
    if (tone) b.setAttribute("data-tone", tone);
    if (!b.getAttribute("aria-label") && b.title) b.setAttribute("aria-label", b.title);
  }

  // ---------- pure helpers (unit-tested) ----------
  function buildLoaderUrl(key, callbackName) {
    return "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) +
      "&v=weekly&loading=async&language=ka&region=GE&callback=" + encodeURIComponent(callbackName || "__gmapReady");
  }

  /** Calls fn once, `ms` after the last call (search-as-you-type without a request per keystroke). */
  function createDebouncer(fn, ms) {
    let t = null;
    const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    d.cancel = () => clearTimeout(t);
    return d;
  }

  function osrmUrl(server, from, to) {
    return server + from.lng + "," + from.lat + ";" + to.lng + "," + to.lat + "?overview=full&geometries=geojson&steps=false&alternatives=false";
  }

  function summarizeRoute(durationSec, distanceM) {
    const min = Math.max(1, Math.round(durationSec / 60));
    const km = distanceM / 1000;
    return min + " წთ · " + (km >= 10 ? km.toFixed(0) : km.toFixed(1)) + " კმ";
  }

  /** Quiet grey map styles (matches the flat "mono" look of the main map). The traffic overlay keeps its own colours. */
  function mapStyles(night) {
    const base = [
      { stylers: [{ saturation: -100 }] },
      { featureType: "poi.business", stylers: [{ visibility: "off" }] },
      { featureType: "transit", elementType: "labels.icon", stylers: [{ visibility: "off" }] }
    ];
    if (!night) return base;
    return base.concat([
      { elementType: "geometry", stylers: [{ color: "#1d1f23" }] },
      { elementType: "labels.text.fill", stylers: [{ color: "#9aa0a8" }] },
      { elementType: "labels.text.stroke", stylers: [{ color: "#1d1f23" }] },
      { featureType: "road", elementType: "geometry", stylers: [{ color: "#3a3d43" }] },
      { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#4b4f56" }] },
      { featureType: "water", elementType: "geometry", stylers: [{ color: "#101215" }] },
      { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#1d1f23" }] }
    ]);
  }

  function bearing(a, b) {
    const r = Math.PI / 180, y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
    const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  }

  function meters(a, b) {
    const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(h));
  }

  /** Position of p projected on segment a->b as a fraction (0 = a, 1 = b, unclamped); equirectangular, fine at street scale. */
  function segT(a, b, p) {
    const k = Math.cos(p.lat * Math.PI / 180);
    const ax = (a.lng - p.lng) * k, ay = a.lat - p.lat, dx = (b.lng - a.lng) * k, dy = b.lat - a.lat, L = dx * dx + dy * dy;
    return L ? (-ax * dx - ay * dy) / L : 1;
  }

  /** Nearest point of the polyline segments [from, to) to pt: { d: metres, i: segment index }. */
  function nearestOnPolyline(pt, line, from, to) {
    if (!line || !line.length) return { d: Infinity, i: -1 };
    if (line.length === 1) return { d: meters(pt, line[0]), i: 0 };
    const lo = Math.max(0, from | 0), hi = Math.min(line.length - 1, typeof to === "number" ? to : line.length - 1);
    let best = { d: Infinity, i: -1 };
    for (let i = lo; i < hi; i++) {
      const a = line[i], b = line[i + 1];
      const t = Math.max(0, Math.min(1, segT(a, b, pt)));
      const d = meters(pt, { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) });
      if (d < best.d) best = { d, i };
    }
    return best;
  }

  function distToPolylineM(pt, line) { return nearestOnPolyline(pt, line).d; }

  function createOffRouteTracker(opts) {
    const o = opts || {};
    const thresholdM = typeof o.thresholdM === "number" ? o.thresholdM : 45;
    const ticks = typeof o.ticks === "number" ? o.ticks : 4;
    const cooldownMs = typeof o.cooldownMs === "number" ? o.cooldownMs : 20000;
    const maxReroutes = typeof o.maxReroutes === "number" ? o.maxReroutes : 12;

    let offCount = 0;
    let lastReroute = -Infinity;
    let rerouteCount = 0;

    return {
      update(distM, nowMs) {
        const now = typeof nowMs === "number" ? nowMs : Date.now();
        if (distM > thresholdM) {
          offCount++;
          if (offCount >= ticks) {
            if (rerouteCount < maxReroutes && (now - lastReroute) >= cooldownMs) {
              rerouteCount++;
              lastReroute = now;
              offCount = 0;
              return true;
            }
            return false;
          }
          return false;
        } else {
          offCount = 0;
          return false;
        }
      },
      reset() {
        offCount = 0;
        lastReroute = -Infinity;
        rerouteCount = 0;
      }
    };
  }


  // ---------- Google Routes API (traffic-aware) helpers ----------
  /** Decodes a Google encoded polyline (precision 1e5) into [{lat,lng}]. */
  function decodePolyline(str) {
    const out = []; let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (const axis of [0, 1]) {
        let shift = 0, result = 0, b;
        do { b = str.charCodeAt(i++) - 63; result |= (b & 31) << shift; shift += 5; } while (b >= 32 && i < str.length + 1);
        const d = (result & 1) ? ~(result >> 1) : (result >> 1);
        if (axis === 0) lat += d; else lng += d;
      }
      out.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return out;
  }

  /** Google sometimes leaves a road-shield placeholder in the text ("... და დარჩით {1/}-ზე"): drop it, and the "stay on" clause it belongs to (v3.10.99). */
  function cleanInstr(t) {
    return String(t || "").replace(/,?\s*(და\s+)?დარჩით\s*\{[^}]*\}\S*/g, "").replace(/\{[^}]*\}\S*/g, "").replace(/\s{2,}/g, " ").trim();
  }

  const secs = (d) => { const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d || "")); return m ? parseFloat(m[1]) : 0; };

  /** Routes API computeRoutes response -> our route objects (alternatives, traffic ETA, steps with maneuver text). */
  function parseRoutesResponse(json) {
    const list = (json && json.routes) || [];
    return list.filter((r) => r && r.polyline && r.polyline.encodedPolyline).map((r) => {
      const steps = [];
      ((r.legs && r.legs) || []).forEach((leg) => (leg.steps || []).forEach((st) => {
        const ni = st.navigationInstruction;
        const ll = st.startLocation && st.startLocation.latLng;
        if (ni && ni.instructions && ll) steps.push({ text: cleanInstr(ni.instructions), maneuver: ni.maneuver || "", distanceM: st.distanceMeters || 0, loc: { lat: ll.latitude, lng: ll.longitude } });
      }));
      const durationSec = secs(r.duration), staticSec = secs(r.staticDuration) || durationSec;
      return { coords: decodePolyline(r.polyline.encodedPolyline), durationSec, staticSec, delaySec: Math.max(0, durationSec - staticSec), distanceM: r.distanceMeters || 0, steps, label: (r.routeLabels || []).join(",") };
    });
  }

  function routesRequestBody(from, to, departInMin) {
    const body = {
      origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
      destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
      travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE", computeAlternativeRoutes: true,
      languageCode: "ka", units: "METRIC"
    };
    if (departInMin > 0) body.departureTime = new Date(Date.now() + departInMin * 60000 + 30000).toISOString();
    return body;
  }

  /** Index of the maneuver the car is heading to. Progress along each step-to-step segment (projection t): a maneuver is "reached"
   *  once the car's projection passes the end of the segment leading to it; before the first start we aim at step 0. Never goes back. */
  function nextStepIndex(steps, pos, from) {
    const n = steps.length;
    if (!n) return -1;
    const t = (a, b) => segT(a, b, pos);
    if (!from && t(steps[0].loc, n > 1 ? steps[1].loc : steps[0].loc) <= 0 && meters(pos, steps[0].loc) > 25) return 0;
    for (let k = Math.max(from || 0, 1); k < n; k++) if (t(steps[k - 1].loc, steps[k].loc) < 1) return k;
    return n - 1;
  }

  /** Voice prompt before a maneuver, same tiers as routing.js announceApproach (500/200/50 m; 800/300/80 m above 70 km/h).
   *  update() returns the text to say or null: each tier once per maneuver, only the closest when several are crossed at once. */
  function createVoiceCues() {
    let idx = -1, said = new Set();
    return {
      update(stepIdx, step, distM, speedKmh) {
        if (!step || !step.text || stepIdx <= 0 || !isFinite(distM)) return null;
        if (stepIdx !== idx) { idx = stepIdx; said = new Set(); }
        const tiers = speedKmh > 70 ? [800, 300, 80] : [500, 200, 50];
        let crossed = -1;
        tiers.forEach((t, k) => { if (distM <= t && !said.has(k)) { said.add(k); crossed = k; } });
        if (crossed < 0) return null;
        if (crossed === tiers.length - 1) return step.text;
        return Math.max(10, Math.round(distM / 10) * 10) + " მეტრში, " + step.text;
      },
      reset() { idx = -1; said = new Set(); }
    };
  }

  /** Smooth car for the Google map: dead reckoning between the 1 Hz GPS fixes plus exponential smoothing, the same model and
   *  time constants as FollowCamera in map-gl.js, whose math helpers (advance, shortestDelta, normDeg) are passed in as `util`. */
  function createCarGlide(util) {
    let fix = null, pos = null, heading = 0;
    const hasHeading = (h) => h != null && isFinite(h);
    return {
      setFix(f, now) {
        fix = { lat: f.lat, lng: f.lng, headingDeg: f.headingDeg, speedMs: f.speedMs || 0, t: now };
        if (!pos) { pos = { lat: f.lat, lng: f.lng }; if (hasHeading(f.headingDeg)) heading = util.normDeg(f.headingDeg); }
      },
      frame(now, dt) {
        if (!fix) return null;
        const age = Math.max(0, Math.min(1500, now - fix.t));
        let tgt = { lat: fix.lat, lng: fix.lng };
        if (fix.speedMs > 1 && hasHeading(fix.headingDeg)) { const a = util.advance(fix.lng, fix.lat, fix.headingDeg, fix.speedMs * age / 1000); tgt = { lat: a.lat, lng: a.lng }; }
        if (Math.abs(tgt.lat - pos.lat) > 0.003 || Math.abs(tgt.lng - pos.lng) > 0.003) pos = tgt;   // far jump (GPS just locked): snap
        else { const k = 1 - Math.exp(-dt / 220); pos = { lat: pos.lat + (tgt.lat - pos.lat) * k, lng: pos.lng + (tgt.lng - pos.lng) * k }; }
        let turning = false;
        if (hasHeading(fix.headingDeg)) {
          const d = util.shortestDelta(fix.headingDeg, heading);
          if (Math.abs(d) > 0.2) { heading = util.normDeg(heading + d * (1 - Math.exp(-dt / (fix.speedMs > 3 ? 260 : 900)))); turning = true; }
        }
        const moving = fix.speedMs > 1 || turning || Math.abs(tgt.lat - pos.lat) > 1e-7 || Math.abs(tgt.lng - pos.lng) > 1e-7;
        return { lat: pos.lat, lng: pos.lng, heading, moving };
      }
    };
  }

  /** Camera centre that keeps the car `frac` of the screen height behind the centre, so more road ahead is visible. */
  function aheadPoint(util, pos, headingDeg, zoom, heightPx, frac) {
    const mpp = 156543.03392 * Math.cos(pos.lat * Math.PI / 180) / Math.pow(2, zoom);
    const a = util.advance(pos.lng, pos.lat, headingDeg, heightPx * (frac == null ? 0.25 : frac) * mpp);
    return { lat: a.lat, lng: a.lng };
  }

  /** Camera dead-band: skip a camera move that would not change the picture (less than ~half a pixel / under a degree).
   *  Every moveCamera() on the vector map re-renders it, which is the expensive part on the MCU2. */
  function cameraNeedsUpdate(prev, next, minM, minDeg) {
    if (!prev) return true;
    if (meters(prev, next) >= minM) return true;
    if (next.heading == null || prev.heading == null) return false;
    return Math.abs(((next.heading - prev.heading) % 360 + 540) % 360 - 180) >= minDeg;
  }

  /**
   * v3.10.79 GPU camera for the Google 3D map (?gcam=gpu), the same idea as our map's FollowCamera.gpuStep: Google redraws the
   * whole vector map on every camera move (in the car ~60 fps standing, 6-15 fps moving by day), so the camera is moved only
   * every opts.everyMs or when the heading drifted more than opts.maxAngle; in between the last drawn picture is turned and
   * shifted by the compositor (CSS transform on the oversized map div).
   * prev = { t, heading, center } of the last real move (null = none yet), cur = { t, heading, pos } now,
   * view = { zoom, w, h (map div px), hVis (visible screen height px), frac (car below the centre, of hVis) }.
   * Returns { draw: true } or { draw: false, ox, oy (car point on screen, the turning point), theta (deg), tx, ty (px) }.
   */
  function gpuPlan(prev, cur, view, opts) {
    const o = opts || {};
    if (!prev) return { draw: true };
    const dHead = ((cur.heading - prev.heading) % 360 + 540) % 360 - 180;
    if (cur.t - prev.t >= (o.everyMs || 250) || Math.abs(dHead) > (o.maxAngle || 12)) return { draw: true };
    const mpp = 156543.03392 * Math.cos(prev.center.lat * Math.PI / 180) / Math.pow(2, view.zoom);
    const e = (cur.pos.lng - prev.center.lng) * 111320 * Math.cos(prev.center.lat * Math.PI / 180);
    const n = (cur.pos.lat - prev.center.lat) * 111320;
    const x = e / mpp, y = -n / mpp, phi = -prev.heading * Math.PI / 180;
    const px = view.w / 2 + x * Math.cos(phi) - y * Math.sin(phi);   // where the car is in the picture drawn last time
    const py = view.h / 2 + x * Math.sin(phi) + y * Math.cos(phi);
    const ox = view.w / 2, oy = view.h / 2 + (view.frac == null ? 0.25 : view.frac) * view.hVis;   // where it must be shown
    return { draw: false, ox, oy, theta: -dHead, tx: ox - px, ty: oy - py };
  }

  /** ?gscale=s (0.5..1, test only): the map renders s x s of the pixels and is stretched back to full screen with a CSS
   *  transform, to measure whether the MCU2 is limited by pixel fill. Text gets softer and taps on map icons can be off. */
  function scaledBoxStyle(s) {
    if (!(s > 0 && s < 1)) return "position:absolute;inset:0";
    const pct = Math.round(s * 1000) / 10;
    return "position:absolute;left:0;top:0;width:" + pct + "%;height:" + pct + "%;transform:scale(" + (1 / s).toFixed(4) + ");transform-origin:0 0";
  }

  /** Frames per second over ~1 s windows: tick(nowMs) returns the fps when a window closes, otherwise null. */
  function createFpsMeter() {
    let t0 = null, n = 0;
    return {
      tick(now) {
        if (t0 === null) { t0 = now; n = 0; return null; }
        n++;
        if (now - t0 < 1000) return null;
        const fps = n * 1000 / (now - t0);
        t0 = now; n = 0;
        return fps;
      }
    };
  }

  /** The n nearest chargers within maxM metres of center, nearest first (our charger records use lat/lon). */
  function nearestChargers(list, center, n, maxM) {
    const out = [];
    for (const st of list || []) {
      if (!st || !isFinite(st.lat) || !isFinite(st.lon)) continue;
      const d = meters(center, { lat: st.lat, lng: st.lon });
      if (d <= maxM) out.push({ st, d });
    }
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, n).map((x) => x.st);
  }

  /** v3.10.101: turn arrow for a Routes API maneuver: { d: SVG path (24x24), left: mirror it } or null. Left/right share one shape. */
  const MANEUVER_PATHS = {
    straight: "M12 21V4M6 10l6-6 6 6",
    turn: "M7 21v-7a5 5 0 0 1 5-5h8M15 4l5 5-5 5",
    slight: "M8 21v-6l8-8M10 7h6v6",
    sharp: "M8 21V6l10 10M18 9v7h-7",
    uturn: "M8 21V10a5 5 0 0 1 10 0v6M14 12l4 4 4-4",
    roundabout: "M12 21v-6M12 15a5 5 0 1 1 5-5h4M18 7l3 3-3 3",
    merge: "M7 21c0-6 10-8 10-15M12 6l5-3 2 5",
  };
  function maneuverIcon(m) {
    m = String(m || "");
    let key = "", left = /LEFT/.test(m);
    if (/^UTURN/.test(m)) { key = "uturn"; left = !/RIGHT/.test(m); }
    else if (/^ROUNDABOUT/.test(m)) { key = "roundabout"; left = false; }
    else if (/SHARP/.test(m)) key = "sharp";
    else if (/SLIGHT|RAMP|FORK/.test(m)) key = "slight";
    else if (/^TURN_(LEFT|RIGHT)$/.test(m)) key = "turn";
    else if (m === "MERGE") key = "merge";
    else if (/STRAIGHT|DEPART|NAME_CHANGE/.test(m)) key = "straight";
    return key ? { d: MANEUVER_PATHS[key], left } : null;
  }

  /** v3.10.101: metres left along the route from the car (on segment i) to the end; cum = cumulative metres per vertex. */
  function routeCum(coords) { const c = [0]; for (let k = 1; k < coords.length; k++) c.push(c[k - 1] + meters(coords[k - 1], coords[k])); return c; }
  function remainingOnRoute(coords, cum, pos, i) {
    const total = cum[cum.length - 1] || 0;
    if (!(i >= 0) || !coords[i + 1]) return total;
    const t = Math.max(0, Math.min(1, segT(coords[i], coords[i + 1], pos)));
    return Math.max(0, total - (cum[i] + t * (cum[i + 1] - cum[i])));
  }
  /** v3.10.104: metres from the route start to each step's maneuver point (projected onto the line, in route order), or null. */
  function stepAlongs(coords, cum, steps) {
    let from = 0;
    return steps.map((st) => {
      const nr = nearestOnPolyline(st.loc, coords, from);
      if (nr.i < 0) return null;
      from = nr.i;
      const a = coords[nr.i], b = coords[nr.i + 1];
      if (!b) return cum[nr.i];
      const t = Math.max(0, Math.min(1, segT(a, b, st.loc)));
      return cum[nr.i] + t * (cum[nr.i + 1] - cum[nr.i]);
    });
  }
  /** v3.10.105: index of the next maneuver by metres along the route: the first one (from step 1, never going back) the car has not
   *  yet passed by 5 m (GPS lag); -1 when some maneuver could not be placed on the line (the caller then uses nextStepIndex). */
  function nextStepAlong(stepAlong, carAlongM, from) {
    const n = stepAlong.length;
    if (!n || stepAlong.some((a) => a == null)) return -1;
    for (let k = Math.max(from || 0, 1); k < n; k++) if (stepAlong[k] > carAlongM - 5) return k;
    return n - 1;
  }
  /** Distance to the next maneuver: along the route when the car is on it; straight line otherwise, or when the along value is
   *  impossible (shorter than the straight line: the maneuver matched a wrong part of a looping route). */
  function distToStep(straightM, alongStepM, carAlongM) {
    if (alongStepM == null || carAlongM == null) return straightM;
    const d = Math.max(0, alongStepM - carAlongM);
    return d + 20 < straightM ? straightM : d;
  }
  /** v3.10.104: arrived when within 30 m of the place, or less than 30 m of route is left (a place far from the road). */
  function hasArrived(distToPlaceM, remainOnRouteM) {
    return distToPlaceM < 30 || (remainOnRouteM != null && remainOnRouteM < 30);
  }
  /** v3.10.104: the saved Google navigation (localStorage gmapNav) if it is fresh: { name, address, lat, lng } or null.
   *  v3.10.105: "fresh" = refreshed by the running navigation within the last 10 min (a reload on shifting into R), not 3 h:
   *  a trip that ended without the arrival (parked 50 m before the end) must not start again on the next drive. */
  const NAV_KEY = "gmapNav", NAV_MAX_AGE_MS = 10 * 60 * 1000, NAV_NEAR_M = 300;
  function parseSavedNav(str, now) {
    try {
      const n = JSON.parse(str || "null");
      if (!n || !isFinite(n.lat) || !isFinite(n.lng) || !(now - n.t >= 0 && now - n.t < NAV_MAX_AGE_MS)) return null;
      return { name: String(n.name || "დანიშნულების ადგილი"), address: String(n.address || ""), lat: +n.lat, lng: +n.lng };
    } catch (_) { return null; }
  }

  /** Arrival strip text: traffic ETA of the route scaled by the share still to drive. */
  function etaInfo(remainM, totalM, durationSec, nowMs) {
    const sec = totalM > 0 ? durationSec * Math.min(1, remainM / totalM) : durationSec;
    const min = Math.max(0, Math.round(sec / 60));
    const at = new Date(nowMs + sec * 1000);
    const hhmm = String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0");
    const dur = min >= 60 ? Math.floor(min / 60) + " სთ " + (min % 60) + " წთ" : min + " წთ";
    return { arrive: hhmm, dur, dist: fmtDist(remainM) };
  }

  /** v3.10.116: weather along the route. Points every `everyM` along the line (and the end), each with the time the car is
   *  expected there (the traffic ETA shared out by distance). Only for routes of 25 km or more, at most 8 points. */
  function routeWeatherPoints(coords, cum, durationSec, everyM = 20000) {
    const total = cum && cum.length ? cum[cum.length - 1] : 0;
    if (!coords || coords.length < 2 || total < 25000) return [];
    const step = Math.max(everyM, total / 8);
    const pts = [];
    let k = 0;
    for (let d = step; d < total + 1; d = d + step > total && d < total ? total : d + step) {
      while (k < cum.length - 2 && cum[k + 1] < d) k++;
      const t = cum[k + 1] > cum[k] ? Math.min(1, (d - cum[k]) / (cum[k + 1] - cum[k])) : 0;
      const a = coords[k], b = coords[k + 1];
      pts.push({ lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng), alongM: d, etaSec: durationSec * d / total });
      if (d >= total) break;
    }
    return pts.slice(0, 8);
  }
  /** Bad weather for driving at one point: snow, ice (0 °C or below with wet road), storm, heavy rain, fog. null = fine. */
  function weatherHazard(code, tempC, precipMm) {
    const c = +code, t = +tempC, p = +precipMm || 0;
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { sev: 5, text: "თოვლი" };
    if (t <= 0 && (p > 0 || (c >= 51 && c <= 67) || (c >= 80 && c <= 82))) return { sev: 4, text: "მოყინვის საფრთხე" };
    if (c >= 95) return { sev: 3, text: "ჭექა-ქუხილი" };
    if (c === 65 || c === 82 || c === 67 || p >= 4) return { sev: 2, text: "ძლიერი წვიმა" };
    if (c === 45 || c === 48) return { sev: 1, text: "ნისლი" };
    if (t <= 1) return { sev: 1, text: "ყინვა" };
    return null;
  }
  /** Georgian "near X": გუდაური -> გუდაურთან, ქუმლისციხე -> ქუმლისციხესთან, a non-Georgian name -> "X-თან". */
  function nearForm(name) {
    const n = String(name || "").trim();
    if (/ი$/.test(n)) return n.slice(0, -1) + "თან";
    if (/[აეოუ]$/.test(n)) return n + "სთან";
    return /[ა-ჰ]$/.test(n) ? n + "თან" : n + "-თან";
  }
  /** "🌨️ ქუმლისციხესთან თოვლი, -3° (≈ 13:40)"; without a place name "~85 კმ-ში". */
  function hazardText(h, name, tempC, alongM, atMs) {
    const icon = h.sev === 5 ? "🌨️" : h.sev === 4 ? "🧊" : h.sev === 3 ? "⛈️" : h.sev === 2 ? "🌧️" : h.sev === 1 && h.text === "ნისლი" ? "🌫️" : "❄️";
    const at = new Date(atMs), hm = String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0");
    const where = name ? nearForm(name) : "~" + Math.round(alongM / 1000) + " კმ-ში";
    return icon + " " + where + " " + h.text + ", " + Math.round(tempC) + "° (≈ " + hm + ")";
  }

  /** v3.10.117: "დღეს 21:00" / "ხვალ 09:00" / "5 ნოემბერს 09:00" for a planned departure. */
  function whenText(ms, now = Date.now()) {
    const d = new Date(ms), n = new Date(now);
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const day0 = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    const days = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - day0) / 864e5);
    if (days === 0) return "დღეს " + hm;
    if (days === 1) return "ხვალ " + hm;
    const months = ["იანვარს", "თებერვალს", "მარტს", "აპრილს", "მაისს", "ივნისს", "ივლისს", "აგვისტოს", "სექტემბერს", "ოქტომბერს", "ნოემბერს", "დეკემბერს"];
    return d.getDate() + " " + months[d.getMonth()] + " " + hm;
  }
  /** A plan is used from 90 min before its time until 3 h after it; earlier it is only mentioned. */
  function planState(departAt, now) {
    const m = (departAt - now) / 60000;
    return m > 90 ? "later" : m >= -180 ? "now" : "gone";
  }

  /** v3.10.115: recent places (newest first, max 5, the same place only once: same name or within 60 m). */
  function addRecent(list, p, max = 5) {
    const out = [p].concat((list || []).filter((r) => r && r.name !== p.name && meters(r, p) > 60));
    return out.slice(0, max);
  }
  /** v3.10.115: the "then" line: what the maneuver after the next one is, in two words; "" when there is nothing to say. */
  function thenPhrase(m) {
    m = String(m || "");
    const side = /LEFT/.test(m) ? "მარცხნივ" : /RIGHT/.test(m) ? "მარჯვნივ" : "";
    if (/^UTURN/.test(m)) return "მობრუნება";
    if (/^ROUNDABOUT/.test(m)) return "წრეზე";
    if (/^RAMP/.test(m)) return side ? "გასასვლელი " + side : "";
    if (/^FORK/.test(m)) return side ? "განშტოება " + side : "";
    if (/SLIGHT/.test(m)) return side ? "ოდნავ " + side : "";
    if (/SHARP/.test(m)) return side ? "მკვეთრად " + side : "";
    if (/^TURN_(LEFT|RIGHT)$/.test(m)) return side;
    return "";
  }
  /** The next maneuver is "close" after the coming one: under 150 m apart (along the route when known). */
  function thenIsClose(gapM) { return isFinite(gapM) && gapM >= 0 && gapM < 150; }

  /** v3.10.110: map zoom while following, by speed (Samvel: street names and house numbers on the Google map). Google shows
   *  house numbers from about zoom 18, so slow or standing = 18; town speed = 17; above 65 km/h = 16 (more road ahead).
   *  Hysteresis (18 until > 20 km/h, 16 until < 55 km/h) so a speed around a threshold does not zoom back and forth. */
  function autoZoom(kmh, cur) {
    const z = Math.round(cur);
    if (kmh < 12) return 18;
    if (kmh > 65) return 16;
    if (z === 18) return kmh > 20 ? 17 : 18;
    if (z === 16) return kmh < 55 ? 17 : 16;
    return 17;
  }

  function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + " კმ" : Math.round(m / 10) * 10 + " მ"; }

  // ---------- the mode ----------
  const S = {
    enabled: false, key: "", open: false, map: null, traffic: null, trafficOn: true, loading: null, g: null,
    carMarker: null, carPos: null, carHeading: 0, follow: true, placeMarker: null, catMarkers: [], activeCat: null,
    routeLines: [], routes: [], routeIdx: 0, stepIdx: 0, segIdx: 0, offRouteTracker: null, rerouting: false, voice: null, glide: null, raf: null, lastFrame: 0, idle: 0, lastFix: null,
    vector: false, mapId: "", carRot: null, carTimer: null, lastCam: null, lastMarker: null, camCount: 0, gfps: 0, gscale: 0, gtilt: 20, debug: false, warned: {}, rebuilding: false,
    navigating: false, place: null, sessionToken: null, night: null, timers: []
  };

  const $ = (id) => document.getElementById(id);
  // the main app's SpeechAssistant (speech.js): Georgian TTS + chimes, honours the driver's mute button
  const speak = (text) => { try { if (window.speechAssistant) window.speechAssistant.speak(text); } catch (_) {} };
  const say = (msg) => { if (typeof window !== "undefined" && window.showToast) window.showToast(msg, "info", 3500); };

  // ---------- free-tier guard: every paid Google call asks our server first (/api/google-permit) ----------
  const SKU_LABEL = { routes: "საცობიანი მარშრუტი", mapload: "Google რუკის გახსნა", autocomplete: "ძებნა", details: "ადგილის დეტალები", nearby: "კატეგორიის ძებნა" };

  /** Driver-facing text for a cap answer from /api/google-permit. */
  function capText(j) {
    return "Google-ის უფასო " + (j.reason === "day" ? "დღის" : "თვის") + " ლიმიტი ამოიწურა: " + (SKU_LABEL[j.sku] || j.sku) +
      ". განახლდება " + j.resetsOn + "-ს. მანამდე Google-ის ეს ფუნქცია არ იმუშავებს.";
  }

  /** Toast once per SKU and month when 80 % of our monthly cap is used. */
  function warnText(j) {
    return "Google-ის უფასო თვიური ლიმიტის " + Math.round(100 * j.month / j.monthCap) + "% დაიხარჯა: " + (SKU_LABEL[j.sku] || j.sku) + " (" + j.month + "/" + j.monthCap + ")";
  }

  /** Resolves with the permit; at a cap it shows the reason and throws an Error with code "cap:<sku>:<day|month>". */
  async function permit(sku) {
    let r, j = null;
    try { r = await fetch("/api/google-permit?sku=" + sku, { cache: "no-store", credentials: "same-origin" }); }
    catch (_) { const e = new Error("ლიმიტის სერვერი მიუწვდომელია, Google-ის მოთხოვნა არ გაიგზავნა"); e.code = "permit"; throw e; }
    try { j = await r.json(); } catch (_) {}
    if (!r.ok) {
      const isCap = j && j.error === "cap";
      const e = new Error(isCap ? capText(j) : "Google-ის ნებართვა ვერ მივიღე (" + r.status + ")");
      e.code = isCap ? "cap:" + sku + ":" + j.reason : "http" + r.status;
      if (isCap) { setStatus(e.message, 8000); say(e.message); }
      throw e;
    }
    if (j && j.warn) {
      const k = sku + ":" + j.resetsOn;
      if (!S.warned[k]) { S.warned[k] = true; say(warnText(j)); }
    }
    return j;
  }
  const isCap = (e) => !!(e && typeof e.code === "string" && e.code.indexOf("cap:") === 0);

  /** The status bubble; with ms it hides itself after that long. v3.10.105: one timer, so an older timer never hides a newer text. */
  function setStatus(text, ms) {
    clearTimeout(S.statusTimer);
    if (text && ms) S.statusTimer = setTimeout(() => setStatus(""), ms);
    const el = $("gmap-status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("show", !!text);
  }

  function loadGoogle(key) {
    if (S.loading) return S.loading;
    S.loading = new Promise((resolve, reject) => {
      if (window.google && window.google.maps && window.google.maps.importLibrary) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error("Google რუკის ჩატვირთვა დაიგვიანა")), 20000);
      window.__gmapReady = () => { clearTimeout(timer); resolve(); };
      window.gm_authFailure = () => {
        setStatus("Google-მა გასაღები უარყო: შეამოწმეთ გასაღების შეზღუდვა (HTTP referrer) და ჩართული API-ები.");
      };
      const s = document.createElement("script");
      s.src = buildLoaderUrl(key, "__gmapReady");
      s.async = true;
      s.onerror = () => { clearTimeout(timer); reject(new Error("Google რუკა ვერ ჩაიტვირთა")); };
      document.head.appendChild(s);
    }).then(async () => {
      const [maps, places] = await Promise.all([window.google.maps.importLibrary("maps"), window.google.maps.importLibrary("places")]);
      S.g = { maps, places, core: window.google.maps };
    }).catch((e) => { S.loading = null; throw e; });
    return S.loading;
  }

  async function fetchConfig() {
    try {
      const r = await fetch("/api/gmaps-config", { cache: "no-store", credentials: "same-origin" });
      if (!r.ok) return { enabled: false };
      const j = await r.json();
      return j && j.enabled && typeof j.key === "string" && j.key ? { enabled: true, key: j.key, mapId: typeof j.mapId === "string" ? j.mapId : "" } : { enabled: false };
    } catch (_) { return { enabled: false }; }
  }

  function currentCenter() {
    const p = window.currentPos;
    return p && isFinite(p.lat) && isFinite(p.lng) ? { lat: p.lat, lng: p.lng } : TBILISI;
  }

  /** Raster (default: light on the MCU2, JSON styles, north-up) or vector (test: needs a Map ID, can turn heading-up). */
  function mapOptions(vector, night, view) {
    const o = { center: view.center, zoom: view.zoom, disableDefaultUI: true, gestureHandling: "greedy", clickableIcons: false, keyboardShortcuts: false };
    if (!vector) { o.styles = mapStyles(night); return o; }
    o.mapId = S.mapId || "DEMO_MAP_ID";   // DEMO_MAP_ID is Google's test id; set GOOGLE_MAP_ID on the server for real use
    o.renderingType = "VECTOR";
    o.colorScheme = night ? "DARK" : "LIGHT";   // a Map ID map ignores `styles`; the colour scheme is fixed at creation
    o.heading = view.heading || 0;
    o.tilt = S.gtilt || 0;   // v3.10.98: 20 by default (best row while driving in the v3.10.97 car test; 45 cost ~30-40%); ?gtilt=0 = flat
    return o;
  }

  /** One map per look: classic, vector light, vector dark (a vector map's colour scheme is fixed when it is created). */
  function mapKey(vector, night) { return vector ? (night ? "vector-dark" : "vector-light") : "raster"; }

  /**
   * Shows the map for the current look. v3.10.59: a map made once is kept and shown again (Antigravity's review: a new
   * google.maps.Map per 3D / night toggle left the old WebGL context alive and Chromium caps them at ~8-16, and every new
   * map is a billed map load). So at most 3 maps exist, and toggling back costs nothing.
   */
  function createMap(view) {
    const { Map, TrafficLayer } = S.g.maps;
    const box = $("gmap-canvas");
    S.night = !!window.__night;
    const key = mapKey(S.vector, S.night);
    const v = view || { center: currentCenter(), zoom: 16 };
    S.maps = S.maps || {};
    // the overlays live on one map at a time: take them off the one we leave
    if (S.carMarker) S.carMarker.setMap(null);
    if (S.traffic) S.traffic.setMap(null);
    Object.keys(S.maps).forEach((k) => { S.maps[k].el.style.display = k === key ? "" : "none"; });
    if (S.maps[key]) {
      S.map = S.maps[key].map;
      S.maps[key].el.style.display = "";
      S.map.setCenter(v.center);
      if (v.zoom) S.map.setZoom(v.zoom);
      if (S.vector && isFinite(v.heading)) S.map.setHeading(v.heading);
      if (S.vector && S.map.setTilt) S.map.setTilt(S.gtilt || 0);
    } else {
      const el = document.createElement("div");   // a fresh element per map: a Map ID cannot be added to an existing map
      // the GPU camera turns the vector map picture: its div is larger than the screen (?gscale does not apply then)
      el.style.cssText = S.gpuOn && S.vector ? "position:absolute;left:-25%;top:-25%;width:150%;height:150%;will-change:transform" : scaledBoxStyle(S.gscale);
      box.appendChild(el);
      S.map = new Map(el, mapOptions(S.vector, S.night, v));
      S.maps[key] = { map: S.map, el };
      // v3.10.96: the car photos showed a flat map with tilt 45 in the options; set it again once the first tiles are in
      if (S.vector && S.gtilt) { const m = S.map; const l = m.addListener("tilesloaded", () => { l.remove(); if (m.setTilt) m.setTilt(S.gtilt); }); }
      S.map.addListener("dragstart", () => { S.follow = false; $("gmap-btn-me") && $("gmap-btn-me").classList.remove("active"); });
      S.map.addListener("click", () => { if (S.sideOpen && !S.sideFixed) setSideOpen(false); });   // v3.10.112: a tap on the map tucks the panel away
    }
    S.carMarker = null; S.carRot = null; S.lastMarker = null; S.lastCam = null;
    S.traffic = new TrafficLayer();
    try { S.trafficOn = localStorage.getItem("gmapTraffic") !== "0"; } catch (_) { S.trafficOn = true; }
    if (S.noTraffic) S.trafficOn = false;   // v3.10.93 ?gtraffic=0 (test): no traffic layer, the saved choice is left alone
    applyTraffic();
  }

  function applyTraffic() {
    if (S.traffic) S.traffic.setMap(S.trafficOn ? S.map : null);
    const b = $("gmap-btn-traffic");
    if (b) b.classList.toggle("active", S.trafficOn);
  }

  /** Re-creates the map (vector on/off, or night on a vector map) and puts our overlays back on it. */
  /** Every new google.maps.Map is a billed map load, so a rebuild needs a permit; onDenied undoes the toggle that asked for it. */
  async function rebuildMap(onDenied) {
    if (!S.map || S.rebuilding) return;
    S.rebuilding = true;
    const kept = S.maps && S.maps[mapKey(S.vector, !!window.__night)];   // showing a kept map again is not a new map load
    if (!kept) { try { await permit("mapload"); } catch (_) { S.rebuilding = false; if (onDenied) onDenied(); return; } }
    S.rebuilding = false;
    if (!S.map) return;
    const c = S.map.getCenter();
    createMap({ center: c ? { lat: c.lat(), lng: c.lng() } : currentCenter(), zoom: S.map.getZoom() || 16, heading: S.carHeading });
    if (S.place && S.placeMarker) S.placeMarker.setMap(S.map);
    S.catMarkers.forEach((m) => m.setMap(S.map));
    if (S.routes.length) drawRoutes();
    updatePanelButtons();
    wakeCar();
  }

  function updatePanelButtons() {
    const v = $("gmap-btn-vector"); if (v) v.classList.toggle("active", S.vector);
    const n = $("gmap-btn-night"); if (n) n.classList.toggle("active", !!window.__night);
  }

  function syncNight() {
    const night = !!window.__night;
    if (!S.map || night === S.night) return;
    if (S.vector) rebuildMap(() => { S.night = night; updatePanelButtons(); });   // colorScheme is fixed at creation; at the cap keep the old colours
    else { S.night = night; S.map.setOptions({ styles: mapStyles(night) }); }
    updatePanelButtons();
  }

  function markerIcon(rotation) {
    return { path: S.g.core.SymbolPath.FORWARD_CLOSED_ARROW, scale: 6, rotation, fillColor: "#3e6ae1", fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 2 };
  }

  // Arrow/camera rate: 20 fps on both maps (v3.10.95: the 3D map was 10 fps; the parked car test showed 20 smoother).
  // ?gfps=N (2..30) overrides both, for measuring in the car.
  function carFrameMs() { return S.gfps ? 1000 / S.gfps : (S.vector ? (S.gpuOn ? 16 : 50) : 50); }   // GPU camera: the turn is cheap, 60 fps

  /** One frame of the glide: arrow position/rotation, and the camera while following (heading-up on the vector map). */
  function drawCar(f) {
    S.carHeading = f.heading;
    const pos = { lat: f.lat, lng: f.lng };
    const headingUp = S.vector && S.follow && !S.northUp;
    // the marker is drawn upright on the screen, so on a rotated map its rotation is relative to the map heading
    const mapHeading = S.vector && S.map.getHeading ? (S.map.getHeading() || 0) : 0;
    const rot = Math.round(headingUp ? 0 : ((f.heading - mapHeading) % 360 + 360) % 360);
    updateCompass(headingUp ? f.heading : mapHeading);
    if (!S.carMarker) { S.carMarker = new S.g.core.Marker({ position: pos, map: S.map, icon: markerIcon(rot), zIndex: 999, clickable: false }); S.carRot = rot; S.lastMarker = pos; }
    else {
      if (!S.lastMarker || meters(S.lastMarker, pos) >= 0.3) { S.carMarker.setPosition(pos); S.lastMarker = pos; }
      if (rot !== S.carRot) { S.carMarker.setIcon(markerIcon(rot)); S.carRot = rot; }
    }
    if (!S.follow) { S.lastCam = null; gpuReset(); return; }
    const el = S.map.getDiv && S.map.getDiv();
    const gpu = S.gpuOn && headingUp && S.map.moveCamera && el;
    const h = ((el && el.clientHeight) || 800) / (gpu ? GPU_OVERSCAN : 1);   // the oversized div: use the visible height
    const zoom = S.map.getZoom() || 16;
    const center = aheadPoint(window.MapGL, pos, f.heading, zoom, h, 0.25);
    if (gpu) {
      const now = performance.now();
      const plan = gpuPlan(S.gpuR, { t: now, heading: f.heading, pos }, { zoom, w: el.clientWidth, h: el.clientHeight, hVis: h }, { everyMs: S.gpuMs, maxAngle: 12 });
      gpuArrow(true);
      if (plan.draw) {
        S.map.moveCamera({ center, heading: f.heading });
        S.gpuR = { t: now, heading: f.heading, center };
        S.lastCam = { lat: center.lat, lng: center.lng, heading: f.heading }; S.camCount++;
        el.style.transform = "";
        gpuLogo(el, 0);
      } else {
        el.style.transformOrigin = plan.ox.toFixed(1) + "px " + plan.oy.toFixed(1) + "px";
        el.style.transform = "rotate(" + plan.theta.toFixed(2) + "deg) translate(" + plan.tx.toFixed(1) + "px," + plan.ty.toFixed(1) + "px)";
        gpuLogo(el, plan.theta);
      }
      return;
    }
    gpuReset();
    const cam = { lat: center.lat, lng: center.lng, heading: headingUp ? f.heading : null };
    const halfPx = 0.5 * 156543.03392 * Math.cos(center.lat * Math.PI / 180) / Math.pow(2, zoom);
    if (!cameraNeedsUpdate(S.lastCam, cam, halfPx, 1)) return;
    S.lastCam = cam; S.camCount++;
    if (headingUp && S.map.moveCamera) S.map.moveCamera({ center, heading: f.heading });
    else S.map.setCenter(center);
  }

  /** v3.10.111 (Samvel): the compass turns with the map, so "N" always points north. Only a CSS rotation of a small SVG,
   *  and only when the angle changed by a degree or more. */
  function updateCompass(mapHeading) {
    const r = $("gmap-compass-rose");
    if (!r) return;
    const a = Math.round(-(mapHeading || 0));
    if (a === S.compassDeg) return;
    S.compassDeg = a;
    r.style.transform = "rotate(" + a + "deg)";
  }

  /** v3.10.112 (design "ე"): hide the side panel after 8 s without a touch while the car moves (> 10 km/h); it never hides
   *  by itself while standing. ?gside=fixed keeps it open. */
  function sideShouldHide(open, kmh, idleMs) { return !!open && kmh > 10 && idleMs > 8000; }

  function setSideOpen(open) {
    S.sideOpen = !!open;
    S.sideTouchAt = Date.now();
    const layer = $("gmap-layer");
    if (layer) layer.classList.toggle("side-closed", !S.sideOpen);
  }

  function sideTick() {
    if (S.sideFixed) return;
    if (sideShouldHide(S.sideOpen, S.lastKmh || 0, Date.now() - (S.sideTouchAt || 0))) setSideOpen(false);
    const fab = $("gmap-fab-me"), me = $("gmap-btn-me");
    if (fab && me) fab.classList.toggle("active", me.classList.contains("active"));
  }

  /** A tap on the compass: north up (the map stops turning) or back to heading up. Kept in localStorage. */
  function toggleNorthUp() {
    S.northUp = !S.northUp;
    try { localStorage.setItem("gmapNorthUp", S.northUp ? "1" : "0"); } catch (_) {}
    const c = $("gmap-compass");
    if (c) c.classList.toggle("north-up", S.northUp);
    if (S.northUp && S.map && S.vector && S.map.setHeading) S.map.setHeading(0);
    if (S.northUp) updateCompass(0);
    S.lastCam = null;
    say(S.northUp ? "რუკა: ჩრდილოეთი ზემოთ" : "რუკა: მოძრაობის მიმართულებით");
    wakeCar();
  }

  // ---- v3.10.79 GPU camera helpers (?gcam=gpu) ----
  const GPU_OVERSCAN = 1.5;   // the vector map div is 150% of the screen, centred: a 12 deg turn never shows its corners

  /** Our own arrow, fixed on the screen where the car is shown (Google's marker would need a redraw for every new angle). */
  function gpuArrow(on) {
    let a = $("gmap-gpu-car");
    if (on && !a) {
      a = document.createElement("div");
      a.id = "gmap-gpu-car";
      const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), poly = document.createElementNS(NS, "polygon");
      svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "34"); svg.setAttribute("height", "34");
      [["points", "12 2 20 21 12 16 4 21"], ["fill", "#3e6ae1"], ["stroke", "#fff"], ["stroke-width", "2"], ["stroke-linejoin", "round"]].forEach(([k, v]) => poly.setAttribute(k, v));
      svg.appendChild(poly); a.appendChild(svg);
      $("gmap-layer").appendChild(a);
    }
    if (a) a.style.display = on ? "" : "none";
    if (S.carMarker) S.carMarker.setMap(on ? null : S.map);
  }

  /** Google's logo and data credit stay upright and readable while the picture is turned (Google's terms: always visible). */
  function gpuLogo(el, theta) {
    if (!S.logoEls || !S.logoEls.length || !S.logoEls[0].isConnected) {
      const logo = el.querySelector('a[href*="maps.google.com/maps"], a[title*="Google"]');
      S.logoEls = [logo && logo.parentElement].concat(Array.from(el.querySelectorAll(".gm-style-cc"))).filter(Boolean);
    }
    const t = theta ? "rotate(" + (-theta).toFixed(2) + "deg)" : "";
    S.logoEls.forEach((n) => { n.style.transform = t; });
  }

  /** Back to the plain Google map (the driver pans, classic map, Google mode closed). */
  function gpuReset() {
    S.gpuR = null;
    const el = S.map && S.map.getDiv && S.map.getDiv();
    if (el && el.style.transform) el.style.transform = "";
    if (el && S.logoEls) gpuLogo(el, 0);
    if ($("gmap-gpu-car") && $("gmap-gpu-car").style.display !== "none") gpuArrow(false);
  }

  function carLoop(ts) {
    S.raf = null;
    if (!S.open || !S.map || !S.glide) return;
    const dt = Math.min(1000, S.lastFrame ? ts - S.lastFrame : 16);
    S.lastFrame = ts;
    const f = S.glide.frame(performance.now(), dt);
    if (f) drawCar(f);
    S.idle = f && f.moving ? 0 : S.idle + 1;
    // the next frame is timed with setTimeout (no idle rAF wake-ups every 16 ms just to check the clock); sleeps when standing
    if (S.idle < 1500 / carFrameMs()) S.carTimer = setTimeout(() => { S.carTimer = null; S.raf = requestAnimationFrame(carLoop); }, Math.max(0, carFrameMs() - 8));
    else S.lastFrame = 0;
  }

  function wakeCar() { S.idle = 0; if (!S.raf && !S.carTimer && S.open) S.raf = requestAnimationFrame(carLoop); }

  /** ?debug=1: the browser's real frame rate while Google mode is open (the main HUD only measures our MapLibre map). */
  function startDebugMeter() {
    if (!S.debug || S.debugRaf) return;
    let box = $("gmap-debug");
    if (!box) {
      box = document.createElement("div");
      box.id = "gmap-debug";
      box.style.cssText = "position:absolute;left:12px;bottom:12px;z-index:5;background:rgba(0,0,0,.7);color:#7CFC00;font:14px monospace;padding:6px 10px;border-radius:8px;pointer-events:none";
      $("gmap-layer").appendChild(box);
    }
    const meter = createFpsMeter();
    let cam0 = S.camCount;
    const loop = (t) => {
      if (!S.open) { S.debugRaf = null; return; }
      const fps = meter.tick(t);
      if (fps != null) {
        box.textContent = "Google " + (S.vector ? "3D" : "classic") + "  fps " + fps.toFixed(1) + "  camera " + (S.camCount - cam0) + "/s  arrow " + Math.round(1000 / carFrameMs()) + " fps" +
          "  traffic " + (S.trafficOn ? "on" : "off") + (S.vector && S.map.getTilt ? "  tilt " + Math.round(S.map.getTilt() || 0) + "/" + (S.gtilt || 0) : "") + (S.gscale ? "  scale " + S.gscale : "") + (S.mapId ? "" : "  DEMO_MAP_ID");
        cam0 = S.camCount;
      }
      S.debugRaf = requestAnimationFrame(loop);
    };
    S.debugRaf = requestAnimationFrame(loop);
  }

  /** Follows autoZoom while the camera follows the car; a zoom the driver chose (+ / −) is kept for 60 s, ?gzoom=0 turns it off. */
  function applyAutoZoom(fix) {
    if (S.noAutoZoom || !S.follow || !S.map || Date.now() - (S.manualZoomAt || 0) < 60000) return;
    const kmh = (fix.speedMs || 0) * 3.6 || window.currentSpeedKmhForLock || 0;
    const cur = S.map.getZoom() || 17;
    const z = autoZoom(kmh, cur);
    if (z !== Math.round(cur)) S.map.setZoom(z);
  }

  /** The latest fix from the main app: window.__carFix (GPS heading snapped to the road) or, as a fallback, window.currentPos. */
  function readFix() {
    const f = window.__carFix;
    if (f && isFinite(f.lat) && isFinite(f.lng)) return f;
    const p = window.currentPos;
    if (!p || !isFinite(p.lat) || !isFinite(p.lng)) return null;
    if (S.lastFix && S.lastFix.lat === p.lat && S.lastFix.lng === p.lng) return S.lastFix;
    const hd = S.carPos && meters(S.carPos, p) > 4 ? bearing(S.carPos, p) : S.carHeading;
    return { lat: p.lat, lng: p.lng, headingDeg: hd, speedMs: 0 };
  }

  /** Polls the main app's fix (4x a second); route logic runs once per new fix, the glide animates in between. */
  function syncCar() {
    if (!S.open || !S.map) return;
    syncNight();
    const fix = readFix();
    if (!fix || fix === S.lastFix) return;
    S.lastFix = fix;
    S.lastKmh = (fix.speedMs || 0) * 3.6 || window.currentSpeedKmhForLock || 0;
    applyAutoZoom(fix);
    if (!S.glide && window.MapGL) S.glide = createCarGlide(window.MapGL);
    if (S.glide) { S.glide.setFix(fix, performance.now()); wakeCar(); }
    const pos = { lat: fix.lat, lng: fix.lng };
    S.carPos = pos;
    if (S.navigating) {
      const rt = S.routes[S.routeIdx];
      S.carAlong = null;   // metres driven along the route; null while off it
      if (rt && rt.coords && rt.coords.length && S.offRouteTracker && !S.rerouting) {
        // look near the last match first (cheap on long routes); scan the whole line only when the car seems off it there
        let nr = nearestOnPolyline(pos, rt.coords, S.segIdx - 20, S.segIdx + 200);
        if (nr.d > OFF_ROUTE_M) nr = nearestOnPolyline(pos, rt.coords);
        if (nr.i >= 0) S.segIdx = nr.i;
        if (nr.i >= 0 && nr.d <= OFF_ROUTE_M) {
          trimPassed(pos, rt.coords, nr.i);
          if (!rt.cum) rt.cum = routeCum(rt.coords);
          S.carAlong = rt.cum[rt.cum.length - 1] - remainingOnRoute(rt.coords, rt.cum, pos, nr.i);
        }
        if (S.offRouteTracker.update(nr.d)) reroute();
      }
      const left = S.carAlong != null && rt && rt.cum ? rt.cum[rt.cum.length - 1] - S.carAlong : null;
      if (S.place && S.place.loc && hasArrived(meters(pos, S.place.loc), left)) {
        stopNavigation();
        setStatus("დანიშნულების ადგილზე ხართ", 5000);
        speak("დანიშნულების ადგილზე მიხვედით");
        return;
      }
      if (Date.now() - (S.navSavedAt || 0) > 30000) saveNav();
      updateNavBanner();
      updateSignal(pos, fix.headingDeg);
    }
  }

  /** Route line as [lat, lng] pairs, the shape traffic-signals.js expects (cached per route). */
  function routeLatLngs() {
    const rt = S.routes[S.routeIdx];
    if (!rt || !rt.coords) return null;
    if (!rt.latLngs) rt.latLngs = rt.coords.map((c) => [c.lat, c.lng]);
    return rt.latLngs;
  }

  /** Traffic light ahead on the Google route (our Overpass data, same rule as the main map: on the route, within 350 m). */
  function updateSignal(pos, headingDeg) {
    const nav = $("gmap-nav");
    if (!nav) return;
    let el = $("gmap-nav-signal");
    if (!el) { el = document.createElement("div"); el.id = "gmap-nav-signal"; el.className = "gmap-nav-signal"; nav.appendChild(el); }
    let sig = null;
    const eng = window.trafficSignalsEngine;
    if (S.navigating && eng && typeof eng.findUpcomingSignal === "function") {
      try { sig = eng.findUpcomingSignal(pos, headingDeg, routeLatLngs()); } catch (_) { sig = null; }
    }
    el.textContent = sig ? "🚦 შუქნიშანი " + sig.distanceMeters + " მეტრში" : "";
    el.classList.toggle("show", !!sig);
  }

  /** Loads the traffic-light tiles along the whole route once, so the alerts are ready before the car gets there. */
  function prefetchSignals() {
    const eng = window.trafficSignalsEngine, ll = routeLatLngs();
    if (eng && typeof eng.fetchSignalsAlongRoute === "function" && ll) { try { eng.fetchSignalsAlongRoute(ll); } catch (_) {} }
  }

  // ---------- search (Places API New) ----------
  function newToken() { S.sessionToken = new S.g.places.AutocompleteSessionToken(); }

  function clearResults() {
    const box = $("gmap-results");
    if (box) { box.textContent = ""; box.classList.remove("show"); }
  }

  function renderSuggestions(list) {
    const box = $("gmap-results");
    if (!box) return;
    box.textContent = "";
    list.forEach((sug) => {
      const pp = sug.placePrediction;
      if (!pp) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gmap-result";
      const main = document.createElement("span");
      main.className = "gmap-result-main";
      main.textContent = (pp.mainText && pp.mainText.text) || (pp.text && pp.text.text) || "";
      const sec = document.createElement("span");
      sec.className = "gmap-result-sec";
      sec.textContent = (pp.secondaryText && pp.secondaryText.text) || "";
      btn.appendChild(main);
      btn.appendChild(sec);
      btn.addEventListener("click", () => choosePrediction(pp));
      box.appendChild(btn);
    });
    box.classList.toggle("show", box.childElementCount > 0);
  }

  async function suggest(text) {
    const q = String(text || "").trim();
    if (q.length < 3) { clearResults(); return; }
    try {
      if (!S.sessionToken) newToken();
      const c = S.map ? S.map.getCenter() : null;
      const center = c ? { lat: c.lat(), lng: c.lng() } : currentCenter();
      const seq = S.sugSeq = (S.sugSeq || 0) + 1;
      await permit("autocomplete");
      const res = await S.g.places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: q, sessionToken: S.sessionToken, language: "ka", region: "ge", includedRegionCodes: ["ge"],
        locationBias: { center, radius: 30000 }
      });
      if (seq !== S.sugSeq) return;   // v3.10.105: an older, slower answer must not replace the newer one
      renderSuggestions((res && res.suggestions) || []);
    } catch (e) {
      if (isCap(e) || (e && e.code === "permit")) { clearResults(); if (!isCap(e)) setStatus(e.message, 6000); return; }
      setStatus("ძიება ვერ მუშაობს: ჩართულია თუ არა Places API (New) თქვენს Google პროექტში?", 6000);
      console.warn("[GMap] autocomplete:", e && e.message);
    }
  }

  // ---------- v3.10.115: home, work and recent places under the search box (one tap, no typing) ----------
  const FAV_KEY = "gmapFavs", RECENT_KEY = "gmapRecent";
  function readJson(k, d) { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v == null ? d : v; } catch (_) { return d; } }
  function writeJson(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }

  function rememberPlace(pl) {
    if (!pl || !pl.loc || !isFinite(pl.loc.lat)) return;
    const p = { name: String(pl.name || "ადგილი").slice(0, 80), address: String(pl.address || "").slice(0, 160), lat: +pl.loc.lat, lng: +pl.loc.lng };
    writeJson(RECENT_KEY, addRecent(readJson(RECENT_KEY, []), p));
    // the home / work address from the settings, searched once: its coordinates are kept, so the next time is one tap
    if (S.pendingFav) {
      const favs = readJson(FAV_KEY, {});
      favs[S.pendingFav.kind] = Object.assign({ text: S.pendingFav.text }, p);
      writeJson(FAV_KEY, favs);
      S.pendingFav = null;
    }
  }

  function goPlace(p) {
    clearResults();
    const input = $("gmap-search-input");
    if (input) { input.value = p.name; input.blur(); }
    showPlace({ name: p.name, address: p.address, loc: { lat: p.lat, lng: p.lng } });
    routeToPlace();
  }

  function goFav(kind) {
    const text = (localStorage.getItem(kind === "home" ? "saved_home" : "saved_work") || "").trim();
    const fav = readJson(FAV_KEY, {})[kind];
    if (fav && fav.text === text && isFinite(fav.lat)) { goPlace(fav); return; }
    if (!text) { setStatus((kind === "home" ? "სახლის" : "სამსახურის") + " მისამართი ჩაწერეთ პარამეტრებში (⚙️)", 5000); return; }
    S.pendingFav = { kind, text };   // the result the driver picks becomes home / work (saved by rememberPlace)
    const input = $("gmap-search-input");
    if (input) input.value = text;
    suggest(text);
  }

  function quickRow(icon, title, sub, fn) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "gmap-result gmap-quick";
    const main = document.createElement("span");
    main.className = "gmap-result-main";
    main.textContent = icon + " " + title;
    const sec = document.createElement("span");
    sec.className = "gmap-result-sec";
    sec.textContent = sub;
    b.appendChild(main);
    b.appendChild(sec);
    b.addEventListener("mousedown", (e) => e.preventDefault());   // keep the input focused until the tap is handled
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  function showQuickList() {
    const box = $("gmap-results");
    if (!box) return;
    box.textContent = "";
    const home = (localStorage.getItem("saved_home") || "").trim(), work = (localStorage.getItem("saved_work") || "").trim();
    box.appendChild(quickRow("🏠", "სახლი", home || "მისამართი ჩაწერეთ პარამეტრებში", () => goFav("home")));
    box.appendChild(quickRow("🏢", "სამსახური", work || "მისამართი ჩაწერეთ პარამეტრებში", () => goFav("work")));
    readJson(RECENT_KEY, []).forEach((r) => { if (r && isFinite(r.lat)) box.appendChild(quickRow("🕘", r.name, r.address, () => goPlace(r))); });
    box.classList.add("show");
    S.quickShown = true;
  }

  async function choosePrediction(pp) {
    try {
      await permit("details");
      const place = pp.toPlace();
      // Essentials fields only (10,000 free a month): displayName would bill the call as Pro (5,000); the name comes from the suggestion
      await place.fetchFields({ fields: ["formattedAddress", "location"] });
      S.sessionToken = null; // a session ends with the selection (billing: one session = autocomplete + one details call)
      clearResults();
      const name = (pp.mainText && pp.mainText.text) || (pp.text && pp.text.text) || "";
      const input = $("gmap-search-input");
      if (input) input.value = name;
      showPlace({ name, address: place.formattedAddress || "", loc: place.location });
    } catch (e) {
      if (isCap(e)) return;
      setStatus("ადგილის დეტალები ვერ ჩაიტვირთა", 6000);
      console.warn("[GMap] place details:", e && e.message);
    }
  }

  function clearRoute() { S.routeLines.forEach((l) => l.setMap(null)); S.routeLines = []; S.selLines = null; }

  /** v3.10.99: the driven part of the chosen route disappears (the line starts at the car, snapped onto the route).
   *  setPath re-tessellates the whole line, so only on a new segment or every 3 s. */
  function trimPassed(pos, coords, i) {
    if (!S.selLines || !coords[i + 1]) return;
    const now = Date.now();
    if (i === S.trimSeg && now - (S.trimAt || 0) < 3000) return;
    S.trimSeg = i; S.trimAt = now;
    const a = coords[i], b = coords[i + 1], t = Math.max(0, Math.min(1, segT(a, b, pos)));
    const path = [{ lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) }].concat(coords.slice(i + 1));
    S.selLines.forEach((l) => l.setPath(path));
  }
  function resetRoutes() { clearRoute(); S.routes = []; stopNavigation(); const b = $("gmap-card-routes"); if (b) b.textContent = ""; const st = $("gmap-card-start"); if (st) st.hidden = true; }

  function showPlace(p) {
    const loc = p.loc && typeof p.loc.lat === "function" ? { lat: p.loc.lat(), lng: p.loc.lng() } : p.loc;
    if (!loc) return;
    S.place = { name: p.name, address: p.address, loc };
    rememberPlace(S.place);
    resetRoutes();
    if (!S.placeMarker) S.placeMarker = new S.g.core.Marker({ map: S.map, zIndex: 900 });
    S.placeMarker.setPosition(loc);
    S.placeMarker.setMap(S.map);
    S.follow = false;
    $("gmap-btn-me") && $("gmap-btn-me").classList.remove("active");
    S.map.panTo(loc);
    if (S.map.getZoom() < 15) S.map.setZoom(16);
    const card = $("gmap-card");
    if (!card) return;
    $("gmap-card-title").textContent = p.name;
    $("gmap-card-addr").textContent = p.address;
    $("gmap-card-route").textContent = "";
    $("gmap-card-go").disabled = false;
    card.classList.add("show");
  }

  function closeCard() {
    const card = $("gmap-card");
    if (card) card.classList.remove("show");
    if (S.placeMarker) S.placeMarker.setMap(null);
    resetRoutes();
    S.place = null;
  }

  // ---------- route: our OSRM line on the Google map ----------
  async function fetchRoute(from, to) {
    let lastErr = null;
    for (const server of OSRM_SERVERS) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      try {
        const r = await fetch(osrmUrl(server, from, to), { signal: ctrl.signal });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        const rt = j && j.routes && j.routes[0];
        if (rt && rt.geometry && Array.isArray(rt.geometry.coordinates)) {
          return { coords: rt.geometry.coordinates.map((c) => ({ lat: c[1], lng: c[0] })), durationSec: rt.duration, distanceM: rt.distance };
        }
      } catch (e) { lastErr = e; } finally { clearTimeout(timer); }
    }
    throw lastErr || new Error("მარშრუტი ვერ მოიძებნა");
  }

  const ROUTES_FIELD_MASK = "routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.routeLabels," +
    "routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,routes.legs.steps.startLocation";

  /** Traffic-aware routes. The server only counts (/api/route-permit enforces the daily/monthly cap); the browser then asks Google
   *  with the referrer-restricted Maps key. Google answers this request with 503 "Deadline expired" when it comes from Render,
   *  and with 200 from a desktop or the car's browser (verified 2026-10-19), so the call cannot stay on the server. */
  async function fetchGoogleRoutes(from, to, departInMin) {
    const fail = (code) => { const e = new Error("Routes: " + code); e.code = code; return e; };
    try { await permit("routes"); } catch (e) { throw fail(e.code || "permit"); }
    if (!S.key) throw fail("no-key");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let r;
    try {
      r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST", signal: ctrl.signal, cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": S.key, "X-Goog-FieldMask": ROUTES_FIELD_MASK },
        body: JSON.stringify(routesRequestBody(from, to, departInMin))
      });
    } catch (e) { throw fail(e && e.name === "AbortError" ? "timeout" : "network"); }
    finally { clearTimeout(timer); }
    if (!r.ok) {
      let code = "google" + r.status;
      try { const j = await r.json(); if (j && j.error && j.error.status) code += ":" + j.error.status; } catch (_) {}
      throw fail(code);
    }
    const routes = parseRoutesResponse(await r.json());
    if (!routes.length) { const e = new Error("Routes: no route"); e.code = "empty"; throw e; }
    return routes;
  }

  function fallbackNote(code) {
    if (/^cap/.test(code)) return "Google მარშრუტების ლიმიტი ამოიწურა (" + (/month/.test(code) ? "თვის" : "დღის") + "), ნაჩვენებია OSRM მარშრუტი ტრაფიკის გარეშე.";
    if (code === "no-key") return "Google-ის გასაღები არ არის (GOOGLE_MAPS_KEY), ნაჩვენებია OSRM მარშრუტი ტრაფიკის გარეშე.";
    if (code === "timeout") return "Google-მა მარშრუტი 10 წამში არ დააბრუნა, ნაჩვენებია OSRM მარშრუტი ტრაფიკის გარეშე.";
    if (code === "network") return "Google-თან კავშირი ვერ დამყარდა, ნაჩვენებია OSRM მარშრუტი ტრაფიკის გარეშე.";
    if (/^google403/.test(code)) return "Google-მა მარშრუტი უარყო: რუკის გასაღებზე (Maps Platform API Key) Routes API უნდა იყოს ჩართული. ნაჩვენებია OSRM მარშრუტი.";
    // the code at the end (e.g. google503:UNAVAILABLE) lets the driver send us the exact reason from the car
    return "Google მარშრუტი ვერ მუშაობს (" + (code || "?") + "), ნაჩვენებია OSRM მარშრუტი ტრაფიკის გარეშე.";
  }

  function drawRoutes() {
    clearRoute();
    const { Polyline } = S.g.maps;
    // alternatives first (grey, under), the chosen one last (blue). v3.10.102: thin and see-through, no white casing,
    // so Google's traffic colours on the road stay visible under / beside the route
    S.routes.forEach((rt, i) => {
      if (i === S.routeIdx || S.navigating) return;
      const l = new Polyline({ path: rt.coords, map: S.map, strokeColor: "#8a8f98", strokeOpacity: 0.6, strokeWeight: 4, zIndex: 5, clickable: true });
      l.addListener("click", () => selectRoute(i));
      S.routeLines.push(l);
    });
    const sel = S.routes[S.routeIdx];
    S.selLines = [
      new Polyline({ path: sel.coords, map: S.map, strokeColor: "#3e6ae1", strokeOpacity: 0.7, strokeWeight: 4, zIndex: 11 }),
    ];
    S.routeLines.push(...S.selLines);
    S.trimSeg = -1;
    if (S.navigating && S.carPos) { const nr = nearestOnPolyline(S.carPos, sel.coords); if (nr.i >= 0 && nr.d <= OFF_ROUTE_M) trimPassed(S.carPos, sel.coords, nr.i); }
  }

  function renderRouteOptions() {
    const box = $("gmap-card-routes");
    if (!box) return;
    box.textContent = "";
    S.routes.forEach((rt, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "gmap-route-opt" + (i === S.routeIdx ? " active" : "");
      const t = document.createElement("span");
      t.className = "gmap-route-time";
      t.textContent = summarizeRoute(rt.durationSec, rt.distanceM);
      b.appendChild(t);
      const n = document.createElement("span");
      n.className = "gmap-route-note";
      n.textContent = rt.source === "osrm" ? "საცობების გარეშე" : (rt.delaySec >= 120 ? "საცობი +" + Math.round(rt.delaySec / 60) + " წთ" : "თავისუფალია");
      b.appendChild(n);
      b.addEventListener("click", () => selectRoute(i));
      box.appendChild(b);
    });
  }

  function selectRoute(i) {
    if (!S.routes[i]) return;
    S.routeIdx = i; S.stepIdx = 0; S.segIdx = 0;
    drawRoutes(); renderRouteOptions(); updateNavBanner();
  }

  function updateEta() {
    const el = $("gmap-eta");
    if (!el) return;
    const rt = S.routes[S.routeIdx];
    if (!S.navigating || !rt || !rt.coords || rt.coords.length < 2) { el.classList.remove("show"); return; }
    if (!rt.cum) rt.cum = routeCum(rt.coords);
    const remain = S.carPos ? remainingOnRoute(rt.coords, rt.cum, S.carPos, S.segIdx) : rt.cum[rt.cum.length - 1];
    const e = etaInfo(remain, rt.cum[rt.cum.length - 1], rt.durationSec || 0, Date.now());
    $("gmap-eta-time").textContent = e.arrive;
    $("gmap-eta-rest").textContent = e.dur + " · " + e.dist;
    el.classList.add("show");
  }

  function updateNavBanner() {
    const nav = $("gmap-nav");
    if (!nav) return;
    updateEta();
    const rt = S.routes[S.routeIdx];
    if (!S.navigating || !rt || !rt.steps.length) { nav.classList.remove("show"); return; }
    const onRoute = S.carPos && S.carAlong != null;
    if (onRoute) {
      if (!rt.cum) rt.cum = routeCum(rt.coords);
      if (!rt.stepAlong) rt.stepAlong = stepAlongs(rt.coords, rt.cum, rt.steps);
    }
    if (S.carPos) {
      const k = onRoute ? nextStepAlong(rt.stepAlong, S.carAlong, S.stepIdx) : -1;
      S.stepIdx = k >= 0 ? k : nextStepIndex(rt.steps, S.carPos, S.stepIdx);
    }
    const st = rt.steps[S.stepIdx];
    let d = S.carPos ? meters(S.carPos, st.loc) : st.distanceM;
    if (onRoute) d = distToStep(d, rt.stepAlong[S.stepIdx], S.carAlong);
    $("gmap-nav-dist").textContent = fmtDist(d);
    $("gmap-nav-text").textContent = st.text;
    const icon = $("gmap-nav-icon");
    if (icon && icon.getAttribute("data-m") !== st.maneuver) {
      icon.setAttribute("data-m", st.maneuver);
      const mi = maneuverIcon(st.maneuver);
      icon.classList.toggle("show", !!mi);
      if (mi) { $("gmap-nav-icon-path").setAttribute("d", mi.d); $("gmap-nav-icon-g").setAttribute("transform", mi.left ? "translate(24,0) scale(-1,1)" : ""); }
    }
    // v3.10.115: "then …" when the maneuver after this one comes within 150 m of it
    const nx = rt.steps[S.stepIdx + 1];
    let thenTxt = "";
    if (nx) {
      const gap = rt.stepAlong && rt.stepAlong[S.stepIdx + 1] != null && rt.stepAlong[S.stepIdx] != null ? rt.stepAlong[S.stepIdx + 1] - rt.stepAlong[S.stepIdx] : meters(st.loc, nx.loc);
      if (thenIsClose(gap)) thenTxt = thenPhrase(nx.maneuver);
    }
    let th = $("gmap-nav-then");
    if (!th) { th = document.createElement("div"); th.id = "gmap-nav-then"; th.className = "gmap-nav-then"; nav.insertBefore(th, $("gmap-nav-signal") || null); }
    th.textContent = thenTxt ? "შემდეგ: " + thenTxt : "";
    th.classList.toggle("show", !!thenTxt);
    if (S.voice) { const t = S.voice.update(S.stepIdx, st, d, window.currentSpeedKmhForLock || 0); if (t) speak(thenTxt ? t + ", შემდეგ " + thenTxt : t); }
    nav.classList.add("show");
  }

  function startNavigation() {
    if (!S.routes.length) return;
    S.navigating = true; S.follow = true; S.stepIdx = 0; S.segIdx = 0; S.carAlong = null;
    // v3.10.104: remembered, so a page reload (the car browser reloads on shifting into R) carries on with the same destination
    saveNav();
    drawRoutes();   // v3.10.105: without the grey alternatives (a tap on one would switch the route while driving)
    S.offRouteTracker = createOffRouteTracker({ thresholdM: OFF_ROUTE_M, ticks: 4, cooldownMs: 20000, maxReroutes: 12 });
    S.voice = createVoiceCues();
    prefetchSignals();
    window.__gmapNavigating = true;   // routing.js stays quiet: one voice at a time
    const first = S.routes[S.routeIdx] && S.routes[S.routeIdx].steps[0];
    speak("მარშრუტი დაწყებულია." + (first && first.text ? " " + first.text : ""));
    // v3.10.116: bad weather on the way, said once at the start (a safety prompt: "ყურადღება" = priority 1)
    if (S.routeWeather && S.routeWeather.length) speak("ყურადღება, გზაზე " + S.routeWeather[0].replace(/^\S+\s/, "").replace(/\(≈ [^)]*\)/, "").trim());
    const layer = $("gmap-layer");
    if (layer) layer.classList.add("navigating");
    document.body.classList.add("gmap-navigating");
    $("gmap-btn-me") && $("gmap-btn-me").classList.add("active");
    $("gmap-card").classList.remove("show");
    S.map.setZoom(17);
    wakeCar();
    updateNavBanner();
  }

  /** Saves the running navigation; called on start and every 30 s while driving (the 10 min freshness above). */
  function saveNav() {
    S.navSavedAt = Date.now();
    try { if (S.place && S.place.loc) localStorage.setItem(NAV_KEY, JSON.stringify({ name: S.place.name, address: S.place.address, lat: S.place.loc.lat, lng: S.place.loc.lng, t: S.navSavedAt })); } catch (_) {}
  }

  function stopNavigation() {
    const was = S.navigating;
    if (was) { try { localStorage.removeItem(NAV_KEY); } catch (_) {} }
    S.navigating = false;
    S.carAlong = null;
    if (was && S.map && S.routes.length) drawRoutes();   // the alternatives come back with the route card
    S.offRouteTracker = null;
    S.voice = null;
    if (typeof window !== "undefined") window.__gmapNavigating = false;
    const layer = $("gmap-layer");
    if (layer) layer.classList.remove("navigating");
    if (typeof document !== "undefined") document.body.classList.remove("gmap-navigating");
    const nav = $("gmap-nav");
    if (nav) nav.classList.remove("show");
    const eta = $("gmap-eta");
    if (eta) eta.classList.remove("show");
  }

  async function reroute() {
    if (!S.place || S.rerouting) return;
    S.rerouting = true;
    setStatus("მარშრუტი გადაითვალა...");
    const from = S.carPos || currentCenter();
    try {
      let routes, note = "";
      try {
        routes = await fetchGoogleRoutes(from, S.place.loc, 0);
      } catch (ge) {
        console.warn("[GMap] Reroute Routes API:", ge && ge.message);
        const o = await fetchRoute(from, S.place.loc);
        routes = [{ coords: o.coords, durationSec: o.durationSec, staticSec: o.durationSec, delaySec: 0, distanceM: o.distanceM, steps: [], source: "osrm" }];
        note = fallbackNote((ge && ge.code) || "");
      }
      S.routes = routes;
      S.routeIdx = 0;
      S.stepIdx = 0;
      S.segIdx = 0;
      drawRoutes();
      renderRouteOptions();
      updateNavBanner();
      if (S.voice) S.voice.reset();
      prefetchSignals();
      speak("მარშრუტი გადაითვალა");
      setStatus(note || "მარშრუტი გადაითვალა", note ? 6000 : 3000);
    } catch (e) {
      console.warn("[GMap] reroute failed:", e && e.message);
      setStatus("მარშრუტი ვერ გადაითვალა, ვცდი ისევ, როცა გზიდან გადახვევთ", 5000);   // v3.10.105: was stuck on "გადაითვალა..."
    } finally {
      S.rerouting = false;
    }
  }

  /** v3.10.104: after a page reload, the saved navigation goes on: the car's position (up to 10 s for the GPS), a fresh Google
   *  route to the same place, navigation started. One Routes call per reload. */
  async function resumeSavedNav() {
    let saved = null;
    try { saved = parseSavedNav(localStorage.getItem(NAV_KEY), Date.now()); } catch (_) {}
    if (!saved || S.navigating) return;
    for (let k = 0; k < 20 && !S.carPos && S.open; k++) await new Promise((r) => setTimeout(r, 500));
    if (!S.open || S.navigating) return;
    if (S.carPos && meters(S.carPos, saved) < NAV_NEAR_M) { try { localStorage.removeItem(NAV_KEY); } catch (_) {} return; }   // already there
    showPlace({ name: saved.name, address: saved.address, loc: { lat: saved.lat, lng: saved.lng } });
    await routeToPlace();
    if (!S.open || !S.place || !S.routes.length || S.navigating) return;
    startNavigation();
    setStatus("ნავიგაცია გაგრძელდა: " + saved.name, 4000);
  }

  /** v3.10.116: weather along the chosen route (Open-Meteo, free, one request for all points; place names from our
   *  /api/reverse for the bad spots only). The line shows on the route card; at the start it is said once. */
  async function checkRouteWeather(rt) {
    const box = $("gmap-card-weather");
    S.routeWeather = null;
    if (box) { box.textContent = ""; box.classList.remove("show"); }
    if (!rt || !rt.coords) return;
    if (!rt.cum) rt.cum = routeCum(rt.coords);
    const pts = routeWeatherPoints(rt.coords, rt.cum, rt.durationSec || 0);
    if (!pts.length) return;
    const token = S.weatherToken = (S.weatherToken || 0) + 1;
    try {
      const hours = Math.min(48, Math.ceil((rt.durationSec || 0) / 3600) + 2);
      const url = "https://api.open-meteo.com/v1/forecast?latitude=" + pts.map((p) => p.lat.toFixed(3)).join(",") + "&longitude=" + pts.map((p) => p.lng.toFixed(3)).join(",") +
        "&hourly=temperature_2m,weather_code,precipitation&forecast_hours=" + hours + "&timeformat=unixtime&timezone=auto";
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return;
      let j = await r.json();
      if (!Array.isArray(j)) j = [j];
      const now = Date.now(), found = [];
      pts.forEach((p, i) => {
        const h = j[i] && j[i].hourly;
        if (!h || !h.time) return;
        const at = now + p.etaSec * 1000;
        let best = 0;
        h.time.forEach((t, k) => { if (Math.abs(t * 1000 - at) < Math.abs(h.time[best] * 1000 - at)) best = k; });
        const hz = weatherHazard(h.weather_code[best], h.temperature_2m[best], h.precipitation[best]);
        if (hz) found.push({ hz, p, temp: h.temperature_2m[best], at });
      });
      if (token !== S.weatherToken || !found.length) return;
      found.sort((a, b) => b.hz.sev - a.hz.sev || a.p.alongM - b.p.alongM);
      const shown = found.slice(0, 2);
      const lines = [];
      for (const f of shown) {
        let name = "";
        try { const rr = await fetch("/api/reverse?lat=" + f.p.lat.toFixed(4) + "&lon=" + f.p.lng.toFixed(4), { credentials: "same-origin" }); if (rr.ok) name = ((await rr.json()) || {}).name || ""; } catch (_) {}
        lines.push(hazardText(f.hz, name, f.temp, f.p.alongM, f.at));
      }
      if (token !== S.weatherToken) return;
      S.routeWeather = lines;
      if (box) { box.textContent = lines.join("\n"); box.classList.add("show"); }
    } catch (e) { console.warn("[GMap] route weather:", e && e.message); }
  }

  /** v3.10.117: a trip planned on the phone. Checked when the Google map opens and every 10 min: within 90 min of its time the
   *  place card opens with the traffic forecast for the departure, and the plan is cleared on the server (used once). */
  async function checkPlannedTrip() {
    const code = window.__remoteCode;
    if (!code || !S.open || S.navigating) return;
    let p = null;
    try { const r = await fetch("/api/session/plan?code=" + encodeURIComponent(code), { cache: "no-store", credentials: "same-origin" }); if (r.ok) p = ((await r.json()) || {}).plan; } catch (_) { return; }
    if (!p || !isFinite(p.lat)) return;
    const st = planState(p.departAt, Date.now());
    if (st === "later") {
      if (S.planNoticed !== p.t) { S.planNoticed = p.t; setStatus("📅 დაგეგმილია: " + p.name + ", " + whenText(p.departAt), 7000); }
      return;
    }
    if (st !== "now" || S.place || S.planShown === p.t) return;
    S.planShown = p.t;
    showPlace({ name: p.name, address: p.fullName || "", loc: { lat: p.lat, lng: p.lng } });
    await routeToPlace(Math.max(0, Math.round((p.departAt - Date.now()) / 60000)));
    setStatus("📅 დაგეგმილი მგზავრობა: " + p.name + ", " + whenText(p.departAt), 9000);
    speak("დაგეგმილი მგზავრობა: " + p.name);
    fetch("/api/session/plan?code=" + encodeURIComponent(code), { method: "DELETE", credentials: "same-origin" }).catch(() => {});
  }

  async function routeToPlace(departOverride) {
    if (!S.place) return;
    const btn = $("gmap-card-go"), info = $("gmap-card-route");
    btn.disabled = true;
    info.textContent = "ითვლება...";
    const from = S.carPos || currentCenter();
    const sel = $("gmap-depart");
    const depart = typeof departOverride === "number" ? departOverride : (sel ? parseInt(sel.value, 10) || 0 : 0);   // v3.10.117: a planned trip
    try {
      let routes, note = "";
      try {
        routes = await fetchGoogleRoutes(from, S.place.loc, depart);
      } catch (ge) {
        console.warn("[GMap] Routes API:", ge && ge.message);
        const o = await fetchRoute(from, S.place.loc);
        routes = [{ coords: o.coords, durationSec: o.durationSec, staticSec: o.durationSec, delaySec: 0, distanceM: o.distanceM, steps: [], source: "osrm" }];
        note = fallbackNote((ge && ge.code) || "");
      }
      S.routes = routes; S.routeIdx = 0; S.stepIdx = 0;
      drawRoutes(); renderRouteOptions();
      const bounds = new S.g.core.LatLngBounds();
      routes[0].coords.forEach((c) => bounds.extend(c));
      S.follow = false;
      S.map.fitBounds(bounds, 90);
      info.textContent = note || (depart > 0 ? "პროგნოზი გასვლისთვის +" + depart + " წთ-ში" : "");
      $("gmap-card-start").hidden = false;
      checkRouteWeather(routes[0]);   // v3.10.116, does not hold the card up   // v3.10.104: the OSRM fallback (no turn list) can be driven too: line, ETA, rerouting
    } catch (e) {
      info.textContent = "მარშრუტი ვერ დაითვალა: " + (e && e.message);
    } finally { btn.disabled = false; }
  }

  // ---------- category chips (nearby search) ----------
  function clearCategory() {
    S.catMarkers.forEach((m) => m.setMap(null));
    S.catMarkers = [];
    S.activeCat = null;
    document.querySelectorAll("#gmap-layer [data-cat]").forEach((b) => b.classList.remove("active"));
  }

  /** ⚡ chip (v3.10.51): our own charger database (570 stations with tariffs, free) instead of Google Nearby Search
   *  (Pro, 5,000 free a month). Our data on the Google map is allowed. */
  function toggleCategory(cat, chipEl) {
    if (S.activeCat === cat.id) { clearCategory(); return; }
    clearCategory();
    S.activeCat = cat.id;
    chipEl.classList.add("active");
    const c = S.map.getCenter();
    const list = nearestChargers((window.chargersEngine && window.chargersEngine.chargers) || [], { lat: c.lat(), lng: c.lng() }, 30, 8000);
    list.forEach((st) => {
      const m = new S.g.core.Marker({ position: { lat: st.lat, lng: st.lon }, map: S.map, title: st.name || "EV დამტენი", label: { text: "⚡", fontSize: "16px" }, zIndex: 500 });
      m.addListener("click", () => showPlace({ name: st.name || "EV დამტენი", address: [st.operator, st.power, st.price].filter(Boolean).join(" · "), loc: { lat: st.lat, lng: st.lon } }));
      S.catMarkers.push(m);
    });
    if (!list.length) say("8 კმ-ის რადიუსში დამტენი ვერ მოიძებნა");
  }

  // ---------- shortcuts from the main map (v3.10.50; data only flows main map -> Google mode, never back) ----------
  /** Opens Google mode with the driver's text already searched (Places autocomplete, counted like typed text). */
  async function openWithQuery(text) {
    const q = String(text || "").trim();
    await open();
    if (!S.open || !S.map) return false;
    const input = $("gmap-search-input");
    if (input) input.value = q;
    if (q.length >= 3) await suggest(q);
    return true;
  }

  /** Takes our own (OSM) destination into Google mode and computes the traffic-aware routes there. */
  async function openWithDestination(dest) {
    if (!dest || !isFinite(dest.lat) || !isFinite(dest.lng)) return false;
    await open();
    if (!S.open || !S.map) return false;
    showPlace({ name: dest.name || "დანიშნულების ადგილი", address: dest.address || "", loc: { lat: dest.lat, lng: dest.lng } });
    await routeToPlace();
    return true;
  }

  /** A place from our own data (charger list, phone) shown on the Google map with its card; Google mode must be open. */
  function focusPlace(p) {
    if (!S.open || !S.map || !p || !isFinite(p.lat) || !isFinite(p.lng)) return false;
    showPlace({ name: p.name || "ადგილი", address: p.address || "", loc: { lat: +p.lat, lng: +p.lng } });
    return true;
  }

  // ---------- open / close ----------
  /** v3.10.55: while Google mode is open its search box sits in our top bar (weather, battery, clock stay visible). */
  function dockSearch(intoTopBar) {
    const top = document.querySelector(".gmap-top"), bar = document.querySelector(".top-bar"), layer = $("gmap-layer");
    if (!top || !bar || !layer) return;
    if (intoTopBar) {
      const slot = bar.querySelector(".search-container");
      if (top.parentNode !== bar) bar.insertBefore(top, slot ? slot.nextSibling : null);
    } else if (top.parentNode !== layer) {
      layer.insertBefore(top, $("gmap-status"));
    }
  }

  async function open() {
    if (!S.enabled || S.open) return;
    const layer = $("gmap-layer");
    if (!layer) return;
    S.open = true;
    layer.classList.add("show");
    document.body.classList.add("gmap-open");
    dockSearch(true);
    if (window.__setMainMapPaused) window.__setMainMapPaused(true);   // one map rendering at a time on the MCU2
    setStatus("Google რუკა იტვირთება...");
    try {
      await loadGoogle(S.key);
      if (!S.open) return;
      if (!S.map) { await permit("mapload"); if (!S.open) return; createMap(); }
      setStatus("");
      S.follow = true;
      $("gmap-btn-me") && $("gmap-btn-me").classList.add("active");
      syncCar();
      updatePanelButtons();
      startDebugMeter();
      S.timers.push(setInterval(syncCar, 250));
      resumeSavedNav();
      setTimeout(checkPlannedTrip, 4000);   // v3.10.117: after a possible resumed navigation
      S.timers.push(setInterval(checkPlannedTrip, 600000));
      setSideOpen(true);
      S.timers.push(setInterval(sideTick, 1000));
    } catch (e) {
      // v3.10.77: no Google map (no network, the free-tier cap, a key problem): back to our map instead of an empty layer
      const msg = (e && e.message) || "Google რუკა მიუწვდომელია";
      setStatus("");
      close();
      say(isCap(e) ? "ჩვენს რუკაზე ხართ (Google-ის ლიმიტი)" : "Google რუკა ვერ ჩაიტვირთა: " + msg + " · ჩვენს რუკაზე ხართ");
    }
  }

  // ---- v3.10.77: the Google map is the main map (Samvel). It opens by itself when the app starts, unless the driver chose
  // our map in the settings (localStorage tesla_nav_main_map = "ours") or the address has ?map=ours / ?map=lite. ----
  const MAIN_MAP_KEY = "tesla_nav_main_map";
  // v3.10.93: once, forget the start map chosen before, so the app opens on Google 3D (Samvel wants only the Google 3D map;
  // our map stays as the automatic fallback when Google cannot load). The v87 flag is set too, so that reset never runs again.
  try { if (typeof localStorage !== "undefined" && !localStorage.getItem("tesla_nav_main_map_v93")) { localStorage.removeItem(MAIN_MAP_KEY); localStorage.setItem("tesla_nav_main_map_v93", "1"); localStorage.setItem("tesla_nav_main_map_v87", "1"); } } catch (_) {}
  function mainMapIsGoogle(search) {
    const q = String(search || "");
    if (/[?&]map=(ours|lite|raster|vector)\b/.test(q)) return false;
    if (/[?&]gmap3d=1/.test(q)) return true;
    return currentMainMap() !== "ours";
  }
  function autoOpen() {
    // v3.10.80: Google 3D unless "google" (classic) was chosen; wait until our map exists (open() pauses it) so the two never
    // render at once; give up quietly after ~15 s
    S.vector = /[?&]gmap3d=1/.test(location.search) || currentMainMap() !== "google";   // ?gmap3d=1: the full test forces 3D (nothing saved)
    let tries = 0;
    const t = setInterval(() => {
      if (S.open || ++tries > 30) { clearInterval(t); return; }
      if (window.__setMainMapPaused && window.map) { clearInterval(t); open(); }
    }, 500);
  }

  // ---- v3.10.80 one map picker (Samvel): "google3d" (default, main), "google" (classic), "ours" (OSM). The choice is shown at
  // once and opens with the app next time. Used by the map menu of our dock and of the Google side panel, and the settings. ----
  const MAP_KINDS = ["google3d", "google", "ours"];
  function currentMainMap() {
    let v = null;
    try { v = localStorage.getItem(MAIN_MAP_KEY); } catch (_) {}
    return MAP_KINDS.includes(v) ? v : "google3d";   // v3.10.93: Google 3D is the start map again (Samvel: only Google 3D)
  }
  /** The map on the screen right now. */
  function shownMap() { return S.open ? (S.vector ? "google3d" : "google") : "ours"; }
  function selectMap(kind) {
    if (!MAP_KINDS.includes(kind)) return false;
    try { localStorage.setItem(MAIN_MAP_KEY, kind); } catch (_) {}
    if (kind === "ours") { close(); return true; }
    if (!S.enabled) { say("Google რუკა მიუწვდომელია (გასაღები არ არის): ჩვენს რუკაზე ხართ"); return false; }
    const want = kind === "google3d";
    try { localStorage.setItem("gmapVector", want ? "1" : "0"); } catch (_) {}
    if (!S.open) { S.vector = want; open(); return true; }
    if (S.vector !== want) {
      S.vector = want;
      rebuildMap(() => { S.vector = !want; try { localStorage.setItem("gmapVector", S.vector ? "1" : "0"); } catch (_) {} updatePanelButtons(); });
      updatePanelButtons();
    }
    return true;
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    gpuReset();
    stopNavigation();
    S.timers.forEach(clearInterval);
    S.timers = [];
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = null; }
    if (S.carTimer) { clearTimeout(S.carTimer); S.carTimer = null; }
    S.lastCam = null;
    S.lastFrame = 0;
    const layer = $("gmap-layer");
    if (layer) layer.classList.remove("show");
    document.body.classList.remove("gmap-open");
    dockSearch(false);
    if (window.__setMainMapPaused) window.__setMainMapPaused(false);
    try { if (window.map && window.map.resize) setTimeout(() => window.map.resize(), 50); } catch (_) {}
  }

  function wireUi() {
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    on("btn-google-mode", "click", () => (S.open ? close() : open()));
    on("gmap-btn-close", "click", close);
    on("gmap-compass", "click", (e) => { e.stopPropagation(); toggleNorthUp(); });
    on("gmap-side-tab", "click", (e) => { e.stopPropagation(); setSideOpen(true); });
    on("gmap-fab-me", "click", (e) => { e.stopPropagation(); const me = $("gmap-btn-me"); if (me) me.click(); sideTick(); });
    { const side = document.querySelector("#gmap-layer .gmap-side"); if (side) side.addEventListener("click", () => { S.sideTouchAt = Date.now(); }, true); }
    on("gmap-btn-zoom-in", "click", () => { if (!S.map) return; S.manualZoomAt = Date.now(); S.map.setZoom(S.map.getZoom() + 1); });
    on("gmap-btn-zoom-out", "click", () => { if (!S.map) return; S.manualZoomAt = Date.now(); S.map.setZoom(S.map.getZoom() - 1); });
    on("gmap-btn-me", "click", () => {
      if (!S.map) return;
      S.follow = true;
      S.manualZoomAt = 0;   // v3.10.110: back to the speed zoom
      $("gmap-btn-me").classList.add("active");
      wakeCar();   // the glide re-centres (and on the vector map turns heading-up) on its next frame
    });
    on("gmap-btn-traffic", "click", () => {
      S.trafficOn = !S.trafficOn;
      try { localStorage.setItem("gmapTraffic", S.trafficOn ? "1" : "0"); } catch (_) {}
      applyTraffic();
    });
    on("gmap-btn-night", "click", () => { if (window.toggleNightMode) window.toggleNightMode(); syncNight(); });
    // v3.10.80: this button opens the map picker (Google 3D / Google classic / ours) instead of toggling 3D
    on("gmap-btn-vector", "click", (e) => { if (e) e.stopPropagation(); if (window.openMapPicker) window.openMapPicker(); });
    on("gmap-card-close", "click", closeCard);
    on("gmap-card-go", "click", routeToPlace);
    on("gmap-card-start", "click", startNavigation);
    on("gmap-nav-stop", "click", () => { stopNavigation(); const c = $("gmap-card"); if (c && S.place) c.classList.add("show"); });
    const input = $("gmap-search-input");
    if (input) {
      const deb = createDebouncer(suggest, 300);
      input.addEventListener("input", () => { S.quickShown = false; S.pendingFav = null; if (input.value.trim().length < 3) { deb.cancel(); if (!input.value.trim()) showQuickList(); else clearResults(); } else deb(input.value); });
      input.addEventListener("focus", () => { if (!input.value.trim()) showQuickList(); });
      input.addEventListener("blur", () => { setTimeout(() => { if (S.quickShown) { S.quickShown = false; clearResults(); } }, 250); });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { deb.cancel(); suggest(input.value); } });
    }
    on("gmap-search-clear", "click", () => { if (input) input.value = ""; clearResults(); closeCard(); });
    // v3.10.56: the side panel holds what the main dock has: ⚡ chargers (was a chip under the search), then the main dock
    // buttons that make sense over the Google map (they click the same main button, so the logic and state stay one).
    const side = document.querySelector(".gmap-side"), closeBtn = $("gmap-btn-close");
    if (side) {
      // v3.10.113: the buttons written in index.html get the same line icons
      [["gmap-btn-traffic", "traffic", "green"], ["gmap-btn-night", "night", "violet"], ["gmap-btn-vector", "map", "sky"], ["gmap-btn-me", "locate", "sky"],
        ["gmap-btn-zoom-in", "plus", ""], ["gmap-btn-zoom-out", "minus", ""], ["gmap-btn-close", "close", "red"]].forEach(([id, ic, tone]) => setPanelIcon($(id), ic, tone));
      const add = (icon, title, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "gmap-btn";
        b.title = title;
        b.textContent = icon;
        b.addEventListener("click", (e) => { e.stopPropagation(); fn(b); });
        side.insertBefore(b, closeBtn || null);
        return b;
      };
      CATEGORIES.forEach((cat) => { const b = add(cat.label.split(" ")[0], cat.label.split(" ").slice(1).join(" ") || cat.label, () => { if (S.map) toggleCategory(cat, b); }); b.dataset.cat = cat.id; setPanelIcon(b, "bolt", "amber"); });
      SIDE_PROXIES.forEach((p) => {
        const main = $(p.target);
        if (!main) return;
        const b = add(p.icon, p.title, () => { main.click(); mirror(); });
        setPanelIcon(b, p.ikey, p.tone);
        const mirror = () => {
          const on = !!p.activeClass && main.classList.contains(p.activeClass);
          b.classList.toggle("active", on);
          if (p.ikeyOff) setPanelIcon(b, on ? p.ikey : p.ikeyOff, p.tone);
        };
        mirror();
        if (typeof MutationObserver !== "undefined" && p.activeClass) new MutationObserver(mirror).observe(main, { attributes: true, attributeFilter: ["class"] });
      });
    }
  }

  async function init() {
    if (typeof document === "undefined") return;
    wireUi();
    const cfg = await fetchConfig();
    S.enabled = cfg.enabled;
    S.key = cfg.key || "";
    S.mapId = cfg.mapId || "";
    const q = (typeof location !== "undefined" && location.search) || "";
    S.debug = /[?&]debug=1/.test(q);
    const gf = /[?&]gfps=(\d+)/.exec(q);
    if (gf) S.gfps = Math.min(30, Math.max(2, parseInt(gf[1], 10)));
    const gs = /[?&]gscale=(0?\.\d+|1(?:\.0+)?)/.exec(q);
    if (gs) { const v = parseFloat(gs[1]); S.gscale = v >= 1 ? 0 : Math.max(0.5, v); }
    // v3.10.93 lightening tests for the Google 3D map: ?gtilt=N (0..60) tilt, ?gtraffic=0 no traffic layer
    const gt = /[?&]gtilt=(\d+)/.exec(q);
    if (gt) S.gtilt = Math.min(60, Math.max(0, parseInt(gt[1], 10)));
    S.noTraffic = /[?&]gtraffic=0(&|$)/.test(q);
    S.noAutoZoom = /[?&]gzoom=0(&|$)/.test(q);
    S.sideFixed = /[?&]gside=fixed/.test(q);   // v3.10.112: the side panel never hides itself   // v3.10.110: no speed zoom (e.g. for the fps suite)
    // v3.10.79 ?gcam=gpu: GPU camera on the 3D (vector) map; ?gcamms=N ms between real camera moves (default 250)
    S.gpuOn = /[?&]gcam=gpu/.test(q);
    try { S.northUp = localStorage.getItem("gmapNorthUp") === "1"; } catch (_) { S.northUp = false; }   // v3.10.111
    if ($("gmap-compass")) $("gmap-compass").classList.toggle("north-up", !!S.northUp);
    const gm = /[?&]gcamms=(\d+)/.exec(q);
    S.gpuMs = gm ? Math.min(2000, Math.max(50, parseInt(gm[1], 10))) : 250;
    if (S.gpuOn) document.body.classList.add("gcam-gpu");
    try { S.vector = localStorage.getItem("gmapVector") === "1"; } catch (_) { S.vector = false; }
    const btn = $("btn-google-mode");
    if (btn) btn.hidden = !S.enabled;
    if (S.enabled && mainMapIsGoogle(q)) autoOpen();
  }

  const api = { init, open, close, isOpen: () => S.open, isEnabled: () => S.enabled, camMoves: () => S.camCount, isVector: () => !!S.vector, tilt: () => (S.map && S.map.getTilt ? Math.round(S.map.getTilt() || 0) : 0), renderType: () => (S.map && S.map.getRenderingType ? String(S.map.getRenderingType() || "") : ""), gpuOn: () => !!S.gpuOn, mainMapIsGoogle, MAIN_MAP_KEY, selectMap, shownMap, currentMainMap, MAP_KINDS, gpuPlan, openWithQuery, openWithDestination, focusPlace, SIDE_PROXIES, mapKey, distToPolylineM, nearestOnPolyline, createOffRouteTracker, createVoiceCues, nearestChargers, createCarGlide, aheadPoint, mapOptions, cameraNeedsUpdate, createFpsMeter, scaledBoxStyle, capText, warnText, decodePolyline, parseRoutesResponse, routesRequestBody, nextStepIndex, fmtDist, whenText, planState, nearForm, routeWeatherPoints, weatherHazard, hazardText, addRecent, thenPhrase, thenIsClose, autoZoom, sideShouldHide, maneuverIcon, routeCum, remainingOnRoute, etaInfo, stepAlongs, nextStepAlong, distToStep, hasArrived, parseSavedNav, buildLoaderUrl, createDebouncer, osrmUrl, summarizeRoute, mapStyles, bearing, meters, CATEGORIES };
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => init());
    else init();
  }
  return api;
});
