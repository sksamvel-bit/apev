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
    const k0 = Math.cos(pos.lat * Math.PI / 180);
    const xy = (p) => ({ x: (p.lng - pos.lng) * k0, y: p.lat - pos.lat });
    const t = (a, b) => { const A = xy(a), B = xy(b), dx = B.x - A.x, dy = B.y - A.y, L = dx * dx + dy * dy; return L ? ((0 - A.x) * dx + (0 - A.y) * dy) / L : 1; };
    if (!from && t(steps[0].loc, n > 1 ? steps[1].loc : steps[0].loc) <= 0 && meters(pos, steps[0].loc) > 25) return 0;
    for (let k = Math.max(from || 0, 1); k < n; k++) if (t(steps[k - 1].loc, steps[k].loc) < 1) return k;
    return n - 1;
  }

  function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + " კმ" : Math.round(m / 10) * 10 + " მ"; }

  // ---------- the mode ----------
  const S = {
    enabled: false, key: "", open: false, map: null, traffic: null, trafficOn: true, loading: null, g: null,
    carMarker: null, carPos: null, carHeading: 0, follow: true, placeMarker: null, catMarkers: [], activeCat: null,
    routeLines: [], routes: [], routeIdx: 0, stepIdx: 0, navigating: false, place: null, sessionToken: null, night: null, timers: []
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
    if (S.navigating) updateNavBanner();
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

  /** Traffic-aware routes via our server (/api/route): the server holds the key and enforces the daily/monthly call cap. */
  async function fetchGoogleRoutes(from, to, departInMin) {
    const url = "/api/route?from=" + from.lat.toFixed(6) + "," + from.lng.toFixed(6) + "&to=" + to.lat.toFixed(6) + "," + to.lng.toFixed(6) + "&depart=" + (departInMin || 0);
    const r = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    if (!r.ok) {
      let code = "http" + r.status;
      try { const j = await r.json(); if (j && j.error) code = j.error + (j.reason ? ":" + j.reason : ""); } catch (_) {}
      const e = new Error("Routes: " + code); e.code = code; throw e;
    }
    const routes = parseRoutesResponse(await r.json());
    if (!routes.length) { const e = new Error("Routes: no route"); e.code = "empty"; throw e; }
    return routes;
  }

  function fallbackNote(code) {
    if (/^cap/.test(code)) return "Google მარშრუტების ლიმიტი ამოიწურა (" + (/month/.test(code) ? "თვის" : "დღის") + "), ნაჩვენებია OSRM მარშრუტი ტრაფიკის გარეშე.";
    if (code === "no-key") return "Google მარშრუტის გასაღები არ არის დაყენებული (GOOGLE_ROUTES_KEY), ნაჩვენებია OSRM მარშრუტი ტრაფიკის გარეშე.";
    return "Google მარშრუტი ვერ მუშაობს, ნაჩვენებია OSRM მარშრუტი ტრაფიკის გარეშე.";
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
    S.routeIdx = i; S.stepIdx = 0;
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
    nav.classList.add("show");
  }

  function startNavigation() {
    if (!S.routes.length) return;
    S.navigating = true; S.follow = true; S.stepIdx = 0;
    $("gmap-btn-me") && $("gmap-btn-me").classList.add("active");
    $("gmap-card").classList.remove("show");
    S.map.setZoom(17);
    if (S.carPos) S.map.panTo(S.carPos);
    updateNavBanner();
  }

  function stopNavigation() {
    S.navigating = false;
    const nav = $("gmap-nav");
    if (nav) nav.classList.remove("show");
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
    stopNavigation();
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
    on("gmap-card-start", "click", startNavigation);
    on("gmap-nav-stop", "click", () => { stopNavigation(); const c = $("gmap-card"); if (c && S.place) c.classList.add("show"); });
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

  const api = { init, open, close, isOpen: () => S.open, decodePolyline, parseRoutesResponse, routesRequestBody, nextStepIndex, fmtDist, buildLoaderUrl, createDebouncer, osrmUrl, summarizeRoute, mapStyles, bearing, meters, CATEGORIES };
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => init());
    else init();
  }
  return api;
});
