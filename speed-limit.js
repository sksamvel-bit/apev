/**
 * Speed Limit Engine (Automotive Road Speed Limit Detection & Warnings)
 * Multi-Tier Speed Limit System for Georgia & International Roads:
 * 1. TomTom Live FlowSegmentData (if API key provided in Settings)
 * 2. Active Route Step & Street Name Speed Profile (OSRM)
 * 3. High-Precision Georgian Highway & Express Corridor Geofences (110, 80, 70, 90, 60, 20 km/h)
 * 4. Dynamic Visual Overspeed Warning Pulse (when speed > limit + 5)
 */

class SpeedLimitEngine {
  constructor(routingEngine = null) {
    this.routingEngine = routingEngine;
    this.currentLimit = 60;
    this.currentRoadName = "საქალაქო გზა";
    this.tomtomKey = localStorage.getItem("tomtom_api_key") || "";
    this.lastCheckPos = null;
    this.lastCheckTime = 0;
    this.lastTomTomCheckTime = 0;
    this.isQueryingTomTom = false;
    this.cachedCellResults = new Map();

    // DOM Elements Cache
    this.badgeEl = null;
    this.valEl = null;

    // High-Precision Geometric Corridors for Georgia's High-Speed Road Network
    this.corridors = [
      // 1. დავით აღმაშენებლის ხეივანი (80 კმ/სთ)
      {
        name: "დავით აღმაშენებლის ხეივანი",
        limit: 80,
        tolerance: 110,
        points: [
          [41.765, 44.775],
          [41.774, 44.774],
          [41.785, 44.773],
          [41.800, 44.770],
          [41.815, 44.763],
          [41.838, 44.755]
        ]
      },
      // 2. კახეთის გზატკეცილი (80 კმ/სთ)
      {
        name: "კახეთის გზატკეცილი",
        limit: 80,
        tolerance: 130,
        points: [
          [41.688, 44.858],
          [41.684, 44.882],
          [41.678, 44.912],
          [41.673, 44.945],
          [41.666, 44.975],
          [41.660, 45.010]
        ]
      },
      // 3. თბილისი - რუსთავის ავტობანი (80 კმ/სთ)
      {
        name: "თბილისი-რუსთავის ავტობანი",
        limit: 80,
        tolerance: 120,
        points: [
          [41.650, 44.885],
          [41.625, 44.910],
          [41.600, 44.935],
          [41.575, 44.960],
          [41.555, 44.985]
        ]
      },
      // 4. მტკვრის მარჯვენა სანაპირო (70 კმ/სთ)
      {
        name: "მტკვრის მარჯვენა სანაპირო",
        limit: 70,
        tolerance: 65,
        points: [
          [41.678, 44.832],
          [41.692, 44.810],
          [41.705, 44.798],
          [41.725, 44.788],
          [41.745, 44.780],
          [41.770, 44.778]
        ]
      },
      // 5. მტკვრის მარცხენა სანაპირო (70 კმ/სთ)
      {
        name: "მტკვრის მარცხენა სანაპირო",
        limit: 70,
        tolerance: 65,
        points: [
          [41.682, 44.836],
          [41.696, 44.814],
          [41.710, 44.802],
          [41.730, 44.792],
          [41.750, 44.784],
          [41.768, 44.782]
        ]
      },
      // 6. მარშალ გელოვანის გამზირი (70 კმ/სთ)
      {
        name: "მარშალ გელოვანის გამზირი",
        limit: 70,
        tolerance: 60,
        points: [
          [41.745, 44.778],
          [41.756, 44.776],
          [41.768, 44.774]
        ]
      },
      // 7. ჩაბუა ამირეჯიბის გზატკეცილი / ვერეს ხეობა (70 კმ/სთ)
      {
        name: "ჩაბუა ამირეჯიბის გზატკეცილი",
        limit: 70,
        tolerance: 60,
        points: [
          [41.714, 44.780],
          [41.715, 44.765],
          [41.718, 44.748]
        ]
      },
      // 8. E60 აღმოსავლეთ-დასავლეთის ავტომაგისტრალი (110 კმ/სთ)
      {
        name: "E60 ავტომაგისტრალი (ნატახტარი-გორი)",
        limit: 110,
        tolerance: 140,
        points: [
          [41.870, 44.715],
          [41.915, 44.580],
          [41.980, 44.320],
          [42.010, 44.110],
          [42.000, 43.900]
        ]
      },
      {
        name: "E60 ავტომაგისტრალი (გორი-ხაშური)",
        limit: 110,
        tolerance: 140,
        points: [
          [42.000, 43.900],
          [42.030, 43.800],
          [42.010, 43.600],
          [42.020, 43.520]
        ]
      },
      {
        name: "E60 ავტომაგისტრალი (ზესტაფონი-ქუთაისი)",
        limit: 110,
        tolerance: 140,
        points: [
          [42.110, 43.050],
          [42.170, 42.800],
          [42.220, 42.600]
        ]
      },
      {
        name: "E60 ავტომაგისტრალი (სამტრედია-ბათუმი)",
        limit: 110,
        tolerance: 140,
        points: [
          [42.150, 42.340],
          [41.950, 41.800],
          [41.800, 41.750],
          [41.720, 41.700]
        ]
      }
    ];

    // Urban Bounding Boxes (Standard 60 km/h in inhabited areas)
    this.urbanZones = [
      { name: "თბილისი", minLat: 41.640, maxLat: 41.820, minLng: 44.680, maxLng: 44.920, defaultLimit: 60 },
      { name: "ბათუმი", minLat: 41.580, maxLat: 41.680, minLng: 41.580, maxLng: 41.680, defaultLimit: 60 },
      { name: "ქუთაისი", minLat: 42.200, maxLat: 42.300, minLng: 42.620, maxLng: 42.750, defaultLimit: 60 },
      { name: "რუსთავი", minLat: 41.520, maxLat: 41.570, minLng: 44.950, maxLng: 45.040, defaultLimit: 60 }
    ];
  }

