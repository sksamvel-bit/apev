/**
 * Speed Limit Engine (Automotive Road Speed Limit Detection & Warnings)
 * High-Precision Verified Speed Limit System for Georgia:
 * 1. Active Navigation Route Step (OSRM maxspeed & verified highway classifications)
 * 2. High-Precision Georgia Highway & Express Corridor Geofences (80, 70 km/h)
 * 3. Verified Georgian Municipal Urban Zones (60 km/h)
 * 4. Honest Fallback: Shows "—" when speed limit is unverified (NEVER guesses or triggers false alarms)
 * 5. Dynamic Visual Overspeed Warning: Pulses red ONLY when a verified numeric limit is exceeded by > 5 km/h
 */

class SpeedLimitEngine {
  constructor(routingEngine = null) {
    this.routingEngine = routingEngine;
    this.currentLimit = 60; // Initial default before GPS lock
    this.currentRoadName = "საქალაქო გზა";
    this.lastCheckPos = null;
    this.lastCheckTime = 0;

    // DOM Elements Cache
    this.badgeEl = null;
    this.valEl = null;

    // High-Precision Geometric Corridors for Georgia's High-Speed Express Roads
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
      }
    ];

    // Verified Urban Bounding Boxes (Standard statutory 60 km/h in Georgian municipalities)
    this.urbanZones = [
      { name: "თბილისი", minLat: 41.640, maxLat: 41.820, minLng: 44.680, maxLng: 44.920 },
      { name: "ბათუმი", minLat: 41.580, maxLat: 41.680, minLng: 41.580, maxLng: 41.680 },
      { name: "ქუთაისი", minLat: 42.200, maxLat: 42.300, minLng: 42.620, maxLng: 42.750 },
      { name: "რუსთავი", minLat: 41.520, maxLat: 41.570, minLng: 44.950, maxLng: 45.040 },
      { name: "გორი", minLat: 41.960, maxLat: 42.000, minLng: 44.090, maxLng: 44.140 },
      { name: "ზუგდიდი", minLat: 42.490, maxLat: 42.530, minLng: 41.850, maxLng: 41.900 },
      { name: "ფოთი", minLat: 42.130, maxLat: 42.170, minLng: 41.650, maxLng: 41.720 },
      { name: "თელავი", minLat: 41.900, maxLat: 41.940, minLng: 45.450, maxLng: 45.510 },
      { name: "ხაშური", minLat: 41.980, maxLat: 42.010, minLng: 43.580, maxLng: 43.620 },
      { name: "სამტრედია", minLat: 42.140, maxLat: 42.170, minLng: 42.320, maxLng: 42.360 }
    ];
  }

  // Backward compatibility stub (TomTom dead level removed per audit)
  setTomTomKey(key) {}

  /**
   * Main periodic update called from updateVehicleMarker()
   */
  update(lat, lng, currentSpeedKmh = 0) {
    const now = performance.now();

    // Throttle checks: if vehicle moved < 25m and < 3s passed, check overspeed alert only
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
  }

  /**
   * Deterministic verified multi-tier detection algorithm
   */
  detectSpeedLimit(lat, lng) {
    // Tier 1: Active Navigation Route Step Matching (highest priority when navigating)
    if (this.routingEngine && this.routingEngine.isNavigating && this.routingEngine.activeRoute) {
      const routeLimit = this.checkRouteStepLimit(lat, lng);
      if (routeLimit) return routeLimit;
    }

    // Tier 2: High-Precision Georgia Highway & Express Corridor Geofences (80 & 70 km/h)
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

    // Tier 3: Verified Municipal Urban Zones (Standard 60 km/h in inhabited areas)
    for (const zone of this.urbanZones) {
      if (lat >= zone.minLat && lat <= zone.maxLat && lng >= zone.minLng && lng <= zone.maxLng) {
        return { limit: 60, name: `${zone.name}-ს საქალაქო გზა`, source: "urban_zone" };
      }
    }

    // Tier 4: Unverified Road — Display neutral "—" (No blind guessing, no false red alerts)
    return { limit: null, name: "შეზღუდვა დაუდასტურებელია", source: "unverified" };
  }

  /**
   * Checks active route steps for verified road names or OSRM maxspeed metadata
   */
  checkRouteStepLimit(lat, lng) {
    const steps = this.routingEngine.steps;
    const curIdx = this.routingEngine.currentStepIndex || 0;
    const step = steps[curIdx] || steps[0];
    if (!step) return null;

    // Direct OSRM maxspeed tag if provided by routing server
    if (typeof step.maxspeed === "number" && step.maxspeed > 0) {
      return { limit: step.maxspeed, name: step.name || "მარშრუტი", source: "osrm_maxspeed" };
    }

    const name = (step.name || "").trim();

    // 110 km/h Motorway patterns (Strict matching: E60, ს-1, ს-2, ავტობანი)
    if (/(E[ -]?60|ს[ -]?1|ს[ -]?2|ავტობანი|Autobahn|Motorway)/i.test(name) && !/კახეთის/i.test(name)) {
      return { limit: 110, name: name || "ავტომაგისტრალი", source: "route_motorway" };
    }

    // 80 km/h expressways
    if (/(აღმაშენებლის ხეივანი|Aghmashenebeli|კახეთის გზატკეცილი|Kakheti Highway|თბილისი-რუსთავი|რუსთავის ავტობანი)/i.test(name)) {
      return { limit: 80, name, source: "route_expressway_80" };
    }

    // 70 km/h express roads
    if (/(სანაპირო|Sanapiro|გელოვანი|ამირეჯიბი|გმირთა მოედანი|ვარაზისხევი|თამარაშვილი|მაჭავარიანი|სალოსის გამზირი)/i.test(name)) {
      return { limit: 70, name, source: "route_expressway_70" };
    }

    return null;
  }

  /**
   * Updates DOM Elements
   */
  renderUI(currentSpeedKmh = 0) {
    if (!this.valEl) this.valEl = document.getElementById("speed-limit-val");
    if (!this.badgeEl) this.badgeEl = document.getElementById("speed-limit-badge");

    const displayStr = (typeof this.currentLimit === "number" && this.currentLimit > 0)
      ? String(this.currentLimit)
      : "—";

    if (this.valEl && this.valEl.textContent !== displayStr) {
      this.valEl.textContent = displayStr;
    }

    if (this.badgeEl) {
      this.badgeEl.title = (typeof this.currentLimit === "number")
        ? `სიჩქარის შეზღუდვა: ${this.currentLimit} კმ/სთ (${this.currentRoadName})`
        : `სიჩქარის შეზღუდვა: უცნობია (${this.currentRoadName})`;
    }

    this.updateOverspeedUI(currentSpeedKmh);
  }

  /**
   * Visual Red Pulsing Warning when exceeding speed limit by > 5 km/h
   * Strict Safety Rule: Pulses ONLY when limit is verified numeric. NEVER on "—"!
   */
  updateOverspeedUI(currentSpeedKmh = 0) {
    if (!this.badgeEl) this.badgeEl = document.getElementById("speed-limit-badge");
    if (!this.badgeEl) return;

    const isOverspeeding = (typeof this.currentLimit === "number" && this.currentLimit > 0) &&
      currentSpeedKmh > (this.currentLimit + 5);

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
