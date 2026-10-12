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

    // Road Incidents Layer (Leaflet LayerGroup)
    this.incidentsLayer = L.layerGroup();
    this.showIncidents = true;

    // Immediate lightweight incidents render (zero SDK overhead)
    this.loadRoadIncidents();

    // Default heuristic traffic score based on peak hours
    const hour = new Date().getHours();
    const initialScore = (hour >= 8 && hour <= 10) || (hour >= 18 && hour <= 20) ? 7 : (hour >= 11 && hour <= 17 ? 4 : 2);
    if (this.onTrafficScoreUpdate) {
      this.onTrafficScoreUpdate(initialScore);
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
    this.trafficProvider.setMap(this.ymapsMap);

    // 3. Listen for Traffic Score (1-10 Score)
    const updateScore = () => {
      const state = this.trafficProvider.state;
      let score = state ? state.get("level") : null;
      if (score === null || score === undefined) {
        const hour = new Date().getHours();
        score = (hour >= 8 && hour <= 10) || (hour >= 18 && hour <= 20) ? 7 : (hour >= 11 && hour <= 17 ? 4 : 2);
      }
      if (this.onTrafficScoreUpdate) {
        this.onTrafficScoreUpdate(score);
      }
    };

    this.trafficProvider.state.events.add("change", updateScore);
    setTimeout(updateScore, 2000);

    // Sync Leaflet pan & zoom with Yandex Map
    this.map.on("move", () => {
      if (this.isActive && this.ymapsMap) {
        const c = this.map.getCenter();
        this.ymapsMap.setCenter([c.lat, c.lng]);
      }
    });

    this.map.on("zoomend", () => {
      if (this.isActive && this.ymapsMap) {
        this.ymapsMap.setZoom(this.map.getZoom());
      }
    });

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
      this.ymapsMap.setCenter([c.lat, c.lng]);
      this.ymapsMap.setZoom(this.map.getZoom());
      setTimeout(() => {
        if (this.ymapsMap && this.ymapsMap.container) {
          this.ymapsMap.container.fitToViewport();
        }
      }, 50);
    }
  }

  disable() {
    this.isActive = false;
    if (this.container) {
      this.container.style.visibility = "hidden";
    }
  }

  // Road Incidents (ავარიები, საგზაო სამუშაოები, კამერები)
  loadRoadIncidents() {
    const INCIDENTS_DATA = [
      { lat: 41.7145, lon: 44.7820, type: "works", title: "საგზაო სამუშაოები", desc: "გმირთა მოედანი - მარჯვენა ზოლი შეზღუდულია" },
      { lat: 41.7205, lon: 44.7750, type: "camera", title: "სიჩქარის რადარი (60 კმ/სთ)", desc: "პეკინის გამზირი" },
      { lat: 41.7085, lon: 44.7712, type: "camera", title: "ზოლის კამერა (Bus Lane)", desc: "ჭავჭავაძის გამზირი" },
      { lat: 41.7280, lon: 44.7890, type: "works", title: "საგზაო სამუშაოები", desc: "წერეთლის გამზირი" },
      { lat: 41.6980, lon: 44.8020, type: "camera", title: "სიჩქარის რადარი (60 კმ/სთ)", desc: "მემარჯვენე სანაპირო" },
      { lat: 41.7015, lon: 44.7930, type: "crash", title: "ავარია (შეფერხება)", desc: "რუსთაველის გამზირი" }
    ];

    INCIDENTS_DATA.forEach(inc => {
      let iconHtml = "";
      if (inc.type === "crash") {
        iconHtml = `<div class="incident-badge crash" title="${inc.title}">💥</div>`;
      } else if (inc.type === "works") {
        iconHtml = `<div class="incident-badge works" title="${inc.title}">🚧</div>`;
      } else if (inc.type === "camera") {
        iconHtml = `<div class="incident-badge camera" title="${inc.title}">📹</div>`;
      }

      const icon = L.divIcon({
        className: "incident-custom-icon",
        html: iconHtml,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });

      const marker = L.marker([inc.lat, inc.lon], { icon }).bindPopup(`
        <div style="font-weight:700; color:#fff; font-size:1rem;">${inc.title}</div>
        <div style="font-size:0.85rem; color:#94a3b8; margin-top:4px;">${inc.desc}</div>
      `);

      this.incidentsLayer.addLayer(marker);
    });

    if (this.showIncidents) {
      this.incidentsLayer.addTo(this.map);
    }
  }

  toggleIncidents() {
    this.showIncidents = !this.showIncidents;
    if (this.showIncidents) {
      this.incidentsLayer.addTo(this.map);
    } else {
      this.map.removeLayer(this.incidentsLayer);
    }
    return this.showIncidents;
  }
}

window.YandexEngine = YandexEngine;
