/**
 * Tesla Model 3 Navigation - Main Application Controller
 * Enhanced with Live Weather, Battery/Energy calculations, EV Chargers layer,
 * In-Car YouTube Media Player, and Multi-Style Map Engine.
 */

// Global State
let map = null;
let carMarker = null;
let destMarker = null;

let currentBaseTileLayer = null;
let currentLabelsTileLayer = null;
let currentMapStyle = "google-roads";

let trafficEngine = null;
let trafficSignalsEngine = null;
let routingEngine = null;
let speechAssistant = null;
let weatherEngine = null;
let batteryEngine = null;
let chargersEngine = null;
let mediaEngine = null;
let yandexEngine = null;

let currentPos = { lat: 41.7166, lng: 44.7833 }; // Default Tbilisi Freedom Square
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
  try { initEventListeners(); } catch (e) { console.error("initEventListeners error:", e); }
  try { requestWakeLock(); } catch (e) { console.error("requestWakeLock error:", e); }
  try { initGeolocation(); } catch (e) { console.error("initGeolocation error:", e); }
  try { initRemoteSession(); } catch (e) { console.error("initRemoteSession error:", e); }
  try { restoreActiveRouteState(); } catch (e) { console.error("restoreActiveRouteState error:", e); }
});

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

// Map Initialization
function initMap() {
  map = L.map("map", {
    center: [currentPos.lat, currentPos.lng],
    zoom: 15,
    zoomControl: false,
    attributionControl: false,
    preferCanvas: true,        // Hardware-accelerated HTML5 Canvas for all vectors & polylines!
    fadeAnimation: false,       // Eliminates opacity transitions during tile swaps for 60 FPS
    markerZoomAnimation: true,
    inertiaDeceleration: 3200,
    inertiaMaxSpeed: 1600
  });
  window.map = map;

  // Set initial map style (persisted or Google Roads by default)
  const savedStyle = localStorage.getItem("tesla_nav_map_style");
  const initialStyle = (savedStyle === "google-sat" || savedStyle === "yandex") ? savedStyle : "google-roads";
  setMapStyle(initialStyle);

  // Custom Automotive Navigation Arrow Marker (Red Chevron with White Outline, matching photo)
  const carIcon = L.divIcon({
    className: "tesla-car-marker-container",
    html: `
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
    `,
    iconSize: [44, 44],
    iconAnchor: [22, 22]
  });

  carMarker = L.marker([currentPos.lat, currentPos.lng], {
    icon: carIcon,
    zIndexOffset: 1000
  }).addTo(map);

  map.on("click", (e) => {
    handleMapClick(e.latlng);
  });

  map.on("dragstart", () => {
    setFollowCarMode(false);
  });

  // CRITICAL FOR AUTOMOTIVE TOUCHSCREENS:
  // Prevent Leaflet from intercepting touch events or stealing clicks on UI overlays!
  const overlaySelectors = [
    ".top-bar",
    ".dock-controls",
    "#nav-hud",
    "#route-preview-card",
    ".car-hud-stats",
    "#map-style-menu",
    "#search-results",
    "#settings-modal",
    "#remote-modal",
    "#media-player-card"
  ];

  overlaySelectors.forEach(sel => {
    const el = document.querySelector(sel);
    if (el) {
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
    }
  });
}

