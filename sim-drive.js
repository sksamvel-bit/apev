/**
 * Test Drive Simulation Engine (sim-drive.js)
 * Allows testing vehicle navigation, heading-up rotation, follow-camera 3D pitch,
 * turn-by-turn maneuvers, speedometer, and traffic lights simulation in-car or desktop.
 */
(function() {
  class SimDriveEngine {
    constructor() {
      this.isSimulating = false;
      this.timer = null;
      this.currentDistance = 0;
      this.stepIntervalMs = 500; // 2 Hz updates - smooth dead-reckoning extrapolation for FollowCamera
      this.cumDist = null;
      this.coords = null;
      this.btn = null;

      // Intercept geolocation watchPosition so real GPS doesn't overwrite simulation while active
      if (typeof navigator !== "undefined" && navigator.geolocation && navigator.geolocation.watchPosition) {
        const origWatch = navigator.geolocation.watchPosition.bind(navigator.geolocation);
        navigator.geolocation.watchPosition = function(success, error, options) {
          return origWatch(function(pos) {
            if (typeof window !== "undefined" && window.isSimulatingDrive) return; // ignore real GPS during simulation
            success(pos);
          }, error, options);
        };
      }
    }

    init() {
      if (typeof document === "undefined") return;
      this.btn = document.getElementById("btn-sim-drive");
      if (this.btn) {
        this.btn.addEventListener("click", () => this.toggle());
      }
    }

    toggle() {
      if (this.isSimulating) {
        this.stop();
      } else {
        this.start();
      }
    }

    async start() {
      const re = typeof window !== "undefined" ? window.routingEngine : null;
      if (!re) {
        if (typeof window !== "undefined" && window.showToast) window.showToast("ნავიგაციის ძრავი არ არის მზად", "error");
        return;
      }

      // If no route exists, start a default demo route in Tbilisi (Freedom Square -> Chavchavadze, Vake)
      if (!re.activeRoute || !re.activeRoute.coordinates || re.activeRoute.coordinates.length < 2) {
        const dest = { lat: 41.7082, lng: 44.7750, name: "ვაკე, ჭავჭავაძის გამზირი" };
        const startPos = (window.currentPos && window.currentPos.lat) ? window.currentPos : { lat: 41.6938, lng: 44.8015 };
        if (window.showToast) window.showToast("🏎️ ტესტ-დრაივი: მარშრუტის დახაზვა...", "info", 2000);

        try {
          if (typeof window.startNavigation === "function") {
            await window.startNavigation(dest, dest.name);
          } else if (typeof re.calculateRoute === "function") {
            await re.calculateRoute(startPos, dest, true);
          }
        } catch (err) {
          if (window.showToast) window.showToast("ტესტ-დრაივის მარშრუტი ვერ აიგო: " + err.message, "error");
          return;
        }
      }

      if (!re.activeRoute || !re.activeRoute.coordinates || re.activeRoute.coordinates.length < 2) {
        if (typeof window !== "undefined" && window.showToast) window.showToast("მარშრუტი არ არსებობს", "error");
        return;
      }

      this.coords = re.activeRoute.coordinates;
      this.cumDist = re.cumDist;

      // Recalculate cumDist if needed
      if (!this.cumDist || this.cumDist.length !== this.coords.length) {
        const cum = [0];
        for (let k = 1; k < this.coords.length; k++) {
          const d = typeof re.haversineMeters === "function"
            ? re.haversineMeters(this.coords[k - 1][0], this.coords[k - 1][1], this.coords[k][0], this.coords[k][1])
            : 10;
          cum.push(cum[k - 1] + d);
        }
        this.cumDist = cum;
      }

      this.isSimulating = true;
      if (typeof window !== "undefined") {
        window.isSimulatingDrive = true;
        if (typeof window.setFollowCarMode === "function") window.setFollowCarMode(true);
        if (typeof window.recenterOnCar === "function") window.recenterOnCar();
        if (window.showToast) {
          window.showToast("🏎️ ტესტ-დრაივი დაიწყო! რუკა მოძრაობს და ბრუნავს", "success", 3000);
        }
      }

      if (this.btn) this.btn.classList.add("active");

      this.currentDistance = 0;
      this.currentHeading = null;
      this.runStep();
      this.timer = setInterval(() => this.runStep(), this.stepIntervalMs);
    }

    getPointAtDistance(dist) {
      if (!this.coords || !this.cumDist || this.coords.length === 0) return { lat: 0, lng: 0 };
      if (dist <= 0) return { lat: this.coords[0][0], lng: this.coords[0][1] };
      const totalLen = this.cumDist[this.cumDist.length - 1];
      if (dist >= totalLen) {
        const last = this.coords[this.coords.length - 1];
        return { lat: last[0], lng: last[1] };
      }

      let seg = 0;
      while (seg < this.cumDist.length - 2 && this.cumDist[seg + 1] < dist) {
        seg++;
      }

      const p1 = this.coords[seg];
      const p2 = this.coords[Math.min(seg + 1, this.coords.length - 1)];
      const segLen = Math.max(0.001, this.cumDist[seg + 1] - this.cumDist[seg]);
      const t = Math.max(0, Math.min(1, (dist - this.cumDist[seg]) / segLen));

      return {
        lat: p1[0] + t * (p2[0] - p1[0]),
        lng: p1[1] + t * (p2[1] - p1[1])
      };
    }

    runStep() {
      if (!this.isSimulating || !this.coords || !this.cumDist) return;

      const re = typeof window !== "undefined" ? window.routingEngine : null;
      const totalLen = this.cumDist[this.cumDist.length - 1];

      if (this.currentDistance >= totalLen) {
        this.stop();
        if (re && typeof re.onArrival === "function") re.onArrival();
        if (typeof window !== "undefined" && window.showToast) {
          window.showToast("🏁 ტესტ-დრაივი დასრულდა! მიხვედით დანიშნულების ადგილზე", "success", 4000);
        }
        return;
      }

      const currentPos = this.getPointAtDistance(this.currentDistance);

      // Realistic speed modulation: ~45-56 km/h
      const speedKmh = Math.max(25, Math.round(48 + Math.sin(this.currentDistance / 60) * 8));
      const speedMps = speedKmh / 3.6;

      // Pure Pursuit Lookahead steering (14m - 24m ahead on polyline)
      const lookaheadDist = Math.max(14, Math.min(24, speedMps * 1.35));
      const lookaheadPos = this.getPointAtDistance(Math.min(totalLen, this.currentDistance + lookaheadDist));

      let rawTargetHeading = 0;
      if (re && typeof re.calculateBearing === "function") {
        rawTargetHeading = re.calculateBearing(currentPos.lat, currentPos.lng, lookaheadPos.lat, lookaheadPos.lng);
      } else {
        const dLng = (lookaheadPos.lng - currentPos.lng) * Math.PI / 180;
        const lat1 = currentPos.lat * Math.PI / 180;
        const lat2 = lookaheadPos.lat * Math.PI / 180;
        const y = Math.sin(dLng) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
        rawTargetHeading = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
      }

      // Smooth automotive steering curve without sharp discrete jumps
      if (this.currentHeading == null || isNaN(this.currentHeading)) {
        this.currentHeading = rawTargetHeading;
      } else {
        let delta = ((rawTargetHeading - this.currentHeading + 540) % 360) - 180;
        const maxRate = 18;
        const clampedDelta = Math.max(-maxRate, Math.min(maxRate, delta));
        this.currentHeading = (this.currentHeading + clampedDelta * 0.75 + 360) % 360;
      }

      const heading = Math.round(this.currentHeading);

      // Update route tracking & maneuvers
      let signalAhead = null;
      if (re && typeof re.updateVehiclePosition === "function") {
        signalAhead = re.updateVehiclePosition(currentPos, speedKmh, heading);
      }

      // Update vehicle marker & follow camera
      if (re && typeof re.onPositionUpdate === "function") {
        re.onPositionUpdate({
          pos: currentPos,
          heading: heading,
          speed: speedKmh,
          signalAhead: signalAhead
        });
      } else if (typeof window !== "undefined" && typeof window.updateVehicleMarker === "function") {
        window.updateVehicleMarker(currentPos.lat, currentPos.lng, heading, speedKmh, 5);
      }

      // Explicitly feed FollowCamera smooth continuous heading
      if (typeof window !== "undefined" && window.mapCamera) {
        window.mapCamera.setFix({
          lng: currentPos.lng,
          lat: currentPos.lat,
          headingDeg: heading,
          speedMs: speedMps
        });
      }

      // Advance distance for next tick (dt = stepIntervalMs / 1000)
      this.currentDistance += speedMps * (this.stepIntervalMs / 1000);
    }

    stop() {
      this.isSimulating = false;
      this.currentHeading = null;
      if (typeof window !== "undefined") window.isSimulatingDrive = false;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      if (this.btn) this.btn.classList.remove("active");
      if (typeof window !== "undefined" && window.showToast) {
        window.showToast("🛑 ტესტ-დრაივი შეჩერებულია", "info", 2000);
      }
    }
  }

  if (typeof window !== "undefined") {
    const engine = new SimDriveEngine();
    window.simDriveEngine = engine;
    window.SimDriveEngine = SimDriveEngine;

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => engine.init());
    } else {
      engine.init();
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { SimDriveEngine };
  }
})();
