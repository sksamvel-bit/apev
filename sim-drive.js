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
      this.runStep();
      this.timer = setInterval(() => this.runStep(), this.stepIntervalMs);
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

      // Linear scan for current segment in cumDist
      let seg = 0;
      while (seg < this.cumDist.length - 2 && this.cumDist[seg + 1] < this.currentDistance) {
        seg++;
      }

      const p1 = this.coords[seg];
      const p2 = this.coords[Math.min(seg + 1, this.coords.length - 1)];
      const segLen = Math.max(0.1, this.cumDist[seg + 1] - this.cumDist[seg]);
      const t = Math.max(0, Math.min(1, (this.currentDistance - this.cumDist[seg]) / segLen));

      const lat = p1[0] + t * (p2[0] - p1[0]);
      const lng = p1[1] + t * (p2[1] - p1[1]);
      const heading = (re && typeof re.calculateBearing === "function")
        ? Math.round(re.calculateBearing(p1[0], p1[1], p2[0], p2[1]))
        : 0;

      // Realistic speed modulation: ~45-56 km/h
      const speedKmh = Math.max(25, Math.round(48 + Math.sin(this.currentDistance / 60) * 8));
      const currentPos = { lat, lng };

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
        window.updateVehicleMarker(lat, lng, heading, speedKmh, 5);
      }

      // Advance distance for next tick (dt = stepIntervalMs / 1000)
      const speedMps = speedKmh / 3.6;
      this.currentDistance += speedMps * (this.stepIntervalMs / 1000);
    }

    stop() {
      this.isSimulating = false;
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
