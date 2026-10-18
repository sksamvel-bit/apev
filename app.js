/**
 * Tesla Model 3 Navigation - Main Application Controller
 * Enhanced with Live Weather, Battery/Energy calculations, EV Chargers layer,
 * and Multi-Style Map Engine.
 */

// Global State
let map = null;
let carMarker = null;
let destMarker = null;

let mapCamera = null;
let currentMapStyle = "openfreemap";
let currentMapOrientation = "heading-up";
localStorage.setItem("tesla_nav_map_orientation", "heading-up");

let trafficEngine = null;
let trafficSignalsEngine = null;
let routingEngine = null;
let speechAssistant = null;
let weatherEngine = null;
let batteryEngine = null;
let chargersEngine = null;
let speedLimitEngine = null;

// Driving lockout switch (false keeps search unrestricted while driving by user command)
const DRIVING_LOCKOUT = false;
window.DRIVING_LOCKOUT = DRIVING_LOCKOUT;

let currentPos = { lat: 41.7166, lng: 44.7833 }; // Default Tbilisi Freedom Square
window.currentPos = currentPos;
let currentHeading = 0;
let currentSpeedKmh = 0;
let isFollowCar = true;
let wakeLock = null;

// SVG Icons for Turn-by-Turn HUD
const MANEUVER_ICONS = {
  "straight": `<svg viewBox="0 0 24 24"><path d="M12 2L6 8h4v12h4V8h4L12 2z"/></svg>`,
  "turn-left": `<svg viewBox="0 0 24 24"><path d="M9 4L3 10l6 6v-4h6a5 5 0 0 1 5 5v3h4v-3a9 9 0 0 0-9-9H9V4z"/></svg>`,
  "turn-right": `<svg viewBox="0 0 24 24"><path d="M15 4l6 6-6 6v-4H9a5 5 0 0 0-5 5v3H0v-3a9 9 0 0 1 9-9h6V4z"/></svg>`,
  "u-turn": `<svg viewBox="0 0 24 24"><path d="M18 10a6 6 0 0 0-12 0v10h4V10a2 2 0 0 1 4 0v10h4V10z"/><polygon points="3,13 6,20 9,13"/></svg>`,
  "roundabout": `<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.5v-3h-2v3H8l4 4 4-4h-3z"/></svg>`,
  "arrive": `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="#10b981" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="5" fill="#10b981"/></svg>`
};

document.addEventListener("DOMContentLoaded", () => {
  try { initClock(); } catch (e) { console.error("initClock error:", e); }
  try { initMap(); } catch (e) { console.error("initMap error:", e); }
  try { applyNightMode(isNightMode); } catch (e) { console.error("applyNightMode error:", e); }
  try { initSubsystems(); } catch (e) { console.error("initSubsystems error:", e); }
  try { setMapStyle(currentMapStyle, { persist: false }); } catch (e) { console.error("setMapStyle error:", e); }
  try { initEventListeners(); } catch (e) { console.error("initEventListeners error:", e); }
  try { requestWakeLock(); } catch (e) { console.error("requestWakeLock error:", e); }
  try { initGeolocation(); } catch (e) { console.error("initGeolocation error:", e); }
  try { initCompassSensor(); } catch (e) { console.error("initCompassSensor error:", e); }
  try { initRemoteSession(); } catch (e) { console.error("initRemoteSession error:", e); }
  try { restoreActiveRouteState(); } catch (e) { console.error("restoreActiveRouteState error:", e); }
});

// Clean ?key= from browser address bar immediately (prevents leaking in Referer)
try {
  const currentUrl = new URL(window.location.href);
  if (currentUrl.searchParams.has("key")) {
    currentUrl.searchParams.delete("key");
    window.history.replaceState({}, document.title, currentUrl.pathname + (currentUrl.search ? currentUrl.search : "") + currentUrl.hash);
  }
} catch (_) {}

// Automotive Client Error Telemetry -> Server Log
window.addEventListener("error", (event) => {
  try {
    const payload = {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      time: new Date().toISOString()
    };
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/telemetry/error", JSON.stringify(payload));
    }
  } catch (_) {}
});

// Automotive Service Worker for instant reload on Tesla Reverse (R)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      console.log('[SW] ServiceWorker active with scope:', reg.scope);
      // Auto-update check on load
      reg.update().catch(() => {});
    }).catch((err) => {
      console.warn('[SW] Registration failed:', err);
    });
  });
  // When a new Service Worker takes control, reload cleanly so Tesla browser runs the fresh code immediately
  // Never reload while the car is moving (a deploy during a drive must not blank the map), and not on the very first install.
  const hadSwController = !!navigator.serviceWorker.controller;
  let swReloadPending = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadSwController || swReloadPending) return;
    swReloadPending = true;
    const tryReload = () => {
      if ((window.currentSpeedKmhForLock || 0) > 3) { setTimeout(tryReload, 5000); return; }
      window.location.reload();
    };
    tryReload();
  });
}

// Real-time Top Clock (Strict 24-Hour Format)
function initClock() {
  const clockEl = document.getElementById("top-clock");
  const update = () => {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    clockEl.textContent = `${hours}:${minutes}`;
  };
  update();
  setInterval(update, 1000);
}

// ---------------------------------------------------------------------------------------------------------------
// Map (MapLibre GL JS)
//  - "openfreemap": vector tiles (OpenFreeMap, OSM data). Street names follow the roads and are never upside down,
//    point labels stay upright, the map can be rotated (heading-up) and tilted like the Tesla navigation.
//  - "google-roads" / "google-sat": Google raster tiles. Raster tiles have their labels baked in, so on a rotated
//    map those labels rotate with it (that is why the vector map is the default).
// Route line, traffic lights and the TomTom flow layer are registered in layerRegistry (map-gl.js) and re-injected on
// every style switch; chargers and the car/destination pins are DOM markers pinned to the screen.
// ---------------------------------------------------------------------------------------------------------------
const OFM_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const OFM_STYLE_CACHE_KEY = "tesla_nav_ofm_style_v1";
const MAP_STYLE_KEYS = ["openfreemap", "google-roads"];
const APP_VERSION = "3.10.29";
const MAP_DEFAULT_ZOOM = 16;      // MapLibre zoom (Leaflet-equivalent 17)
// Performance experiments (all default to the normal behaviour): ?labels=0 hides the base-map labels/icons, ?markers=0 skips the
// charger DOM markers, ?pitch=N sets the heading-up tilt (0-60). Used to find what makes the car's browser slow.
const PERF = (function () {
  const q = new URLSearchParams(location.search);
  const p = parseFloat(q.get("pitch"));
  // Lite is remembered only for this browser session (sessionStorage): an old permanent flag from earlier versions is wiped,
  // so the full map is the normal start and auto-Lite re-decides after a few slow seconds.
  let stored = null; try { stored = sessionStorage.getItem("lite"); localStorage.removeItem("lite"); } catch (_) {}
  const lq = q.get("lite");   // ?lite=1 forces Lite, ?lite=0 forces the full map (and disables auto-Lite)
  return { labels: q.get("labels") !== "0", markers: q.get("markers") !== "0", pitch: isFinite(p) && p >= 0 && p <= 60 ? p : null,
           lite: lq === "1" || (lq == null && stored === "1"), liteAuto: lq == null };
})();
window.__perf = PERF;
// ?style=mono is a flat map by default (pitch 0); ?pitch=N still overrides
// Look: since v3.10.25 the grey "mono" flat map is the default; ?style=classic = the old coloured map, ?style=tesla = the Tesla palette.
const LOOK_PARAM = (function () {
  try { const st = new URLSearchParams(location.search).get("style"); return st === "classic" || st === "tesla" ? st : "mono"; } catch (_) { return "mono"; }
})();
// Auto-flatten: if the map is still slow after Lite (see the governor in initMap), the tilt is dropped for the rest of the session
let flatStored = false; try { flatStored = sessionStorage.getItem("flat") === "1"; } catch (_) {}
let MAP_HEADING_PITCH = PERF.pitch != null ? PERF.pitch : (flatStored || LOOK_PARAM === "mono" ? 0 : 45);

// "Tesla look" (opt-in, URL only): it is on ONLY while the address contains ?style=tesla. Nothing is remembered, so the plain
// address always shows the original map. (An old remembered flag from v3.10.10-12 is wiped here.)
const TESLA_LOOK = (function () {
  let on = false;
  try {
    localStorage.removeItem("tesla_look");
    on = LOOK_PARAM !== "classic";
    window.__lookMode = on ? LOOK_PARAM : null;
  } catch (_) {}
  return on && !!window.TeslaStyle;
})();
window.__teslaLook = TESLA_LOOK;
window.__night = false;
if (TESLA_LOOK) document.body.classList.add("tesla-look");

const layerRegistry = new window.MapGL.LayerRegistry();
window.layerRegistry = layerRegistry;

function googleRasterStyle(lyrs, id) {
  return {
    version: 8,
    sources: {
      [id]: {
        type: "raster",
        tiles: [0, 1, 2, 3].map(n => `https://mt${n}.google.com/vt/lyrs=${lyrs}&hl=ka&gl=GE&x={x}&y={y}&z={z}`),
        tileSize: 256,
        maxzoom: 20
      }
    },
    layers: [{ id: id + "-layer", type: "raster", source: id }]
  };
}

/** Georgian street/place names first, no 3D buildings (heavy on the Tesla GPU and they hide labels). */
function tuneVectorStyle(style) {
  const out = Object.assign({}, style);
  out.layers = (style.layers || []).map((l) => {
    if (l.id === "building-3d") {
      return Object.assign({}, l, { layout: Object.assign({}, l.layout, { visibility: "none" }) });
    }
    const tf = l.type === "symbol" && l.layout ? l.layout["text-field"] : null;
    if (tf != null) {
      const txt = JSON.stringify(tf);
      if (txt.includes("name:latin") || txt.includes("name_en")) {
        return Object.assign({}, l, {
          layout: Object.assign({}, l.layout, { "text-field": ["coalesce", ["get", "name:ka"], ["get", "name"], ["get", "name_en"]] })
        });
      }
    }
    return l;
  });
  // The Liberty style has no house-number layer although the tiles carry the data: add one (zoom 17+, small, no collisions with names).
  if (!out.layers.some((l) => l["source-layer"] === "housenumber") && out.sources && out.sources.openmaptiles) {
    const ref = out.layers.find((l) => l.type === "symbol" && l.layout && l.layout["text-font"] && l["source-layer"] === "transportation_name") ||
                out.layers.find((l) => l.type === "symbol" && l.layout && l.layout["text-font"]);
    out.layers.push({
      // minzoom 16 = the car's default zoom (MAP_DEFAULT_ZOOM); with 17 the numbers never showed unless the driver zoomed in.
      // They are hidden while driving (see the speed watcher in initMap) because placing them costs CPU on the Atom.
      id: "housenumber", type: "symbol", source: "openmaptiles", "source-layer": "housenumber", minzoom: 16,
      layout: { "text-field": ["get", "housenumber"], "text-font": ref ? ref.layout["text-font"] : ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 16, 11, 18, 14] },
      paint: { "text-color": "#3f4650", "text-halo-color": "#ffffff", "text-halo-width": 1.5 }
    });
  }
  return out;
}

function teslaLook(style) { return TESLA_LOOK ? window.TeslaStyle.apply(style, window.__night, window.__lookMode) : style; }

async function loadStyleJson(styleKey) {
  if (styleKey === "google-roads") return googleRasterStyle("m", "google-roads");
  if (styleKey === "google-sat") return googleRasterStyle("y", "google-sat");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(OFM_STYLE_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    try { localStorage.setItem(OFM_STYLE_CACHE_KEY, JSON.stringify(json)); } catch (_) {}
    window.__teslaBase = tuneVectorStyle(json);
    return teslaLook(window.__teslaBase);
  } catch (err) {
    // style server slow/unreachable: use the last good copy (the tiles themselves may still come from the browser cache)
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(OFM_STYLE_CACHE_KEY)); } catch (_) {}
    if (cached && cached.layers) { window.__teslaBase = tuneVectorStyle(cached); return teslaLook(window.__teslaBase); }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Vector map health: when the style or its tiles cannot be loaded at all, fall back to Google tiles.