// Map Style Switcher: Google Roads, Google Satellite, Yandex Maps
function setMapStyle(styleKey) {
  if (styleKey !== "google-sat" && styleKey !== "yandex") {
    styleKey = "google-roads";
  }
  currentMapStyle = styleKey;
  localStorage.setItem("tesla_nav_map_style", styleKey);

  if (currentBaseTileLayer) {
    map.removeLayer(currentBaseTileLayer);
    currentBaseTileLayer = null;
  }
  if (currentLabelsTileLayer) {
    map.removeLayer(currentLabelsTileLayer);
    currentLabelsTileLayer = null;
  }

  // Toggle Yandex Map container
  if (styleKey === "yandex") {
    if (yandexEngine) yandexEngine.enable();
  } else {
    if (yandexEngine) yandexEngine.disable();
  }

  // High-performance tile caching options (strictly optimized for Tesla MCU RAM limits)
  const perfTileOptions = {
    subdomains: ["0", "1", "2", "3"],
    maxZoom: 20,
    keepBuffer: 2,           // Keeps only 2 off-screen tile rings; frees RAM immediately!
    updateWhenZooming: false, // Prevents network thrashing during zoom gestures
    updateWhenIdle: true      // Loads tiles only when panning settles
  };

  if (styleKey === "google-roads") {
    // Official Google Maps Standard Roads with Georgian labels
    currentBaseTileLayer = L.tileLayer("https://mt{s}.google.com/vt/lyrs=m&hl=ka&gl=GE&x={x}&y={y}&z={z}", perfTileOptions).addTo(map);
  } else if (styleKey === "google-sat") {
    // Official Google Maps Satellite Hybrid with Georgian street labels
    currentBaseTileLayer = L.tileLayer("https://mt{s}.google.com/vt/lyrs=y&hl=ka&gl=GE&x={x}&y={y}&z={z}", perfTileOptions).addTo(map);
  }
  window.currentBaseTileLayer = currentBaseTileLayer;

  // Update body class for styling
  document.body.classList.remove("map-style-google-roads", "map-style-google-sat", "map-style-yandex");
  document.body.classList.add(`map-style-${styleKey}`);

  // Update UI selection state in menu
  document.querySelectorAll(".map-style-opt").forEach(opt => {
    opt.classList.toggle("active", opt.dataset.style === styleKey);
  });

  const btnMapStyle = document.getElementById("btn-map-style");
  if (btnMapStyle) {
    btnMapStyle.classList.toggle("yandex-active", styleKey === "yandex");
  }
}

// Global Night Mode (1-Click Dark/Light Toggle for ALL maps)
let isNightMode = localStorage.getItem("tesla_nav_night_mode") === "true";

function toggleNightMode() {
  applyNightMode(!isNightMode);
  showToast(isNightMode ? "🌙 ღამის რეჟიმი ჩართულია" : "☀️ დღის რეჟიმი ჩართულია", "info", 1800);
}

function applyNightMode(enable) {
  isNightMode = enable;
  localStorage.setItem("tesla_nav_night_mode", isNightMode ? "true" : "false");
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
  try { trafficSignalsEngine = new TrafficSignalsEngine(map); window.trafficSignalsEngine = trafficSignalsEngine; } catch (e) { console.warn("trafficSignalsEngine init notice:", e); }
  try { trafficEngine = new TrafficEngine(map); window.trafficEngine = trafficEngine; } catch (e) { console.warn("trafficEngine init notice:", e); }
  try {
    chargersEngine = new ChargersEngine(map, (chargerData) => {
      prepareRoutePreview(chargerData, chargerData.name || "EV დამტენი სადგური", chargerData.address || "ელექტრომობილის დამტენი");
    });
    window.chargersEngine = chargersEngine;
  } catch (e) { console.warn("chargersEngine init notice:", e); }
  try { mediaEngine = new MediaPlayerEngine(); window.mediaEngine = mediaEngine; } catch (e) { console.warn("mediaEngine init notice:", e); }

  // Initialize Yandex Engine (Live Traffic & Score)
  try {
    yandexEngine = new YandexEngine(map, (score) => {
      updateTrafficScoreUI(score);
    });
    window.yandexEngine = yandexEngine;
  } catch (e) { console.warn("yandexEngine init notice:", e); }

  try {
    routingEngine = new RoutingEngine(map, trafficEngine, trafficSignalsEngine, speechAssistant, batteryEngine);
    const avoidUnpavedSaved = localStorage.getItem("avoid_unpaved") === "true";
    routingEngine.setAvoidUnpaved(avoidUnpavedSaved);
    window.routingEngine = routingEngine;
  } catch (e) { console.warn("routingEngine init notice:", e); }

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
        if (arrivalEl) arrivalEl.textContent = `🔋 ჩასვლა: ${summary.batteryImpact.arrivalSoC}%`;
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
  if (socEl) socEl.textContent = `${stats.currentSoC}%`;
  if (rangeEl) rangeEl.textContent = `${stats.remainingRangeKm} კმ`;
}

