/**
 * Traffic Signals Engine
 * Manages traffic light markers, Overpass API queries, curated lights, and proximity warnings
 */

// Curated accurate traffic signal coordinates for main intersections (Tbilisi & key roads)
const CURATED_SIGNALS = [
  // Chavchavadze Ave
  { lat: 41.7118, lon: 44.7570, name: "ჭავჭავაძე / თამარაშვილი" },
  { lat: 41.7099, lon: 44.7645, name: "ჭავჭავაძე / ყიფშიძე" },
  { lat: 41.7087, lon: 44.7708, name: "ჭავჭავაძე / აბაშიძე" },
  { lat: 41.7082, lon: 44.7750, name: "ჭავჭავაძე / ჭაბუა ამირეჯიბი" },
  { lat: 41.7080, lon: 44.7788, name: "ჭავჭავაძე / ვარაზისხევი" },
  // Melikishvili & Rustaveli
  { lat: 41.7077, lon: 44.7816, name: "მელიქიშვილი / კოსტავა (ფილარმონია)" },
  { lat: 41.7061, lon: 44.7885, name: "რუსთაველი (მეტრო რუსთაველი)" },
  { lat: 41.7018, lon: 44.7932, name: "რუსთაველი / რესპუბლიკის მოედანი" },
  { lat: 41.6974, lon: 44.7988, name: "რუსთაველი / თავისუფლების მოედანი" },
  // Pekini & Saburtalo
  { lat: 41.7225, lon: 44.7682, name: "პეკინი / ვაჟა-ფშაველა" },
  { lat: 41.7212, lon: 44.7735, name: "პეკინი / ყაზბეგი" },
  { lat: 41.7197, lon: 44.7789, name: "პეკინი / გამსახურდია" },
  { lat: 41.7188, lon: 44.7831, name: "26 მაისის მოედანი (სპორტის სასახლე)" },
  { lat: 41.7248, lon: 44.7554, name: "ვაჟა-ფშაველა / თამარაშვილი" },
  { lat: 41.7289, lon: 44.7432, name: "ვაჟა-ფშაველა / ქავთარაძე" },
  // Heroes Square & Right/Left Embankment
  { lat: 41.7139, lon: 44.7839, name: "გმირთა მოედანი" },
  { lat: 41.7182, lon: 44.7941, name: "თამარ მეფის ხიდი" },
  { lat: 41.7231, lon: 44.7938, name: "სააკაძის მოედანი" },
  { lat: 41.7208, lon: 44.7997, name: "აღმაშენებლის გამზირი / წერეთელი" },
  { lat: 41.7275, lon: 44.7865, name: "წერეთლის გამზირი" },
  // Dry Bridge & Old Town
  { lat: 41.6995, lon: 44.8035, name: "მშრალი ხიდი / სანაპირო" },
  { lat: 41.6931, lon: 44.8082, name: "ბარათაშვილის ხიდი" },
  { lat: 41.6908, lon: 44.8115, name: "ავლაბარი / მეტეხი" },
  { lat: 41.6881, lon: 44.8152, name: "ორთაჭალა / გორგასალი" },
  // Didube / Gldani / Kakheti Highway
  { lat: 41.7485, lon: 44.7802, name: "დიდუბე / წერეთლის ბოლო" },
  { lat: 41.7820, lon: 44.8150, name: "გლდანი - ხიზანიშვილის ქუჩა" },
  { lat: 41.6950, lon: 44.8450, name: "კახეთის გზატკეცილი / ისანი" }
];

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
          width: 38px;
          height: 38px;
          background: #0f172a;
          border: 2px solid #64748b;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 4px 12px rgba(0,0,0,0.6);
        ">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none">
            <rect x="7" y="2" width="10" height="20" rx="3" fill="#1e293b" stroke="#64748b" stroke-width="1.5"/>
            <circle cx="12" cy="6" r="2.2" fill="#ef4444" />
            <circle cx="12" cy="12" r="2.2" fill="#f59e0b" />
            <circle cx="12" cy="18" r="2.2" fill="#10b981" />
          </svg>
        </div>
      `,
      iconSize: [38, 38],
      iconAnchor: [19, 19]
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
      const dist = this.haversineMeters(currentPos.lat, currentPos.lng, sig.lat, sig.lon);
      
      // Look ahead within 350 meters
      if (dist < 350 && dist > 15) {
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
