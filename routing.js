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
    this.routeLine = null;
    this.routeLinePassed = null;
    this.steps = [];
    this.currentStepIndex = 0;
    this.isNavigating = false;
    this.offRouteStrikes = 0;
    this.isRerouting = false;
    this.lastClosestIndex = 0;

    // Simulation state
    this.isSimulating = false;
    this.simTimer = null;
    this.simIndex = 0;
    this.simSpeedFactor = 3.0;

    // Callbacks for UI updates
    this.onManeuverUpdate = null;
    this.onSummaryUpdate = null;
    this.avoidUnpaved = false;
    this.onArrival = null;
    this.onPositionUpdate = null;
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

  async calculateRoute(startLatLng, endLatLng, autoStart = false) {
    // Clear previous route first
    this.clearRoute();

    let url = `https://router.project-osrm.org/route/v1/driving/${startLatLng.lng},${startLatLng.lat};${endLatLng.lng},${endLatLng.lat}?overview=full&geometries=geojson&steps=true&alternatives=true`;
    if (this.avoidUnpaved) {
      url += `&exclude=unpaved`;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("OSRM Routing failed with status: " + response.status);

      const data = await response.json();
      if (!data.routes || data.routes.length === 0) {
        throw new Error("მარშრუტი ვერ მოიძებნა");
      }

      const route = data.routes[0];
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
        destination: endLatLng,
        destName: endLatLng.name || "დანიშნულების ადგილი"
      };

      this.lastClosestIndex = 0;
      this.offRouteStrikes = 0;

      // Passed path (subtle slate gray behind vehicle)
      this.routeLinePassed = L.polyline([], {
        color: "#64748b",
        weight: 6,
        opacity: 0.5,
        lineCap: "round",
        lineJoin: "round"
      }).addTo(this.map);

      // Upcoming glowing guide path
      this.routeLine = L.polyline(latlngs, {
        color: "#00d2ff",
        weight: 6,
        opacity: 0.9,
        lineCap: "round",
        lineJoin: "round"
      }).addTo(this.map);

      // Fit bounds nicely with padding for HUD card
      this.map.fitBounds(this.routeLine.getBounds(), {
        paddingTopLeft: [420, 40],
        paddingBottomRight: [40, 40]
      });

      // Parse Turn-by-Turn Steps
      if (route.legs && route.legs[0] && route.legs[0].steps) {
        this.parseSteps(route.legs[0].steps, latlngs);
      }

      // Initial Summary update
      this.updateRouteSummary({ lat: startLatLng.lat, lng: startLatLng.lng });

      // Fetch additional traffic signals along route bounds
      if (this.trafficSignalsEngine) {
        this.trafficSignalsEngine.fetchSignalsForBounds(this.routeLine.getBounds());
      }

      if (autoStart) {
        this.startNavigation();
      }

      return this.activeRoute;
    } catch (err) {
      console.error("Routing error:", err);
      throw err;
    }
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

    this.currentStepIndex = 0;
    this.isNavigating = false;
  }

  startNavigation() {
    this.isNavigating = true;
    if (this.steps.length > 0) {
      this.updateManeuverHUD(this.steps[this.currentStepIndex], this.steps[this.currentStepIndex].distanceMeters);
      if (this.speech) {
        let voiceText = "მარშრუტი დაწყებულია. ";
        const firstStep = this.steps[this.currentStepIndex];
        if (firstStep) {
          voiceText += `${firstStep.instruction}`;
          if (firstStep.streetName && firstStep.streetName !== "გზა") {
            voiceText += ` ${firstStep.streetName}-ზე`;
          }
        }
        this.speech.speak(voiceText);
      }
    }
  }

  updateVehiclePosition(currentLatLng, speedKmh = 0, headingDeg = 0) {
    if (!this.isNavigating || !this.activeRoute || this.steps.length === 0) return null;

    // 1. Dynamic Polyline Trimming & Off-Route Detection (TMap / Tesla OEM Standard)
    const coords = this.activeRoute.coordinates;
    if (coords && coords.length > 1) {
      let minDeviation = Infinity;
      let bestSegIndex = this.lastClosestIndex;

      // Local search window around last known position for high-performance 60 FPS
      const searchStart = Math.max(0, this.lastClosestIndex - 2);
      const searchEnd = Math.min(coords.length - 1, this.lastClosestIndex + 30);

      for (let i = searchStart; i < searchEnd; i++) {
        const d = this.distanceToSegmentMeters(currentLatLng, coords[i], coords[i + 1]);
        if (d < minDeviation) {
          minDeviation = d;
          bestSegIndex = i;
        }
      }

      // If deviation is high in local window, do a global scan in case vehicle jumped/shortcutted
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
      if (this.routeLine && this.routeLinePassed) {
        const passedPart = coords.slice(0, bestSegIndex + 1);
        passedPart.push([currentLatLng.lat, currentLatLng.lng]);
        const upcomingPart = [[currentLatLng.lat, currentLatLng.lng], ...coords.slice(bestSegIndex + 1)];

        this.routeLinePassed.setLatLngs(passedPart);
        this.routeLine.setLatLngs(upcomingPart);
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

    const currentStep = this.steps[this.currentStepIndex];
    if (!currentStep) return null;

    // Distance to current maneuver
    const distToManeuver = this.haversineMeters(
      currentLatLng.lat, currentLatLng.lng,
      currentStep.location[0], currentStep.location[1]
    );

    // If within 30 meters of maneuver point, advance to next step
    if (distToManeuver < 30 && this.currentStepIndex < this.steps.length - 1) {
      this.currentStepIndex++;
      const nextStep = this.steps[this.currentStepIndex];
      this.updateManeuverHUD(nextStep, nextStep.distanceMeters);

      // Voice prompt
      let voiceText = `${nextStep.instruction}`;
      if (nextStep.streetName && nextStep.streetName !== "გზა") {
        voiceText += ` ${nextStep.streetName}-ზე`;
      }
      if (this.speech) {
        this.speech.speak(voiceText);
      }
    } else {
      this.updateManeuverHUD(currentStep, Math.round(distToManeuver));
    }

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
    this.isRerouting = true;
    this.offRouteStrikes = 0;

    const dest = this.activeRoute.destination;
    const destName = this.activeRoute.destName;

    if (window.showToast) {
      window.showToast("🔄 მარშრუტს აცდით — ახლდება...", "info", 3000);
    }
    if (this.speech) {
      this.speech.speak("მარშრუტს აცდით. ახალი მარშრუტი ითვლება.");
    }

    try {
      dest.name = destName;
      await this.calculateRoute(currentLatLng, dest, true);
    } catch (err) {
      console.warn("Auto-reroute failed:", err);
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

  getLaneGuidance(icon) {
    if (icon === "turn-left") {
      return [
        { arrow: "↰", recommended: true },
        { arrow: "↑", recommended: false },
        { arrow: "↑", recommended: false }
      ];
    } else if (icon === "turn-right") {
      return [
        { arrow: "↑", recommended: false },
        { arrow: "↑", recommended: false },
        { arrow: "↱", recommended: true }
      ];
    } else if (icon === "u-turn") {
      return [
        { arrow: "↺", recommended: true },
        { arrow: "↑", recommended: false }
      ];
    } else {
      return [
        { arrow: "↑", recommended: true },
        { arrow: "↑", recommended: true },
        { arrow: "↑", recommended: false }
      ];
    }
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

  updateRouteSummary(currentLatLng) {
    if (!this.activeRoute || !this.activeRoute.coordinates || !this.onSummaryUpdate) return;

    const dest = this.activeRoute.coordinates[this.activeRoute.coordinates.length - 1];
    const remainingMeters = this.haversineMeters(
      currentLatLng.lat, currentLatLng.lng,
      dest[0], dest[1]
    );

    const remainingKm = remainingMeters / 1000;
    const avgSpeed = 40; // km/h
    const remainingMinutes = Math.max(1, Math.round((remainingKm) / (avgSpeed / 60)) + (this.activeRoute.trafficDelayMin || 0));

    const now = new Date();
    now.setMinutes(now.getMinutes() + remainingMinutes);
    const etaHours = String(now.getHours()).padStart(2, '0');
    const etaMinutes = String(now.getMinutes()).padStart(2, '0');
    const etaStr = `${etaHours}:${etaMinutes}`;

    const batteryImpact = this.batteryEngine
      ? this.batteryEngine.calculateTripEnergy(remainingKm)
      : null;

    this.onSummaryUpdate({
      distanceKm: remainingKm.toFixed(1),
      durationMin: remainingMinutes,
      etaStr: etaStr,
      batteryImpact: batteryImpact
    });
  }

  // Demo Drive Simulation along route
  startSimulation() {
    if (!this.activeRoute || !this.activeRoute.coordinates || !this.activeRoute.coordinates.length) return;

    this.stopSimulation();
    this.isSimulating = true;
    this.simIndex = 0;

    const coords = this.activeRoute.coordinates;
    const intervalMs = 250;

    this.simTimer = setInterval(() => {
      if (this.simIndex >= coords.length - 1) {
        this.stopSimulation();
        if (this.speech) this.speech.speak("მიხვედით დანიშნულების ადგილზე");
        if (this.onArrival) this.onArrival();
        return;
      }

      const p1 = coords[this.simIndex];
      const p2 = coords[Math.min(this.simIndex + 1, coords.length - 1)];

      const heading = this.calculateBearing(p1[0], p1[1], p2[0], p2[1]);
      const currentPos = { lat: p1[0], lng: p1[1] };
      const simulatedSpeedKmh = Math.floor(45 + Math.sin(this.simIndex / 5) * 12);

      const signalAhead = this.updateVehiclePosition(currentPos, simulatedSpeedKmh, heading);

      if (this.onPositionUpdate) {
        this.onPositionUpdate({
          pos: currentPos,
          heading: heading,
          speed: simulatedSpeedKmh,
          signalAhead: signalAhead
        });
      }

      this.simIndex++;
    }, intervalMs);
  }

  stopSimulation() {
    this.isSimulating = false;
    if (this.simTimer) {
      clearInterval(this.simTimer);
      this.simTimer = null;
    }
  }

  clearRoute() {
    this.stopSimulation();
    this.isNavigating = false;
    this.offRouteStrikes = 0;
    this.isRerouting = false;
    this.lastClosestIndex = 0;
    if (this.routeLine) {
      this.map.removeLayer(this.routeLine);
      this.routeLine = null;
    }
    if (this.routeLinePassed) {
      this.map.removeLayer(this.routeLinePassed);
      this.routeLinePassed = null;
    }
    if (this.trafficEngine) {
      this.trafficEngine.clearRouteTraffic();
    }
    this.activeRoute = null;
    this.steps = [];
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