const vectorHealth = { active: false, errors: 0, tilesOk: false };
let styleRequestToken = 0;

async function applyMapStyle(styleKey) {
  if (!map) return;
  const token = ++styleRequestToken;
  vectorHealth.active = styleKey === "openfreemap";
  vectorHealth.errors = 0;
  vectorHealth.tilesOk = false;
  let style;
  try {
    style = await loadStyleJson(styleKey);
  } catch (err) {
    console.warn("[Map] style load failed:", styleKey, err && err.message);
    if (styleKey === "openfreemap") fallbackToGoogleRoads("მიუწვდომელია");
    return;
  }
  if (token !== styleRequestToken || !map) return;   // a newer style request replaced this one
  map.setStyle(layerRegistry.inject(style), { diff: false });
}

function fallbackToGoogleRoads(reason) {
  if (currentMapStyle !== "openfreemap") return;
  showToast(`⚠️ ვექტორული რუკა ${reason} — დროებით Google რუკაზე გადავედი`, "error", 5000);
  setMapStyle("google-roads", { persist: false });
}

function initMap() {
  const saved = localStorage.getItem("tesla_nav_map_style");
  // Only the vector map is offered in the menu; Google raster is an emergency fallback (never restored from storage)
  currentMapStyle = "openfreemap";

  if (typeof maplibregl === "undefined") {
    console.error("MapLibre GL JS not loaded");
    const mapEl = document.getElementById("map");
    if (mapEl) {
      mapEl.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:#f1f5f9; text-align:center; padding:20px;">
          <div style="font-size:2rem; margin-bottom:12px;">🗺️</div>
          <div style="font-size:1.2rem; font-weight:700; margin-bottom:8px;">რუკის ძრავის ჩატვირთვა ვერ მოხერხდა</div>
          <div style="font-size:0.9rem; color:#94a3b8; margin-bottom:20px; max-width:400px;">გთხოვთ დააჭიროთ განახლებას (Ctrl + Shift + R ან ქვედა ღილაკი)</div>
          <button onclick="if('caches' in window){caches.keys().then(k=>Promise.all(k.map(n=>caches.delete(n)))).then(()=>location.reload(true))}else{location.reload(true)}" style="background:#e82127; color:#fff; border:none; border-radius:10px; padding:12px 24px; font-size:1rem; font-weight:600; cursor:pointer;">
            🔄 რუკის განახლება
          </button>
        </div>
      `;
    }
    return;
  }

  const headingUp = currentMapOrientation === "heading-up";
  map = new maplibregl.Map({
    container: "map",
    style: { version: 8, sources: {}, layers: [] },   // the real style is applied by setMapStyle() once the layers are registered
    center: [currentPos.lng, currentPos.lat],
    zoom: MAP_DEFAULT_ZOOM,
    pitch: headingUp ? MAP_HEADING_PITCH : 0,
    bearing: headingUp ? lastKnownValidHeading : 0,
    maxPitch: 60,
    attributionControl: false,
    antialias: false,               // saves GPU on the Tesla MCU
    fadeDuration: 0,
    crossSourceCollisions: false,
    dragRotate: false,              // car screen: an accidental rotate/pitch must never take the camera away from the car
    pitchWithRotate: false,
    touchPitch: false,
    clickTolerance: 12,             // touch jitter below 12 px is a tap, not a drag
    pixelRatio: (function () { const q = parseFloat(new URLSearchParams(location.search).get('dpr')); return q > 0 ? q : Math.min(window.devicePixelRatio || 1, 1.25); })()   // ?dpr=1 for perf experiments
  });
  window.map = map;
  if (!PERF.labels) {
    const hideLabels = () => {
      try {
        map.getStyle().layers.forEach((l) => {
          if (l.type === "symbol" && l.source === "openmaptiles" && !(l.layout && l.layout.visibility === "none")) map.setLayoutProperty(l.id, "visibility", "none");
        });
      } catch (_) {}
    };
    map.on("styledata", hideLabels);
  }
  window.__renderCount = 0;
  map.on("render", () => { window.__renderCount++; });

  // Lite mode: hide minor labels/icons (the main cost on the car's CPU). Re-applied after every style change.
  const liteHidden = new Set();
  const applyLite = () => {
    try {
      if (!PERF.lite) return;
      window.MapGL.pickLiteHidden(map.getStyle().layers, "openmaptiles").forEach((id) => {
        if (map.getLayoutProperty(id, "visibility") !== "none") { liteHidden.add(id); map.setLayoutProperty(id, "visibility", "none"); }
      });
    } catch (_) {}
  };
  window.__setLite = (on, persist) => {
    PERF.lite = !!on;
    if (persist) { try { sessionStorage.setItem("lite", on ? "1" : "0"); } catch (_) {} }
    try { hnOn = null; } catch (_) {}
    if (on) applyLite();
    else { detailOn = false; liteHidden.forEach((id) => { try { map.setLayoutProperty(id, "visibility", "visible"); } catch (_) {} }); liteHidden.clear(); }
  };
  // While the car stands (speed < 3 km/h for 2 s) house numbers and minor street names come back; they hide again when moving.
  let detailOn = false, stillSince = 0;
  const setDetail = (on) => {
    if (on === detailOn || !PERF.lite) return;
    detailOn = on;
    try {
      // House numbers are NOT toggled here: they follow the speed watcher below (shown while crawling, not only when standing).
      window.MapGL.pickLiteDetail(map.getStyle().layers, "openmaptiles").filter((id) => id !== "housenumber")
        .forEach((id) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
    } catch (_) {}
  };
  setInterval(() => {
    if (!PERF.lite) return;
    if (currentSpeedKmh < 3) { if (!stillSince) stillSince = Date.now(); if (Date.now() - stillSince > 2000) setDetail(true); }
    else { stillSince = 0; setDetail(false); }
  }, 500);
  map.on("styledata", () => { applyLite(); if (detailOn) { detailOn = false; setDetail(true); } hnOn = null; });
  // House numbers, both modes: shown while the car crawls/stands, hidden while driving. Normal mode: on < 15 km/h, off > 25.
  // Lite (the car's usual mode, placing labels costs CPU on the Atom): on < 12 km/h, off > 20. (Before v3.10.29 Lite showed them only at a stand-still.)
  let hnOn = null;
  setInterval(() => {
    const onBelow = PERF.lite ? 12 : 15, offAbove = PERF.lite ? 20 : 25;
    const want = hnOn === false ? currentSpeedKmh < onBelow : currentSpeedKmh <= offAbove;
    if (want === hnOn) return;
    hnOn = want;
    try { if (map.getLayer("housenumber")) map.setLayoutProperty("housenumber", "visibility", want ? "visible" : "none"); } catch (_) { hnOn = null; }
  }, 700);
  if (PERF.liteAuto && !PERF.lite) {
    const gov = new window.MapGL.LiteGovernor({ minFps: 6, need: 5 });
    let lastCount = 0, lastT = performance.now();
    setInterval(() => {
      const now = performance.now(), fps = (window.__renderCount - lastCount) * 1000 / (now - lastT);
      lastCount = window.__renderCount; lastT = now;
      if (gov.sample(fps, currentSpeedKmh > 3)) window.__setLite(true, true);
    }, 1000);
  }
  // Stage 2 (no driver action needed): Lite is on and the map is still below 8 fps for 8 moving seconds -> flat map (pitch 0).
  if (PERF.liteAuto && PERF.pitch == null && MAP_HEADING_PITCH > 0) {
    const gov2 = new window.MapGL.LiteGovernor({ minFps: 8, need: 8 });
    let c2 = 0, t2 = performance.now();
    const iv2 = setInterval(() => {
      const now = performance.now(), fps = (window.__renderCount - c2) * 1000 / (now - t2);
      c2 = window.__renderCount; t2 = now;
      if (!PERF.lite) return;   // only after stage 1
      if (gov2.sample(fps, currentSpeedKmh > 3)) {
        clearInterval(iv2);
        MAP_HEADING_PITCH = 0;
        try { sessionStorage.setItem("flat", "1"); } catch (_) {}
        try { if (mapCamera) { mapCamera.headingPitch = 0; if (typeof mapCamera.recenter === "function") mapCamera.recenter(currentPos, lastKnownValidHeading || currentHeading || 0, 0); } } catch (_) {}
      }
    }, 1000);
  }

  // zoom around the screen centre so a pinch/scroll never fights the follow camera
  try {
    map.scrollZoom.enable({ around: "center" });
    map.touchZoomRotate.enable({ around: "center" });
    map.touchZoomRotate.disableRotation();
  } catch (_) {}

  map.on("click", (e) => {
    const t = e.originalEvent && e.originalEvent.target;
    if (t && t.closest && t.closest(".maplibregl-marker, .maplibregl-popup")) return;   // a pin was tapped, not the map
    if (trafficSignalsEngine && trafficSignalsEngine.handleClick(e)) return;
    handleMapClick({ lat: e.lngLat.lat, lng: e.lngLat.lng });
  });

  // Only genuine gestures of the driver switch to manual mode (programmatic camera moves have no originalEvent and pass followCamera: true)
  map.on("dragstart", (e) => { if (e && e.originalEvent) { setFollowCarMode(false); scheduleFollowResume(); } });
  map.on("dragend", (e) => { if (e && e.originalEvent) scheduleFollowResume(); });
  const manualGesture = (e) => {
    if (e && e.originalEvent && !e.followCamera && currentMapOrientation !== "manual") {
      setMapOrientation("manual");
      setFollowCarMode(false);
      scheduleFollowResume();
    }
  };
  map.on("rotatestart", manualGesture);
  map.on("pitchstart", manualGesture);

  map.on("rotate", () => {
    const needleEl = document.getElementById("compass-needle-svg");
    if (needleEl) needleEl.style.transform = `rotate(${-map.getBearing()}deg)`;
  });

  // vector map health (see fallbackToGoogleRoads)
  map.on("sourcedata", (e) => { if (e.sourceId === "openmaptiles" && e.tile) vectorHealth.tilesOk = true; });
  map.on("error", (e) => {
    if (!vectorHealth.active || vectorHealth.tilesOk || currentMapStyle !== "openfreemap") return;
    const msg = String((e && e.error && (e.error.url || e.error.message)) || "");
    if (e.sourceId === "openmaptiles" || msg.includes("openfreemap")) {
      vectorHealth.errors++;
      if (vectorHealth.errors >= 6) { vectorHealth.active = false; fallbackToGoogleRoads("ვერ ჩაიტვირთა"); }
    }
  });

  createVehiclePuck();

  mapCamera = new window.MapGL.FollowCamera(map, { headingPitch: MAP_HEADING_PITCH, onFrame: onCameraFrame });
  mapCamera.setMode(currentMapOrientation);
  mapCamera.setFix({ lng: currentPos.lng, lat: currentPos.lat, headingDeg: lastKnownValidHeading || currentHeading || 0, speedMs: 0 });
  window.mapCamera = mapCamera;
  // a route preview (fitBounds) must not be pulled back to the car, and our follow padding must not add to its padding
  window.onBeforeRouteFit = () => { setFollowCarMode(false); mapCamera.clearPadding(); };

  updateOrientationUI();
}

// After the driver pans the map and lets go, the camera returns to the car by itself (Waze/Google behaviour).
// Not while a route preview is open (the driver is looking at the whole route).
const FOLLOW_RESUME_MS = 8000;
let followResumeTimer = null;
function scheduleFollowResume() {
  clearTimeout(followResumeTimer);
  followResumeTimer = setTimeout(() => {
    followResumeTimer = null;
    if (!isFollowCar && !pendingDestination) recenterOnCar();
  }, FOLLOW_RESUME_MS);
}

function createVehiclePuck() {
  const carEl = document.createElement("div");
  carEl.className = "tesla-car-marker-container";
  carEl.style.cursor = "pointer";
  carEl.title = "მანქანის ცენტრირება";
  carEl.addEventListener("click", (e) => {
    e.stopPropagation();
    recenterOnCar();
  });
  carEl.innerHTML = `
    <div class="car-heading-cone" id="car-cone"></div>
    <svg class="tesla-car-icon-body nav-arrow-body" id="car-svg-icon" viewBox="0 0 36 36" width="36" height="36">
      <defs>
        <linearGradient id="navArrowGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#ff473a"/>
          <stop offset="100%" stop-color="#cc1a1a"/>
        </linearGradient>
      </defs>
      <path d="M18 3.5 L31.5 30 L18 23.5 L4.5 30 Z"
            fill="url(#navArrowGrad)"
            stroke="#ffffff"
            stroke-width="2.6"
            stroke-linejoin="round"
            stroke-linecap="round"/>
    </svg>
  `;

  carMarker = new maplibregl.Marker({
    element: carEl,
    anchor: "center",
    rotationAlignment: "viewport",
    pitchAlignment: "viewport"
  })
    .setLngLat([currentPos.lng, currentPos.lat])
    .addTo(map);

  window.carMarker = carMarker;
}

/** Called by the follow camera every frame: moves the car pin and turns the arrow. */
function onCameraFrame(f) {
  if (!carMarker) return;
  carMarker.setLngLat([f.lng, f.lat]);
  if (!cachedCarIconEl || !cachedCarIconEl.isConnected) {
    const el = carMarker.getElement();
    cachedCarIconEl = el ? el.querySelector(".tesla-car-icon-body") : null;
  }
  if (!cachedCarIconEl) return;
  const heading = f.headingDeg != null && isFinite(f.headingDeg) ? f.headingDeg : continuousHeading;
  let rot;
  if (currentMapOrientation === "heading-up") rot = window.MapGL.shortestDelta(heading, f.bearing);   // road ahead is UP
  else if (currentMapOrientation === "north-up") rot = window.MapGL.normDeg(heading);
  else rot = window.MapGL.shortestDelta(heading, map.getBearing());
  cachedCarIconEl.style.transform = `rotate(${rot.toFixed(1)}deg)`;
}

function createDestMarker(lngLat) {
  const wrap = document.createElement("div");
  wrap.className = "dest-marker-wrap";
  wrap.innerHTML = `
    <div class="dest-custom-icon">
      <svg viewBox="0 0 24 24" width="38" height="38" fill="#e82127" style="filter: drop-shadow(0 3px 6px rgba(0,0,0,0.6));">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
      </svg>
    </div>`;
  return new maplibregl.Marker({ element: wrap, anchor: "bottom", rotationAlignment: "viewport", pitchAlignment: "viewport" })
    .setLngLat(lngLat);
}

function removeDestMarker() {
  if (destMarker) {
    destMarker.remove();
    destMarker = null;
  }
}

function setMapOrientation(mode) {
  currentMapOrientation = mode;
  try { localStorage.setItem("tesla_nav_map_orientation", mode); } catch (_) {}
  if (mapCamera) { mapCamera.syncFromMap(); mapCamera.setMode(mode); }
  updateOrientationUI();
}

// Map Style Switcher: OpenFreeMap (vector), Google Roads, Google Satellite
function setMapStyle(styleKey, opts = {}) {
  if (!MAP_STYLE_KEYS.includes(styleKey)) styleKey = "openfreemap";
  currentMapStyle = styleKey;
  if (opts.persist !== false) localStorage.setItem("tesla_nav_map_style", styleKey);

  applyMapStyle(styleKey);

  document.body.classList.remove("map-style-openfreemap", "map-style-google-roads", "map-style-google-sat");
  document.body.classList.add(`map-style-${styleKey}`);
  document.querySelectorAll(".map-style-opt").forEach(opt => {
    opt.classList.toggle("active", opt.dataset.style === styleKey);
  });
}

// Global Night Mode (1-Click Dark/Light Toggle for ALL maps)
// Default to Day Mode (clean, authentic Google Maps daylight appearance)
let isNightMode = false;
localStorage.setItem("tesla_nav_night_mode", "false");

function toggleNightMode() {
  applyNightMode(!isNightMode);
  showToast(isNightMode ? "🌙 ღამის რეჟიმი ჩართულია" : "☀️ დღის რეჟიმი ჩართულია", "info", 1800);
}

function applyNightMode(enable) {
  const nightChanged = isNightMode !== enable;
  isNightMode = enable;
  window.__night = enable;
  localStorage.setItem("tesla_nav_night_mode", isNightMode ? "true" : "false");
  // Tesla look has its own dark palette: rebuild the style instead of filtering the canvas
  // (patched in place: a full setStyle rebuild blanks the map and freezes the car's browser)
  if (TESLA_LOOK && nightChanged && map && currentMapStyle === "openfreemap") {
    let patched = false;
    try {
      if (window.__teslaBase && map.isStyleLoaded()) {
        for (const c of window.TeslaStyle.diff(window.__teslaBase, !enable, enable, window.__lookMode)) {
          if (map.getLayer(c.id)) map.setPaintProperty(c.id, c.prop, c.value);
        }
        patched = true;
      }
    } catch (e) { console.warn("night paint patch failed, rebuilding:", e); }
    if (!patched) applyMapStyle(currentMapStyle);
  }
  document.body.classList.toggle("night-mode-active", isNightMode);

  const btnNight = document.getElementById("btn-toggle-night");
  const iconSvg = document.getElementById("night-icon-svg");
  const tooltipText = document.getElementById("night-tooltip-text");

  if (btnNight) {
    btnNight.classList.toggle("night-active", isNightMode);
  }
  if (tooltipText) {
    tooltipText.textContent = isNightMode ? "დღის რეჟიმი" : "ღამის რეჟიმი";
  }
  if (iconSvg) {
    if (isNightMode) {
      iconSvg.setAttribute("fill", "none");
      iconSvg.innerHTML = `
        <circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2" fill="currentColor"/>
        <line x1="12" y1="1" x2="12" y2="3" stroke="currentColor" stroke-width="2"/>
        <line x1="12" y1="21" x2="12" y2="23" stroke="currentColor" stroke-width="2"/>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" stroke="currentColor" stroke-width="2"/>
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" stroke="currentColor" stroke-width="2"/>
        <line x1="1" y1="12" x2="3" y2="12" stroke="currentColor" stroke-width="2"/>
        <line x1="21" y1="12" x2="23" y2="12" stroke="currentColor" stroke-width="2"/>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" stroke="currentColor" stroke-width="2"/>
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" stroke="currentColor" stroke-width="2"/>
      `;
    } else {
      iconSvg.setAttribute("fill", "currentColor");
      iconSvg.innerHTML = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`;
    }
  }
}

