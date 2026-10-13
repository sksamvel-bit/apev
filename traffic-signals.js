/**
 * Traffic Signals Engine (v3.9, tile based)
 *
 * Data: OpenStreetMap `highway=traffic_signals` nodes via the Overpass API.
 *  - ~1 km tiles (0.01 x 0.014 deg), fetched on demand: tile under the car, two tiles ahead along the heading,
 *    tiles along a freshly calculated route (first ~25 km, nearest first), tiles of the visible map area.
 *  - No more "out 50" truncation of one huge route bounding box: every signal of a loaded tile is kept.
 *  - Cached in memory (LRU 60 tiles) and in localStorage (14 days) -> instant after a browser restart / reverse gear.
 *  - 2 Overpass endpoints, back-off after failures, max 2 requests in flight.
 *
 * Alerts: only signals that are (a) ahead (+-50 deg of heading) and (b) ON the active route (<= 30 m from the route line),
 * so signals on parallel / crossing streets do not trigger "signal in 150 m".
 *
 * Map markers: data is kept per tile; DOM markers are created only for the visible area (zoom >= 15, max 150).
 */

const SIGNALS_STORAGE_KEY = "sig_tiles_v1";

class TrafficSignalsEngine {
  constructor(map) {
    this.map = map;
    this.layerGroup = L.layerGroup().addTo(map);
    this.isEnabled = true;

    this.endpoints = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
    this.tileLat = 0.01;    // ~1.1 km
    this.tileLng = 0.014;   // ~1.0 km at Georgia's latitudes
    this.maxTiles = 60;
    this.ttlMs = 14 * 24 * 3600 * 1000;
    this.minRenderZoom = 15;
    this.maxRenderMarkers = 150;
    this.routeCorridorMeters = 30;

    this.tiles = new Map();    // "i,j" -> { t, sigs: [{lat, lon, name}] }
    this.pending = new Map();  // "i,j" -> Promise
    this.failCount = 0;
    this.failUntil = 0;
    this.markers = new Map();  // "lat,lon" -> L.marker
    this.fetchFn = (...a) => fetch(...a); // injectable for tests

    this.loadPersisted();
    if (map && typeof map.on === "function") {
      map.on("moveend zoomend", () => this.scheduleViewport());
    }
    this.scheduleViewport();
  }

