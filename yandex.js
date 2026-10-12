/**
 * Yandex Maps & Live Traffic Engine
 * Uses Yandex JavaScript API v2.1 with API Key: e9746eaf-9ee1-44b5-a380-f97a4ebc98d8
 * Features:
 * - Yandex Base Map & Yandex Live Traffic Layer
 * - 10-Point City Traffic Score (Яндекс Пробки 1-10 ბალი)
 * - Road Incidents & Cameras Layer (ავარიები, სამუშაოები, რადარები)
 */

const YANDEX_API_KEY = "e9746eaf-9ee1-44b5-a380-f97a4ebc98d8";

class YandexEngine {
  constructor(map, onTrafficScoreUpdate) {
    this.map = map;
    this.onTrafficScoreUpdate = onTrafficScoreUpdate;
    this.isLoaded = false;
    this.isLoading = false;
    this.ymapsMap = null;
    this.trafficProvider = null;
    this.container = null;
    this.isActive = false;
    this.isTrafficEnabled = true;

    // Road Incidents Layer (Leaflet LayerGroup)
    this.incidentsLayer = L.layerGroup();
    this.showIncidents = false;

    // AUDIT FIX: no heuristic/fake score. UI shows "--" until Yandex reports a real level.
    if (this.onTrafficScoreUpdate) {
      this.onTrafficScoreUpdate(null);
    }
  }

  // Lazy-load Yandex Maps JS API v2.1 only when user switches to Yandex map
  initScript() {
    if (this.isLoaded || this.isLoading) return;

    if (window.ymaps) {
      this.isLoaded = true;
      this.initYandexComponents();
      if (this.isActive) this.enable();
      return;
    }

    this.isLoading = true;
    const script = document.createElement("script");
    script.src = `https://api-maps.yandex.ru/2.1/?apikey=${YANDEX_API_KEY}&lang=ru_RU`;
    script.type = "text/javascript";
    script.async = true;

    script.onload = () => {
      ymaps.ready(() => {
        this.isLoaded = true;
        this.isLoading = false;
        this.initYandexComponents();
        if (this.isActive) {
          this.enable();
        }
        if (typeof this.onReady === "function") {
          try { this.onReady(); } catch(e){}
        }
      });
    };

    script.onerror = (err) => {
      console.warn("Yandex Maps API load notice:", err);
      this.isLoading = false;
    };

    document.head.appendChild(script);
  }

  initYandexComponents() {
    // 1. Create container with visibility:hidden instead of display:none
    // so that Yandex Maps correctly computes viewport dimensions
    if (!this.container) {
      this.container = document.createElement("div");
      this.container.id = "yandex-map-container";
      this.container.style.position = "absolute";
      this.container.style.inset = "0";
      this.container.style.width = "100%";
      this.container.style.height = "100%";
      this.container.style.zIndex = "0";
      this.container.style.visibility = "hidden";
      document.getElementById("map").prepend(this.container);
    }

    const center = this.map.getCenter();
    this.ymapsMap = new ymaps.Map("yandex-map-container", {
      center: [center.lat, center.lng],
      zoom: this.map.getZoom(),
      controls: []
    }, {
      suppressMapOpenBlock: true
    });

    // 2. Enable Real-Time Traffic Provider (Яндекс Пробки)
    this.trafficProvider = new ymaps.traffic.provider.Actual({}, { infoLayerShown: true });
    if (this.isTrafficEnabled) {
      this.trafficProvider.setMap(this.ymapsMap);
    }

    // 3. Listen for Traffic Score (1-10 Score)
    const updateScore = () => {
      const state = this.trafficProvider ? this.trafficProvider.state : null;
      let score = state ? state.get("level") : null;
      if (score === undefined) score = null;
      if (this.onTrafficScoreUpdate) {
        this.onTrafficScoreUpdate(score);
      }
    };

    this.trafficProvider.state.events.add("change", updateScore);
    setTimeout(updateScore, 2000);

    // High-performance 60 FPS lockstep sync with Leaflet
    let syncPending = false;
    const syncToYandex = () => {
      if (!this.isActive || !this.ymapsMap || syncPending) return;
      syncPending = true;

      requestAnimationFrame(() => {
        syncPending = false;
        if (!this.isActive || !this.ymapsMap) return;

        const c = this.map.getCenter();
        const z = this.map.getZoom();

        // Pass duration: 0 and checkZoomRange: false to immediately lockstep with Leaflet!
        this.ymapsMap.setCenter([c.lat, c.lng], z, {
          duration: 0,
          checkZoomRange: false
        });
      });
    };

    // Instantaneous synchronous lockstep for zoom transitions (0 latency, zero drifting icons)
    const syncImmediate = () => {
      if (!this.isActive || !this.ymapsMap) return;
      syncPending = false;
      const c = this.map.getCenter();
      const z = this.map.getZoom();
      this.ymapsMap.setCenter([c.lat, c.lng], z, {
        duration: 0,
        checkZoomRange: false
      });
    };

    // Dragging / panning uses 60 FPS requestAnimationFrame throttling
    this.map.on("move", syncToYandex);
    this.map.on("moveend", syncImmediate);

    // Zooming is synchronized instantaneously with zero delay
    this.map.on("zoom", syncImmediate);
    this.map.on("zoomend", syncImmediate);
    this.map.on("viewreset", syncImmediate);
  }

  enable() {
    this.isActive = true;

    // Trigger on-demand script download if not yet loaded
    if (!this.isLoaded) {
      if (!this.isLoading) {
        this.initScript();
      }
      return;
    }

    if (this.container) {
      this.container.style.visibility = "visible";
    }
    if (this.ymapsMap) {
      const c = this.map.getCenter();
      this.ymapsMap.setCenter([c.lat, c.lng], this.map.getZoom(), {
        duration: 0,
        checkZoomRange: false
      });
      if (this.trafficProvider) {
        this.trafficProvider.setMap(this.isTrafficEnabled ? this.ymapsMap : null);
      }
      setTimeout(() => {
        if (this.ymapsMap && this.ymapsMap.container) {
          this.ymapsMap.container.fitToViewport();
        }
      }, 50);
    }
  }

  toggleTraffic(explicitState) {
    if (typeof explicitState === "boolean") {
      this.isTrafficEnabled = explicitState;
    } else {
      this.isTrafficEnabled = !this.isTrafficEnabled;
    }

    if (this.trafficProvider && this.ymapsMap) {
      if (this.isTrafficEnabled) {
        this.trafficProvider.setMap(this.ymapsMap);
      } else {
        this.trafficProvider.setMap(null);
      }
    }
    return this.isTrafficEnabled;
  }

  disable() {
    this.isActive = false;
    if (this.container) {
      this.container.style.visibility = "hidden";
    }
  }

  // Road Incidents (ავარიები, საგზაო სამუშაოები, კამერები)
  loadRoadIncidents() {
    // Demo markers removed for Tesla MCU lightweight performance
  }

  toggleIncidents() {
    return false;
  }
}

window.YandexEngine = YandexEngine;