function initSubsystems() {
  try { speechAssistant = new SpeechAssistant(); window.speechAssistant = speechAssistant; } catch (e) { console.warn("speechAssistant init notice:", e); }
  try { batteryEngine = new BatteryEngine(); window.batteryEngine = batteryEngine; } catch (e) { console.warn("batteryEngine init notice:", e); }
  try { weatherEngine = new WeatherEngine(); window.weatherEngine = weatherEngine; } catch (e) { console.warn("weatherEngine init notice:", e); }
  try { trafficSignalsEngine = new TrafficSignalsEngine(map, true); window.trafficSignalsEngine = trafficSignalsEngine; } catch (e) { console.warn("trafficSignalsEngine init notice:", e); }
  try { trafficEngine = new TrafficEngine(map, true); window.trafficEngine = trafficEngine; } catch (e) { console.warn("trafficEngine init notice:", e); }
  try {
    chargersEngine = new ChargersEngine(map, (chargerData) => {
      prepareRoutePreview(chargerData, chargerData.name || "EV დამტენი სადგური", chargerData.address || "ელექტრომობილის დამტენი");
    }, false);   // map markers are OFF by default: chargers live in the list drawer (dock button); the bolt button still shows them on the map
    window.chargersEngine = chargersEngine;
  } catch (e) { console.warn("chargersEngine init notice:", e); }

  try {
    routingEngine = new RoutingEngine(map, trafficEngine, trafficSignalsEngine, speechAssistant, batteryEngine);
    const avoidUnpavedSaved = localStorage.getItem("avoid_unpaved") === "true";
    routingEngine.setAvoidUnpaved(avoidUnpavedSaved);
    window.routingEngine = routingEngine;
  } catch (e) { console.warn("routingEngine init notice:", e); }

  try {
    speedLimitEngine = new SpeedLimitEngine(routingEngine);
    window.speedLimitEngine = speedLimitEngine;
    speedLimitEngine.update(currentPos.lat, currentPos.lng, currentSpeedKmh);
  } catch (e) { console.warn("speedLimitEngine init notice:", e); }

  // Initial battery stats render
  if (batteryEngine) {
    updateBatteryUI(batteryEngine.getStats());
    batteryEngine.onBatteryChange = (stats) => updateBatteryUI(stats);
  }

  // Cached DOM elements & dirty-checking states for 60 FPS HUD rendering
  const navHudEl = document.getElementById("nav-hud");
  const maneuverDistEl = document.getElementById("maneuver-dist");
  const maneuverInstEl = document.getElementById("maneuver-instruction");
  const maneuverStreetEl = document.getElementById("maneuver-street");
  const maneuverIconEl = document.getElementById("maneuver-icon-container");
  const laneContainer = document.getElementById("hud-lane-guidance");

  const lastManeuverState = {
    dist: "",
    instruction: "",
    street: "",
    icon: "",
    lanesKey: ""
  };

  const summaryDistEl = document.getElementById("summary-dist");
  const summaryTimeEl = document.getElementById("summary-time");
  const summaryEtaEl = document.getElementById("summary-eta");
  const bRow = document.getElementById("hud-battery-row");
  const kwhEl = document.getElementById("hud-battery-kwh");
  const arrivalEl = document.getElementById("hud-battery-arrival");

  const lastSummaryState = {
    dist: "",
    time: "",
    eta: "",
    batteryKey: ""
  };

  // Setup Routing Engine Callbacks
  routingEngine.onManeuverUpdate = (data) => {
    if (navHudEl && !navHudEl.classList.contains("active")) {
      navHudEl.classList.add("active");
    }
    if (data.distanceStr !== lastManeuverState.dist && maneuverDistEl) {
      maneuverDistEl.textContent = data.distanceStr;
      lastManeuverState.dist = data.distanceStr;
    }
    if (data.instruction !== lastManeuverState.instruction && maneuverInstEl) {
      maneuverInstEl.textContent = data.instruction;
      lastManeuverState.instruction = data.instruction;
    }
    if (data.streetName !== lastManeuverState.street && maneuverStreetEl) {
      maneuverStreetEl.textContent = data.streetName;
      lastManeuverState.street = data.streetName;
    }
    if (data.icon !== lastManeuverState.icon && maneuverIconEl) {
      maneuverIconEl.innerHTML = MANEUVER_ICONS[data.icon] || MANEUVER_ICONS["straight"];
      lastManeuverState.icon = data.icon;
    }

    // Render Lane Guidance with dirty check
    if (laneContainer) {
      const lanesKey = JSON.stringify(data.lanes || []);
      if (lanesKey !== lastManeuverState.lanesKey) {
        lastManeuverState.lanesKey = lanesKey;
        if (data.lanes && data.lanes.length > 0) {
          laneContainer.style.display = "flex";
          laneContainer.innerHTML = data.lanes.map(l =>
            `<div class="lane-arrow ${l.recommended ? 'recommended' : ''}">${l.arrow}</div>`
          ).join("");
        } else {
          laneContainer.style.display = "none";
        }
      }
    }
  };

  routingEngine.onRouteSelected = (route) => {
    // The user tapped another route in the preview: refresh the card numbers
    if (pendingDestination) fillPreviewCard(route, pendingDestination.title, pendingDestination.address);
  };
  routingEngine.onSummaryUpdate = (summary) => {
    const distStr = `${summary.distanceKm} კმ`;
    const timeStr = `${summary.durationMin} წთ`;
    if (distStr !== lastSummaryState.dist && summaryDistEl) {
      summaryDistEl.textContent = distStr;
      lastSummaryState.dist = distStr;
    }
    if (timeStr !== lastSummaryState.time && summaryTimeEl) {
      summaryTimeEl.textContent = timeStr;
      lastSummaryState.time = timeStr;
    }
    if (summary.etaStr !== lastSummaryState.eta && summaryEtaEl) {
      summaryEtaEl.textContent = summary.etaStr;
      lastSummaryState.eta = summary.etaStr;
    }

    // Update Battery Consumption & Arrival SoC with dirty check
    if (summary.batteryImpact) {
      const bKey = `${summary.batteryImpact.energyKwh}_${summary.batteryImpact.arrivalSoC}_${summary.batteryImpact.status}`;
      if (bKey !== lastSummaryState.batteryKey) {
        lastSummaryState.batteryKey = bKey;
        if (bRow) {
          bRow.style.display = "flex";
          bRow.className = `hud-battery-row ${summary.batteryImpact.status}`;
        }
        if (kwhEl) kwhEl.textContent = `⚡ ~${summary.batteryImpact.energyKwh} kWh`;
        if (arrivalEl) arrivalEl.textContent = `🔋 ჩასვლა: ~${summary.batteryImpact.arrivalSoC}% (შეფასება)`;
      }
    }
  };

  routingEngine.onPositionUpdate = (state) => {
    updateVehicleMarker(state.pos.lat, state.pos.lng, state.heading, state.speed);

    // Save active route state for auto-resume
    if (routingEngine && routingEngine.activeRoute) {
      saveActiveRouteState(routingEngine.activeRoute.destination, routingEngine.activeRoute.destName);
    }

    // Traffic signal alert banner
    const alertBanner = document.getElementById("traffic-signal-alert");
    if (state.signalAhead) {
      alertBanner.classList.add("active");
      document.getElementById("signal-alert-text").textContent = `🚦 შუქნიშანი ${state.signalAhead.distanceMeters} მეტრში`;
    } else {
      alertBanner.classList.remove("active");
    }
  };

  routingEngine.onArrival = () => {
    clearActiveRouteState();
    document.getElementById("maneuver-instruction").textContent = "მიხვედით დანიშნულების ადგილზე!";
    document.getElementById("maneuver-dist").textContent = "0 მ";
    document.getElementById("maneuver-icon-container").innerHTML = MANEUVER_ICONS["arrive"];
    setTimeout(() => {
      cancelNavigation();
    }, 8000);
  };
}

