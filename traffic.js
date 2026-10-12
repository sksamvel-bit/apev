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
  /**
   * AUDIT FIX: previously generated PSEUDO-RANDOM (sin-based) congestion colours and
   * fake delay minutes. Removed. Without a real data source we show no congestion
   * colouring and add 0 delay. (Real data: TomTom flow tiles / Yandex layer only.)
   */
  renderRouteCongestion(latlngs, totalDurationSec) {
    this.clearRouteTraffic();
    return 0;
  }
}

window.TrafficEngine = TrafficEngine;
