/**
 * Traffic Engine
 * Live traffic flow tiles (TomTom, needs a free API key in Settings) drawn as a MapLibre raster layer.
 * The layer is registered in window.layerRegistry, so it survives a map style switch.
 *
 * There is no other real traffic data source: without a key the traffic button has nothing to show and the
 * route gets no congestion colouring and no extra delay (the old code invented pseudo-random congestion).
 */

const TRAFFIC_SOURCE_ID = "traffic-flow-src";
const TRAFFIC_LAYER_ID = "traffic-flow-layer";

class TrafficEngine {
  constructor(map, startEnabled = true) {
    this.map = map;
    this.isEnabled = !!startEnabled;
    this.tomtomKey = localStorage.getItem("tomtom_api_key") || "";

    this.registerMapLayers();
  }

  hasKey() {
    return !!this.tomtomKey;
  }

  sourceSpec() {
    return {
      type: "raster",
      tiles: [`https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${encodeURIComponent(this.tomtomKey)}`],
      tileSize: 256,
      maxzoom: 19
    };
  }

  layerSpec() {
    return {
      id: TRAFFIC_LAYER_ID,
      type: "raster",
      source: TRAFFIC_SOURCE_ID,
      layout: { visibility: this.isEnabled ? "visible" : "none" },
      paint: { "raster-opacity": 0.75 }
    };
  }

  registerMapLayers() {
    const reg = typeof window !== "undefined" ? window.layerRegistry : null;
    if (!reg) return;
    reg.register("traffic-flow", {
      sources: () => (this.hasKey() ? { [TRAFFIC_SOURCE_ID]: this.sourceSpec() } : {}),
      layers: () => (this.hasKey() ? [this.layerSpec()] : [])
    });
  }

  /** Remove the layer/source from the live map (style data stays in the registry). */
  removeFromMap() {
    const m = this.map;
    if (!m || typeof m.getLayer !== "function") return;
    if (m.getLayer(TRAFFIC_LAYER_ID)) m.removeLayer(TRAFFIC_LAYER_ID);
    if (m.getSource(TRAFFIC_SOURCE_ID)) m.removeSource(TRAFFIC_SOURCE_ID);
  }

  setApiKey(key) {
    this.tomtomKey = (key || "").trim();
    localStorage.setItem("tomtom_api_key", this.tomtomKey);
    this.removeFromMap();
    const m = this.map;
    if (this.hasKey() && m && typeof m.addSource === "function" && m.isStyleLoaded()) {
      m.addSource(TRAFFIC_SOURCE_ID, this.sourceSpec());
      m.addLayer(this.layerSpec());
    }
  }

  toggle() {
    this.isEnabled = !this.isEnabled;
    const m = this.map;
    if (m && typeof m.getLayer === "function" && m.getLayer(TRAFFIC_LAYER_ID)) {
      m.setLayoutProperty(TRAFFIC_LAYER_ID, "visibility", this.isEnabled ? "visible" : "none");
    }
    return this.isEnabled;
  }

  clearRouteTraffic() {
    // no route congestion colouring without a real data source
  }

  /**
   * AUDIT FIX: previously generated PSEUDO-RANDOM (sin-based) congestion colours and
   * fake delay minutes. Removed. Without a real data source we show no congestion
   * colouring and add 0 delay.
   */
  renderRouteCongestion(latlngs, totalDurationSec) {
    return 0;
  }
}

window.TrafficEngine = TrafficEngine;
