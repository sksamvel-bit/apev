/**
 * Routing Engine
 * Integrates OSRM driving routes, Turn-by-Turn maneuver translations,
 * active path tracking, Demo Drive Simulation, and Battery consumption estimates.
 */

class RoutingEngine {
  constructor(map, trafficEngine, trafficSignalsEngine, speechAssistant, batteryEngine) {
    this.map = map;
    this.trafficEngine = trafficEngine;
    this.trafficSignalsEngine = trafficSignalsEngine;
    this.speech = speechAssistant;
    this.batteryEngine = batteryEngine;

    this.activeRoute = null;
    // Route geometry lives here (not only inside the map) so that it survives a map style switch
    this.routeGeo = { upcoming: RoutingEngine.emptyGeo(), passed: RoutingEngine.emptyGeo() };
    this.steps = [];
    this.currentStepIndex = 0;
    this.isNavigating = false;
    this.offRouteStrikes = 0;
    this.isRerouting = false;
    this.lastClosestIndex = 0;

    // Callbacks for UI updates
    this.onManeuverUpdate = null;
    this.onSummaryUpdate = null;
    this.avoidUnpaved = false;
    this.onArrival = null;
    this.onPositionUpdate = null;

    // Alternatives (preview only): other OSRM routes drawn in grey, tap one (or its time label) to switch
    this.altRoutes = [];
    this.altCtx = null;
    this.altGeo = RoutingEngine.emptyGeo();
    this.altMarkers = [];
    this.onRouteSelected = null;

    this.registerMapLayers();
    if (map && typeof map.on === "function") {
      map.on("click", "route-alt-line", (e) => {
        const f = e && e.features && e.features[0];
        if (f && f.properties && f.properties.k != null) this.selectAlternative(Number(f.properties.k));
      });
    }
  }

  /** Keeps up to 2 genuinely different alternatives (not near-copies of the best route, not absurdly slow). */
  static pickAlternatives(routes) {
    const best = routes[0];
    const out = [];
    for (let k = 1; k < routes.length && out.length < 2; k++) {
      const r = routes[k];
      if (!r || !r.geometry || !r.geometry.coordinates || r.geometry.coordinates.length < 2) continue;
      if (r.duration > best.duration * 1.6 + 120) continue;
      const same = (o) => Math.abs(r.duration - o.duration) < o.duration * 0.03 && Math.abs(r.distance - o.distance) < o.distance * 0.03;
      if (same(best) || out.some((j) => same(routes[j]))) continue; // near-copy of the active route or of one already kept
      out.push(k);
    }
    return out;
  }

  static emptyGeo() {
    return { type: "FeatureCollection", features: [] };
  }

