/**
 * EV Chargers Engine
 * Manages EV charging stations layer, live 650+ chargers in Georgia,
 * connector types, power ratings, and 1-click routing.
 * 
 * TESLA MCU OPTIMIZATION: Viewport Bounding-Box Culling
 * Instead of keeping 650+ heavy DOM elements in the map pane simultaneously
 * (which causes severe frame-rate drops on Intel Atom MCU2), this engine maintains
 * the station database in memory and dynamically renders only visible stations
 * within the map viewport (typically 10-30 markers).
 */

const CURATED_CHARGERS = [];

class ChargersEngine {
  constructor(map, onRouteToCharger) {
    this.map = map;
    this.onRouteToCharger = onRouteToCharger;
    this.layerGroup = L.layerGroup().addTo(map);
    this.chargers = [];
    this.activeMarkers = new Map(); // key -> L.marker
    this.isEnabled = true;
    this.cachedKeys = new Set();

    this.loadCuratedChargers();
    this.fetchLiveChargers();

    // Auto-sync live chargers periodically (every 15 mins)
    setInterval(() => this.fetchLiveChargers(), 15 * 60 * 1000);

    // Update rendered markers on map panning/zooming
    if (this.map) {
      this.map.on("moveend zoomend", () => {
        if (this.isEnabled) this.updateVisibleMarkers();
      });
    }
  }

  loadCuratedChargers() {
    CURATED_CHARGERS.forEach(ch => {
      this.addCharger(ch.lat, ch.lon, ch.name, ch.power, ch.type, ch.operator);
    });
  }

