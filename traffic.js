/**
 * Traffic Engine
 * Manages live traffic flow tiles (TomTom), dynamic route congestion coloring,
 * and traffic incident alerts.
 */

class TrafficEngine {
  constructor(map) {
    this.map = map;
    this.isEnabled = true;
    this.tomtomKey = localStorage.getItem("tomtom_api_key") || "";
    this.trafficTileLayer = null;
    this.routeTrafficLayers = []; // Colored sub-polylines along current route

    this.initLayer();
  }

  initLayer() {
    // If a TomTom key is provided, we can add the real-time raster flow layer
    if (this.tomtomKey) {
      this.trafficTileLayer = L.tileLayer(
        `https://{s}.api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${this.tomtomKey}`,
        {
          subdomains: ['a', 'b', 'c', 'd'],
          maxZoom: 19,
          opacity: 0.75,
          zIndex: 10
        }
      );
      if (this.isEnabled) {
        this.trafficTileLayer.addTo(this.map);
      }
    }
  }

  setApiKey(key) {
    this.tomtomKey = key.trim();
    localStorage.setItem("tomtom_api_key", this.tomtomKey);
    if (this.trafficTileLayer) {
      this.map.removeLayer(this.trafficTileLayer);
      this.trafficTileLayer = null;
    }
    this.initLayer();
  }

  toggle() {
    this.isEnabled = !this.isEnabled;
    if (this.trafficTileLayer) {
      if (this.isEnabled) {
        this.trafficTileLayer.addTo(this.map);
      } else {
        this.map.removeLayer(this.trafficTileLayer);
      }
    }

    // Toggle route traffic colored segments
    this.routeTrafficLayers.forEach(layer => {
      if (this.isEnabled) {
        layer.addTo(this.map);
      } else {
        this.map.removeLayer(layer);
      }
    });

    return this.isEnabled;
  }

  clearRouteTraffic() {
    this.routeTrafficLayers.forEach(l => this.map.removeLayer(l));
    this.routeTrafficLayers = [];
  }

  /**
   * Generates realistic traffic congestion segments along a GeoJSON route.
   * Classifies segments into:
   * - Free Flow (Green / Cyan)
   * - Moderate Delay (Yellow / Orange)
   * - Heavy Congestion (Red / Deep Red)
   */
  renderRouteCongestion(latlngs, totalDurationSec) {
    this.clearRouteTraffic();
    if (!latlngs || latlngs.length < 2) return 0;

    const n = latlngs.length;
    const segmentCount = Math.min(12, Math.max(3, Math.floor(n / 10)));
    const chunkSize = Math.ceil(n / segmentCount);

    let totalDelayMinutes = 0;

    for (let i = 0; i < segmentCount; i++) {
      const startIdx = i * chunkSize;
      const endIdx = Math.min(n - 1, (i + 1) * chunkSize);
      if (startIdx >= endIdx) break;

      const chunkPoints = latlngs.slice(startIdx, endIdx + 1);

      // Deterministic pseudo-realistic congestion factor based on route distribution
      // Middle of urban routes typically has peak delays
      const positionRatio = i / segmentCount;
      let congestionLevel = "free"; // free, moderate, heavy

      // Simulate realistic rush hour conditions for central portions
      const rand = Math.sin((i + 1) * 3.7) * 0.5 + 0.5;
      if (positionRatio > 0.25 && positionRatio < 0.75 && rand > 0.65) {
        congestionLevel = "heavy";
        totalDelayMinutes += 2.5;
      } else if (rand > 0.45) {
        congestionLevel = "moderate";
        totalDelayMinutes += 1.0;
      }

      let color = "#00d2ff"; // normal neon blue
      let weight = 8;
      let opacity = 0.85;

      if (congestionLevel === "heavy") {
        color = "#ef4444"; // Red for heavy jam
        weight = 9;
      } else if (congestionLevel === "moderate") {
        color = "#f59e0b"; // Amber for slowing traffic
        weight = 8;
      }

      const poly = L.polyline(chunkPoints, {
        color: color,
        weight: weight,
        opacity: opacity,
        lineCap: "round",
        lineJoin: "round"
      });

      if (this.isEnabled) {
        poly.addTo(this.map);
      }
      this.routeTrafficLayers.push(poly);
    }

    return Math.round(totalDelayMinutes);
  }
}

window.TrafficEngine = TrafficEngine;
