/**
 * Speed Limit Engine (Automotive Road Speed Limit Detection & Warnings)
 * High-Precision Verified Speed Limit System for Georgia:
 * 1. Active Navigation Route Step (OSRM maxspeed & verified highway classifications)
 * 2. High-Precision Georgia Highway & Express Corridor Geofences (80, 70 km/h)
 * 3. Verified Georgian Municipal Urban Zones (60 km/h)
 * 4. Honest Fallback: Shows "—" when speed limit is unverified (NEVER guesses or triggers false alarms)
 * 5. Dynamic Visual Overspeed Warning: Pulses red ONLY when a verified numeric limit is exceeded by > 5 km/h
 *
 * OSM LAYER (v3.9): the posted limit is read from OpenStreetMap `maxspeed` tags (Overpass API, ~0.5 km tiles,
 * cached 24 h, LRU 40 tiles, back-off on failure). Confidence levels:
 *   confirmed = numeric OSM/OSRM maxspeed  -> shown as "60", red alarm allowed
 *   estimate  = hand-made corridors / city boxes / road-name rules -> shown as "~60", NO alarm (by default)
 *   unknown   -> "—"
 * A motorway/trunk without a maxspeed tag is never labelled with the city default.
 */

class SpeedLimitEngine {
  constructor(routingEngine = null) {
    this.routingEngine = routingEngine;
    this.currentLimit = null; // unknown until a real fix: never show a guessed number
    this.currentRoadName = "—";
    this.currentConfidence = "unknown"; // 'confirmed' | 'estimate' | 'unknown'
    this.OVERSPEED_ON_ESTIMATE = false; // red alarm only for CONFIRMED limits (set true to also alarm on estimates)
    this.lastSpeed = 0;

    // ---- OpenStreetMap (Overpass) layer ----
    this.osmEnabled = true;
    // v3.10.69 (audit H2): our server first (it caches every tile for 7 days and waits for Overpass as long as needed),
    // then the public servers directly (v3.10.68 mirrors)
    this.osmEndpoints = ["/api/overpass", "https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
    this.osmTileLat = 0.005;   // ~555 m
    this.osmTileLng = 0.007;   // ~520 m at Georgia's latitudes
    this.osmMaxTiles = 40;
    this.osmTtlMs = 24 * 3600 * 1000;
    this.osmMatchMeters = 22;  // nearest road must be within this distance of the GPS point
    this.osmTiles = new Map();   // "i,j" -> { t, ways }
    this.osmPending = new Map(); // "i,j" -> Promise
    this.osmFailCount = 0;
    this.osmFailUntil = 0;
    this.osmHeading = null;
    this.osmLastPos = null;
    this.fetchFn = (...a) => fetch(...a); // injectable for tests
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

  /**
   * Main periodic update called from updateVehicleMarker()
   */
  update(lat, lng, currentSpeedKmh = 0, headingDeg = null) {
    const now = performance.now();

    // Throttle checks: if vehicle moved < 25m and < 3s passed, check overspeed alert only
    if (this.lastCheckPos && (now - this.lastCheckTime < 3000)) {
      const d = this.haversineMeters(this.lastCheckPos.lat, this.lastCheckPos.lng, lat, lng);
      if (d < 25) {
        this.updateOverspeedUI(currentSpeedKmh);
        return;
      }
    }

    // Heading: explicit value, else derived from movement (>= 10 m since the last reference point)
    if (typeof headingDeg === "number" && isFinite(headingDeg)) {
      this.osmHeading = headingDeg;
    } else if (this.osmLastPos && this.haversineMeters(this.osmLastPos.lat, this.osmLastPos.lng, lat, lng) >= 10) {
      this.osmHeading = this.bearingDeg(this.osmLastPos.lat, this.osmLastPos.lng, lat, lng);
      this.osmLastPos = { lat, lng };
    }
    if (!this.osmLastPos) this.osmLastPos = { lat, lng };

    this.lastCheckPos = { lat, lng };
    this.lastCheckTime = now;
    this.lastSpeed = currentSpeedKmh;

    // Ask OSM for the tile under us and the one ahead (async, never blocks the UI)
    this.prefetchOsm(lat, lng);

    this.applyDetection(lat, lng, currentSpeedKmh);
  }

  applyDetection(lat, lng, currentSpeedKmh = 0) {
    const detected = this.detectSpeedLimit(lat, lng);
    this.currentLimit = detected.limit;
    this.currentRoadName = detected.name;
    this.currentConfidence = detected.confidence || (detected.limit == null ? "unknown" : "estimate");
    this.renderUI(currentSpeedKmh);
  }

  /**
   * Deterministic verified multi-tier detection algorithm
   */
  detectSpeedLimit(lat, lng) {
    // Tier 0: OpenStreetMap maxspeed of the road we are actually on (cached tile lookup, synchronous)
    const osm = this.osmLookup(lat, lng);
    if (osm && osm.limit != null) {
      return { limit: osm.limit, name: osm.name, source: "osm", confidence: osm.confidence };
    }
    // A motorway/trunk without a maxspeed tag must NOT inherit the city default
    const fastRoad = !!(osm && /^(motorway|trunk)(_link)?$/.test(osm.highway || ""));

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
          return { limit: c.limit, name: c.name, source: "corridor", confidence: "estimate" };
        }
      }
    }

