/**
 * Traffic Signals Engine
 * Manages traffic light markers, Overpass API queries, curated lights, and proximity warnings
 */

// Curated accurate traffic signal coordinates for main intersections (Tbilisi & key roads)
// AUDIT FIX: hand-typed, unverified coordinates removed; signals come from OSM Overpass only.
const CURATED_SIGNALS = [];

class TrafficSignalsEngine {
  constructor(map) {
    this.map = map;
    this.layerGroup = L.layerGroup().addTo(map);
    this.signals = []; // Array of {lat, lon, id, name}
    this.isEnabled = true;
    this.cachedPoints = new Set();
    this.overpassCooldown = 0;

    // Load curated signals right away
    this.loadCuratedSignals();
  }

  loadCuratedSignals() {
    CURATED_SIGNALS.forEach(sig => {
      this.addSignal(sig.lat, sig.lon, sig.name || "შუქნიშანი");
    });
  }

  createSignalIcon() {
    return L.divIcon({
      className: 'traffic-signal-custom-icon',
      html: `
        <div class="traffic-signal-pin" title="შუქნიშანი" style="
          width: 22px;
          height: 22px;
          background: #0f172a;
          border: 1.2px solid #64748b;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 2px 6px rgba(0,0,0,0.5);
        ">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none">
            <rect x="7" y="2" width="10" height="20" rx="3" fill="#1e293b" stroke="#64748b" stroke-width="1.5"/>
            <circle cx="12" cy="6" r="2.2" fill="#ef4444" />
            <circle cx="12" cy="12" r="2.2" fill="#f59e0b" />
            <circle cx="12" cy="18" r="2.2" fill="#10b981" />
          </svg>
        </div>
      `,
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
  }

  addSignal(lat, lon, name = "შუქნიშანი") {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (this.cachedPoints.has(key)) return;

    this.cachedPoints.add(key);
    this.signals.push({ lat, lon, name });

    const marker = L.marker([lat, lon], {
      icon: this.createSignalIcon(),
      interactive: true
    });

    marker.bindPopup(`
      <div style="font-weight:700; color:#fbbf24; display:flex; align-items:center; gap:6px;">
        🚦 ${name}
      </div>
      <div style="font-size:0.85rem; color:#94a3b8; margin-top:4px;">
        საგზაო შუქნიშანი (Traffic Light)
      </div>
    `);

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

  // Fetch signals along route or around bounding box via Overpass
  async fetchSignalsForBounds(bounds) {
    const now = Date.now();
    if (now - this.overpassCooldown < 15000) return; // 15s throttle
    this.overpassCooldown = now;

    const s = bounds.getSouth();
    const w = bounds.getWest();
    const n = bounds.getNorth();
    const e = bounds.getEast();

    // Query Overpass for traffic_signals (official reliable endpoint)
    const query = `[out:json][timeout:10];node[highway=traffic_signals](${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)});out 50;`;
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

    try {
      const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!response.ok) return;
      const data = await response.json();
      if (data && data.elements) {
        data.elements.forEach(el => {
          this.addSignal(el.lat, el.lon, el.tags?.name || "შუქნიშანი");
        });
      }
    } catch (err) {
      // Graceful fallback to existing curated lights
      console.warn("Overpass query notice (using local signals):", err.message);
    }
  }

  // Calculate distance to nearest upcoming traffic signal ahead on current route
  findUpcomingSignal(currentPos, headingDeg, routeCoordinates) {
    if (!currentPos || this.signals.length === 0) return null;

    let nearest = null;
    let minDistance = Infinity;

    for (const sig of this.signals) {
      // Fast coordinate bounding-box rejection (~400m box) before haversine
      if (Math.abs(sig.lat - currentPos.lat) > 0.0035 || Math.abs(sig.lon - currentPos.lng) > 0.005) {
        continue;
      }

      const dist = this.haversineMeters(currentPos.lat, currentPos.lng, sig.lat, sig.lon);
      
      // Look ahead within 350 meters
      if (dist < 350 && dist > 15) {
        // AUDIT FIX: only signals AHEAD (within +-50 deg of heading)
        if (headingDeg != null && !isNaN(headingDeg)) {
          const toRad = x => x * Math.PI / 180;
          const y = Math.sin(toRad(sig.lon - currentPos.lng)) * Math.cos(toRad(sig.lat));
          const x = Math.cos(toRad(currentPos.lat)) * Math.sin(toRad(sig.lat)) - Math.sin(toRad(currentPos.lat)) * Math.cos(toRad(sig.lat)) * Math.cos(toRad(sig.lon - currentPos.lng));
          const brg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
          let diff = Math.abs(brg - headingDeg) % 360; if (diff > 180) diff = 360 - diff;
          if (diff > 50) continue;
        }
        if (dist < minDistance) {
          minDistance = dist;
          nearest = { ...sig, distanceMeters: Math.round(dist) };
        }
      }
    }

    return nearest;
  }

  haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; // meters
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

window.TrafficSignalsEngine = TrafficSignalsEngine;