  static lineGeo(latlngs) {
    if (!latlngs || latlngs.length < 2) return RoutingEngine.emptyGeo();
    return {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: latlngs.map(p => [p[1], p[0]]) }
    };
  }

  /** Route line layers (MapLibre). Registered once; re-injected by the layer registry after every style switch. */
  registerMapLayers() {
    const reg = typeof window !== "undefined" ? window.layerRegistry : null;
    if (!reg) return;
    const round = { "line-cap": "round", "line-join": "round" };
    reg.register("route", {
      where: "labels",
      sources: () => ({
        "route-alt-source": { type: "geojson", data: this.altGeo },
        "route-passed-source": { type: "geojson", data: this.routeGeo.passed },
        "route-source": { type: "geojson", data: this.routeGeo.upcoming }
      }),
      layers: () => {
        const tl = typeof window !== "undefined" && window.__teslaLook && window.TeslaStyle ? window.TeslaStyle.routeColors(!!window.__night, window.__lookMode) : null;
        return [
        { id: "route-alt-casing", type: "line", source: "route-alt-source", layout: round,
          paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.7 } },
        { id: "route-alt-line", type: "line", source: "route-alt-source", layout: round,
          paint: { "line-color": "#8a93a0", "line-width": 6, "line-opacity": 0.95 } },
        { id: "route-passed-line", type: "line", source: "route-passed-source", layout: round,
          paint: { "line-color": "#64748b", "line-width": 5, "line-opacity": 0.6 } },
        { id: "route-casing", type: "line", source: "route-source", layout: round,
          paint: { "line-color": tl ? tl.casing : "#003b66", "line-width": 10, "line-opacity": 0.75 } },
        { id: "route-line", type: "line", source: "route-source", layout: round,
          paint: { "line-color": tl ? tl.line : "#00d2ff", "line-width": 6, "line-opacity": 0.95 } }
        ];
      }
    });
  }

  setAvoidUnpaved(avoid) {
    this.avoidUnpaved = !!avoid;
  }

  setStepIndex(idx) {
    if (idx >= 0 && idx < this.steps.length) {
      this.currentStepIndex = idx;
      this.updateManeuverHUD(this.steps[idx], this.steps[idx].distanceMeters);
    }
  }

  parseCoord(pt) {
    if (!pt) return null;
    if (Array.isArray(pt) && pt.length >= 2) {
      const lat = Number(pt[0]);
      const lng = Number(pt[1]);
      if (!isNaN(lat) && !isNaN(lng) && isFinite(lat) && isFinite(lng)) return { lat, lng };
    }
    const lat = Number(pt.lat ?? pt.latitude);
    const lng = Number(pt.lng ?? pt.longitude ?? pt.lon);
    if (!isNaN(lat) && !isNaN(lng) && isFinite(lat) && isFinite(lng)) {
      return { lat, lng };
    }
    return null;
  }

  async calculateRoute(startLatLng, endLatLng, autoStart = false, opts = {}) {
    // Clear previous route only AFTER a new one was fetched successfully,
    // so network failure preserves active navigation.

    const start = this.parseCoord(startLatLng);
    const end = this.parseCoord(endLatLng);
    if (!start || !end) {
      throw new Error("არასწორი კოორდინატები");
    }

    // Alternatives only for a preview (not while driving / rerouting: those must be fast and unambiguous)
    const wantAlt = !autoStart && opts.alternatives !== false;
    const query = `${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson&steps=true&alternatives=${wantAlt ? "true" : "false"}`;

    const routingServers = [
      "https://router.project-osrm.org/route/v1/driving/",
      "https://routing.openstreetmap.de/routed-car/route/v1/driving/"
    ];

    let data = null;
    let lastError = null;

    for (const server of routingServers) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000); // 9 s timeout
      try {
        const response = await fetch(server + query, { signal: ctrl.signal });
        if (!response.ok) {
          throw new Error(`Routing server (${new URL(server).hostname}) returned HTTP ${response.status}`);
        }
        const resJson = await response.json();
        if (resJson && resJson.routes && resJson.routes.length > 0) {
          data = resJson;
          break; // Succeeded!
        }
      } catch (err) {
        lastError = err;
        console.warn(`[Routing] Server ${server} failed, trying fallback:`, err.message);
      } finally {
        clearTimeout(timer);
      }
    }

    if (!data || !data.routes || data.routes.length === 0) {
      throw lastError || new Error("მარშრუტი ვერ მოიძებნა");
    }

    return this.applyRoute(data.routes, 0, start, end, endLatLng, autoStart, opts, wantAlt);
  }

  /** Makes routes[idx] the active route (used for the first calculation and when the user taps an alternative). */
  applyRoute(routes, idx, start, end, endLatLng, autoStart, opts, wantAlt) {
    this.clearRoute(); // success -> now replace the old route

    const route = routes[idx];
    const geojsonCoords = route.geometry.coordinates; // [lon, lat]
    const latlngs = geojsonCoords.map(c => [c[1], c[0]]);

    // Render realistic traffic colored segments
    const trafficDelayMin = this.trafficEngine
      ? this.trafficEngine.renderRouteCongestion(latlngs, route.duration)
      : 0;

    const distKm = route.distance / 1000;
    const batteryImpact = this.batteryEngine
      ? this.batteryEngine.calculateTripEnergy(distKm)
      : null;

    this.activeRoute = {
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      coordinates: latlngs,
      rawSteps: route.legs && route.legs[0] ? route.legs[0].steps : [],
      trafficDelayMin: trafficDelayMin,
      batteryImpact: batteryImpact,
      destination: end,
      destName: endLatLng.name || end.name || "დანიშნულების ადგილი"
    };

    this.lastClosestIndex = 0;
    this.offRouteStrikes = 0;
    this.arrivalFired = false;

    // Render route on map
    this.setRouteData(latlngs, []);
    if (wantAlt) this.setAlternatives(routes, idx, { start, end, endLatLng });

    // Fit bounds nicely with padding for the preview card. Not when navigation starts right away
    // (the camera follows the car) and not for a reroute (opts.fit === false keeps the driving zoom).
    if (opts.fit !== false && !autoStart && this.map && typeof this.map.fitBounds === "function") {
      if (typeof window !== "undefined" && typeof window.onBeforeRouteFit === "function") window.onBeforeRouteFit();
      const bounds = this.getLngLatBounds(geojsonCoords);
      if (bounds) {
        this.map.fitBounds(bounds, {
          padding: { top: 40, bottom: 40, left: 420, right: 40 },
          duration: 800,
          maxZoom: 17
        });
      }
    }

    // Parse Turn-by-Turn Steps
    if (route.legs && route.legs[0] && route.legs[0].steps) {
      this.parseSteps(route.legs[0].steps, latlngs);
    }

    // Initial Summary update
    this.updateRouteSummary({ lat: start.lat, lng: start.lng });

    // Fetch additional traffic signals along route bounds
    if (this.trafficSignalsEngine && typeof this.trafficSignalsEngine.fetchSignalsAlongRoute === "function") {
      this.trafficSignalsEngine.fetchSignalsAlongRoute(latlngs);
    }

    if (autoStart) {
      this.startNavigation(!!opts.silent);
    }

    return this.activeRoute;
  }

  /** Draw the other routes in grey with a "N წთ (+M)" label each. */
  setAlternatives(routes, activeIdx, ctx) {
    this.altCtx = { routes, ctx };
    const best = routes[activeIdx];
    const alts = routes.map((r, k) => k).filter((k) => k !== activeIdx);
    // keep only distinct, reasonable ones (relative to the ACTIVE route; routes[0] is OSRM's fastest)
    const base = [best].concat(alts.map((k) => routes[k]));
    const mainPts = best.geometry.coordinates;
    const margin = Math.min(1000, best.distance * 0.15);
    const keep = [];
    const labelPos = {};
    RoutingEngine.pickAlternatives(base).map((j) => alts[j - 1]).forEach((k) => {
      // A real alternative leaves the main route by at least 400 m somewhere away from start/end
      // (OSRM also returns tiny U-turn loops at the ends: those are noise, not choices)
      const dv = RoutingEngine.divergence(routes[k].geometry.coordinates, mainPts, margin);
      if (dv.pos && dv.maxDist >= 400) { keep.push(k); labelPos[k] = dv.pos; }
    });
    this.altRoutes = keep;
    const feats = keep.map((k) => ({
      type: "Feature", properties: { k },
      geometry: { type: "LineString", coordinates: routes[k].geometry.coordinates }
    }));
    this.altGeo = { type: "FeatureCollection", features: feats };
    this.pushAltData();
    this.clearAltMarkers();
    if (typeof document === "undefined" || !this.map || typeof maplibregl === "undefined") return;
    keep.forEach((k) => {
      const r = routes[k];
      const mins = Math.max(1, Math.round(r.duration / 60));
      const diff = Math.round((r.duration - best.duration) / 60);
      const el = document.createElement("div");
      el.className = "route-alt-label";
      el.textContent = mins + " წთ" + (diff !== 0 ? " (" + (diff > 0 ? "+" : "") + diff + ")" : "");
      el.addEventListener("click", (ev) => { ev.stopPropagation(); this.selectAlternative(k); });
      try { this.altMarkers.push(new maplibregl.Marker({ element: el }).setLngLat(labelPos[k]).addTo(this.map)); } catch (_) {}
    });
  }

  /**
   * How far (m) the alternative really leaves the main route, and where: the vertex of the alternative that is
   * farthest from the main route, ignoring the first/last `margin` metres. Returns { maxDist, pos } (pos = [lng, lat],
   * also the best place for the label).
   */
  static divergence(altCoords, mainCoords, margin) {
    const kx = 111139 * Math.cos(mainCoords[0][1] * Math.PI / 180), ky = 111139;
    const first = mainCoords[0], last = mainCoords[mainCoords.length - 1];
    const stepM = Math.max(1, Math.floor(mainCoords.length / 1500));
    const stepA = Math.max(1, Math.floor(altCoords.length / 80));
    const dist = (a, p) => Math.hypot((a[0] - p[0]) * kx, (a[1] - p[1]) * ky);
    let best = null, bd = -1;
    for (let i = 0; i < altCoords.length; i += stepA) {
      const a = altCoords[i];
      if (dist(a, first) < margin || dist(a, last) < margin) continue;
      let md = Infinity;
      for (let j = 0; j < mainCoords.length; j += stepM) {
        const d = dist(a, mainCoords[j]);
        if (d < md) md = d;
      }
      if (md > bd) { bd = md; best = a; }
    }
    return { maxDist: bd, pos: best };
  }

  pushAltData() {
    if (!this.map || typeof this.map.getSource !== "function") return;
    const src = this.map.getSource("route-alt-source");
    if (src && typeof src.setData === "function") src.setData(this.altGeo);
  }

  clearAltMarkers() {
    this.altMarkers.forEach((m) => { try { m.remove(); } catch (_) {} });
    this.altMarkers = [];
  }

  /** Switch the preview to alternative k (index in the OSRM answer). No refit: the user keeps the view. */
  selectAlternative(k) {
    if (!this.altCtx || this.isNavigating || !this.altCtx.routes[k]) return null;
    const { routes, ctx } = this.altCtx;
    const route = this.applyRoute(routes, k, ctx.start, ctx.end, ctx.endLatLng, false, { fit: false }, true);
    if (typeof this.onRouteSelected === "function") this.onRouteSelected(route);
    return route;
  }

  parseSteps(rawSteps, allLatlngs) {
    this.steps = [];
    if (!rawSteps || rawSteps.length === 0) return;

    rawSteps.forEach((step, idx) => {
      const maneuver = step.maneuver || {};
      const type = maneuver.type || "continue";
      const modifier = maneuver.modifier || "";
      const streetName = step.name ? step.name.trim() : "გზა";

      let instruction = "იარეთ პირდაპირ";
      let icon = "straight";

      if (type === "depart") {
        instruction = "დაიწყეთ მოძრაობა";
        icon = "straight";
      } else if (type === "arrive") {
        instruction = "მიხვედით დანიშნულების ადგილზე";
        icon = "arrive";
      } else if (type === "roundabout" || type === "rotary") {
        instruction = "შედით წრიულ მოძრაობაზე";
        icon = "roundabout";
      } else if (modifier.includes("left")) {
        instruction = modifier.includes("slight") ? "ოდნავ მარცხნივ" : "მოუხვიეთ მარცხნივ";
        icon = "turn-left";
      } else if (modifier.includes("right")) {
        instruction = modifier.includes("slight") ? "ოდნავ მარჯვნივ" : "მოუხვიეთ მარჯვნივ";
        icon = "turn-right";
      } else if (modifier.includes("uturn")) {
        instruction = "მობრუნდით უკან";
        icon = "u-turn";
      }

      const loc = maneuver.location ? [maneuver.location[1], maneuver.location[0]] : [0, 0];

      this.steps.push({
        index: idx,
        instruction: instruction,
        streetName: streetName,
        distanceMeters: Math.round(step.distance || 0),
        durationSec: Math.round(step.duration || 0),
        location: loc,
        icon: icon
      });
    });

    // Cumulative distance along the route polyline + position of every maneuver ON the route
    const cum = [0];
    for (let k = 1; k < allLatlngs.length; k++) {
      cum.push(cum[k - 1] + this.haversineMeters(allLatlngs[k - 1][0], allLatlngs[k - 1][1], allLatlngs[k][0], allLatlngs[k][1]));
    }
    this.cumDist = cum;
    this.stepRouteDist = [];
    let from = 0;
    this.steps.forEach((s, k) => {
      if (k === 0) { this.stepRouteDist.push(0); return; }
      if (k === this.steps.length - 1) { this.stepRouteDist.push(cum[cum.length - 1]); return; }
      let best = from, bd = Infinity;
      for (let j = from; j < allLatlngs.length; j++) {
        const d = this.haversineMeters(s.location[0], s.location[1], allLatlngs[j][0], allLatlngs[j][1]);
        if (d < bd) { bd = d; best = j; }
      }
      from = best;
      this.stepRouteDist.push(cum[best]);
    });

    this.currentStepIndex = 0;
    this.isNavigating = false;
    this.announced = new Set();
  }

  // Distance travelled along the route (projection onto the current segment)
  progressMeters(pos) {
    const coords = this.activeRoute.coordinates;
    const cum = this.cumDist;
    const i = Math.max(0, Math.min(this.lastClosestIndex, coords.length - 2));
    const a = coords[i], b = coords[i + 1];
    const cos = Math.cos(pos.lat * Math.PI / 180);
    const abx = (b[1] - a[1]) * cos, aby = b[0] - a[0];
    const apx = (pos.lng - a[1]) * cos, apy = pos.lat - a[0];
    const l2 = abx * abx + aby * aby;
    let t = l2 ? (apx * abx + apy * aby) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return cum[i] + t * (cum[i + 1] - cum[i]);
  }

  /** One voice at a time: while Google mode (gmap.js) navigates, its own prompts speak and this route stays quiet. */
  say(text) {
    if (this.speech && !(typeof window !== "undefined" && window.__gmapNavigating)) this.speech.speak(text);
  }

  // Voice prompts BEFORE the maneuver (500 / 200 m / now; 800 / 300 / 80 m above 70 km/h)
  announceApproach(step, idx, dist, speedKmh) {
    if (!this.speech || idx === 0 || !step) return;
    const tiers = speedKmh > 70 ? [800, 300, 80] : [500, 200, 50];
    let crossed = -1;
    tiers.forEach((t, k) => {
      if (dist <= t && !this.announced.has(k)) { this.announced.add(k); crossed = k; }
    });
    if (crossed < 0) return; // if several tiers crossed at once, only the closest is spoken
    const street = step.streetName && step.streetName !== "გზა" ? ` ${step.streetName}-ზე` : "";
    let text;
    if (crossed === tiers.length - 1) {
      text = `${step.instruction}${street}`;
    } else {
      const rounded = Math.max(10, Math.round(dist / 10) * 10);
      text = `${rounded} მეტრში, ${step.instruction}${street}`;
    }
    this.say(text);
  }

  /** Remove the grey alternatives (lines + labels) without touching the active route. */
  clearAlternatives() {
    this.altRoutes = [];
    this.altCtx = null;
    this.altGeo = RoutingEngine.emptyGeo();
    this.pushAltData();
    this.clearAltMarkers();
  }

  startNavigation(silent = false) {
    this.clearAlternatives(); // driving: only the chosen route stays on the map (fewer layers/markers on the MCU2)
    this.isNavigating = true;
    this.announced = new Set();
    if (this.steps.length > 0) {
      this.updateManeuverHUD(this.steps[this.currentStepIndex], this.steps[this.currentStepIndex].distanceMeters);
      if (this.speech && !silent) {
        let voiceText = "მარშრუტი დაწყებულია. ";
        const firstStep = this.steps[this.currentStepIndex];
        if (firstStep) {
          voiceText += `${firstStep.instruction}`;
          if (firstStep.streetName && firstStep.streetName !== "გზა") {
            voiceText += ` ${firstStep.streetName}-ზე`;
          }
        }
        this.say(voiceText);
      }
    }
  }

  updateVehiclePosition(currentLatLng, speedKmh = 0, headingDeg = 0) {
    if (!this.isNavigating || !this.activeRoute || this.steps.length === 0) return null;

    // 1. Dynamic Polyline Trimming & Off-Route Detection
    const coords = this.activeRoute.coordinates;
    if (coords && coords.length > 1) {
      let minDeviation = Infinity;
      let bestSegIndex = this.lastClosestIndex;

      // Local search window around last known position for high performance
      const searchStart = Math.max(0, this.lastClosestIndex - 2);
      const searchEnd = Math.min(coords.length - 1, this.lastClosestIndex + 30);

      for (let i = searchStart; i < searchEnd; i++) {
        const d = this.distanceToSegmentMeters(currentLatLng, coords[i], coords[i + 1]);
        if (d < minDeviation) {
          minDeviation = d;
          bestSegIndex = i;
        }
      }

      // If deviation is high in local window, do a global scan in case vehicle jumped
      if (minDeviation > 45) {
        for (let i = 0; i < coords.length - 1; i++) {
          const d = this.distanceToSegmentMeters(currentLatLng, coords[i], coords[i + 1]);
          if (d < minDeviation) {
            minDeviation = d;
            bestSegIndex = i;
          }
        }
      }

      this.lastClosestIndex = bestSegIndex;

      // Dynamically trim polylines: passed part is gray, upcoming part is cyan
      // OPTIMIZATION: only rebuild and redraw if segment advanced or vehicle moved > 15m
      // Prevents 10,000 throwaway array objects/sec and continuous canvas repaints on Intel Atom
      const segChanged = bestSegIndex !== this.lastTrimSegIndex;
      let movedEnough = true;
      if (!segChanged && this.lastTrimPos) {
        const dLat = Math.abs(currentLatLng.lat - this.lastTrimPos.lat);
        const dLng = Math.abs(currentLatLng.lng - this.lastTrimPos.lng);
        if (dLat < 0.00012 && dLng < 0.00015) movedEnough = false; // ~15m
      }

      if (segChanged || movedEnough) {
        this.lastTrimSegIndex = bestSegIndex;
        this.lastTrimPos = { lat: currentLatLng.lat, lng: currentLatLng.lng };

        const passedPart = coords.slice(0, bestSegIndex + 1);
        passedPart.push([currentLatLng.lat, currentLatLng.lng]);
        const upcomingPart = [[currentLatLng.lat, currentLatLng.lng], ...coords.slice(bestSegIndex + 1)];
        this.setRouteData(upcomingPart, passedPart);
      }

      // Off-route check: > 38 meters deviation for 3 consecutive GPS updates
      if (minDeviation > 38) {
        this.offRouteStrikes++;
        if (this.offRouteStrikes >= 3 && !this.isRerouting) {
          this.triggerAutoReroute(currentLatLng);
        }
      } else {
        this.offRouteStrikes = 0;
      }
    }

    // Step logic driven by progress ALONG the route (immune to skipped GPS fixes)
    const progress = this.progressMeters(currentLatLng);
    let idx = this.currentStepIndex;
    while (idx < this.steps.length - 1 && this.stepRouteDist[idx] < progress - 20) idx++;
    if (idx !== this.currentStepIndex) {
      this.currentStepIndex = idx;
      this.announced = new Set();
    }
    const step = this.steps[idx];
    if (!step) return null;
    const distToManeuver = Math.max(0, Math.round(this.stepRouteDist[idx] - progress));

    // Arrival (fires once)
    const totalLen = this.cumDist[this.cumDist.length - 1];
    if (!this.arrivalFired && idx >= this.steps.length - 1 && totalLen - progress < 40) {
      this.arrivalFired = true;
      if (this.onArrival) this.onArrival();
    }

    this.updateManeuverHUD(step, distToManeuver);
    this.announceApproach(step, idx, distToManeuver, speedKmh);

    // Check upcoming traffic signal
    let upcomingSignal = null;
    if (this.trafficSignalsEngine && this.activeRoute.coordinates) {
      upcomingSignal = this.trafficSignalsEngine.findUpcomingSignal(
        currentLatLng, headingDeg, this.activeRoute.coordinates
      );
    }

    // Update summary ETA & remaining distance
    this.updateRouteSummary(currentLatLng);

    return upcomingSignal;
  }

  async triggerAutoReroute(currentLatLng) {
    if (this.isRerouting || !this.activeRoute || !this.activeRoute.destination) return;
    if (Date.now() - (this.lastRerouteAt || 0) < 10000) return; // 10 s back-off
    this.lastRerouteAt = Date.now();
    this.isRerouting = true;
    this.offRouteStrikes = 0;

    const dest = this.activeRoute.destination;
    const destName = this.activeRoute.destName;

    if (window.showToast) {
      window.showToast("🔄 მარშრუტს აცდით — ახლდება...", "info", 3000);
    }
    if (this.speech) {
      this.say("მარშრუტს აცდით. ახალი მარშრუტი ითვლება.");
    }

    try {
      dest.name = destName;
      await this.calculateRoute(currentLatLng, dest, true, { fit: false, silent: true });
    } catch (err) {
      console.warn("Auto-reroute failed (old route kept):", err);
      if (window.showToast) window.showToast("გადათვლა ვერ მოხერხდა — ძველი მარშრუტი რჩება", "error", 3000);
    } finally {
      this.isRerouting = false;
    }
  }

  distanceToSegmentMeters(p, a, b) {
    const latMid = (p.lat * Math.PI) / 180;
    const cosLat = Math.cos(latMid);
    const mPerDegLat = 111139;
    const mPerDegLng = 111139 * cosLat;

    const px = p.lng * mPerDegLng;
    const py = p.lat * mPerDegLat;
    const ax = a[1] * mPerDegLng;
    const ay = a[0] * mPerDegLat;
    const bx = b[1] * mPerDegLng;
    const by = b[0] * mPerDegLat;

    const abx = bx - ax;
    const aby = by - ay;
    const segLenSq = abx * abx + aby * aby;
    if (segLenSq === 0) {
      return Math.hypot(px - ax, py - ay);
    }
    const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / segLenSq));
    const projX = ax + t * abx;
    const projY = ay + t * aby;
    return Math.hypot(px - projX, py - projY);
  }

  // Fake lanes removed: no real lane data -> show nothing
  getLaneGuidance(icon) {
    return [];
  }

  updateManeuverHUD(step, distMeters) {
    if (this.onManeuverUpdate && step) {
      let formattedDist = distMeters > 950
        ? `${(distMeters / 1000).toFixed(1)} კმ`
        : `${distMeters} მ`;

      this.onManeuverUpdate({
        instruction: step.instruction,
        streetName: step.streetName,
        distanceStr: formattedDist,
        icon: step.icon,
        lanes: this.getLaneGuidance(step.icon)
      });
    }
  }

  // Remaining distance ALONG the route (O(1) instant lookup from precomputed cumDist)
  remainingRouteMeters(currentLatLng) {
    if (!this.activeRoute) return 0;
    if (!this.cumDist || this.cumDist.length === 0) return this.activeRoute.distanceMeters || 0;
    const totalLen = this.cumDist[this.cumDist.length - 1];
    const progress = this.progressMeters(currentLatLng);
    return Math.max(0, totalLen - progress);
  }

  updateRouteSummary(currentLatLng) {
    if (!this.activeRoute || !this.activeRoute.coordinates || !this.onSummaryUpdate) return;

    const total = this.activeRoute.distanceMeters || 1;
    const remainingMeters = Math.min(total, this.remainingRouteMeters(currentLatLng));
    const remainingKm = remainingMeters / 1000;
    // Time: OSRM duration scaled by remaining fraction (same basis as the preview card)
    const remainingMinutes = Math.max(1, Math.round((this.activeRoute.durationSeconds * (remainingMeters / total)) / 60));

    const now = new Date();
    now.setMinutes(now.getMinutes() + remainingMinutes);
    const etaStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // Arrival SoC = start SoC - energy for WHOLE trip: constant, does not creep up while driving
    this.onSummaryUpdate({
      distanceKm: remainingKm.toFixed(1),
      durationMin: remainingMinutes,
      etaStr: etaStr,
      batteryImpact: this.activeRoute.batteryImpact
    });
  }

  clearRoute() {
    this.isNavigating = false;
    this.offRouteStrikes = 0;
    this.isRerouting = false;
    this.lastClosestIndex = 0;
    this.setRouteData([], []);
    this.clearAlternatives();
    if (this.trafficEngine) {
      this.trafficEngine.clearRouteTraffic();
    }
    this.activeRoute = null;
    this.steps = [];
  }

  /** Store the route geometry and push it to the map when the sources exist (they do not during a style switch). */
  setRouteData(upcomingLatLngs, passedLatLngs) {
    this.routeGeo.upcoming = RoutingEngine.lineGeo(upcomingLatLngs);
    this.routeGeo.passed = RoutingEngine.lineGeo(passedLatLngs);
    if (!this.map || typeof this.map.getSource !== "function") return;
    const up = this.map.getSource("route-source");
    const pa = this.map.getSource("route-passed-source");
    if (up && typeof up.setData === "function") up.setData(this.routeGeo.upcoming);
    if (pa && typeof pa.setData === "function") pa.setData(this.routeGeo.passed);
  }

  getLngLatBounds(coords) {
    if (!coords || coords.length === 0) return null;
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const c of coords) {
      const lng = c[0], lat = c[1];
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    return [[minLng, minLat], [maxLng, maxLat]];
  }

  getCurrentSegmentBearing() {
    if (!this.isNavigating || !this.activeRoute || !this.activeRoute.coordinates) return null;
    const coords = this.activeRoute.coordinates;
    const idx = Math.max(0, this.lastClosestIndex || 0);
    for (let i = idx; i < Math.min(coords.length - 1, idx + 10); i++) {
      const p1 = coords[i];
      const p2 = coords[i + 1];
      const d = this.haversineMeters(p1[0], p1[1], p2[0], p2[1]);
      if (d >= 2) {
        return Math.round(this.calculateBearing(p1[0], p1[1], p2[0], p2[1]));
      }
    }
    return null;
  }

  calculateBearing(lat1, lon1, lat2, lon2) {
    const toRad = deg => deg * Math.PI / 180;
    const toDeg = rad => rad * 180 / Math.PI;

    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);

    let brng = toDeg(Math.atan2(y, x));
    return (brng + 360) % 360;
  }

  haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
}

window.RoutingEngine = RoutingEngine;