  setTomTomKey(key) {
    this.tomtomKey = (key || "").trim();
  }

  /**
   * Main periodic update called from updateVehicleMarker()
   */
  update(lat, lng, currentSpeedKmh = 0) {
    const now = performance.now();

    // Throttle checks: if vehicle moved < 25m and < 3s passed, dirty check overspeed warning only
    if (this.lastCheckPos && (now - this.lastCheckTime < 3000)) {
      const d = this.haversineMeters(this.lastCheckPos.lat, this.lastCheckPos.lng, lat, lng);
      if (d < 25) {
        this.updateOverspeedUI(currentSpeedKmh);
        return;
      }
    }

    this.lastCheckPos = { lat, lng };
    this.lastCheckTime = now;

    const detected = this.detectSpeedLimit(lat, lng);
    this.currentLimit = detected.limit;
    this.currentRoadName = detected.name;

    // Update DOM UI
    this.renderUI(currentSpeedKmh);

    // If TomTom API key is present, asynchronously verify live flow data (debounced every 12s)
    if (this.tomtomKey && !this.isQueryingTomTom && (now - this.lastTomTomCheckTime > 12000)) {
      this.fetchTomTomSpeedLimit(lat, lng, currentSpeedKmh);
    }
  }

  /**
   * Deterministic multi-tier detection algorithm
   */
  detectSpeedLimit(lat, lng) {
    // Tier 1: Active Navigation Route Step Matching
    if (this.routingEngine && this.routingEngine.isNavigating && this.routingEngine.activeRoute) {
      const routeLimit = this.checkRouteStepLimit(lat, lng);
      if (routeLimit) return routeLimit;
    }

    // Tier 2: High-Precision Georgia Highway & Express Corridor Geofences
    for (const c of this.corridors) {
      for (let i = 0; i < c.points.length - 1; i++) {
        const d = this.pointToSegmentDistanceMeters(
          lat, lng,
          c.points[i][0], c.points[i][1],
          c.points[i + 1][0], c.points[i + 1][1]
        );
        if (d <= c.tolerance) {
          return { limit: c.limit, name: c.name, source: "corridor" };
        }
      }
    }

    // Tier 3: Urban vs Non-Urban Statutory Zone Check
    for (const zone of this.urbanZones) {
      if (lat >= zone.minLat && lat <= zone.maxLat && lng >= zone.minLng && lng <= zone.maxLng) {
        return { limit: zone.defaultLimit, name: `${zone.name}-ს საქალაქო გზა`, source: "urban_zone" };
      }
    }

    // Tier 4: Regional Intercity Highway Statutory Default (Georgia traffic code: 90 km/h)
    return { limit: 90, name: "საქალაქთაშორისო საავტომობილო გზა", source: "rural_highway" };
  }