// Update Top Battery Chip UI
function updateBatteryUI(stats) {
  const socEl = document.getElementById("top-battery-soc");
  const rangeEl = document.getElementById("top-battery-range");
  // AUDIT FIX: SoC is manually entered (not read from the car) -> label as such
  if (socEl) socEl.textContent = `${stats.currentSoC}% ✎`;
  if (rangeEl) rangeEl.textContent = `≈${stats.remainingRangeKm} კმ`;
}

// Geolocation GPS & Live Weather Fetch
function initGeolocation() {
  if (!navigator.geolocation) {
    console.warn("Geolocation not supported by browser");
    fetchWeatherForPos(currentPos.lat, currentPos.lng);
    return;
  }

  const gpsBadge = document.getElementById("gps-status-dot");

  navigator.geolocation.watchPosition(
    (position) => {
      gpsBadge.classList.remove("simulated");
      const coords = position.coords;
      const lat = coords.latitude;
      const lng = coords.longitude;
      const now = performance.now();

      let speed = (typeof coords.speed === "number" && !isNaN(coords.speed) && coords.speed !== null)
        ? Math.round(coords.speed * 3.6)
        : null;

      // Fallback: derive speed from GPS displacement over time if browser didn't supply speed
      if (speed === null && lastGpsPos && lastGpsTime > 0) {
        const dt = (now - lastGpsTime) / 1000;
        if (dt >= 0.4 && dt <= 10) {
          const dM = routingEngine ? routingEngine.haversineMeters(lastGpsPos.lat, lastGpsPos.lng, lat, lng) : 0;
          speed = Math.round((dM / dt) * 3.6);
        } else {
          speed = 0;
        }
      } else if (speed === null) {
        speed = 0;
      }

      const rawHeading = (typeof coords.heading === "number" && isFinite(coords.heading) && coords.heading !== null)
        ? coords.heading
        : null;

      currentPos = { lat, lng };
      currentSpeedKmh = speed;
      try { const d = (window.__dbg = window.__dbg || { fixes: [] }); d.fixes.push({ t: Date.now(), lat, lng, acc: coords.accuracy, spd: coords.speed, hdg: coords.heading }); if (d.fixes.length > 40) d.fixes.shift(); } catch (_) {}

      updateVehicleMarker(lat, lng, rawHeading, speed, coords.accuracy);
      fetchWeatherForPos(lat, lng);

      if (routingEngine && routingEngine.isNavigating) {
        const signalAhead = routingEngine.updateVehiclePosition(currentPos, speed, currentHeading);
        const alertBanner = document.getElementById("traffic-signal-alert");
        if (signalAhead) {
          alertBanner.classList.add("active");
          document.getElementById("signal-alert-text").textContent = `🚦 შუქნიშანი ${signalAhead.distanceMeters} მეტრში`;
        } else {
          alertBanner.classList.remove("active");
        }
      }
    },
    (err) => {
      console.warn("GPS watch position notice:", err.message);
      gpsBadge.classList.add("simulated");
      fetchWeatherForPos(currentPos.lat, currentPos.lng);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 10000
    }
  );
}

async function fetchWeatherForPos(lat, lng) {
  if (!weatherEngine) return;
  const data = await weatherEngine.fetchWeather(lat, lng);
  if (data) {
    document.getElementById("weather-icon").textContent = data.icon;
    document.getElementById("weather-temp").textContent = `${data.temp}°C`;
  }
}

// DOM element caches & dirty-checking state for vehicle updates
let lastRenderedSpeed = -1;
let lastRenderedHeading = -999;
let cachedSpeedValEl = null;
let cachedCarIconEl = null;
let lastGpsPos = null;
let lastGpsTime = 0;
let lastHeadingFixPos = null;
let lastKnownValidHeading = (() => {
  const saved = parseFloat(localStorage.getItem("tesla_nav_saved_heading"));
  return (isFinite(saved) && saved >= 0 && saved <= 360) ? saved : 0;
})();
let continuousHeading = lastKnownValidHeading; // Continuous rotation angle (prevents 359->0 360-spin glitch)
let stationaryCompassHeading = null; // Stationary device compass heading (deviceorientation)
const smoothedVelocityVector = { vx: 0, vy: 0, initialized: false };

function calculateBearing(lat1, lon1, lat2, lon2) {
  const toRad = deg => (deg * Math.PI) / 180;
  const toDeg = rad => (rad * 180) / Math.PI;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  let brng = toDeg(Math.atan2(y, x));
  return (brng + 360) % 360;
}