  /** Flat, de-duplicated list of all known signals (a node on a tile border can appear in two tiles). */
  get signals() {
    const seen = new Set(), out = [];
    for (const t of this.tiles.values()) {
      for (const s of t.sigs) {
        const k = s.lat.toFixed(5) + "," + s.lon.toFixed(5);
        if (!seen.has(k)) { seen.add(k); out.push(s); }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- tiles
  tileIndex(lat, lng) { return [Math.floor(lat / this.tileLat), Math.floor(lng / this.tileLng)]; }
  tileKey(i, j) { return i + "," + j; }
  tileBounds(i, j) {
    return { s: i * this.tileLat, n: (i + 1) * this.tileLat, w: j * this.tileLng, e: (j + 1) * this.tileLng };
  }

  requestTile(i, j) {
    const key = this.tileKey(i, j);
    const hit = this.tiles.get(key);
    if (hit && Date.now() - hit.t < this.ttlMs) return Promise.resolve(hit);
    if (this.pending.has(key)) return this.pending.get(key);
    if (Date.now() < this.failUntil) return Promise.resolve(null); // back-off after failures
    if (this.pending.size >= 2) return Promise.resolve(null);      // polite to the public API

    const p = this.fetchTile(i, j)
      .then(tile => {
        this.failCount = 0;
        this.failUntil = 0;
        this.tiles.delete(key);
        this.tiles.set(key, tile);
        while (this.tiles.size > this.maxTiles) this.tiles.delete(this.tiles.keys().next().value);
        this.savePersistedSoon();
        this.scheduleViewport();
        return tile;
      })
      .catch(() => {
        this.failCount++;
        this.failUntil = Date.now() + Math.min(300000, 15000 * Math.pow(2, this.failCount));
        return null;
      })
      .finally(() => { this.pending.delete(key); });
    this.pending.set(key, p);
    return p;
  }

  async fetchTile(i, j) {
    const b = this.tileBounds(i, j);
    const q = "[out:json][timeout:10];node[highway=traffic_signals](" +
      b.s.toFixed(5) + "," + b.w.toFixed(5) + "," + b.n.toFixed(5) + "," + b.e.toFixed(5) + ");out 500;";
    let lastErr = null;
    for (const ep of this.endpoints) {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
      try {
        const res = await this.fetchFn(ep + "?data=" + encodeURIComponent(q), ctrl ? { signal: ctrl.signal } : undefined);
        if (!res.ok) throw new Error("Overpass HTTP " + res.status);
        return this.buildTile(await res.json());
      } catch (e) {
        lastErr = e;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr || new Error("Overpass failed");
  }

  buildTile(data) {
    const sigs = [];
    const seen = new Set();
    for (const el of (data && data.elements) || []) {
      if (typeof el.lat !== "number" || typeof el.lon !== "number") continue;
      const key = el.lat.toFixed(5) + "," + el.lon.toFixed(5);
      if (seen.has(key)) continue;
      seen.add(key);
      sigs.push({ lat: el.lat, lon: el.lon, name: (el.tags && el.tags.name) || "შუქნიშანი" });
    }
    return { t: Date.now(), sigs };
  }

  /** Runs the given tile list with at most 2 requests in flight. */
  async queueTiles(list) {
    const q = [...list];
    const worker = async () => {
      while (q.length) { const [i, j] = q.shift(); await this.requestTile(i, j); }
    };
    await Promise.all([worker(), worker()]);
  }

  /** Tile under the car + tiles 450 m and 900 m ahead along the heading. */
  ensureAround(lat, lng, headingDeg) {
    const list = [this.tileIndex(lat, lng)];
    if (typeof headingDeg === "number" && isFinite(headingDeg)) {
      const rad = headingDeg * Math.PI / 180;
      for (const d of [450, 900]) {
        const aLat = lat + (d * Math.cos(rad)) / 111320;
        const aLng = lng + (d * Math.sin(rad)) / (111320 * Math.cos(lat * Math.PI / 180));
        list.push(this.tileIndex(aLat, aLng));
      }
    }
    const uniq = [...new Map(list.map(t => [this.tileKey(t[0], t[1]), t])).values()];
    return this.queueTiles(uniq);
  }

  /** After a route was calculated: load the tiles along its first ~25 km (nearest first). */
  fetchSignalsAlongRoute(coords, maxKm = 25, maxTiles = 40) {
    if (!coords || coords.length < 2) return Promise.resolve();
    const order = new Map();
    let acc = 0, sinceSample = 1e9;
    for (let k = 0; k < coords.length; k++) {
      if (k > 0) {
        const d = this.haversineMeters(coords[k - 1][0], coords[k - 1][1], coords[k][0], coords[k][1]);
        acc += d; sinceSample += d;
      }
      if (acc > maxKm * 1000) break;
      if (sinceSample >= 400 || k === 0) {
        sinceSample = 0;
        const [i, j] = this.tileIndex(coords[k][0], coords[k][1]);
        const key = this.tileKey(i, j);
        if (!order.has(key)) order.set(key, [i, j]);
        if (order.size >= maxTiles) break;
      }
    }
    return this.queueTiles([...order.values()]);
  }

  /** Legacy API: tiles intersecting a Leaflet bounds object (only when the area is small). */
  fetchSignalsForBounds(bounds) {
    const i0 = Math.floor(bounds.getSouth() / this.tileLat), i1 = Math.floor(bounds.getNorth() / this.tileLat);
    const j0 = Math.floor(bounds.getWest() / this.tileLng), j1 = Math.floor(bounds.getEast() / this.tileLng);
    const list = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) list.push([i, j]);
    if (list.length > 12) {
      const ci = Math.floor((i0 + i1) / 2), cj = Math.floor((j0 + j1) / 2);
      return this.queueTiles([[ci, cj]]);
    }
    return this.queueTiles(list);
  }

  // ----------------------------------------------------- persistence
  loadPersisted() {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SIGNALS_STORAGE_KEY) : null;
      if (!raw) return;
      const o = JSON.parse(raw), now = Date.now();
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (now - v[0] < this.ttlMs) {
          this.tiles.set(k, { t: v[0], sigs: v[1].map(a => ({ lat: a[0], lon: a[1], name: a[2] || "შუქნიშანი" })) });
        }
      }
    } catch (e) { /* ignore corrupt storage */ }
  }

  savePersistedSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.savePersisted(); }, 1500);
    if (this._saveTimer && typeof this._saveTimer.unref === "function") this._saveTimer.unref();
  }

  savePersisted() {
    try {
      if (typeof localStorage === "undefined") return;
      const o = {};
      for (const [k, v] of this.tiles) o[k] = [v.t, v.sigs.map(s => [s.lat, s.lon, s.name === "შუქნიშანი" ? 0 : s.name])];
      localStorage.setItem(SIGNALS_STORAGE_KEY, JSON.stringify(o));
    } catch (e) { /* storage full / disabled: ignore */ }
  }

  // --------------------------------------------------- map rendering
  scheduleViewport() {
    if (!this.map) return;
    if (this._viewTimer) clearTimeout(this._viewTimer);
    this._viewTimer = setTimeout(() => { this._viewTimer = null; this.updateViewport(); }, 600);
    if (this._viewTimer && typeof this._viewTimer.unref === "function") this._viewTimer.unref();
  }

  async updateViewport() {
    if (!this.map || typeof this.map.getBounds !== "function") return;
    if (!this.isEnabled) return;
    const z = this.map.getZoom();
    if (z < this.minRenderZoom) { this.clearMarkers(); return; }
    const b = this.map.getBounds();
    if (!b) return;
    const i0 = Math.floor(b.getSouth() / this.tileLat), i1 = Math.floor(b.getNorth() / this.tileLat);
    const j0 = Math.floor(b.getWest() / this.tileLng), j1 = Math.floor(b.getEast() / this.tileLng);
    const list = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) list.push([i, j]);
    this.renderMarkers(b, list);
    if (list.length <= 6) {
      const missing = list.filter(([i, j]) => !this.tiles.has(this.tileKey(i, j)));
      if (missing.length) {
        await this.queueTiles(missing);
        this.renderMarkers(b, list); // draw right after the tiles arrived
      }
    }
  }

  renderMarkers(bounds, tileList) {
    const want = new Map();
    for (const [i, j] of tileList) {
      const tile = this.tiles.get(this.tileKey(i, j));
      if (!tile) continue;
      for (const s of tile.sigs) {
        if (want.size >= this.maxRenderMarkers) break;
        if (bounds.contains([s.lat, s.lon])) want.set(s.lat.toFixed(5) + "," + s.lon.toFixed(5), s);
      }
    }
    for (const [key, m] of this.markers) {
      if (!want.has(key)) { this.layerGroup.removeLayer(m); this.markers.delete(key); }
    }
    for (const [key, s] of want) {
      if (this.markers.has(key)) continue;
      const e = window.escapeHtml || (v => String(v == null ? "" : v));
      const m = L.marker([s.lat, s.lon], { icon: this.createSignalIcon(), interactive: true });
      m.bindPopup(
        '<div style="font-weight:700; color:#fbbf24; display:flex; align-items:center; gap:6px;">🚦 ' + e(s.name) + "</div>" +
        '<div style="font-size:0.85rem; color:#94a3b8; margin-top:4px;">საგზაო შუქნიშანი (Traffic Light)</div>'
      );
      this.layerGroup.addLayer(m);
      this.markers.set(key, m);
    }
  }

  clearMarkers() {
    for (const m of this.markers.values()) this.layerGroup.removeLayer(m);
    this.markers.clear();
  }

  createSignalIcon() {
    return L.divIcon({
      className: "traffic-signal-custom-icon",
      html: `
        <div class="traffic-signal-pin" title="შუქნიშანი" style="
          width: 22px; height: 22px; background: #0f172a; border: 1.2px solid #64748b; border-radius: 50%;
          display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(0,0,0,0.5);">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none">
            <rect x="7" y="2" width="10" height="20" rx="3" fill="#1e293b" stroke="#64748b" stroke-width="1.5"/>
            <circle cx="12" cy="6" r="2.2" fill="#ef4444" />
            <circle cx="12" cy="12" r="2.2" fill="#f59e0b" />
            <circle cx="12" cy="18" r="2.2" fill="#10b981" />
          </svg>
        </div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
  }

  toggle() {
    this.isEnabled = !this.isEnabled;
    if (this.isEnabled) {
      this.layerGroup.addTo(this.map);   // markers stay in the group, so they reappear
      this.scheduleViewport();
    } else {
      this.map.removeLayer(this.layerGroup);
    }
    return this.isEnabled;
  }

  // ------------------------------------------------------------ alerts
  /**
   * Nearest signal ahead (15-350 m, +-50 deg of heading) that lies on the active route (<= 30 m from the route line).
   * Without a route (or when the car is far from it) only the heading filter applies.
   */
  findUpcomingSignal(currentPos, headingDeg, routeCoordinates) {
    if (!currentPos) return null;
    this.ensureAround(currentPos.lat, currentPos.lng, headingDeg); // fire and forget

    const [ci, cj] = this.tileIndex(currentPos.lat, currentPos.lng);
    const candidates = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const t = this.tiles.get(this.tileKey(ci + di, cj + dj));
      if (t) candidates.push(...t.sigs);
    }
    if (!candidates.length) return null;

    const cosLat = Math.cos(currentPos.lat * Math.PI / 180);
    const kx = 111320 * cosLat, ky = 110540;
    let segs = null;
    if (routeCoordinates && routeCoordinates.length > 1) {
      segs = [];
      for (let k = 0; k < routeCoordinates.length - 1; k++) {
        const a = routeCoordinates[k];
        if (Math.abs(a[0] - currentPos.lat) < 0.008 && Math.abs(a[1] - currentPos.lng) < 0.011) segs.push(k);
      }
      if (!segs.length) segs = null; // car far from the route line -> heading filter only
    }

    let nearest = null, minDistance = Infinity;
    for (const sig of candidates) {
      if (Math.abs(sig.lat - currentPos.lat) > 0.0035 || Math.abs(sig.lon - currentPos.lng) > 0.005) continue;
      const dist = this.haversineMeters(currentPos.lat, currentPos.lng, sig.lat, sig.lon);
      if (!(dist < 350 && dist > 15)) continue;

      if (typeof headingDeg === "number" && isFinite(headingDeg)) {
        const t = Math.PI / 180;
        const y = Math.sin((sig.lon - currentPos.lng) * t) * Math.cos(sig.lat * t);
        const x = Math.cos(currentPos.lat * t) * Math.sin(sig.lat * t) - Math.sin(currentPos.lat * t) * Math.cos(sig.lat * t) * Math.cos((sig.lon - currentPos.lng) * t);
        const brg = (Math.atan2(y, x) / t + 360) % 360;
        let diff = Math.abs(brg - headingDeg) % 360; if (diff > 180) diff = 360 - diff;
        if (diff > 50) continue;
      }

      if (segs) {
        let onRoute = false;
        for (const k of segs) {
          const a = routeCoordinates[k], b = routeCoordinates[k + 1];
          const ax = (a[1] - sig.lon) * kx, ay = (a[0] - sig.lat) * ky;
          const bx = (b[1] - sig.lon) * kx, by = (b[0] - sig.lat) * ky;
          const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
          const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
          if (Math.hypot(ax + t * dx, ay + t * dy) <= this.routeCorridorMeters) { onRoute = true; break; }
        }
        if (!onRoute) continue;
      }

      if (dist < minDistance) { minDistance = dist; nearest = { ...sig, distanceMeters: Math.round(dist) }; }
    }
    return nearest;
  }

  haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}

window.TrafficSignalsEngine = TrafficSignalsEngine;
