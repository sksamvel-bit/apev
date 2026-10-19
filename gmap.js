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
  const OSRM_SERVERS = [
    "https://router.project-osrm.org/route/v1/driving/",
    "https://routing.openstreetmap.de/routed-car/route/v1/driving/"
  ];
  const CATEGORIES = [
    { id: "ev", label: "⚡ დამუხტვა", type: "electric_vehicle_charging_station" },
    { id: "gas", label: "⛽ საწვავი", type: "gas_station" },
    { id: "food", label: "🍽 საკვები", type: "restaurant" },
    { id: "parking", label: "🅿 პარკინგი", type: "parking" }
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

  // ---------- the mode ----------
  const S = {
    enabled: false, key: "", open: false, map: null, traffic: null, trafficOn: true, loading: null, g: null,
    carMarker: null, carPos: null, carHeading: 0, follow: true, placeMarker: null, catMarkers: [], activeCat: null,
    routeLines: [], place: null, sessionToken: null, night: null, timers: []
  };

  const $ = (id) => document.getElementById(id);
  const say = (msg) => { if (typeof window !== "undefined" && window.showToast) window.showToast(msg, "info", 3500); };

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
      return j && j.enabled && typeof j.key === "string" && j.key ? { enabled: true, key: j.key } : { enabled: false };
    } catch (_) { return { enabled: false }; }
  }

  function currentCenter() {
    const p = window.currentPos;
    return p && isFinite(p.lat) && isFinite(p.lng) ? { lat: p.lat, lng: p.lng } : TBILISI;
  }

  function createMap() {
    const { Map, TrafficLayer } = S.g.maps;
    S.map = new Map($("gmap-canvas"), {
      center: currentCenter(), zoom: 16, disableDefaultUI: true, gestureHandling: "greedy", clickableIcons: false,
      keyboardShortcuts: false, styles: mapStyles(!!window.__night)
    });
    S.night = !!window.__night;
    S.traffic = new TrafficLayer();
    try { S.trafficOn = localStorage.getItem("gmapTraffic") !== "0"; } catch (_) { S.trafficOn = true; }
    applyTraffic();
    S.map.addListener("dragstart", () => { S.follow = false; $("gmap-btn-me") && $("gmap-btn-me").classList.remove("active"); });
  }

  function applyTraffic() {
    if (S.traffic) S.traffic.setMap(S.trafficOn ? S.map : null);
    const b = $("gmap-btn-traffic");
    if (b) b.classList.toggle("active", S.trafficOn);
  }

  function markerIcon() {
    return { path: S.g.core.SymbolPath.FORWARD_CLOSED_ARROW, scale: 6, rotation: S.carHeading, fillColor: "#3e6ae1", fillOpacity: 1, strokeColor: "#ffffff", strokeWeight: 2 };
  }

  /** Mirrors the car position the main app already tracks (window.currentPos); the heading comes from the last movement. */
  function syncCar() {
    if (!S.open || !S.map) return;
    const p = window.currentPos;
    if (!p || !isFinite(p.lat) || !isFinite(p.lng)) return;
    const pos = { lat: p.lat, lng: p.lng };
    if (S.carPos && meters(S.carPos, pos) > 4) S.carHeading = bearing(S.carPos, pos);
    const moved = !S.carPos || meters(S.carPos, pos) > 1;
    S.carPos = pos;
    if (!S.carMarker) S.carMarker = new S.g.core.Marker({ position: pos, map: S.map, icon: markerIcon(), zIndex: 999, clickable: false });
    else if (moved) { S.carMarker.setPosition(pos); S.carMarker.setIcon(markerIcon()); }
    if (S.follow && moved) S.map.panTo(pos);
    const night = !!window.__night;
    if (night !== S.night) { S.night = night; S.map.setOptions({ styles: mapStyles(night) }); }
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
      const res = await S.g.places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input: q, sessionToken: S.sessionToken, language: "ka", region: "ge", includedRegionCodes: ["ge"],
        locationBias: { center, radius: 30000 }
      });
      renderSuggestions((res && res.suggestions) || []);
    } catch (e) {
      setStatus("ძიება ვერ მუშაობს: ჩართულია თუ არა Places API (New) თქვენს Google პროექტში?");
      console.warn("[GMap] autocomplete:", e && e.message);
    }
  }

  async function choosePrediction(pp) {
    try {
      const place = pp.toPlace();
      await place.fetchFields({ fields: ["displayName", "formattedAddress", "location"] });
      S.sessionToken = null; // a session ends with the selection (billing: one session = autocomplete + one details call)
      clearResults();
      const input = $("gmap-search-input");
      if (input) input.value = place.displayName || "";
      showPlace({ name: place.displayName || "", address: place.formattedAddress || "", loc: place.location });
    } catch (e) {
      setStatus("ადგილის დეტალები ვერ ჩაიტვირთა");
      console.warn("[GMap] place details:", e && e.message);
    }
  }

  function clearRoute() { S.routeLines.forEach((l) => l.setMap(null)); S.routeLines = []; }

  function showPlace(p) {
    const loc = p.loc && typeof p.loc.lat === "function" ? { lat: p.loc.lat(), lng: p.loc.lng() } : p.loc;
    if (!loc) return;
    S.place = { name: p.name, address: p.address, loc };
    clearRoute();
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
    clearRoute();
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

  async function routeToPlace() {
    if (!S.place) return;
    const btn = $("gmap-card-go"), info = $("gmap-card-route");
    btn.disabled = true;
    info.textContent = "ითვლება...";
    try {
      const from = S.carPos || currentCenter();
      const r = await fetchRoute(from, S.place.loc);
      clearRoute();
      const { Polyline } = S.g.maps;
      S.routeLines = [
        new Polyline({ path: r.coords, map: S.map, strokeColor: "#ffffff", strokeOpacity: 1, strokeWeight: 10, zIndex: 10 }),
        new Polyline({ path: r.coords, map: S.map, strokeColor: "#3e6ae1", strokeOpacity: 1, strokeWeight: 6, zIndex: 11 })
      ];
      const bounds = new S.g.core.LatLngBounds();
      r.coords.forEach((c) => bounds.extend(c));
      S.follow = false;
      S.map.fitBounds(bounds, 90);
      info.textContent = summarizeRoute(r.durationSec, r.distanceM) + " (საცობების გარეშე ანგარიში)";
    } catch (e) {
      info.textContent = "მარშრუტი ვერ დაითვალა: " + (e && e.message);
    } finally { btn.disabled = false; }
  }

  // ---------- category chips (nearby search) ----------
  function clearCategory() {
    S.catMarkers.forEach((m) => m.setMap(null));
    S.catMarkers = [];
    S.activeCat = null;
    document.querySelectorAll("#gmap-layer .gmap-chip").forEach((b) => b.classList.remove("active"));
  }

  async function toggleCategory(cat, chipEl) {
    if (S.activeCat === cat.id) { clearCategory(); return; }
    clearCategory();
    S.activeCat = cat.id;
    chipEl.classList.add("active");
    try {
      const c = S.map.getCenter();
      const { places } = await S.g.places.Place.searchNearby({
        fields: ["displayName", "formattedAddress", "location"], includedPrimaryTypes: [cat.type], maxResultCount: 15,
        locationRestriction: { center: { lat: c.lat(), lng: c.lng() }, radius: 3000 }, language: "ka", region: "ge"
      });
      if (S.activeCat !== cat.id) return;
      (places || []).forEach((pl) => {
        const m = new S.g.core.Marker({ position: pl.location, map: S.map, title: pl.displayName || "", zIndex: 500 });
        m.addListener("click", () => showPlace({ name: pl.displayName || "", address: pl.formattedAddress || "", loc: pl.location }));
        S.catMarkers.push(m);
      });
      if (!places || !places.length) say("ახლოს ვერაფერი მოიძებნა");
    } catch (e) {
      setStatus("კატეგორიის ძიება ვერ მუშაობს: ჩართულია თუ არა Places API (New)?");
      console.warn("[GMap] nearby:", e && e.message);
      clearCategory();
    }
  }

  // ---------- open / close ----------
  async function open() {
    if (!S.enabled || S.open) return;
    const layer = $("gmap-layer");
    if (!layer) return;
    S.open = true;
    layer.classList.add("show");
    document.body.classList.add("gmap-open");
    setStatus("Google რუკა იტვირთება...");
    try {
      await loadGoogle(S.key);
      if (!S.open) return;
      if (!S.map) createMap();
      setStatus("");
      S.follow = true;
      $("gmap-btn-me") && $("gmap-btn-me").classList.add("active");
      syncCar();
      S.timers.push(setInterval(syncCar, 1000));
    } catch (e) {
      setStatus((e && e.message) || "Google რუკა მიუწვდომელია");
    }
  }

  function close() {
    if (!S.open) return;
    S.open = false;
    S.timers.forEach(clearInterval);
    S.timers = [];
    const layer = $("gmap-layer");
    if (layer) layer.classList.remove("show");
    document.body.classList.remove("gmap-open");
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
      if (S.carPos) S.map.panTo(S.carPos);
    });
    on("gmap-btn-traffic", "click", () => {
      S.trafficOn = !S.trafficOn;
      try { localStorage.setItem("gmapTraffic", S.trafficOn ? "1" : "0"); } catch (_) {}
      applyTraffic();
    });
    on("gmap-card-close", "click", closeCard);
    on("gmap-card-go", "click", routeToPlace);
    const input = $("gmap-search-input");
    if (input) {
      const deb = createDebouncer(suggest, 300);
      input.addEventListener("input", () => { if (input.value.trim().length < 3) { deb.cancel(); clearResults(); } else deb(input.value); });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { deb.cancel(); suggest(input.value); } });
    }
    on("gmap-search-clear", "click", () => { if (input) input.value = ""; clearResults(); closeCard(); });
    const chips = $("gmap-chips");
    if (chips) {
      CATEGORIES.forEach((cat) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "gmap-chip";
        b.textContent = cat.label;
        b.addEventListener("click", () => { if (S.map) toggleCategory(cat, b); });
        chips.appendChild(b);
      });
    }
  }

  async function init() {
    if (typeof document === "undefined") return;
    wireUi();
    const cfg = await fetchConfig();
    S.enabled = cfg.enabled;
    S.key = cfg.key || "";
    const btn = $("btn-google-mode");
    if (btn) btn.hidden = !S.enabled;
  }

  const api = { init, open, close, isOpen: () => S.open, buildLoaderUrl, createDebouncer, osrmUrl, summarizeRoute, mapStyles, bearing, meters, CATEGORIES };
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => init());
    else init();
  }
  return api;
});