function shortestAngleDiff(targetDeg, currentDeg) {
  let diff = (targetDeg - currentDeg) % 360;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

function updateVehicleMarker(lat, lng, headingDeg, speedKmh, accuracyMeters = null) {
  const now = performance.now();

  // GPS Jitter & Impossible Jump Filter (TMap standard)
  if (lastGpsPos && lastGpsTime > 0) {
    const dt = Math.max(0.2, (now - lastGpsTime) / 1000);
    const dMeters = routingEngine ? routingEngine.haversineMeters(lastGpsPos.lat, lastGpsPos.lng, lat, lng) : 0;
    // If impossible speed (> 270 km/h) or crazy glitch, apply heavy smoothing
    if (dMeters / dt > 75 && dMeters > 50) {
      lat = lastGpsPos.lat * 0.85 + lat * 0.15;
      lng = lastGpsPos.lng * 0.85 + lng * 0.15;
    } else if (dMeters > 0.4) {
      // Gentle smoothing for clean motion (80% new, 20% previous)
      lat = lastGpsPos.lat * 0.20 + lat * 0.80;
      lng = lastGpsPos.lng * 0.20 + lng * 0.80;
    }
  }

  // --- AUTOMOTIVE HEADING & COURSE OVER GROUND (COG) DETERMINATION ---
  const dFromLastGps = (lastGpsPos && routingEngine)
    ? routingEngine.haversineMeters(lastGpsPos.lat, lastGpsPos.lng, lat, lng)
    : 0;
  const isMoving = speedKmh >= 3.5 || dFromLastGps >= 1.8;
  let targetHeading = null;

  // PRIORITY 1: Hardware GNSS Doppler / Gyro Heading
  // In Tesla's Chromium browser or modern smartphones, coords.heading provides
  // satellite Doppler carrier-phase heading with 0.1-0.5 deg precision (zero position jitter).
  const hasHardwareHeading = typeof headingDeg === "number" && isFinite(headingDeg) && headingDeg !== null &&
                             headingDeg >= 0 && headingDeg <= 360;

  if (hasHardwareHeading) {
    // Hardware Doppler or vehicle gyro heading is highly accurate whether moving or stationary!
    targetHeading = headingDeg;
  } else if (isMoving) {
    // PRIORITY 2: Exponentially Smoothed Velocity Vector (EMA)
    // When hardware heading is null/unavailable, filter (vx, vy) displacement
    // rather than computing noisy point-to-point bearing over short distances.
    if (lastGpsPos && lastGpsTime > 0) {
      const dt = Math.max(0.2, Math.min(3.0, (now - lastGpsTime) / 1000));
      const radLat = lat * (Math.PI / 180);
      const kx = 111320 * Math.cos(radLat);
      const ky = 110540;
      const instVx = ((lng - lastGpsPos.lng) * kx) / dt;
      const instVy = ((lat - lastGpsPos.lat) * ky) / dt;
      const instSpeedMps = Math.hypot(instVx, instVy);

      if (instSpeedMps >= 0.8) { // moving at least ~3 km/h
        if (!smoothedVelocityVector.initialized) {
          smoothedVelocityVector.vx = instVx;
          smoothedVelocityVector.vy = instVy;
          smoothedVelocityVector.initialized = true;
        } else {
          // EMA filter: cancels zero-mean lateral GPS noise while tracking forward travel
          smoothedVelocityVector.vx = smoothedVelocityVector.vx * 0.65 + instVx * 0.35;
          smoothedVelocityVector.vy = smoothedVelocityVector.vy * 0.65 + instVy * 0.35;
        }
        targetHeading = (Math.atan2(smoothedVelocityVector.vx, smoothedVelocityVector.vy) * 180 / Math.PI + 360) % 360;
      }
    }

    // Fallback: if smoothed vector still not ready, check displacement over >= 6 meters
    if (targetHeading === null) {
      if (!lastHeadingFixPos) {
        lastHeadingFixPos = { lat, lng, time: now };
      } else {
        const dMetersFromFix = routingEngine
          ? routingEngine.haversineMeters(lastHeadingFixPos.lat, lastHeadingFixPos.lng, lat, lng)
          : 0;
        if (dMetersFromFix >= 6.0) {
          targetHeading = calculateBearing(lastHeadingFixPos.lat, lastHeadingFixPos.lng, lat, lng);
          lastHeadingFixPos = { lat, lng, time: now };
        }
      }
    }
  } else {
    // Stationary mode (< 3.5 km/h) without hardware GNSS heading:
    // If device orientation compass is active, use it! Otherwise freeze heading.
    if (stationaryCompassHeading !== null) {
      targetHeading = stationaryCompassHeading;
    }
    lastHeadingFixPos = { lat, lng, time: now };
    smoothedVelocityVector.initialized = false;
  }

  // PRIORITY 3: Road & Route Alignment (Keep Arrow Straight in Lane)
  const candidateBearing = targetHeading !== null ? targetHeading : lastKnownValidHeading;

  if (candidateBearing !== null) {
    if (routingEngine && routingEngine.isNavigating && !routingEngine.isRerouting && !window.isSimulatingDrive) {
      // CASE A: Active Navigation Route - snap to route segment if aligned within 45 deg
      const routeBearing = routingEngine.getCurrentSegmentBearing ? routingEngine.getCurrentSegmentBearing() : null;
      if (routeBearing !== null) {
        const diffWithRoute = Math.abs(shortestAngleDiff(routeBearing, candidateBearing));
        if (diffWithRoute <= 45) {
          targetHeading = routeBearing;
        }
      }
    } else if (window.speedLimitEngine && typeof window.speedLimitEngine.getRoadBearing === "function") {
      // CASE B: Free Driving Mode (No Active Route) - snap to OSM road / corridor centerline
      // Prevents slanted arrow when cruising down city avenues, expressways or highways
      const roadBearing = window.speedLimitEngine.getRoadBearing(lat, lng, candidateBearing);
      if (roadBearing !== null) {
        targetHeading = roadBearing;
      }
    }
  }

  // Angular interpolation with adaptive shortest-angular-path smoothing
  if (targetHeading !== null) {
    lastKnownValidHeading = targetHeading;
    try {
      localStorage.setItem("tesla_nav_saved_heading", String(Math.round(lastKnownValidHeading)));
    } catch (_) {}
  }
  if (lastKnownValidHeading !== null) {
    const normCur = ((continuousHeading % 360) + 360) % 360;
    const diff = shortestAngleDiff(lastKnownValidHeading, normCur);
    if (lastRenderedHeading === -999) {
      // First fix: snap immediately without slow rotation
      continuousHeading = lastKnownValidHeading;
    } else if (isMoving) {
      // Adaptive smoothing: gentle (0.28) when cruising straight to kill jitter;
      // dynamic (0.55) when turning corners or intersections
      const factor = Math.abs(diff) <= 30 ? 0.28 : 0.55;
      continuousHeading += diff * factor;
    } else if (Math.abs(diff) > 2) {
      // Stationary: smooth towards compass/target heading
      continuousHeading += diff * 0.45;
    }
  }

  currentHeading = Math.round(((continuousHeading % 360) + 360) % 360);

  lastGpsPos = { lat, lng };
  lastGpsTime = now;
  currentPos = { lat, lng };
  window.currentPos = currentPos;
  currentSpeedKmh = speedKmh;
  window.currentSpeedKmhForLock = speedKmh;
  window.hasRealFix = true;

  if (DRIVING_LOCKOUT) {
    const driving = speedKmh > 5;
    const si = document.getElementById("search-input");
    if (si && si.disabled !== driving) {
      si.disabled = driving;
      si.placeholder = driving ? "🚫 ძებნა მოძრაობისას გამორთულია" : "მოძებნეთ მისამართი ან ობიექტი...";
    }
  }

  // The follow camera (map-gl.js) glides the car pin and the camera between the 1 Hz GPS fixes
  lastRenderedHeading = Math.round(continuousHeading);
  if (mapCamera) {
    // lastKnownValidHeading = GNSS heading snapped to the route/road. The camera does its own smoothing, so it
    // gets this (not continuousHeading, which is already smoothed per fix and would make turns lag by seconds).
    mapCamera.setFix({ lng, lat, headingDeg: lastKnownValidHeading, speedMs: speedKmh / 3.6 });
  }

  // Dirty check: only update DOM textContent when speed actually changes
  if (speedKmh !== lastRenderedSpeed) {
    if (!cachedSpeedValEl) cachedSpeedValEl = document.getElementById("speed-val");
    if (cachedSpeedValEl) cachedSpeedValEl.textContent = speedKmh;
    lastRenderedSpeed = speedKmh;
  }

  // Dynamic Road Speed Limit & Overspeed Alert
  if (window.speedLimitEngine) {
    window.speedLimitEngine.update(lat, lng, speedKmh, currentHeading);
  }

  // GPS Accuracy status update
  if (accuracyMeters != null) {
    updateGpsStatusQuality(accuracyMeters);
  }

}

function updateGpsStatusQuality(accuracyMeters) {
  const dot = document.getElementById("gps-status-dot");
  if (!dot) return;
  dot.classList.remove("simulated", "gps-weak", "gps-good", "gps-exact");
  if (accuracyMeters <= 8) {
    dot.classList.add("gps-exact");
    dot.title = `GPS: ზუსტი (±${Math.round(accuracyMeters)} მ)`;
  } else if (accuracyMeters <= 20) {
    dot.classList.add("gps-good");
    dot.title = `GPS: მისაღები (±${Math.round(accuracyMeters)} მ)`;
  } else {
    dot.classList.add("gps-weak");
    dot.title = `GPS: სუსტი (±${Math.round(accuracyMeters)} მ)`;
  }
}

function setFollowCarMode(enabled) {
  isFollowCar = !!enabled;
  if (isFollowCar) { clearTimeout(followResumeTimer); followResumeTimer = null; }
  const btn = document.getElementById("btn-follow-car");
  if (btn) btn.classList.toggle("active", isFollowCar);
  if (mapCamera) {
    mapCamera.setFollowing(isFollowCar);
  }
}

function recenterOnCar() {
  clearTimeout(followResumeTimer);
  followResumeTimer = null;
  setFollowCarMode(true);
  if (currentMapOrientation === "manual") {
    setMapOrientation("heading-up");
  }
  const headingUp = currentMapOrientation === "heading-up";
  const targetBearing = headingUp ? (lastKnownValidHeading || currentHeading || 0) : 0;
  const targetPitch = headingUp ? MAP_HEADING_PITCH : 0;

  if (mapCamera && typeof mapCamera.recenter === "function") {
    mapCamera.recenter(currentPos, targetBearing, targetPitch);
  } else if (map) {
    const h = map.getContainer ? map.getContainer().clientHeight : window.innerHeight;
    const padTop = headingUp ? Math.round(h * 0.30) : 0;
    if (map.easeTo) {
      map.easeTo({
        center: [currentPos.lng, currentPos.lat],
        bearing: targetBearing,
        pitch: targetPitch,
        padding: { top: padTop, bottom: 0, left: 0, right: 0 },
        duration: 400
      });
    } else if (map.jumpTo) {
      map.jumpTo({
        center: [currentPos.lng, currentPos.lat],
        bearing: targetBearing,
        pitch: targetPitch,
        padding: { top: padTop, bottom: 0, left: 0, right: 0 }
      }, { followCamera: true });
    }
  }

  showToast("🎯 მანქანის ცენტრირება", "info", 1500);
}

function toggleMapOrientation() {
  if (currentMapOrientation === "heading-up") {
    setMapOrientation("north-up");
    showToast("🧭 ჩრდილოეთის რეჟიმი (North-Up)", "info", 1800);
  } else {
    setMapOrientation("heading-up");
    showToast("🧭 კურსის რეჟიმი (Heading-Up)", "info", 1800);
  }
  setFollowCarMode(true);
}

function updateOrientationUI() {
  const btn = document.getElementById("btn-map-orientation");
  const tip = document.getElementById("orientation-tooltip");
  if (!btn) return;

  btn.classList.remove("manual-active");
  document.body.classList.remove("orientation-north-up", "orientation-heading-up", "orientation-manual");

  if (currentMapOrientation === "manual") {
    btn.classList.add("manual-active");
    btn.classList.remove("active");
    document.body.classList.add("orientation-manual");
    if (tip) tip.textContent = "დააჭირეთ კურსზე (Heading-Up) დასაბრუნებლად";
  } else if (currentMapOrientation === "north-up") {
    btn.classList.remove("active");
    document.body.classList.add("orientation-north-up");
    if (tip) tip.textContent = "ჩრდილოეთის რეჟიმი (North-Up)";
  } else {
    currentMapOrientation = "heading-up";
    btn.classList.add("active");
    document.body.classList.add("orientation-heading-up");
  }
}

// 1-Tap 180-Degree Quick Inversion for Parked Vehicle Orientation Ambiguity
function flipVehicleHeading180() {
  const newHeading = Math.round(((continuousHeading + 180) % 360 + 360) % 360);
  continuousHeading += 180;
  lastKnownValidHeading = newHeading;
  currentHeading = newHeading;
  try {
    localStorage.setItem("tesla_nav_saved_heading", String(currentHeading));
  } catch (_) {}

  // The follow camera turns the arrow and the map smoothly
  if (mapCamera) {
    lastRenderedHeading = Math.round(continuousHeading);
    mapCamera.setFix({ lng: currentPos.lng, lat: currentPos.lat, headingDeg: lastKnownValidHeading, speedMs: 0 });
  }

  showToast(`🔄 მიმართულება შებრუნდა 180°-ით (${currentHeading}°)`, "info", 2000);
}
window.flipVehicleHeading180 = flipVehicleHeading180;

// Device Orientation Compass Fallback for Stationary Orientation
function initCompassSensor() {
  if (typeof window === "undefined") return;

  const handleOrientation = (e) => {
    // 1. webkitCompassHeading (iOS Safari / modern Chromium)
    if (typeof e.webkitCompassHeading === "number" && isFinite(e.webkitCompassHeading)) {
      stationaryCompassHeading = (e.webkitCompassHeading + 360) % 360;
      return;
    }
    // 2. W3C deviceorientationabsolute or alpha with absolute=true
    if (e.absolute === true && typeof e.alpha === "number" && isFinite(e.alpha)) {
      stationaryCompassHeading = (360 - e.alpha + 360) % 360;
    }
  };

  try {
    if ("ondeviceorientationabsolute" in window) {
      window.addEventListener("deviceorientationabsolute", handleOrientation, { passive: true });
    } else if ("ondeviceorientation" in window) {
      window.addEventListener("deviceorientation", handleOrientation, { passive: true });
    }
  } catch (err) {
    console.warn("Compass sensor not supported:", err);
  }
}

// Map Click to Set Destination
function handleMapClick(latlng) {
  removeDestMarker();

  const popupContent = document.createElement("div");
  popupContent.innerHTML = `
    <div style="font-weight:700; font-size:1.15rem; color:#fff;">დანიშნულების ადგილი</div>
    <div style="font-size:0.9rem; color:#94a3b8; margin:6px 0;">კოორდინატები: ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}</div>
    <button class="popup-dest-btn">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
        <path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/>
      </svg>
      აქ წასვლა
    </button>
  `;

  const popup = new maplibregl.Popup({ offset: 35, closeButton: true, closeOnClick: false })
    .setLngLat([latlng.lng, latlng.lat])
    .setDOMContent(popupContent);

  destMarker = createDestMarker([latlng.lng, latlng.lat])
    .setPopup(popup)
    .addTo(map);

  // Instantly display the popup on the very first map click
  destMarker.togglePopup();

  const btn = popupContent.querySelector(".popup-dest-btn");
  if (btn) {
    btn.onclick = () => {
      removeDestMarker();
      prepareRoutePreview(latlng, "მონიშნული ადგილი", `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`);
    };
  }
}

let pendingDestination = null;

// Route Preview (Tesla Model 3 Preview before GO)
async function prepareRoutePreview(destLatLng, destTitle = "დანიშნულების ადგილი", destAddress = "") {
  try {
    // Hide search dropdown if open
    const searchDropdown = document.getElementById("search-results");
    if (searchDropdown) searchDropdown.classList.remove("show");

    // Close preview if previously open
    const previewCard = document.getElementById("route-preview-card");
    const navHud = document.getElementById("nav-hud");
    if (navHud) navHud.classList.remove("active");

    // Set destination marker
    removeDestMarker();
    destMarker = createDestMarker([destLatLng.lng, destLatLng.lat]).addTo(map);

    if (!window.hasRealFix) {
      showToast("⚠️ GPS პოზიცია არ არის — მარშრუტი ნაგულისხმევი წერტილიდან ითვლება", "error", 4500);
    } else {
      showToast("მარშრუტი ითვლება... ⏳", "info", 1500);
    }

    // Calculate route with autoStart = false (Draws polyline and zooms bounds without opening Turn-by-Turn HUD)
    const route = await routingEngine.calculateRoute(currentPos, destLatLng, false);
    if (!route) return;

    pendingDestination = {
      latlng: destLatLng,
      title: destTitle,
      address: destAddress || destTitle
    };

    // Populate Preview Card UI
    fillPreviewCard(route, destTitle, destAddress);

    if (previewCard) {
      previewCard.classList.add("active");
    }
  } catch (err) {
    showToast("მარშრუტის დახაზვა ვერ მოხერხდა: " + err.message, "error");
  }
}

/** Fills the route preview card (time, distance, ETA, battery) for the given route. Called again when an alternative is tapped. */
function fillPreviewCard(route, destTitle, destAddress) {
  const titleEl = document.getElementById("preview-dest-title");
  const addrEl = document.getElementById("preview-dest-address");
  const timeEl = document.getElementById("preview-time");
  const distEl = document.getElementById("preview-dist");
  const etaEl = document.getElementById("preview-eta");
  const kwhEl = document.getElementById("preview-battery-kwh");
  const arrivalEl = document.getElementById("preview-battery-arrival");

  const durationMin = Math.max(1, Math.round(route.durationSeconds / 60) + (route.trafficDelayMin || 0));
  const distKm = (route.distanceMeters / 1000).toFixed(1);

  const now = new Date();
  now.setMinutes(now.getMinutes() + durationMin);
  const etaStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  if (titleEl) titleEl.textContent = destTitle;
  if (addrEl) addrEl.textContent = destAddress || destTitle;
  if (timeEl) timeEl.textContent = `${durationMin} წთ`;
  if (distEl) distEl.textContent = `${distKm} კმ`;
  if (etaEl) etaEl.textContent = etaStr;

  if (route.batteryImpact) {
    if (kwhEl) kwhEl.textContent = `⚡ ~${route.batteryImpact.energyKwh} kWh`;
    if (arrivalEl) arrivalEl.textContent = `🔋 ჩასვლისას: ~${route.batteryImpact.arrivalSoC}% (შეფასება)`;
  } else {
    if (kwhEl) kwhEl.textContent = `⚡ ელემენტი: მზადაა`;
    if (arrivalEl) arrivalEl.textContent = `🔋 ჩასვლისას: OK`;
  }
}

// User confirms Start Navigation (GO button clicked)
function confirmStartNavigation() {
  const previewCard = document.getElementById("route-preview-card");
  if (previewCard) previewCard.classList.remove("active");

  if (!pendingDestination && !routingEngine.activeRoute) return;

  const dest = pendingDestination ? pendingDestination.latlng : routingEngine.activeRoute.destination;
  const title = pendingDestination ? pendingDestination.title : (routingEngine.activeRoute.destName || "დანიშნულების ადგილი");

  routingEngine.startNavigation();
  setFollowCarMode(true);
  if (map) map.setZoom(Math.max(map.getZoom(), MAP_DEFAULT_ZOOM)); // navigation zoom after the preview fitBounds
  saveActiveRouteState(dest, title);
  showToast(`🚀 ნავიგაცია დაწყებულია: ${title}`, "success", 2500);
  pendingDestination = null;
}

// User cancels Route Preview (Cancel or Close clicked)
function dismissRoutePreview() {
  const previewCard = document.getElementById("route-preview-card");
  if (previewCard) previewCard.classList.remove("active");
  routingEngine.clearRoute();
  removeDestMarker();
  pendingDestination = null;
  setFollowCarMode(true);   // back to the car after a route preview
}

// Start Navigation (used by auto-resume and direct programmatic invocations)
async function startNavigation(destLatLng, destName = "დანიშნულების ადგილი", saveState = true) {
  try {
    const searchDropdown = document.getElementById("search-results");
    if (searchDropdown) searchDropdown.classList.remove("show");

    const previewCard = document.getElementById("route-preview-card");
    if (previewCard) previewCard.classList.remove("active");

    await routingEngine.calculateRoute(currentPos, destLatLng, true);
    setFollowCarMode(true);

    if (saveState) {
      saveActiveRouteState(destLatLng, destName);
    }
  } catch (err) {
    showToast("მარშრუტის დახაზვა ვერ მოხერხდა: " + err.message, "error");
  }
}

// Active Route Persistence (Tesla Reverse Gear Auto-Resume)
function saveActiveRouteState(destLatLng, destName) {
  try {
    const state = {
      dest: { lat: destLatLng.lat, lng: destLatLng.lng },
      destName: destName || "დანიშნულების ადგილი",
      stepIndex: routingEngine ? routingEngine.currentStepIndex : 0,
      timestamp: Date.now()
    };
    localStorage.setItem("tesla_nav_active_route", JSON.stringify(state));
  } catch (e) {
    console.warn("Failed to save active route state:", e);
  }
}

function clearActiveRouteState() {
  try {
    localStorage.removeItem("tesla_nav_active_route");
  } catch (e) {}
}

function restoreActiveRouteState() {
  try {
    const raw = localStorage.getItem("tesla_nav_active_route");
    if (!raw) return;
    const state = JSON.parse(raw);
    // Auto-resume if saved within last 12 hours
    if (state && state.dest && (Date.now() - state.timestamp < 12 * 3600 * 1000)) {
      // AUDIT FIX: wait for a REAL GPS fix (otherwise the route starts from the default Freedom Square position)
      const started = Date.now();
      const tryResume = async () => {
        if (window.hasRealFix) {
          showToast(`🔄 მარშრუტი აღდგა: ${state.destName}`, "success", 4500);
          await startNavigation(state.dest, state.destName, false); // step is recomputed from progress
          return;
        }
        if (Date.now() - started > 10000) {
          showToast("მარშრუტის აღდგენა გაუქმდა: GPS პოზიცია ვერ მოიძებნა", "error", 5000);
          return;
        }
        setTimeout(tryResume, 500);
      };
      setTimeout(tryResume, 700);
    }
  } catch (err) {
    console.warn("Error restoring active route:", err);
  }
}

// Cancel Navigation
function cancelNavigation() {
  dismissRoutePreview();
  routingEngine.clearRoute();
  clearActiveRouteState();
  removeDestMarker();
  document.getElementById("nav-hud").classList.remove("active");
  document.getElementById("traffic-signal-alert").classList.remove("active");
  document.getElementById("hud-battery-row").style.display = "none";
  const laneEl = document.getElementById("hud-lane-guidance");
  if (laneEl) laneEl.style.display = "none";
}

// Search & Favorites (Home & Work)
function initSearch() {
  const searchInput = document.getElementById("search-input");
  const clearBtn = document.getElementById("clear-search-btn");
  const resultsContainer = document.getElementById("search-results");
  let debounceTimer = null;

  // Show favorites when search box is focused or clicked while empty
  searchInput.addEventListener("focus", () => {
    if (!searchInput.value.trim()) {
      renderFavoritesDropdown();
    }
  });

  searchInput.addEventListener("click", () => {
    if (!searchInput.value.trim()) {
      renderFavoritesDropdown();
    }
  });

  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim();
    if (query.length > 0) {
      clearBtn.classList.add("active");
    } else {
      clearBtn.classList.remove("active");
      renderFavoritesDropdown();
      return;
    }

    // typing never touches the network (the public geocoder forbids search-as-you-type): local suggestions only
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      onlineSearchToken++;
      renderSuggestions(query, null);
    }, 120);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = searchInput.value.trim();
      if (q.length >= 2) runOnlineSearch(q);
    }
  });

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    clearBtn.classList.remove("active");
    renderFavoritesDropdown();
  });

  document.addEventListener("click", (e) => {
    if (!searchInput.contains(e.target) && !resultsContainer.contains(e.target)) {
      resultsContainer.classList.remove("show");
    }
  });
}