// Update Top Bar Yandex Traffic Score UI
function updateTrafficScoreUI(score) {
  const badge = document.getElementById("traffic-score-badge");
  const text = document.getElementById("traffic-score-text");
  if (!badge || !text) return;

  badge.textContent = score;
  badge.className = "traffic-score-badge " + (score <= 3 ? "low" : score <= 6 ? "med" : "high");
  text.textContent = `საცობი: ${score} ბალი`;
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
      const speed = coords.speed ? Math.round(coords.speed * 3.6) : 0;
      const heading = coords.heading || currentHeading;

      currentPos = { lat, lng };
      currentHeading = heading;
      currentSpeedKmh = speed;

      updateVehicleMarker(lat, lng, heading, speed, coords.accuracy);
      fetchWeatherForPos(lat, lng);

      if (routingEngine.isNavigating && !routingEngine.isSimulating) {
        const signalAhead = routingEngine.updateVehiclePosition(currentPos, speed, heading);
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
    document.getElementById("weather-wind").textContent = `💨 ${data.windKmh} კმ/სთ`;
  }
}

// DOM element caches & dirty-checking state for vehicle updates
let lastRenderedSpeed = -1;
let lastRenderedHeading = -999;
let cachedSpeedValEl = null;
let cachedCarIconEl = null;
let lastGpsPos = null;
let lastGpsTime = 0;

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
    } else {
      // Smooth interpolation (75% new, 25% previous) to eliminate micro-jitter
      lat = lastGpsPos.lat * 0.25 + lat * 0.75;
      lng = lastGpsPos.lng * 0.25 + lng * 0.75;
    }
  }

  lastGpsPos = { lat, lng };
  lastGpsTime = now;
  currentPos = { lat, lng };
  currentHeading = headingDeg;
  currentSpeedKmh = speedKmh;

  if (carMarker) {
    carMarker.setLatLng([lat, lng]);
    if (!cachedCarIconEl) {
      const markerEl = carMarker.getElement();
      cachedCarIconEl = markerEl ? markerEl.querySelector(".tesla-car-icon-body") : document.getElementById("car-svg-icon");
    }
    // Only update transform if heading changed by at least 1 degree
    if (cachedCarIconEl && (Math.abs(headingDeg - lastRenderedHeading) >= 1 || lastRenderedHeading === -999)) {
      cachedCarIconEl.style.transform = `rotate(${headingDeg}deg)`;
      lastRenderedHeading = headingDeg;
    }
  }

  // Dirty check: only update DOM textContent when speed actually changes
  if (speedKmh !== lastRenderedSpeed) {
    if (!cachedSpeedValEl) cachedSpeedValEl = document.getElementById("speed-val");
    if (cachedSpeedValEl) cachedSpeedValEl.textContent = speedKmh;
    lastRenderedSpeed = speedKmh;
  }

  // GPS Accuracy status update
  if (accuracyMeters != null) {
    updateGpsStatusQuality(accuracyMeters);
  }

  // Forward Look-Ahead Camera Offset (TMap standard: 70m ahead along heading)
  if (isFollowCar && map) {
    let targetLat = lat;
    let targetLng = lng;
    if (headingDeg != null && (speedKmh > 5 || (routingEngine && routingEngine.isNavigating))) {
      const R = 6378137;
      const offsetDist = 70; // 70 meters forward offset
      const rad = headingDeg * (Math.PI / 180);
      const dLat = (offsetDist * Math.cos(rad)) / R;
      const dLng = (offsetDist * Math.sin(rad)) / (R * Math.cos(lat * (Math.PI / 180)));
      targetLat = lat + dLat * (180 / Math.PI);
      targetLng = lng + dLng * (180 / Math.PI);
    }
    map.panTo([targetLat, targetLng], { animate: true, duration: 0.35 });
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
  isFollowCar = enabled;
  const btn = document.getElementById("btn-follow-car");
  if (btn) {
    if (isFollowCar) {
      btn.classList.add("active");
      if (map && currentPos) {
        map.panTo([currentPos.lat, currentPos.lng]);
      }
    } else {
      btn.classList.remove("active");
    }
  }
}