  /**
   * Checks active route steps for specific road names or design speeds
   */
  checkRouteStepLimit(lat, lng) {
    const steps = this.routingEngine.steps;
    const curIdx = this.routingEngine.currentStepIndex || 0;
    const step = steps[curIdx] || steps[0];
    if (!step) return null;

    const name = (step.name || "").trim();

    // Motorway patterns
    if (/(E[ -]?60|ს[ -]?1|ს[ -]?2|ავტობანი|მაგისტრალი|Autobahn|Motorway|Highway)/i.test(name)) {
      return { limit: 110, name: name || "ავტომაგისტრალი", source: "route_motorway" };
    }

    // 80 km/h expressways
    if (/(აღმაშენებლის ხეივანი|Aghmashenebeli|კახეთის გზატკეცილი|Kakheti|თბილისი-რუსთავი|რუსთავის ავტობანი)/i.test(name)) {
      return { limit: 80, name, source: "route_expressway_80" };
    }

    // 70 km/h express roads
    if (/(სანაპირო|Sanapiro|გელოვანი|ამირეჯიბი|გმირთა მოედანი|ვარაზისხევი|თამარაშვილი|მაჭავარიანი|სალოსის გამზირი)/i.test(name)) {
      return { limit: 70, name, source: "route_expressway_70" };
    }

    // Residential living streets / narrow alleys
    if (/(შესახვევი|ჩიხი|ჩიხ\.|Blind|Lane|Living Street)/i.test(name)) {
      return { limit: 20, name, source: "route_living_street" };
    }

    // High average design speed fallback from step geometry
    if (step.distance > 500 && step.duration > 0) {
      const avgSpeed = (step.distance / step.duration) * 3.6;
      if (avgSpeed > 95) return { limit: 110, name, source: "route_speed_110" };
      if (avgSpeed > 75) return { limit: 90, name, source: "route_speed_90" };
      if (avgSpeed > 65) return { limit: 80, name, source: "route_speed_80" };
      if (avgSpeed > 55) return { limit: 70, name, source: "route_speed_70" };
    }

    return null;
  }

  /**
   * Live TomTom Flow Segment API (runs in background without blocking UI)
   */
  async fetchTomTomSpeedLimit(lat, lng, currentSpeedKmh) {
    this.isQueryingTomTom = true;
    this.lastTomTomCheckTime = performance.now();

    try {
      const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/relative0/10/json?point=${lat},${lng}&key=${this.tomtomKey}&unit=KMPH`;
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const data = await res.json();
        const flow = data.flowSegmentData;
        if (flow && flow.speedLimit && flow.speedLimit > 0) {
          this.currentLimit = Math.round(flow.speedLimit);
          this.currentRoadName = "TomTom Live Traffic";
          this.renderUI(currentSpeedKmh);
        }
      }
    } catch (err) {
      // Gracefully silent fallback to geo-corridors
    } finally {
      this.isQueryingTomTom = false;
    }
  }

  /**
   * Updates DOM Elements
   */
  renderUI(currentSpeedKmh = 0) {
    if (!this.valEl) this.valEl = document.getElementById("speed-limit-val");
    if (!this.badgeEl) this.badgeEl = document.getElementById("speed-limit-badge");

    if (this.valEl && this.valEl.textContent !== String(this.currentLimit)) {
      this.valEl.textContent = this.currentLimit;
    }

    if (this.badgeEl) {
      this.badgeEl.title = `სიჩქარის შეზღუდვა: ${this.currentLimit} კმ/სთ (${this.currentRoadName})`;
    }

    this.updateOverspeedUI(currentSpeedKmh);
  }

  /**
   * Visual Red Pulsing Warning when exceeding speed limit by > 5 km/h
   */
  updateOverspeedUI(currentSpeedKmh = 0) {
    if (!this.badgeEl) this.badgeEl = document.getElementById("speed-limit-badge");
    if (!this.badgeEl) return;

    const isOverspeeding = currentSpeedKmh > (this.currentLimit + 5);
    this.badgeEl.classList.toggle("speeding", isOverspeeding);
  }

  // Trigonometry helpers
  haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  pointToSegmentDistanceMeters(pLat, pLng, aLat, aLng, bLat, bLng) {
    const dX = bLng - aLng;
    const dY = bLat - aLat;
    const lenSq = dX * dX + dY * dY;
    if (lenSq === 0) return this.haversineMeters(pLat, pLng, aLat, aLng);
    let t = ((pLng - aLng) * dX + (pLat - aLat) * dY) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projLat = aLat + t * dY;
    const projLng = aLng + t * dX;
    return this.haversineMeters(pLat, pLng, projLat, projLng);
  }
}

window.SpeedLimitEngine = SpeedLimitEngine;