// Render 1-Click Favorites (Home & Work)
function renderFavoritesDropdown() {
  const container = document.getElementById("search-results");
  const homeAddr = localStorage.getItem("saved_home") || "";
  const workAddr = localStorage.getItem("saved_work") || "";

  container.innerHTML = `
    <div class="search-favorites-box">
      <div class="fav-header">⭐ რჩეული ადგილები</div>
      <div class="fav-row">
        <button type="button" class="fav-btn" id="fav-go-home">
          <span class="fav-icon">🏠</span>
          <div class="fav-text">
            <div class="fav-title">სახლი</div>
            <div class="fav-sub" title="${escapeHtml(homeAddr) || 'პარამეტრებიდან მითითება'}">${escapeHtml(homeAddr) || 'დააყენეთ...'}</div>
          </div>
        </button>
        <button type="button" class="fav-btn" id="fav-go-work">
          <span class="fav-icon">🏢</span>
          <div class="fav-text">
            <div class="fav-title">სამსახური</div>
            <div class="fav-sub" title="${escapeHtml(workAddr) || 'პარამეტრებიდან მითითება'}">${escapeHtml(workAddr) || 'დააყენეთ...'}</div>
          </div>
        </button>
      </div>
    </div>
  `;

  document.getElementById("fav-go-home").onclick = (e) => {
    e.stopPropagation();
    if (!homeAddr) {
      document.getElementById("settings-modal").classList.add("open");
      showToast("მიუთითეთ სახლის მისამართი პარამეტრებში 🏠", "info");
    } else {
      container.classList.remove("show");
      document.getElementById("search-input").value = homeAddr;
      handleAddressSearchAndNavigate(homeAddr, "🏠 სახლი");
    }
  };

  document.getElementById("fav-go-work").onclick = (e) => {
    e.stopPropagation();
    if (!workAddr) {
      document.getElementById("settings-modal").classList.add("open");
      showToast("მიუთითეთ სამსახურის მისამართი პარამეტრებში 🏢", "info");
    } else {
      container.classList.remove("show");
      document.getElementById("search-input").value = workAddr;
      handleAddressSearchAndNavigate(workAddr, "🏢 სამსახური");
    }
  };

  container.classList.add("show");
}

async function handleAddressSearchAndNavigate(query, label) {
  try {
    showToast(`იძებნება ${label}...`, "info", 2000);
    let url = `/api/search?q=${encodeURIComponent(query)}`;
    if (currentPos && isFinite(currentPos.lat)) url += `&lat=${currentPos.lat.toFixed(3)}&lon=${currentPos.lng.toFixed(3)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data && data.length > 0) {
      const latlng = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      prepareRoutePreview(latlng, label, data[0].display_name);
    } else {
      showToast(`მისამართი ${label} ვერ მოიძებნა`, "error");
    }
  } catch (err) {
    showToast("ძებნის შეცდომა: " + err.message, "error");
  }
}

// ---- search: local suggestions as you type, online geocoder only on Enter / tap (see search.js) ----
let onlineSearchToken = 0;
const RECENTS_KEY = "tesla_nav_recents";

function loadRecents() {
  try { const l = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]"); return Array.isArray(l) ? l : []; } catch (_) { return []; }
}
function rememberDestination(title, subtitle, lat, lon) {
  try {
    const l = window.SearchUtil.addRecent(loadRecents(), { title, subtitle: subtitle || "", lat, lon, kind: "recent" });
    localStorage.setItem(RECENTS_KEY, JSON.stringify(l));
  } catch (_) {}
}

function localSearchItems() {
  const items = loadRecents().map((r) => Object.assign({}, r, { kind: "recent" }));
  const chs = (window.chargersEngine && window.chargersEngine.chargers) || [];
  for (const st of chs) {
    items.push({ title: st.name || "EV დამტენი", subtitle: [st.operator, st.power].filter(Boolean).join(" · "), lat: st.lat, lon: st.lon, kind: "charger" });
  }
  return items;
}

async function runOnlineSearch(query) {
  const token = ++onlineSearchToken;
  renderSuggestions(query, { loading: true });
  try {
    let url = `/api/search?q=${encodeURIComponent(query)}`;
    if (currentPos && isFinite(currentPos.lat)) url += `&lat=${currentPos.lat.toFixed(3)}&lon=${currentPos.lng.toFixed(3)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (token !== onlineSearchToken) return;   // a newer query / typing replaced this one
    renderSuggestions(query, { results: window.SearchUtil.sortByDistance(Array.isArray(data) ? data : [], currentPos) });
  } catch (e) {
    if (token !== onlineSearchToken) return;
    renderSuggestions(query, { error: true });
  }
}

function searchRow(icon, title, subtitle, km, onPick) {
  const div = document.createElement("div");
  div.className = "search-item";
  const ic = document.createElement("span");
  ic.className = "search-item-emoji";
  ic.textContent = icon;
  const info = document.createElement("div");
  info.className = "search-item-info";
  const t = document.createElement("div");
  t.className = "search-item-title";
  t.textContent = title;
  info.appendChild(t);
  if (subtitle) {
    const st = document.createElement("div");
    st.className = "search-item-subtitle";
    st.textContent = subtitle;
    info.appendChild(st);
  }
  div.appendChild(ic);
  div.appendChild(info);
  if (km != null && isFinite(km)) {
    const d = document.createElement("div");
    d.className = "search-item-dist";
    d.textContent = "~" + window.SearchUtil.formatKm(km);
    div.appendChild(d);
  }
  div.addEventListener("click", onPick);
  return div;
}

/** online: null (typing) | { loading } | { results } | { error }. */
function renderSuggestions(query, online) {
  const container = document.getElementById("search-results");
  const input = document.getElementById("search-input");
  container.textContent = "";
  const pick = (title, subtitle, lat, lon) => {
    container.classList.remove("show");
    input.value = title;
    rememberDestination(title, subtitle, lat, lon);
    prepareRoutePreview({ lat, lng: lon }, title, subtitle || title);
  };

  const local = window.SearchUtil.rankLocal(query, localSearchItems(), currentPos, 8);
  const addLocal = (it) => container.appendChild(searchRow(it.kind === "recent" ? "🕘" : "⚡", it.title, it.subtitle, it.km, () => pick(it.title, it.subtitle, it.lat, it.lon)));
  local.filter((it) => it.kind === "recent").slice(0, 3).forEach(addLocal);

  if (online && online.results) {
    for (const r of online.results) {
      const title = String(r.display_name || "").split(",")[0] || query;
      container.appendChild(searchRow("📍", title, r.display_name, r.km, () => pick(title, r.display_name, parseFloat(r.lat), parseFloat(r.lon))));
    }
    if (!online.results.length) container.appendChild(searchRow("🔍", "ვერაფერი მოიძებნა", "სცადეთ სხვა სიტყვა", null, () => {}));
  } else if (online && online.loading) {
    container.appendChild(searchRow("⏳", "იძებნება...", query, null, () => {}));
  } else if (online && online.error) {
    container.appendChild(searchRow("⚠️", "ძებნა ვერ შესრულდა", "შეეხეთ ხელახლა საცდელად", null, () => runOnlineSearch(query)));
  } else if (query.length >= 2) {
    container.appendChild(searchRow("🔎", "ძებნა ინტერნეტში: «" + query + "»", "Enter ან შეხება", null, () => runOnlineSearch(query)));
  }

  // nearby charging stations matching the text (a city name matches dozens, so only the 3 nearest)
  local.filter((it) => it.kind !== "recent").slice(0, 3).forEach(addLocal);

  container.classList.toggle("show", container.childNodes.length > 0);
}

function escapeHtml(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
window.escapeHtml = escapeHtml;

// Toast Notification System (Non-blocking Tesla notifications)
function showToast(message, type = "info", duration = 3500) {
  let container = document.getElementById("tesla-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "tesla-toast-container";
    container.className = "tesla-toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `tesla-toast ${type}`;
  const iconSpan = document.createElement("span");
  iconSpan.textContent = type === 'error' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️';
  const msgSpan = document.createElement("span");
  msgSpan.textContent = message; // AUDIT FIX: textContent, never innerHTML (XSS)
  toast.append(iconSpan, document.createTextNode(" "), msgSpan);
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, duration);
}
window.showToast = showToast;

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
          try {
            wakeLock = await navigator.wakeLock.request('screen');
          } catch (e) {}
        }
      });
    } catch (err) {
      console.warn("WakeLock notice:", err.message);
    }
  }
}

