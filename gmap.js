/**
 * gmap.js - "Google mode" (v3.11.0): the Google map with the city traffic layer and Google Places search, like tmap.ge.
 *
 * Why a separate mode and not a layer on the MapLibre map: Google's terms forbid showing Google data (traffic tiles, Places
 * results) on a non-Google map, so everything that comes from Google lives on the Google map, and our own data (the OSRM route,
 * the car position) is drawn on top of it, which is allowed. The mode is opt-in: it needs GOOGLE_MAPS_KEY on the server
 * (/api/gmaps-config, behind the access PIN); without the key the dock button stays hidden and nothing is loaded from Google.
 *
 * The Google script is loaded only when the driver opens the mode. The map is a classic (raster, mapId-less) map with JSON styles,
 * which is much lighter than the vector/3D map on the Atom MCU2.
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
    { icon: "📋", title: "დამტენების სია", target: "btn-chargers-list", activeClass: "active" },
    { icon: "📷", title: "სიჩქარის კამერები", target: "btn-toggle-cameras", activeClass: "signals-active" },
    { icon: "🔊", iconOff: "🔇", title: "ხმოვანი ნავიგაცია", target: "btn-toggle-voice", activeClass: "active" },
    { icon: "📱", title: "ტელეფონით მართვა", target: "btn-remote-phone" },
    { icon: "⚙️", title: "პარამეტრები", target: "btn-settings" }
  ];

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

  const secs = (d) => { const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d || "")); return m ? parseFloat(m[1]) : 0; };

  /** Routes API computeRoutes response -> our route objects (alternatives, traffic ETA, steps with maneuver text). */
  function parseRoutesResponse(json) {
    const list = (json && json.routes) || [];
    return list.filter((r) => r && r.polyline && r.polyline.encodedPolyline).map((r) => {
      const steps = [];
      ((r.legs && r.legs) || []).forEach((leg) => (leg.steps || []).forEach((st) => {
        const ni = st.navigationInstruction;
        const ll = st.startLocation && st.startLocation.latLng;
        if (ni && ni.instructions && ll) steps.push({ text: ni.instructions, maneuver: ni.maneuver || "", distanceM: st.distanceMeters || 0, loc: { lat: ll.latitude, lng: ll.longitude } });
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

  function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + " კმ" : Math.round(m / 10) * 10 + " მ"; }

  // ---------- the mode ----------
  const S = {
    enabled: false, key: "", open: false, map: null, traffic: null, trafficOn: true, loading: null, g: null,
    carMarker: null, carPos: null, carHeading: 0, follow: true, placeMarker: null, catMarkers: [], activeCat: null,
    routeLines: [], routes: [], routeIdx: 0, stepIdx: 0, segIdx: 0, offRouteTracker: null, rerouting: false, voice: null, glide: null, raf: null, lastFrame: 0, idle: 0, lastFix: null,
    vector: false, mapId: "", carRot: null, carTimer: null, lastCam: null, lastMarker: null, camCount: 0, gfps: 0, gscale: 0, debug: false, warned: {}, rebuilding: false,
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
      if (isCap) { setStatus(e.message); say(e.message); }
      throw e;
    }
    if (j && j.warn) {
      const k = sku + ":" + j.resetsOn;
      if (!S.warned[k]) { S.warned[k] = true; say(warnText(j)); }
    }
    return j;
  }
  const isCap = (e) => !!(e && typeof e.code === "string" && e.code.indexOf("cap:") === 0);

  function setStatus(text) {
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
    o.tilt = 0;
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
    } else {
      const el = document.createElement("div");   // a fresh element per map: a Map ID cannot be added to an existing map
      el.style.cssText = scaledBoxStyle(S.gscale);
      box.appendChild(el);
      S.map = new Map(el, mapOptions(S.vector, S.night, v));
      S.maps[key] = { map: S.map, el };
      S.map.addListener("dragstart", () => { S.follow = false; $("gmap-btn-me") && $("gmap-btn-me").classList.remove("active"); });
    }
    S.carMarker = null; S.carRot = null; S.lastMarker = null; S.lastCam = null;
    S.traffic = new TrafficLayer();
    try { S.trafficOn = localStorage.getItem("gmapTraffic") !== "0"; } catch (_) { S.trafficOn = true; }
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

  // Arrow/camera rate: 20 fps on the classic map; 10 fps on the vector (3D) map, where every camera move re-renders the whole map.
  // ?gfps=N (2..30) overrides both, for measuring in the car.
  function carFrameMs() { return S.gfps ? 1000 / S.gfps : (S.vector ? 100 : 50); }

  /** One frame of the glide: arrow position/rotation, and the camera while following (heading-up on the vector map). */
  function drawCar(f) {
    S.carHeading = f.heading;
    const pos = { lat: f.lat, lng: f.lng };
    const headingUp = S.vector && S.follow;
    // the marker is drawn upright on the screen, so on a rotated map its rotation is relative to the map heading
    const mapHeading = S.vector && S.map.getHeading ? (S.map.getHeading() || 0) : 0;
    const rot = Math.round(headingUp ? 0 : ((f.heading - mapHeading) % 360 + 360) % 360);
    if (!S.carMarker) { S.carMarker = new S.g.core.Marker({ position: pos, map: S.map, icon: markerIcon(rot), zIndex: 999, clickable: false }); S.carRot = rot; S.lastMarker = pos; }
    else {
      if (!S.lastMarker || meters(S.lastMarker, pos) >= 0.3) { S.carMarker.setPosition(pos); S.lastMarker = pos; }
      if (rot !== S.carRot) { S.carMarker.setIcon(markerIcon(rot)); S.carRot = rot; }
    }
    if (!S.follow) { S.lastCam = null; return; }
    const el = S.map.getDiv && S.map.getDiv();
    const h = (el && el.clientHeight) || 800;
    const zoom = S.map.getZoom() || 16;
    const center = aheadPoint(window.MapGL, pos, f.heading, zoom, h, 0.25);
    const cam = { lat: center.lat, lng: center.lng, heading: headingUp ? f.heading : null };
    const halfPx = 0.5 * 156543.03392 * Math.cos(center.lat * Math.PI / 180) / Math.pow(2, zoom);
    if (!cameraNeedsUpdate(S.lastCam, cam, halfPx, 1)) return;
    S.lastCam = cam; S.camCount++;
    if (headingUp && S.map.moveCamera) S.map.moveCamera({ center, heading: f.heading });
    else S.map.setCenter(center);
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
          "  traffic " + (S.trafficOn ? "on" : "off") + (S.gscale ? "  scale " + S.gscale : "") + (S.mapId ? "" : "  DEMO_MAP_ID");
        cam0 = S.camCount;
      }
      S.debugRaf = requestAnimationFrame(loop);
    };
    S.debugRaf = requestAnimationFrame(loop);
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
    if (!S.glide && window.MapGL) S.glide = createCarGlide(window.MapGL);
    if (S.glide) { S.glide.setFix(fix, performance.now()); wakeCar(); }
    const pos = { lat: fix.lat, lng: fix.lng };
    S.carPos = pos;
    if (S.navigating && S.place && S.place.loc && meters(pos, S.place.loc) < 30) {
      stopNavigation();
      setStatus("დანიშნულების ადგილზე ხართ");
      speak("დანიშნულების ადგილზე მიხვედით");
      setTimeout(() => setStatus(""), 5000);
    } else if (S.navigating) {
      const rt = S.routes[S.routeIdx];
      if (rt && rt.coords && rt.coords.length && S.offRouteTracker && !S.rerouting) {
        // look near the last match first (cheap on long routes); scan the whole line only when the car seems off it there
        let nr = nearestOnPolyline(pos, rt.coords, S.segIdx - 20, S.segIdx + 200);
        if (nr.d > OFF_ROUTE_M) nr = nearestOnPolyline(pos, rt.coords);
        if (nr.i >= 0) S.segIdx = nr.i;
        if (S.offRouteTracker.update(nr.d)) reroute();
      }
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
      await permit("autocomplete");
      const res = await S.g.places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: q, sessionToken: S.sessionToken, language: "ka", region: "ge", includedRegionCodes: ["ge"],
        locationBias: { center, radius: 30000 }
      });
      renderSuggestions((res && res.suggestions) || []);
    } catch (e) {
      if (isCap(e) || (e && e.code === "permit")) { clearResults(); if (!isCap(e)) setStatus(e.message); return; }
      setStatus("ძიება ვერ მუშაობს: ჩართულია თუ არა Places API (New) თქვენს Google პროექტში?");
      console.warn("[GMap] autocomplete:", e && e.message);
    }
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
      setStatus("ადგილის დეტალები ვერ ჩაიტვირთა");
      console.warn("[GMap] place details:", e && e.message);
    }
  }

  function clearRoute() { S.routeLines.forEach((l) => l.setMap(null)); S.routeLines = []; }
  function resetRoutes() { clearRoute(); S.routes = []; stopNavigation(); const b = $("gmap-card-routes"); if (b) b.textContent = ""; const st = $("gmap-card-start"); if (st) st.hidden = true; }

  function showPlace(p) {
    const loc = p.loc && typeof p.loc.lat === "function" ? { lat: p.loc.lat(), lng: p.loc.lng() } : p.loc;
    if (!loc) return;
    S.place = { name: p.name, address: p.address, loc };
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
    } finally { clearTimeout(timer); }
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
    if (/^google403/.test(code)) return "Google-მა მარშრუტი უარყო: რუკის გასაღებზე (Maps Platform API Key) Routes API უნდა იყოს ჩართული. ნაჩვენებია OSRM მარშრუტი.";
    // the code at the end (e.g. google503:UNAVAILABLE) lets the driver send us the exact reason from the car
    return "Google მარშრუტი ვერ მუშაობს (" + (code || "?") + "), ნაჩვენებია OSRM მარშრუტი ტრაფიკის გარეშე.";
  }

  function drawRoutes() {
    clearRoute();
    const { Polyline } = S.g.maps;
    // alternatives first (grey, under), the chosen one last (white casing + blue)
    S.routes.forEach((rt, i) => {
      if (i === S.routeIdx) return;
      const l = new Polyline({ path: rt.coords, map: S.map, strokeColor: "#8a8f98", strokeOpacity: 0.9, strokeWeight: 6, zIndex: 5, clickable: true });
      l.addListener("click", () => selectRoute(i));
      S.routeLines.push(l);
    });
    const sel = S.routes[S.routeIdx];
    S.routeLines.push(new Polyline({ path: sel.coords, map: S.map, strokeColor: "#ffffff", strokeOpacity: 1, strokeWeight: 10, zIndex: 10 }));
    S.routeLines.push(new Polyline({ path: sel.coords, map: S.map, strokeColor: "#3e6ae1", strokeOpacity: 1, strokeWeight: 6, zIndex: 11 }));
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

  function updateNavBanner() {
    const nav = $("gmap-nav");
    if (!nav) return;
    const rt = S.routes[S.routeIdx];
    if (!S.navigating || !rt || !rt.steps.length) { nav.classList.remove("show"); return; }
    if (S.carPos) S.stepIdx = nextStepIndex(rt.steps, S.carPos, S.stepIdx);
    const st = rt.steps[S.stepIdx];
    const d = S.carPos ? meters(S.carPos, st.loc) : st.distanceM;
    $("gmap-nav-dist").textContent = fmtDist(d);
    $("gmap-nav-text").textContent = st.text;
    if (S.voice) { const t = S.voice.update(S.stepIdx, st, d, window.currentSpeedKmhForLock || 0); if (t) speak(t); }
    nav.classList.add("show");
  }

  function startNavigation() {
    if (!S.routes.length) return;
    S.navigating = true; S.follow = true; S.stepIdx = 0; S.segIdx = 0;
    S.offRouteTracker = createOffRouteTracker({ thresholdM: OFF_ROUTE_M, ticks: 4, cooldownMs: 20000, maxReroutes: 12 });
    S.voice = createVoiceCues();
    prefetchSignals();
    window.__gmapNavigating = true;   // routing.js stays quiet: one voice at a time
    const first = S.routes[S.routeIdx] && S.routes[S.routeIdx].steps[0];
    speak("მარშრუტი დაწყებულია." + (first && first.text ? " " + first.text : ""));
    const layer = $("gmap-layer");
    if (layer) layer.classList.add("navigating");
    document.body.classList.add("gmap-navigating");
    $("gmap-btn-me") && $("gmap-btn-me").classList.add("active");
    $("gmap-card").classList.remove("show");
    S.map.setZoom(17);
    wakeCar();
    updateNavBanner();
  }

  function stopNavigation() {
    S.navigating = false;
    S.offRouteTracker = null;
    S.voice = null;
    if (typeof window !== "undefined") window.__gmapNavigating = false;
    const layer = $("gmap-layer");
    if (layer) layer.classList.remove("navigating");
    if (typeof document !== "undefined") document.body.classList.remove("gmap-navigating");
    const nav = $("gmap-nav");
    if (nav) nav.classList.remove("show");
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
      setStatus(note || "მარშრუტი გადაითვალა");
      setTimeout(() => setStatus(""), 3000);
    } catch (e) {
      console.warn("[GMap] reroute failed:", e && e.message);
    } finally {
      S.rerouting = false;
    }
  }

  async function routeToPlace() {
    if (!S.place) return;
    const btn = $("gmap-card-go"), info = $("gmap-card-route");
    btn.disabled = true;
    info.textContent = "ითვლება...";
    const from = S.carPos || currentCenter();
    const sel = $("gmap-depart");
    const depart = sel ? parseInt(sel.value, 10) || 0 : 0;
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
      $("gmap-card-start").hidden = !routes[0].steps.length;
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
    } catch (e) {
      if (!isCap(e)) setStatus((e && e.message) || "Google რუკა მიუწვდომელია");
    }
  }

  function close() {
    if (!S.open) return;
    S.open = false;
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
    on("gmap-btn-zoom-in", "click", () => S.map && S.map.setZoom(S.map.getZoom() + 1));
    on("gmap-btn-zoom-out", "click", () => S.map && S.map.setZoom(S.map.getZoom() - 1));
    on("gmap-btn-me", "click", () => {
      if (!S.map) return;
      S.follow = true;
      $("gmap-btn-me").classList.add("active");
      wakeCar();   // the glide re-centres (and on the vector map turns heading-up) on its next frame
    });
    on("gmap-btn-traffic", "click", () => {
      S.trafficOn = !S.trafficOn;
      try { localStorage.setItem("gmapTraffic", S.trafficOn ? "1" : "0"); } catch (_) {}
      applyTraffic();
    });
    on("gmap-btn-night", "click", () => { if (window.toggleNightMode) window.toggleNightMode(); syncNight(); });
    on("gmap-btn-vector", "click", () => {
      const keep = (v) => { try { localStorage.setItem("gmapVector", v ? "1" : "0"); } catch (_) {} };
      S.vector = !S.vector;
      keep(S.vector);
      rebuildMap(() => { S.vector = !S.vector; keep(S.vector); updatePanelButtons(); });
      say(S.vector ? "ვექტორული რუკა (სატესტო): მანქანის მიმართულებით ბრუნავს" + (S.mapId ? "" : ", DEMO_MAP_ID") : "კლასიკური რუკა (ჩრდილოეთი ზემოთ)");
    });
    on("gmap-card-close", "click", closeCard);
    on("gmap-card-go", "click", routeToPlace);
    on("gmap-card-start", "click", startNavigation);
    on("gmap-nav-stop", "click", () => { stopNavigation(); const c = $("gmap-card"); if (c && S.place) c.classList.add("show"); });
    const input = $("gmap-search-input");
    if (input) {
      const deb = createDebouncer(suggest, 300);
      input.addEventListener("input", () => { if (input.value.trim().length < 3) { deb.cancel(); clearResults(); } else deb(input.value); });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { deb.cancel(); suggest(input.value); } });
    }
    on("gmap-search-clear", "click", () => { if (input) input.value = ""; clearResults(); closeCard(); });
    // v3.10.56: the side panel holds what the main dock has: ⚡ chargers (was a chip under the search), then the main dock
    // buttons that make sense over the Google map (they click the same main button, so the logic and state stay one).
    const side = document.querySelector(".gmap-side"), closeBtn = $("gmap-btn-close");
    if (side) {
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
      CATEGORIES.forEach((cat) => { const b = add(cat.label.split(" ")[0], cat.label.split(" ").slice(1).join(" ") || cat.label, () => { if (S.map) toggleCategory(cat, b); }); b.dataset.cat = cat.id; });
      SIDE_PROXIES.forEach((p) => {
        const main = $(p.target);
        if (!main) return;
        const b = add(p.icon, p.title, () => { main.click(); mirror(); });
        const mirror = () => {
          const on = !!p.activeClass && main.classList.contains(p.activeClass);
          b.classList.toggle("active", on);
          if (p.iconOff) b.textContent = on ? p.icon : p.iconOff;
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
    try { S.vector = localStorage.getItem("gmapVector") === "1"; } catch (_) { S.vector = false; }
    const btn = $("btn-google-mode");
    if (btn) btn.hidden = !S.enabled;
  }

  const api = { init, open, close, isOpen: () => S.open, isEnabled: () => S.enabled, openWithQuery, openWithDestination, focusPlace, SIDE_PROXIES, mapKey, distToPolylineM, nearestOnPolyline, createOffRouteTracker, createVoiceCues, nearestChargers, createCarGlide, aheadPoint, mapOptions, cameraNeedsUpdate, createFpsMeter, scaledBoxStyle, capText, warnText, decodePolyline, parseRoutesResponse, routesRequestBody, nextStepIndex, fmtDist, buildLoaderUrl, createDebouncer, osrmUrl, summarizeRoute, mapStyles, bearing, meters, CATEGORIES };
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => init());
    else init();
  }
  return api;
});
