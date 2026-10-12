/**
 * EV Chargers Engine
 * Manages EV charging stations layer, curated fast chargers in Georgia & worldwide,
 * connector types, power ratings, and 1-click routing.
 */

// Curated accurate Fast DC & AC chargers across Georgia (Tbilisi & highways)
// AUDIT FIX: 11 hand-typed, unverified chargers removed (6/11 had no match in the live database).
const CURATED_CHARGERS = [];

class ChargersEngine {
  constructor(map, onRouteToCharger) {
    this.map = map;
    this.onRouteToCharger = onRouteToCharger;
    this.layerGroup = L.layerGroup().addTo(map);
    this.chargers = [];
    this.isEnabled = true;
    this.cachedKeys = new Set();

    this.loadCuratedChargers();
    this.fetchLiveChargers();

    // Auto-sync live chargers periodically (every 15 mins)
    setInterval(() => this.fetchLiveChargers(), 15 * 60 * 1000);
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
        console.log(`[EV] Loaded ${data.stations.length} live charging stations across Georgia from dachar.ge aggregator`);
        data.stations.forEach(st => {
          this.addCharger(st.lat, st.lng, st.name, st.power, st.type, st.operator, st.price, st.hours);
        });
      }
    } catch (err) {
      console.warn('[EV] Live chargers fetch error, using curated:', err);
    }
  }

  createChargerIcon(power) {
    const isUltraFast = power && (power.includes("120") || power.includes("150") || power.includes("160"));
    const glowColor = isUltraFast ? "#10b981" : "#00d2ff";

    return L.divIcon({
      className: 'ev-charger-custom-marker',
      html: `
        <div style="
          width: 34px;
          height: 34px;
          background: #0f172a;
          border: 2px solid ${glowColor};
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 0 10px ${glowColor}70;
          cursor: pointer;
        ">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="${glowColor}">
            <path d="M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66.19-.34.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15-5.9 10.34z"/>
          </svg>
        </div>
      `,
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });
  }

  addCharger(lat, lon, name, power = "50 kW", type = "CCS2", operator = "EV Network", price = null, hours = "24/7") {
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (this.cachedKeys.has(key)) return;

    this.cachedKeys.add(key);
    this.chargers.push({ lat, lon, name, power, type, operator, price, hours });

    const marker = L.marker([lat, lon], {
      icon: this.createChargerIcon(power),
      zIndexOffset: 500
    });

    const e = window.escapeHtml || (v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])));
    const safeName = e(name);
    const safePower = e(power);
    const safeType = e(type);
    const safeOperator = e(operator);
    const safePrice = price ? e(price) : null;
    const safeHours = hours ? e(hours) : null;

    const safeBtnId = `route-to-charger-btn-${key.replace(/[.,]/g, '_')}`;
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
          this.onRouteToCharger({ lat, lng: lon, name, address: name });
        };
      }
    });

    if (this.isEnabled) {
      this.layerGroup.addLayer(marker);
    }
  }

  toggle() {
    this.isEnabled = !this.isEnabled;
    if (this.isEnabled) {
      this.layerGroup.addTo(this.map);
    } else {
      this.map.removeLayer(this.layerGroup);
    }
    return this.isEnabled;
  }
}

window.ChargersEngine = ChargersEngine;