// Map Click to Set Destination
function handleMapClick(latlng) {
  if (destMarker) {
    map.removeLayer(destMarker);
  }

  destMarker = L.marker(latlng, {
    icon: L.divIcon({
      className: 'dest-custom-icon',
      html: `
        <svg viewBox="0 0 24 24" width="38" height="38" fill="#e82127" style="filter: drop-shadow(0 3px 6px rgba(0,0,0,0.6));">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
        </svg>
      `,
      iconSize: [38, 38],
      iconAnchor: [19, 38]
    })
  }).addTo(map);

  const popupContent = document.createElement("div");
  popupContent.innerHTML = `
    <div style="font-weight:700; font-size:1.15rem; color:#fff;">დანიშნულების ადგილი</div>
    <div style="font-size:0.9rem; color:#94a3b8; margin:6px 0;">კოორდინატები: ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}</div>
    <button class="popup-dest-btn">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
        <path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/>
      </svg>
      აქ წასვლა (Start Route)
    </button>
  `;

  destMarker.bindPopup(popupContent).openPopup();

  const btn = popupContent.querySelector(".popup-dest-btn");
  if (btn) {
    btn.onclick = () => {
      destMarker.closePopup();
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
    if (destMarker) {
      map.removeLayer(destMarker);
    }
    destMarker = L.marker(destLatLng, {
      icon: L.divIcon({
        className: 'dest-custom-icon',
        html: `
          <svg viewBox="0 0 24 24" width="38" height="38" fill="#e82127" style="filter: drop-shadow(0 3px 6px rgba(0,0,0,0.6));">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
          </svg>
        `,
        iconSize: [38, 38],
        iconAnchor: [19, 38]
      })
    }).addTo(map);

    showToast("მარშრუტი ითვლება... ⏳", "info", 1500);

    // Calculate route with autoStart = false (Draws polyline and zooms bounds without opening Turn-by-Turn HUD)
    const route = await routingEngine.calculateRoute(currentPos, destLatLng, false);
    if (!route) return;

    pendingDestination = {
      latlng: destLatLng,
      title: destTitle,
      address: destAddress || destTitle
    };

    // Populate Preview Card UI
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
      if (arrivalEl) arrivalEl.textContent = `🔋 ჩასვლისას: ${route.batteryImpact.arrivalSoC}%`;
    } else {
      if (kwhEl) kwhEl.textContent = `⚡ ელემენტი: მზადაა`;
      if (arrivalEl) arrivalEl.textContent = `🔋 ჩასვლისას: OK`;
    }

    if (previewCard) {
      previewCard.classList.add("active");
    }
  } catch (err) {
    showToast("მარშრუტის დახაზვა ვერ მოხერხდა: " + err.message, "error");
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
  saveActiveRouteState(dest, title);
  showToast(`🚀 ნავიგაცია დაწყებულია: ${title}`, "success", 2500);
  pendingDestination = null;
}

// User cancels Route Preview (Cancel or Close clicked)
function dismissRoutePreview() {
  const previewCard = document.getElementById("route-preview-card");
  if (previewCard) previewCard.classList.remove("active");
  routingEngine.clearRoute();
  if (destMarker) {
    map.removeLayer(destMarker);
    destMarker = null;
  }
  pendingDestination = null;
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
      setTimeout(async () => {
        showToast(`🔄 მარშრუტი ავტომატურად აღდგა: ${state.destName} (Tesla Auto-Resume)`, "success", 4500);
        await startNavigation(state.dest, state.destName, false);
        if (state.stepIndex && routingEngine && routingEngine.setStepIndex) {
          routingEngine.setStepIndex(state.stepIndex);
        }
      }, 700);
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
  if (destMarker) {
    map.removeLayer(destMarker);
    destMarker = null;
  }
  document.getElementById("nav-hud").classList.remove("active");
  document.getElementById("traffic-signal-alert").classList.remove("active");
  document.getElementById("hud-battery-row").style.display = "none";
  const laneEl = document.getElementById("hud-lane-guidance");
  if (laneEl) laneEl.style.display = "none";
  document.getElementById("btn-sim-drive").classList.remove("active");
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

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (query.length < 2) return;
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=ge&limit=6&addressdetails=1&accept-language=ka,en`;
        const res = await fetch(url);
        const data = await res.json();
        renderSearchResults(data);
      } catch (e) {
        console.warn("Geocoding error:", e);
      }
    }, 320);
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
            <div class="fav-sub" title="${homeAddr || 'პარამეტრებიდან მითითება'}">${homeAddr || 'დააყენეთ...'}</div>
          </div>
        </button>
        <button type="button" class="fav-btn" id="fav-go-work">
          <span class="fav-icon">🏢</span>
          <div class="fav-text">
            <div class="fav-title">სამსახური</div>
            <div class="fav-sub" title="${workAddr || 'პარამეტრებიდან მითითება'}">${workAddr || 'დააყენეთ...'}</div>
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
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=ge&limit=1`;
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

function renderSearchResults(items) {
  const container = document.getElementById("search-results");
  container.innerHTML = "";

  if (!items || items.length === 0) {
    container.classList.remove("show");
    return;
  }

  items.forEach(item => {
    const div = document.createElement("div");
    div.className = "search-item";
    const title = item.display_name.split(",")[0];
    div.innerHTML = `
      <svg class="search-item-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
      </svg>
      <div class="search-item-info">
        <div class="search-item-title">${title}</div>
        <div class="search-item-subtitle">${item.display_name}</div>
      </div>
    `;

    div.addEventListener("click", () => {
      const latlng = { lat: parseFloat(item.lat), lng: parseFloat(item.lon) };
      container.classList.remove("show");
      document.getElementById("search-input").value = title;
      prepareRoutePreview(latlng, title, item.display_name);
    });

    container.appendChild(div);
  });

  container.classList.add("show");
}

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
  toast.innerHTML = `<span>${type === 'error' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️'}</span> <span>${message}</span>`;
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

function toggleFullscreen() {
  const doc = document;
  const docEl = document.documentElement;

  const isFs = doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || doc.msFullscreenElement;

  if (!isFs) {
    const requestFs = docEl.requestFullscreen || docEl.webkitRequestFullscreen || docEl.mozRequestFullScreen || docEl.msRequestFullscreen;
    if (requestFs) {
      requestFs.call(docEl).catch(err => console.warn("Fullscreen request notice:", err));
    }
  } else {
    const exitFs = doc.exitFullscreen || doc.webkitExitFullscreen || doc.mozCancelFullScreen || doc.msExitFullscreen;
    if (exitFs) {
      exitFs.call(doc).catch(err => console.warn("Fullscreen exit notice:", err));
    }
  }
}

// Event Listeners Setup
function initEventListeners() {
  initSearch();


  // Battery Chip Click -> Quick SoC edit prompt
  const batteryChip = document.getElementById("top-battery-chip");
  if (batteryChip) {
    batteryChip.addEventListener("click", () => {
      const current = batteryEngine.currentSoC;
      const modelName = batteryEngine.getModelConfig().name;
      const input = prompt(`მიუთითეთ Tesla-ს მიმდინარე ბატარეა (%) [${modelName}]:`, current);
      if (input !== null) {
        const val = parseInt(input, 10);
        if (!isNaN(val) && val >= 1 && val <= 100) {
          batteryEngine.setSoC(val);
        }
      }
    });
  }

  // Dock Buttons
  document.getElementById("btn-follow-car").addEventListener("click", () => {
    setFollowCarMode(!isFollowCar);
  });

  // Map Zoom Controls (+ and -)
  document.getElementById("btn-zoom-in").addEventListener("click", () => {
    if (map) map.zoomIn();
  });
  document.getElementById("btn-zoom-out").addEventListener("click", () => {
    if (map) map.zoomOut();
  });

  const btnTraffic = document.getElementById("btn-toggle-traffic");
  btnTraffic.addEventListener("click", () => {
    const enabled = trafficEngine.toggle();
    btnTraffic.classList.toggle("traffic-active", enabled);
  });

  const btnSignals = document.getElementById("btn-toggle-signals");
  btnSignals.addEventListener("click", () => {
    const enabled = trafficSignalsEngine.toggle();
    btnSignals.classList.toggle("signals-active", enabled);
  });

  // Toggle Road Incidents / Cameras (საგზაო ინციდენტები)
  const btnIncidents = document.getElementById("btn-toggle-incidents");
  if (btnIncidents) {
    btnIncidents.addEventListener("click", () => {
      const show = yandexEngine.toggleIncidents();
      btnIncidents.classList.toggle("signals-active", show);
    });
  }

  // Toggle EV Chargers Layer
  const btnChargers = document.getElementById("btn-toggle-chargers");
  if (btnChargers) {
    btnChargers.addEventListener("click", () => {
      const enabled = chargersEngine.toggle();
      btnChargers.classList.toggle("signals-active", enabled);
    });
  }

  // Toggle In-Car YouTube Media Player
  const btnMedia = document.getElementById("btn-toggle-media");
  if (btnMedia) {
    btnMedia.addEventListener("click", () => {
      const open = mediaEngine.toggle();
      btnMedia.classList.toggle("active", open);
    });
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
        const styleName = style === "yandex" ? "🟡 Yandex Maps (ცოცხალი საცობები)" : style === "google-sat" ? "🛰️ Google Satellite (ჰიბრიდი)" : "🗺️ Google Maps (ქუჩები)";
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

  // Demo Drive Simulation Button
  const btnSimDrive = document.getElementById("btn-sim-drive");
  btnSimDrive.addEventListener("click", () => {
    if (!routingEngine.activeRoute) {
      const sampleDest = { lat: 41.7082, lng: 44.7750 }; // Vake Chavchavadze
      startNavigation(sampleDest).then(() => {
        routingEngine.startSimulation();
        btnSimDrive.classList.add("active");
      });
    } else {
      if (routingEngine.isSimulating) {
        routingEngine.stopSimulation();
        btnSimDrive.classList.remove("active");
      } else {
        routingEngine.startSimulation();
        btnSimDrive.classList.add("active");
      }
    }
  });

  document.getElementById("btn-fullscreen").addEventListener("click", toggleFullscreen);
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
      saved = Math.random().toString(36).substring(2, 6).toUpperCase();
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
      const bestIp = (info.localIps && info.localIps[0]) || window.location.hostname;
      const port = info.port || window.location.port || 3000;
      const remoteUrl = `http://${bestIp}:${port}/remote.html?code=${code}`;

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
        prepareRoutePreview(latlng, payload.name, payload.name);
      } catch (err) {
        console.error("Malformed remote destination:", err);
      }
    });

    remoteEventSource.addEventListener("gps", (e) => {
      try {
        const payload = JSON.parse(e.data);
        const statusDot = document.getElementById("gps-status-dot");
        if (statusDot) statusDot.classList.add("active");

        const statusPill = document.getElementById("remote-status-pill");
        if (statusPill) {
          statusPill.innerHTML = `🟢 ტელეფონი დაკავშირებულია (±${Math.round(payload.accuracy || 0)} მ)`;
          statusPill.style.color = "#10b981";
        }

        const currentSpeed = payload.speedKmh != null ? payload.speedKmh : currentSpeedKmh;
        const currentHead = payload.heading || currentHeading;

        updateVehicleMarker(
          payload.lat,
          payload.lng,
          currentHead,
          currentSpeed,
          payload.accuracy
        );

        if (routingEngine && routingEngine.isNavigating && !routingEngine.isSimulating) {
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