  async fetchLiveChargers() {
    try {
      const res = await fetch('/api/chargers/live');
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.stations && data.stations.length > 0) {
        data.stations.forEach(st => {
          this.addCharger(st.lat, st.lng, st.name, st.power, st.type, st.operator, st.price, st.hours);
        });
        this.updateVisibleMarkers();
      }
    } catch (err) {
      console.warn('[EV] Live chargers fetch notice:', err.message);
    }
  }

  createChargerIcon(power) {
    const isUltraFast = power && (power.includes("120") || power.includes("150") || power.includes("160"));
    const glowColor = isUltraFast ? "#10b981" : "#00d2ff";

    return L.divIcon({
      className: 'ev-charger-custom-marker',
      html: `
        <div style="
          width: 24px;
          height: 24px;
          background: #0f172a;
          border: 1.8px solid ${glowColor};
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 0 8px ${glowColor}60;
          cursor: pointer;
        ">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="${glowColor}">
            <path d="M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66.19-.34.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15-5.9 10.34z"/>
          </svg>
        </div>
      `,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
  }

  addCharger(lat, lon, name, power = "50 kW", type = "CCS2", operator = "EV Network", price = null, hours = null) {
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (this.cachedKeys.has(key)) return;

    this.cachedKeys.add(key);
    const isUltraFast = power && (power.includes("120") || power.includes("150") || power.includes("160"));
    const isFast = power && (power.includes("50") || power.includes("60") || power.includes("75") || power.includes("80") || power.includes("90") || power.includes("100"));

    this.chargers.push({
      key,
      lat,
      lon,
      name,
      power,
      type,
      operator,
      price,
      hours,
      isUltraFast,
      isFast
    });
  }

  createMarkerInstance(st) {
    const marker = L.marker([st.lat, st.lon], {
      icon: this.createChargerIcon(st.power),
      zIndexOffset: 500
    });

    const e = window.escapeHtml || (v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])));
    const safeName = e(st.name);
    const safePower = e(st.power);
    const safeType = e(st.type);
    const safeOperator = e(st.operator);
    const safePrice = st.price ? e(st.price) : null;
    const safeHours = st.hours ? e(st.hours) : null;

    const safeBtnId = `route-to-charger-btn-${st.key.replace(/[.,]/g, '_')}`;
    const popupEl = document.createElement("div");
    popupEl.style.minWidth = "240px";
    popupEl.innerHTML = `
      <div style="font-weight:700; color:#10b981; font-size:1.05rem; display:flex; align-items:center; gap:6px;">
        ⚡ ${safeName}
      </div>
      <div style="margin: 8px 0; font-size:0.85rem; color:#cbd5e1; display:flex; flex-direction:column; gap:4px;">
        <div><strong>სიმძლავრე:</strong> <span style="color:#34d399; font-weight:700;">${safePower}</span></div>
        <div><strong>კონექტორი:</strong> ${safeType}</div>
        <div><strong>ოპერატორი:</strong> <span style="text-transform:capitalize; color:#38bdf8;">${safeOperator}</span></div>
        ${safePrice ? `<div><strong>ტარიფი:</strong> <span style="color:#fbbf24; font-weight:700;">${safePrice}</span></div>` : ''}
        ${safeHours ? `<div><strong>სამუშაო საათები:</strong> ${safeHours}</div>` : ''}
      </div>
      <button class="popup-dest-btn" style="background: linear-gradient(135deg, #059669, #10b981);" id="${safeBtnId}">
        ⚡ აქ დამუხტვა (Route)
      </button>
    `;

    marker.bindPopup(popupEl);

    marker.on("popupopen", () => {
      const btn = document.getElementById(safeBtnId);
      if (btn && this.onRouteToCharger) {
        btn.onclick = () => {
          marker.closePopup();
          this.onRouteToCharger({ lat: st.lat, lng: st.lon, name: st.name, address: st.name });
        };
      }
    });

    return marker;
  }

  // Viewport Culling: Only render markers that are inside the visible map area
  updateVisibleMarkers() {
    if (!this.isEnabled || !this.map) return;

    let bounds;
    try {
      bounds = this.map.getBounds().pad(0.12); // viewport + 12% padding
    } catch (e) {
      return;
    }

    const zoom = this.map.getZoom();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const west = bounds.getWest();
    const east = bounds.getEast();

    // Few, relevant markers only: nearest to the map centre first (not array order), fast chargers first.
    // Old code rendered up to 60 and the first 60 in array order, which flooded the night map.
    const maxDomMarkers = zoom >= 16 ? 30 : zoom >= 14 ? 18 : zoom >= 11 ? 12 : 8;
    const c = this.map.getCenter();
    const cand = [];
    for (let i = 0; i < this.chargers.length; i++) {
      const st = this.chargers[i];
      if (st.lat < south || st.lat > north || st.lon < west || st.lon > east) continue;
      // below street zoom only DC fast / ultra-fast chargers are interesting
      if (zoom < 15 && !st.isUltraFast && !st.isFast) continue;
      const dLat = st.lat - c.lat, dLon = (st.lon - c.lng) * 0.75;
      cand.push({ st, d: dLat * dLat + dLon * dLon });
    }
    cand.sort((a, b) => a.d - b.d);
    const currentlyVisible = new Set();
    for (let k = 0; k < cand.length && k < maxDomMarkers; k++) {
      const st = cand[k].st;
      currentlyVisible.add(st.key);
      if (!this.activeMarkers.has(st.key)) {
        const marker = this.createMarkerInstance(st);
        this.activeMarkers.set(st.key, marker);
        this.layerGroup.addLayer(marker);
      }
    }

    // Remove markers that are no longer inside the viewport
    for (const [key, marker] of this.activeMarkers.entries()) {
      if (!currentlyVisible.has(key)) {
        this.layerGroup.removeLayer(marker);
        this.activeMarkers.delete(key);
      }
    }
  }

  toggle() {
    this.isEnabled = !this.isEnabled;
    if (this.isEnabled) {
      this.layerGroup.addTo(this.map);
      this.updateVisibleMarkers();
    } else {
      this.layerGroup.clearLayers();
      this.activeMarkers.clear();
      this.map.removeLayer(this.layerGroup);
    }
    return this.isEnabled;
  }
}

window.ChargersEngine = ChargersEngine;