// In-page battery % dialog (replaces the blocking native prompt(), which is unusable on the car screen)
function openBatteryDialog(current, modelName) {
  let ov = document.getElementById("battery-dialog");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "battery-dialog";
    ov.className = "modal-overlay";
    ov.innerHTML = `
      <div class="modal-window" style="max-width:420px;text-align:center;">
        <div class="modal-header"><h2 class="modal-title">🔋 ბატარეა (%) <span id="battery-dialog-model" style="font-size:.8em;opacity:.7"></span></h2>
          <button type="button" class="modal-close-btn" id="battery-dialog-close">✕</button></div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:14px;align-items:center;">
          <div style="display:flex;gap:10px;align-items:center;">
            <button type="button" class="btn-primary" id="battery-dialog-minus" style="min-width:64px;min-height:56px;font-size:1.6rem;">−</button>
            <input type="number" id="battery-dialog-input" class="setting-input" min="1" max="100" inputmode="numeric" style="width:110px;min-height:56px;font-size:1.6rem;text-align:center;">
            <button type="button" class="btn-primary" id="battery-dialog-plus" style="min-width:64px;min-height:56px;font-size:1.6rem;">+</button>
          </div>
          <button type="button" class="btn-primary" id="battery-dialog-ok" style="width:100%;min-height:56px;font-size:1.1rem;">შენახვა</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const inp = ov.querySelector("#battery-dialog-input");
    const clamp = v => Math.max(1, Math.min(100, v));
    const close = () => ov.classList.remove("open");
    ov.querySelector("#battery-dialog-close").addEventListener("click", close);
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    ov.querySelector("#battery-dialog-minus").addEventListener("click", () => { inp.value = clamp((parseInt(inp.value, 10) || 0) - 5); });
    ov.querySelector("#battery-dialog-plus").addEventListener("click", () => { inp.value = clamp((parseInt(inp.value, 10) || 0) + 5); });
    ov.querySelector("#battery-dialog-ok").addEventListener("click", () => {
      const val = parseInt(inp.value, 10);
      if (!isNaN(val) && val >= 1 && val <= 100) batteryEngine.setSoC(val);
      close();
    });
  }
  ov.querySelector("#battery-dialog-model").textContent = "[" + modelName + "]";
  ov.querySelector("#battery-dialog-input").value = current;
  ov.classList.add("open");
}

// Event Listeners Setup
function initEventListeners() {
  initSearch();


  // Battery Chip Click -> Quick SoC edit prompt
  const batteryChip = document.getElementById("top-battery-chip");
  if (batteryChip) {
    batteryChip.addEventListener("click", () => {
      openBatteryDialog(batteryEngine.currentSoC, batteryEngine.getModelConfig().name);
    });
  }

  // Dock Buttons
  document.getElementById("btn-follow-car").addEventListener("click", (e) => {
    e.stopPropagation();
    recenterOnCar();
  });

  const btnOrientation = document.getElementById("btn-map-orientation");
  if (btnOrientation) {
    btnOrientation.addEventListener("click", () => {
      toggleMapOrientation();
    });
  }
  updateOrientationUI();

  // Map Zoom Controls (+ and -)
  document.getElementById("btn-zoom-in").addEventListener("click", () => {
    if (map) map.zoomIn({ duration: 220 });
  });
  document.getElementById("btn-zoom-out").addEventListener("click", () => {
    if (map) map.zoomOut({ duration: 220 });
  });

  const btnTraffic = document.getElementById("btn-toggle-traffic");
  btnTraffic.addEventListener("click", () => {
    const enabled = trafficEngine.toggle();
    btnTraffic.classList.toggle("traffic-active", enabled);
    if (enabled && !trafficEngine.hasKey()) {
      showToast("🚦 საცობების ფენისთვის პარამეტრებში TomTom API გასაღებია საჭირო", "info", 4000);
    } else {
      showToast(enabled ? "🚦 საცობების ფენა ჩართულია" : "🚦 საცობების ფენა გამორთულია", "info", 1800);
    }
  });

  const btnSignals = document.getElementById("btn-toggle-signals");
  btnSignals.addEventListener("click", () => {
    const enabled = trafficSignalsEngine.toggle();
    btnSignals.classList.toggle("signals-active", enabled);
  });

  // Toggle EV Chargers Layer
  const btnChargers = document.getElementById("btn-toggle-chargers");
  if (btnChargers) {
    btnChargers.addEventListener("click", () => {
      const enabled = chargersEngine.toggle();
      btnChargers.classList.toggle("signals-active", enabled);
    });
  }

  // EV charger list drawer (nearest first, fast-DC filter)
  const btnChargersList = document.getElementById("btn-chargers-list");
  if (btnChargersList && window.ChargerList && chargersEngine) {
    const drawer = new window.ChargerList.ChargerDrawer(chargersEngine, () => currentPos, {
      onFocus: (st) => { try { setFollowCarMode(false); map.easeTo({ center: [st.lon, st.lat], duration: 400 }); scheduleFollowResume(); } catch (_) {} }
    });
    btnChargersList.addEventListener("click", () => btnChargersList.classList.toggle("active", drawer.toggle()));
    drawer.el && drawer.el.querySelector(".cd-close").addEventListener("click", () => btnChargersList.classList.remove("active"));
  }

  // Map Style Menu Toggle
  const btnMapStyle = document.getElementById("btn-map-style");
  const mapStyleMenu = document.getElementById("map-style-menu");
  const mapStyleCloseBtn = document.getElementById("map-style-close-btn");
  if (btnMapStyle && mapStyleMenu) {
    btnMapStyle.addEventListener("click", (e) => {
      e.stopPropagation();
      mapStyleMenu.classList.toggle("open");
    });

    if (mapStyleCloseBtn) {
      mapStyleCloseBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        mapStyleMenu.classList.remove("open");
      });
    }

    document.querySelectorAll(".map-style-opt").forEach(opt => {
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        const style = opt.dataset.style;
        setMapStyle(style);
        mapStyleMenu.classList.remove("open");
        const styleName = style === "google-roads" ? "🗺️ Google Maps (საგანგებო)" : "⚡ 3D ვექტორული რუკა";
        showToast(styleName + " ჩაირთო ✅", "success", 2500);
      });
    });

    document.addEventListener("click", (e) => {
      if (!mapStyleMenu.contains(e.target) && e.target !== btnMapStyle) {
        mapStyleMenu.classList.remove("open");
      }
    });
  }

  // Night / Day Mode Toggle Listener
  const btnNight = document.getElementById("btn-toggle-night");
  if (btnNight) {
    btnNight.addEventListener("click", () => {
      toggleNightMode();
    });
  }

  const btnVoice = document.getElementById("btn-toggle-voice");
  btnVoice.addEventListener("click", () => {
    const muted = speechAssistant.toggleMute();
    btnVoice.classList.toggle("active", !muted);
  });

  document.getElementById("btn-cancel-route").addEventListener("click", cancelNavigation);

  // Route Preview Buttons (Tesla GO and Cancel)
  const btnStartGo = document.getElementById("btn-start-go");
  if (btnStartGo) {
    btnStartGo.addEventListener("click", confirmStartNavigation);
  }

  const btnPreviewCancel = document.getElementById("btn-preview-cancel");
  if (btnPreviewCancel) {
    btnPreviewCancel.addEventListener("click", dismissRoutePreview);
  }

  const btnPreviewClose = document.getElementById("btn-preview-close");
  if (btnPreviewClose) {
    btnPreviewClose.addEventListener("click", dismissRoutePreview);
  }

  // Settings Modal
  const modal = document.getElementById("settings-modal");
  const selectTeslaModel = document.getElementById("select-tesla-model");

  function updateModelSpecsCard(modelKey) {
    if (!window.TESLA_MODELS) return;
    const config = window.TESLA_MODELS[modelKey];
    if (!config) return;

    const batteryEl = document.getElementById("spec-battery-val");
    const consumptionEl = document.getElementById("spec-consumption-val");
    const rangeEl = document.getElementById("spec-range-val");
    const driveEl = document.getElementById("spec-drive-val");
    const tipEl = document.getElementById("spec-charge-tip");

    if (batteryEl) batteryEl.textContent = `${config.usableKwh} kWh Usable (${config.batteryKwh} kWh Gross)`;
    if (consumptionEl) consumptionEl.textContent = `${config.consumptionPer100Km} kWh/100კმ`;
    if (rangeEl) rangeEl.textContent = `${config.officialRangeKm} კმ (WLTP)`;
    if (driveEl) driveEl.textContent = `${config.drive} • ${config.chemistry}`;
    if (tipEl) tipEl.textContent = config.chargeTip;
  }

  if (selectTeslaModel) {
    selectTeslaModel.value = batteryEngine.modelKey;
    updateModelSpecsCard(batteryEngine.modelKey);
    selectTeslaModel.addEventListener("change", () => {
      updateModelSpecsCard(selectTeslaModel.value);
    });
  }

  document.getElementById("btn-settings").addEventListener("click", () => {
    if (selectTeslaModel) {
      selectTeslaModel.value = batteryEngine.modelKey;
      updateModelSpecsCard(batteryEngine.modelKey);
    }
    document.getElementById("input-initial-soc").value = batteryEngine.currentSoC;
    modal.classList.add("open");
  });
  document.getElementById("modal-close-btn").addEventListener("click", () => {
    modal.classList.remove("open");
  });
  document.getElementById("modal-cancel-btn").addEventListener("click", () => {
    modal.classList.remove("open");
  });
  document.getElementById("modal-save-btn").addEventListener("click", () => {
    const key = document.getElementById("input-tomtom-key").value.trim();
    trafficEngine.setApiKey(key);
    if (window.speedLimitEngine) window.speedLimitEngine.setTomTomKey(key);

    const modelType = document.getElementById("select-tesla-model").value;
    batteryEngine.setModel(modelType);

    const socVal = parseInt(document.getElementById("input-initial-soc").value, 10);
    if (!isNaN(socVal)) batteryEngine.setSoC(socVal);

    const avoidUnpaved = document.getElementById("input-avoid-unpaved").checked;
    localStorage.setItem("avoid_unpaved", avoidUnpaved ? "true" : "false");
    routingEngine.setAvoidUnpaved(avoidUnpaved);

    localStorage.setItem("saved_home", document.getElementById("input-home-addr").value.trim());
    localStorage.setItem("saved_work", document.getElementById("input-work-addr").value.trim());
    modal.classList.remove("open");
    const activeModel = batteryEngine.getModelConfig();
    showToast(`პარამეტრები შენახულია! (${activeModel.name}) ✅`, "success");
  });

  // Populate settings inputs
  document.getElementById("input-tomtom-key").value = localStorage.getItem("tomtom_api_key") || "";
  document.getElementById("input-home-addr").value = localStorage.getItem("saved_home") || "";
  document.getElementById("input-work-addr").value = localStorage.getItem("saved_work") || "";
  document.getElementById("input-avoid-unpaved").checked = localStorage.getItem("avoid_unpaved") === "true";
  if (selectTeslaModel) selectTeslaModel.value = batteryEngine.modelKey;
  document.getElementById("input-initial-soc").value = batteryEngine.currentSoC;

  // Remote Phone Companion Modal & Pairing Setup
  const remoteModal = document.getElementById("remote-modal");
  const btnRemote = document.getElementById("btn-remote-phone");
  const remoteCloseBtn = document.getElementById("remote-modal-close-btn");

  if (btnRemote && remoteModal) {
    btnRemote.addEventListener("click", () => {
      remoteModal.classList.add("open");
      initRemoteSession();
    });
  }

  if (remoteCloseBtn && remoteModal) {
    remoteCloseBtn.addEventListener("click", () => {
      remoteModal.classList.remove("open");
    });
  }
}

// Phone Remote Session Management
let remoteEventSource = null;
let currentSessionCode = null;

function getOrGenerateSessionCode() {
  if (!currentSessionCode) {
    let saved = sessionStorage.getItem("tesla_remote_code");
    if (!saved) {
      const rnd = new Uint8Array(8);
      (window.crypto || window.msCrypto).getRandomValues(rnd);
      saved = Array.from(rnd, b => b.toString(16).padStart(2, "0")).join("").toUpperCase(); // 64-bit crypto random
      sessionStorage.setItem("tesla_remote_code", saved);
    }
    currentSessionCode = saved;
  }
  return currentSessionCode;
}

function initRemoteSession() {
  const code = getOrGenerateSessionCode();
  const codeEl = document.getElementById("remote-code-text");
  if (codeEl) codeEl.textContent = code;

  // Fetch local IP address from server
  fetch("/api/info")
    .then(res => res.json())
    .then(info => {
      const isPublicOrHttps = window.location.protocol === "https:" || (window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1");
      const bestIp = (info.localIps && info.localIps[0]) || window.location.hostname;
      const port = info.port || window.location.port || 3000;
      const remoteUrl = isPublicOrHttps
        ? `${window.location.origin}/remote.html?code=${code}`
        : `http://${bestIp}:${port}/remote.html?code=${code}`;

      const linkEl = document.getElementById("remote-url-link");
      if (linkEl) {
        linkEl.href = remoteUrl;
        linkEl.textContent = remoteUrl;
      }

      const qrContainer = document.getElementById("qrcode");
      if (qrContainer) {
        qrContainer.innerHTML = "";
        if (window.QRCode) {
          new QRCode(qrContainer, {
            text: remoteUrl,
            width: 200,
            height: 200,
            colorDark: "#0a0d14",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.M
          });
        }
      }
    })
    .catch(err => console.warn("Failed to fetch server info for QR:", err));

  // Connect SSE for Realtime updates from Phone
  if (window.EventSource) {
    if (remoteEventSource) {
      remoteEventSource.close();
    }
    remoteEventSource = new EventSource(`/api/session/listen?code=${code}`);

    remoteEventSource.addEventListener("init", () => {
      console.log("Remote SSE stream connected on code:", code);
    });

    remoteEventSource.addEventListener("destination", (e) => {
      try {
        const payload = JSON.parse(e.data);
        const modal = document.getElementById("remote-modal");
        if (modal) modal.classList.remove("open");

        showToast(`📍 დანიშნულება მიღებულია ტელეფონიდან: ${payload.name}`, "success", 4000);
        const latlng = { lat: parseFloat(payload.lat), lng: parseFloat(payload.lng) };
        if (!isFinite(latlng.lat) || !isFinite(latlng.lng) || Math.abs(latlng.lat) > 90 || Math.abs(latlng.lng) > 180) return;
        prepareRoutePreview(latlng, String(payload.name || "").slice(0, 120), String(payload.name || "").slice(0, 120));
      } catch (err) {
        console.error("Malformed remote destination:", err);
      }
    });

    remoteEventSource.addEventListener("gps", (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (!isFinite(payload.lat) || !isFinite(payload.lng) || Math.abs(payload.lat) > 90 || Math.abs(payload.lng) > 180) return;
        const statusDot = document.getElementById("gps-status-dot");
        if (statusDot) statusDot.classList.add("active");

        const statusPill = document.getElementById("remote-status-pill");
        if (statusPill) {
          statusPill.textContent = `🟢 ტელეფონი დაკავშირებულია (±${Math.round(payload.accuracy || 0)} მ)`;
          statusPill.style.color = "#10b981";
        }

        const currentSpeed = payload.speedKmh != null ? payload.speedKmh : (payload.speed != null ? Math.round(payload.speed * 3.6) : currentSpeedKmh);
        const currentHead = (typeof payload.heading === 'number' && isFinite(payload.heading) && payload.heading !== null) ? payload.heading : null;

        updateVehicleMarker(
          payload.lat,
          payload.lng,
          currentHead,
          currentSpeed,
          payload.accuracy
        );

        if (routingEngine && routingEngine.isNavigating) {
          const signalAhead = routingEngine.updateVehiclePosition(
            { lat: payload.lat, lng: payload.lng },
            currentSpeed,
            currentHead
          );
          const alertBanner = document.getElementById("traffic-signal-alert");
          if (signalAhead) {
            alertBanner.classList.add("active");
            document.getElementById("signal-alert-text").textContent = `🚦 შუქნიშანი ${signalAhead.distanceMeters} მეტრში`;
          } else {
            alertBanner.classList.remove("active");
          }
        }
      } catch (err) {
        console.error("Malformed remote GPS packet:", err);
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Diagnostics HUD: ?debug=1 in the address, or tap the speed number 5 times. Shows what the GPS really delivers
// and where the camera/arrow are, so a drive can be analysed from a photo of the screen.
// ---------------------------------------------------------------------------------------------------------
(function setupDebugHud() {
  let el = null, timer = null, taps = [];
  const f = (v, n = 1) => (typeof v === "number" && isFinite(v) ? v.toFixed(n) : "-");
  // House-number diagnosis: is the layer there, is it switched on, is the zoom high enough, does the tile data hold any numbers here?
  function hnLine() {
    try {
      if (!map.getLayer("housenumber")) return "housenumbers: layer MISSING (style has no housenumber source)";
      const vis = map.getLayoutProperty("housenumber", "visibility") !== "none";
      const now = Date.now();
      if (!hnLine.t || now - hnLine.t > 1000) {
        hnLine.t = now;
        hnLine.n = map.getZoom() >= 16 && vis ? map.queryRenderedFeatures({ layers: ["housenumber"] }).length : null;
      }
      return "housenumbers: " + (vis ? "ON" : "off(speed)") + "  zoom>=16 " + (map.getZoom() >= 16 ? "yes" : "NO") + "  in view " + (hnLine.n == null ? "-" : hnLine.n) + "  lite " + (PERF.lite ? "yes" : "no");
    } catch (_) { return "housenumbers: n/a"; }
  }
  function render() {
    if (!el || !window.map || !window.carMarker) return;
    const d = window.__dbg || { fixes: [] }, fx = d.fixes, now = Date.now();
    const last = fx[fx.length - 1], prev = fx[fx.length - 2];
    let dt = null, dist = null;
    if (last && prev) {
      dt = (last.t - prev.t) / 1000;
      dist = routingEngine ? routingEngine.haversineMeters(prev.lat, prev.lng, last.lat, last.lng) : null;
    }
    const c = map.getContainer().getBoundingClientRect(), r = carMarker.getElement().getBoundingClientRect();
    const padTop = map.getPadding().top;
    const dx = r.x + r.width / 2 - c.x - c.width / 2;
    const dy = r.y + r.height / 2 - c.y - (c.height / 2 + padTop / 2);
    const cam = window.mapCamera;
    const fps = cam ? (cam.frameCount - (el._fc || 0)) / ((now - (el._ft || now)) / 1000 || 1) : 0;
    const rfps = ((window.__renderCount || 0) - (el._rc || 0)) / ((now - (el._ft0 || now)) / 1000 || 1);
    el._rc = window.__renderCount || 0; el._ft0 = now;
    if (cam) { el._fc = cam.frameCount; el._ft = now; }
    const lines = [
      "v" + APP_VERSION + " DEBUG" + (PERF.lite ? " LITE" : "") + "  fixes:" + fx.length + "  age:" + (last ? f((now - last.t) / 1000) : "-") + "s",
      "last fix: acc " + f(last && last.acc, 0) + "m  spd " + f(last && last.spd) + "  hdg " + f(last && last.hdg, 0),
      "gap " + f(dt) + "s  jump " + f(dist) + "m  => " + (dt && dist != null ? f(dist / dt * 3.6, 0) : "-") + " km/h",
      "follow " + isFollowCar + "  mode " + currentMapOrientation + "  fps " + f(fps, 0) + "  render " + f(rfps, 0) + "/s",
      "cost: jumpTo " + f(cam && cam.jumpMs, 1) + "ms  onFrame " + f(cam && cam.cbMs, 1) + "ms",
      "flags: dpr " + f(map.getPixelRatio && map.getPixelRatio(), 2) + "  pitch " + (PERF.pitch != null ? PERF.pitch : "45*") + "  labels " + (PERF.labels ? "on" : "OFF") + "  markers " + (PERF.markers ? "on" : "OFF") + "  look " + (window.__teslaLook ? (window.__lookMode === "mono" ? "MONO" : "TESLA") : "classic"),
      "bearing " + f(map.getBearing(), 0) + "  pitch " + f(map.getPitch(), 0) + "  zoom " + f(map.getZoom(), 1) + "  pad " + padTop,
      "arrow offset from expected: dx " + f(dx, 0) + "  dy " + f(dy, 0) + " px",
      "heading used " + f(lastKnownValidHeading, 0) + "  speed " + currentSpeedKmh + " km/h",
      hnLine()
    ];
    fx.slice(-5).forEach(q => lines.push(((now - q.t) / 1000).toFixed(1).padStart(5) + "s  " + q.lat.toFixed(5) + "," + q.lng.toFixed(5) + "  a" + f(q.acc, 0) + " s" + f(q.spd) + " h" + f(q.hdg, 0)));
    el.textContent = lines.join("\n");
  }
  function toggle(force) {
    const on = force != null ? force : !el;
    if (on && !el) {
      el = document.createElement("pre");
      el.style.cssText = "position:fixed;left:8px;top:80px;z-index:99999;margin:0;padding:8px 10px;background:rgba(0,0,0,.78);color:#7CFC7C;font:13px/1.35 monospace;border-radius:8px;pointer-events:none;white-space:pre";
      document.body.appendChild(el);
      timer = setInterval(render, 250);
    } else if (!on && el) {
      clearInterval(timer); el.remove(); el = null;
    }
  }
  window.toggleDebugHud = toggle;
  document.addEventListener("DOMContentLoaded", () => {
    if (/[?&]debug=1/.test(location.search)) toggle(true);
    const sv = document.getElementById("speed-val");
    if (sv) sv.addEventListener("click", () => {
      const t = Date.now();
      taps = taps.filter(x => t - x < 3000); taps.push(t);
      if (taps.length >= 5) { taps = []; toggle(); }
    });
  });
})();