    // Tier 3: Verified Municipal Urban Zones (Standard 60 km/h in inhabited areas)
    for (const zone of this.urbanZones) {
      if (!fastRoad && lat >= zone.minLat && lat <= zone.maxLat && lng >= zone.minLng && lng <= zone.maxLng) {
        return { limit: 60, name: `${zone.name}-ს საქალაქო გზა`, source: "urban_zone", confidence: "estimate" };
      }
    }

    // Tier 4: Unverified Road — Display neutral "—" (No blind guessing, no false red alerts)
    return { limit: null, name: "შეზღუდვა დაუდასტურებელია", source: "unverified", confidence: "unknown" };
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
      return { limit: step.maxspeed, name: step.name || "მარშრუტი", source: "osrm_maxspeed", confidence: "confirmed" };
    }

    const name = (step.name || "").trim();

    // 110 km/h Motorway patterns (Strict matching: E60, ს-1, ს-2, ავტობანი)
    if (/(E[ -]?60|ს[ -]?1|ს[ -]?2|ავტობანი|Autobahn|Motorway)/i.test(name) && !/კახეთის/i.test(name)) {
      return { limit: 110, name: name || "ავტომაგისტრალი", source: "route_motorway", confidence: "estimate" };
    }

    // 80 km/h expressways
    if (/(აღმაშენებლის ხეივანი|Aghmashenebeli|კახეთის გზატკეცილი|Kakheti Highway|თბილისი-რუსთავი|რუსთავის ავტობანი)/i.test(name)) {
      return { limit: 80, name, source: "route_expressway_80", confidence: "estimate" };
    }

    // 70 km/h express roads
    if (/(სანაპირო|Sanapiro|გელოვანი|ამირეჯიბი|გმირთა მოედანი|ვარაზისხევი|თამარაშვილი|მაჭავარიანი|სალოსის გამზირი)/i.test(name)) {
      return { limit: 70, name, source: "route_expressway_70", confidence: "estimate" };
    }

    return null;
  }

  /**
   * Updates DOM Elements
   */
  renderUI(currentSpeedKmh = 0) {
    if (!this.valEl) this.valEl = document.getElementById("speed-limit-val");
    if (!this.badgeEl) this.badgeEl = document.getElementById("speed-limit-badge");

    const hasNum = typeof this.currentLimit === "number" && this.currentLimit > 0;
    const displayStr = hasNum
      ? (this.currentConfidence === "confirmed" ? String(this.currentLimit) : "~" + this.currentLimit)
      : "—";
    if (this.badgeEl) this.badgeEl.classList.toggle("estimated", hasNum && this.currentConfidence !== "confirmed");

    if (this.valEl && this.valEl.textContent !== displayStr) {
      this.valEl.textContent = displayStr;
    }

    if (this.badgeEl) {
      this.badgeEl.title = (typeof this.currentLimit === "number")
        ? `სიჩქარის შეზღუდვა: ${this.currentLimit} კმ/სთ (${this.currentRoadName})${this.currentConfidence === "confirmed" ? "" : " — დაახლოებითი"}`
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

    const alarmAllowed = this.currentConfidence === "confirmed" ||
      (this.OVERSPEED_ON_ESTIMATE && this.currentConfidence === "estimate");
    const isOverspeeding = alarmAllowed && (typeof this.currentLimit === "number" && this.currentLimit > 0) &&
      currentSpeedKmh > (this.currentLimit + 5);

    this.badgeEl.classList.toggle("speeding", isOverspeeding);
  }

  // ===================== OpenStreetMap (Overpass) layer =====================
  bearingDeg(lat1, lon1, lat2, lon2) {
    const t = Math.PI / 180;
    const y = Math.sin((lon2 - lon1) * t) * Math.cos(lat2 * t);
    const x = Math.cos(lat1 * t) * Math.sin(lat2 * t) - Math.sin(lat1 * t) * Math.cos(lat2 * t) * Math.cos((lon2 - lon1) * t);
    return (Math.atan2(y, x) / t + 360) % 360;
  }

  tileIndex(lat, lng) { return [Math.floor(lat / this.osmTileLat), Math.floor(lng / this.osmTileLng)]; }
  tileKey(i, j) { return i + "," + j; }
  tileBounds(i, j) {
    return { s: i * this.osmTileLat, n: (i + 1) * this.osmTileLat, w: j * this.osmTileLng, e: (j + 1) * this.osmTileLng };
  }

  /** Request the tile under the car and the one ~400 m ahead. Returns a Promise (useful in tests). */
  prefetchOsm(lat, lng) {
    if (!this.osmEnabled) return Promise.resolve([]);
    const [i, j] = this.tileIndex(lat, lng);
    const jobs = [this.requestTile(i, j)];
    if (this.osmHeading != null) {
      const rad = this.osmHeading * Math.PI / 180;
      const aLat = lat + (400 * Math.cos(rad)) / 111320;
      const aLng = lng + (400 * Math.sin(rad)) / (111320 * Math.cos(lat * Math.PI / 180));
      const [ai, aj] = this.tileIndex(aLat, aLng);
      if (ai !== i || aj !== j) jobs.push(this.requestTile(ai, aj));
    }
    return Promise.all(jobs);
  }

  requestTile(i, j) {
    const key = this.tileKey(i, j);
    const hit = this.osmTiles.get(key);
    if (hit && Date.now() - hit.t < this.osmTtlMs) return Promise.resolve(hit);
    if (this.osmPending.has(key)) return this.osmPending.get(key);
    if (Date.now() < this.osmFailUntil) return Promise.resolve(null); // back-off after failures
    if (this.osmPending.size >= 2) return Promise.resolve(null);      // be polite to the public API

    const p = this.fetchTile(i, j)
      .then(tile => {
        this.osmFailCount = 0;
        this.osmFailUntil = 0;
        this.osmTiles.delete(key);
        this.osmTiles.set(key, tile);
        while (this.osmTiles.size > this.osmMaxTiles) this.osmTiles.delete(this.osmTiles.keys().next().value);
        if (this.lastCheckPos) this.applyDetection(this.lastCheckPos.lat, this.lastCheckPos.lng, this.lastSpeed || 0);
        return tile;
      })
      .catch(() => {
        this.osmFailCount++;
        this.osmFailUntil = Date.now() + Math.min(300000, 15000 * Math.pow(2, this.osmFailCount));
        return null;
      })
      .finally(() => { this.osmPending.delete(key); });
    this.osmPending.set(key, p);
    return p;
  }

  async fetchTile(i, j) {
    const b = this.tileBounds(i, j);
    const q = '[out:json][timeout:20];way[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)(_link)?$"](' +
      b.s.toFixed(5) + "," + b.w.toFixed(5) + "," + b.n.toFixed(5) + "," + b.e.toFixed(5) + ");out tags geom;";
    let lastErr = null;
    for (const ep of this.osmEndpoints) {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
      try {
        const res = await this.fetchFn(ep + "?data=" + encodeURIComponent(q), ctrl ? { signal: ctrl.signal } : undefined);
        if (!res.ok) throw new Error("Overpass HTTP " + res.status);
        return this.buildTile(await res.json());
      } catch (e) {
        lastErr = e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr || new Error("Overpass failed");
  }

  buildTile(data) {
    const ways = [];
    for (const el of (data && data.elements) || []) {
      if (el.type !== "way" || !el.geometry || el.geometry.length < 2 || !el.tags) continue;
      const t = el.tags;
      ways.push({
        id: el.id,
        highway: t.highway,
        name: t.name || t["name:ka"] || t.ref || "",
        maxspeed: t.maxspeed,
        mType: t["maxspeed:type"] || "",
        mFwd: t["maxspeed:forward"],
        mBwd: t["maxspeed:backward"],
        pts: el.geometry.map(g => [g.lat, g.lon])
      });
    }
    return { t: Date.now(), ways };
  }

  /** "60", "60 km/h", "30 mph", "GE:urban" -> { limit, confidence } | null ("none", "signals", "60;80" ... -> null) */
  parseMaxspeed(v) {
    if (v == null) return null;
    const s = String(v).trim().toLowerCase();
    let m = s.match(/^(\d{1,3})(\s*km\/h)?$/);
    if (m) { const n = parseInt(m[1], 10); return n >= 5 && n <= 140 ? { limit: n, confidence: "confirmed" } : null; }
    m = s.match(/^(\d{1,3})\s*mph$/);
    if (m) { const n = Math.round(parseInt(m[1], 10) * 1.609); return n >= 5 && n <= 140 ? { limit: n, confidence: "confirmed" } : null; }
    if (/(^|:)urban$/.test(s)) return { limit: 60, confidence: "estimate" };
    return null;
  }

  /** Nearest drivable OSM way (within osmMatchMeters, heading-aware) from the cached tile; null if nothing known. */
  osmLookup(lat, lng) {
    if (!this.osmEnabled) return null;
    const [i, j] = this.tileIndex(lat, lng);
    const tile = this.osmTiles.get(this.tileKey(i, j));
    if (!tile) return null;
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
    let best = null;
    for (const w of tile.ways) {
      const pts = w.pts;
      for (let k = 0; k < pts.length - 1; k++) {
        const ax = (pts[k][1] - lng) * kx, ay = (pts[k][0] - lat) * ky;
        const bx = (pts[k + 1][1] - lng) * kx, by = (pts[k + 1][0] - lat) * ky;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
        const d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d > this.osmMatchMeters) continue;
        let score = d;
        if (this.osmHeading != null && l2 > 4) { // prefer the road we are travelling along (not a crossing one)
          const seg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
          let diff = Math.abs(seg - this.osmHeading) % 180;
          if (diff > 90) diff = 180 - diff;
          score += diff > 45 ? 30 : diff * 0.25;
        }
        if (!best || score < best.score) best = { score, w };
      }
    }
    if (!best) return null;
    const w = best.w;
    const parsed = this.parseMaxspeed(w.maxspeed) ||
      this.parseMaxspeed(w.mFwd != null && w.mFwd === w.mBwd ? w.mFwd : null) ||
      this.parseMaxspeed(w.mType);
    return {
      limit: parsed ? parsed.limit : null,
      confidence: parsed ? parsed.confidence : "unknown",
      highway: w.highway,
      name: w.name || w.highway
    };
  }

  /**
   * Free-Driving Road Snapping (v3.9.2):
   * When driving without an active route, snaps vehicle heading to the nearest OSM road or corridor centerline
   * if the vehicle is within 18m and traveling along the road within ±28 deg.
   * Returns snapped bearing in degrees [0, 360), or null if not aligned with a road.
   */
  getRoadBearing(lat, lng, candidateHeading) {
    if (candidateHeading === null || candidateHeading === undefined) return null;
    const maxDistanceMeters = 18;
    const maxAngleTolerance = 28;

    // 1. Check cached OSM ways first
    const [i, j] = this.tileIndex(lat, lng);
    const tile = this.osmTiles.get(this.tileKey(i, j));
    let bestMatch = null;

    if (tile && tile.ways && tile.ways.length > 0) {
      const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
      for (const w of tile.ways) {
        const pts = w.pts;
        for (let k = 0; k < pts.length - 1; k++) {
          const ax = (pts[k][1] - lng) * kx, ay = (pts[k][0] - lat) * ky;
          const bx = (pts[k + 1][1] - lng) * kx, by = (pts[k + 1][0] - lat) * ky;
          const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
          if (l2 < 9) continue;
          const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
          const d = Math.hypot(ax + t * dx, ay + t * dy);
          if (d > maxDistanceMeters) continue;

          const segBearing = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
          const diffFwd = Math.abs(((segBearing - candidateHeading + 540) % 360) - 180);
          const oppBearing = (segBearing + 180) % 360;
          const diffBwd = Math.abs(((oppBearing - candidateHeading + 540) % 360) - 180);

          let chosenBearing = null;
          let minDiff = 999;
          if (diffFwd <= maxAngleTolerance) {
            chosenBearing = segBearing;
            minDiff = diffFwd;
          } else if (diffBwd <= maxAngleTolerance) {
            chosenBearing = oppBearing;
            minDiff = diffBwd;
          }

          if (chosenBearing !== null) {
            const score = d + minDiff * 0.25;
            if (!bestMatch || score < bestMatch.score) {
              bestMatch = { score, bearing: Math.round(chosenBearing) };
            }
          }
        }
      }
    }

    if (bestMatch) return bestMatch.bearing;

    // 2. Check Georgian high-speed corridors if OSM tile not loaded
    if (this.corridors && this.corridors.length > 0) {
      for (const corridor of this.corridors) {
        const pts = corridor.points;
        for (let k = 0; k < pts.length - 1; k++) {
          const d = this.pointToSegmentDistanceMeters(lat, lng, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]);
          if (d <= (corridor.tolerance || 60)) {
            const segBearing = this.bearingDeg(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]);
            const diffFwd = Math.abs(((segBearing - candidateHeading + 540) % 360) - 180);
            const oppBearing = (segBearing + 180) % 360;
            const diffBwd = Math.abs(((oppBearing - candidateHeading + 540) % 360) - 180);

            if (diffFwd <= maxAngleTolerance) {
              return Math.round(segBearing);
            }
            if (diffBwd <= maxAngleTolerance) {
              return Math.round(oppBearing);
            }
          }
        }
      }
    }

    return null;
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

  bearingDeg(lat1, lon1, lat2, lon2) {
    const toRad = deg => (deg * Math.PI) / 180;
    const toDeg = rad => (rad * 180) / Math.PI;
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
              Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    let brng = toDeg(Math.atan2(y, x));
    return (brng + 360) % 360;
  }
}

window.SpeedLimitEngine = SpeedLimitEngine;
