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
 * Map rendering (MapLibre): the visible signals (zoom >= 15 in Leaflet terms = 14 in MapLibre, max 150) are one GeoJSON
 * source drawn by a symbol layer: GPU rendered, icons stay upright whatever the map rotation/pitch is.
 * The source/layer are registered in window.layerRegistry, so they survive a map style switch.
 */

const SIGNALS_STORAGE_KEY = "sig_tiles_v1";
const SIGNALS_SOURCE_ID = "signals-src";
const SIGNALS_LAYER_ID = "signals-layer";
const SIGNALS_ICON_ID = "signal-icon";

class TrafficSignalsEngine {
  constructor(map, startEnabled = true) {
    this.map = map;
    this.isEnabled = !!startEnabled;
    this.geo = { type: "FeatureCollection", features: [] };  // signals currently drawn
    this._geoKey = "";
    this.popup = null;

    // v3.10.69 (audit H2): our server first (it caches every tile for 7 days and waits for Overpass as long as needed),
    // then the public servers directly (v3.10.68 mirrors)
    this.endpoints = ["/api/overpass", "https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
    this.tileLat = 0.01;    // ~1.1 km
    this.tileLng = 0.014;   // ~1.0 km at Georgia's latitudes
    this.maxTiles = 60;
    this.ttlMs = 14 * 24 * 3600 * 1000;
    this.minRenderZoom = 15;      // Leaflet-equivalent zoom (MapLibre zoom + 1)
    this.maxRenderMarkers = 150;
    this.routeCorridorMeters = 30;

    this.tiles = new Map();    // "i,j" -> { t, sigs: [{lat, lon, name}] }
    this.pending = new Map();  // "i,j" -> Promise
    this.failCount = 0;
    this.failUntil = 0;
    this.fetchFn = (...a) => fetch(...a); // injectable for tests

    this.loadPersisted();
    this.registerMapLayers();
    if (map && typeof map.on === "function") {
      map.on("moveend", () => this.scheduleViewport());
      // setStyle() drops images: MapLibre asks for the icon again when a layer needs it
      map.on("styleimagemissing", (e) => { if (e.id === SIGNALS_ICON_ID) this.addIcon(); });
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
    if (hit && Date.now() - hit.t < this.ttlMs && hit.haz) return Promise.resolve(hit);   // v3.10.119: a tile without hazards is fetched again (its lights stay meanwhile)
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

  /** v3.10.118: one tile request brings the traffic lights and the road hazards (speed bumps, railway level crossings,
   *  schools) together; the server accepts exactly this text (OVERPASS_HAZ_RE in server.js). */
  static tileQuery(b) {
    const bb = "(" + b.s.toFixed(5) + "," + b.w.toFixed(5) + "," + b.n.toFixed(5) + "," + b.e.toFixed(5) + ")";
    return "[out:json][timeout:20];(node[highway=traffic_signals]" + bb + ";node[traffic_calming~\"^(bump|hump|table|cushion)$\"]" + bb +
      ";node[railway=level_crossing]" + bb + ";nwr[amenity=school]" + bb + ";);out center 600;";
  }

  async fetchTile(i, j) {
    const b = this.tileBounds(i, j);
    const q = TrafficSignalsEngine.tileQuery(b);
    let lastErr = null;
    for (const ep of this.endpoints) {
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      // v3.10.119 (live test: our server got the combined tile from a busy Overpass after 94 s, the car had given up at 20 s):
      // our server waits up to 100 s for Overpass and caches the answer, so it is given 105 s; the public mirrors keep 20 s
      const timer = ctrl ? setTimeout(() => ctrl.abort(), ep.charAt(0) === "/" ? 105000 : 20000) : null;
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
    const sigs = [], haz = [];
    const seen = new Set();
    for (const el of (data && data.elements) || []) {
      const lat = typeof el.lat === "number" ? el.lat : el.center && el.center.lat;
      const lon = typeof el.lon === "number" ? el.lon : el.center && el.center.lon;
      if (typeof lat !== "number" || typeof lon !== "number") continue;
      const tg = el.tags || {};
      // v3.10.118: road hazards from the same answer (old answers have only traffic lights: everything is a signal there)
      const kind = tg.traffic_calming ? "bump" : tg.railway === "level_crossing" ? "rail" : tg.amenity === "school" ? "school" : "signal";
      const key = kind + lat.toFixed(5) + "," + lon.toFixed(5);
      if (seen.has(key)) continue;
      seen.add(key);
      if (kind === "signal") sigs.push({ lat, lon, name: tg.name || "შუქნიშანი" });
      else haz.push({ lat, lon, kind });
    }
    return { t: Date.now(), sigs, haz };
  }

  /** v3.10.118: all known hazards, de-duplicated like the signals. */
  get hazards() {
    const seen = new Set(), out = [];
    for (const t of this.tiles.values()) {
      for (const h of t.haz || []) {
        const k = h.kind + h.lat.toFixed(5) + "," + h.lon.toFixed(5);
        if (!seen.has(k)) { seen.add(k); out.push(h); }
      }
    }
    return out;
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

  // ----------------------------------------------------- persistence
  loadPersisted() {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SIGNALS_STORAGE_KEY) : null;
      if (!raw) return;
      const o = JSON.parse(raw), now = Date.now();
      for (const k of Object.keys(o)) {
        const v = o[k];
        // v3.10.118/119: a tile saved before the hazards existed (no 3rd part) keeps its traffic lights (haz: null) and is
        // fetched again in the background (requestTile), so a slow Overpass never leaves the car without the lights it had
        if (now - v[0] < this.ttlMs) {
          this.tiles.set(k, { t: v[0], sigs: v[1].map(a => ({ lat: a[0], lon: a[1], name: a[2] || "შუქნიშანი" })),
            haz: Array.isArray(v[2]) ? v[2].map(a => ({ lat: a[0], lon: a[1], kind: a[2] === "b" ? "bump" : a[2] === "r" ? "rail" : "school" })) : null });
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
      for (const [k, v] of this.tiles) o[k] = v.haz ? [v.t, v.sigs.map(s => [s.lat, s.lon, s.name === "შუქნიშანი" ? 0 : s.name]), v.haz.map(h => [h.lat, h.lon, h.kind[0]])]
        : [v.t, v.sigs.map(s => [s.lat, s.lon, s.name === "შუქნიშანი" ? 0 : s.name])];
      localStorage.setItem(SIGNALS_STORAGE_KEY, JSON.stringify(o));
    } catch (e) { /* storage full / disabled: ignore */ }
  }

  // --------------------------------------------------- map rendering
  registerMapLayers() {
    const reg = typeof window !== "undefined" ? window.layerRegistry : null;
    if (!reg) return;
    reg.register("signals", {
      sources: () => ({ [SIGNALS_SOURCE_ID]: { type: "geojson", data: this.geo } }),
      layers: () => [{
        id: SIGNALS_LAYER_ID,
        type: "symbol",
        source: SIGNALS_SOURCE_ID,
        layout: {
          "icon-image": SIGNALS_ICON_ID,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-pitch-alignment": "viewport",
          "icon-rotation-alignment": "viewport",
          visibility: this.isEnabled ? "visible" : "none"
        }
      }]
    });
  }

  /** Draws the traffic-light pin (dark disc, grey ring, three lamps) as a 2x bitmap. */
  addIcon() {
    if (!this.map || typeof this.map.addImage !== "function" || typeof document === "undefined") return;
    if (typeof this.map.hasImage === "function" && this.map.hasImage(SIGNALS_ICON_ID)) return;
    const S = 44, c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d");
    g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
    g.fillStyle = "#0f172a"; g.fill();
    g.lineWidth = 2.5; g.strokeStyle = "#64748b"; g.stroke();
    // body
    const bx = S / 2 - 9, by = 8, bw = 18, bh = 28, r = 6;
    g.beginPath();
    g.moveTo(bx + r, by); g.arcTo(bx + bw, by, bx + bw, by + bh, r); g.arcTo(bx + bw, by + bh, bx, by + bh, r);
    g.arcTo(bx, by + bh, bx, by, r); g.arcTo(bx, by, bx + bw, by, r); g.closePath();
    g.fillStyle = "#1e293b"; g.fill(); g.lineWidth = 2; g.strokeStyle = "#64748b"; g.stroke();
    [["#ef4444", 15], ["#f59e0b", 22], ["#10b981", 29]].forEach(([col, y]) => {
      g.beginPath(); g.arc(S / 2, y, 3.4, 0, Math.PI * 2); g.fillStyle = col; g.fill();
    });
    this.map.addImage(SIGNALS_ICON_ID, g.getImageData(0, 0, S, S), { pixelRatio: 2 });
  }

  scheduleViewport() {
    if (!this.map || this._viewTimer) return;   // throttle: moveend fires every frame while the camera follows the car
    this._viewTimer = setTimeout(() => { this._viewTimer = null; this.updateViewport(); }, 600);
    if (this._viewTimer && typeof this._viewTimer.unref === "function") this._viewTimer.unref();
  }

  /** Leaflet-equivalent zoom: MapLibre uses 512 px tiles, so the same view is one level lower. */
  zoomLevel() {
    return this.map && typeof this.map.getZoom === "function" ? this.map.getZoom() + 1 : 0;
  }

  async updateViewport() {
    if (!this.map || typeof this.map.getBounds !== "function") return;
    if (!this.isEnabled) return;
    if (this.zoomLevel() < this.minRenderZoom) { this.clearMarkers(); return; }
    const b0 = this.map.getBounds();
    if (!b0) return;
    const padLat = (b0.getNorth() - b0.getSouth()) * 0.1, padLng = (b0.getEast() - b0.getWest()) * 0.1;
    const b = {
      s: b0.getSouth() - padLat, n: b0.getNorth() + padLat, w: b0.getWest() - padLng, e: b0.getEast() + padLng
    };
    const i0 = Math.floor(b.s / this.tileLat), i1 = Math.floor(b.n / this.tileLat);
    const j0 = Math.floor(b.w / this.tileLng), j1 = Math.floor(b.e / this.tileLng);
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

  /** bounds = {s, n, w, e}; picks at most maxRenderMarkers signals of the given tiles that lie inside. */
  renderMarkers(bounds, tileList) {
    const want = new Map();
    for (const [i, j] of tileList) {
      const tile = this.tiles.get(this.tileKey(i, j));
      if (!tile) continue;
      for (const sg of tile.sigs) {
        if (want.size >= this.maxRenderMarkers) break;
        if (sg.lat >= bounds.s && sg.lat <= bounds.n && sg.lon >= bounds.w && sg.lon <= bounds.e) {
          want.set(sg.lat.toFixed(5) + "," + sg.lon.toFixed(5), sg);
        }
      }
    }
    this.setGeo([...want.values()]);
  }

  setGeo(sigs) {
    const key = sigs.map(sg => sg.lat.toFixed(5) + "," + sg.lon.toFixed(5)).join("|");
    if (key === this._geoKey) return;           // nothing changed: do not re-upload the source
    this._geoKey = key;
    this.geo = {
      type: "FeatureCollection",
      features: sigs.map(sg => ({
        type: "Feature",
        properties: { name: sg.name || "შუქნიშანი" },
        geometry: { type: "Point", coordinates: [sg.lon, sg.lat] }
      }))
    };
    this.pushToMap();
  }

  get visibleCount() { return this.geo.features.length; }

  pushToMap() {
    const src = this.map && typeof this.map.getSource === "function" ? this.map.getSource(SIGNALS_SOURCE_ID) : null;
    if (src && typeof src.setData === "function") src.setData(this.geo);
  }

  clearMarkers() {
    this.setGeo([]);
  }

  /** Tap on a signal icon -> small popup. Returns true when the tap was consumed (map click must not set a destination). */
  handleClick(e) {
    if (!this.isEnabled || !this.map || typeof this.map.getLayer !== "function" || !this.map.getLayer(SIGNALS_LAYER_ID)) return false;
    const p = e.point;
    const hit = this.map.queryRenderedFeatures([[p.x - 18, p.y - 18], [p.x + 18, p.y + 18]], { layers: [SIGNALS_LAYER_ID] });
    if (!hit || !hit.length) return false;
    const f = hit[0];
    if (typeof maplibregl === "undefined") return true;
    const esc = window.escapeHtml || (v => String(v == null ? "" : v));
    const box = document.createElement("div");
    box.innerHTML =
      '<div style="font-weight:700; color:#fbbf24; display:flex; align-items:center; gap:6px;">🚦 ' + esc(f.properties.name) + "</div>" +
      '<div style="font-size:0.85rem; color:#94a3b8; margin-top:4px;">საგზაო შუქნიშანი (Traffic Light)</div>';
    if (this.popup) this.popup.remove();
    this.popup = new maplibregl.Popup({ offset: 16, closeButton: true, maxWidth: "260px" })
      .setLngLat(f.geometry.coordinates).setDOMContent(box).addTo(this.map);
    return true;
  }

  toggle() {
    this.isEnabled = !this.isEnabled;
    if (this.map && typeof this.map.getLayer === "function" && this.map.getLayer(SIGNALS_LAYER_ID)) {
      this.map.setLayoutProperty(SIGNALS_LAYER_ID, "visibility", this.isEnabled ? "visible" : "none");
    }
    if (this.isEnabled) {
      this.scheduleViewport();
    } else if (this.popup) {
      this.popup.remove(); this.popup = null;
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

  /**
   * v3.10.118: the nearest speed bump, railway level crossing and school ahead, one of each: [{ kind, lat, lon,
   * distanceMeters }]. Same idea as findUpcomingSignal (in front of the car, on the route when there is one); a school is a
   * building beside the road, so its corridor is wider.
   */
  findUpcomingHazards(currentPos, headingDeg, routeCoordinates) {
    if (!currentPos) return [];
    const RULES = { bump: { max: 200, corridor: 20, cone: 40 }, rail: { max: 400, corridor: 25, cone: 45 }, school: { max: 350, corridor: 120, cone: 60 } };
    const [ci, cj] = this.tileIndex(currentPos.lat, currentPos.lng);
    const cand = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const t = this.tiles.get(this.tileKey(ci + di, cj + dj));
      if (t && t.haz) cand.push(...t.haz);
    }
    if (!cand.length) return [];
    const cosLat = Math.cos(currentPos.lat * Math.PI / 180), kx = 111320 * cosLat, ky = 110540;
    let segs = null;
    if (routeCoordinates && routeCoordinates.length > 1) {
      segs = [];
      for (let k = 0; k < routeCoordinates.length - 1; k++) {
        const a = routeCoordinates[k];
        if (Math.abs(a[0] - currentPos.lat) < 0.008 && Math.abs(a[1] - currentPos.lng) < 0.011) segs.push(k);
      }
      if (!segs.length) segs = null;
    }
    const best = {};
    for (const h of cand) {
      const r = RULES[h.kind];
      if (!r || Math.abs(h.lat - currentPos.lat) > 0.005 || Math.abs(h.lon - currentPos.lng) > 0.007) continue;
      const dist = this.haversineMeters(currentPos.lat, currentPos.lng, h.lat, h.lon);
      if (!(dist <= r.max && dist > 8)) continue;
      if (typeof headingDeg === "number" && isFinite(headingDeg)) {
        const t = Math.PI / 180;
        const y = Math.sin((h.lon - currentPos.lng) * t) * Math.cos(h.lat * t);
        const x = Math.cos(currentPos.lat * t) * Math.sin(h.lat * t) - Math.sin(currentPos.lat * t) * Math.cos(h.lat * t) * Math.cos((h.lon - currentPos.lng) * t);
        let diff = Math.abs((Math.atan2(y, x) / t + 360) % 360 - headingDeg) % 360; if (diff > 180) diff = 360 - diff;
        if (diff > r.cone) continue;
      }
      if (segs) {
        let on = false;
        for (const k of segs) {
          const a = routeCoordinates[k], b = routeCoordinates[k + 1];
          const ax = (a[1] - h.lon) * kx, ay = (a[0] - h.lat) * ky, bx = (b[1] - h.lon) * kx, by = (b[0] - h.lat) * ky;
          const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
          const tt = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
          if (Math.hypot(ax + tt * dx, ay + tt * dy) <= r.corridor) { on = true; break; }
        }
        if (!on) continue;
      }
      if (!best[h.kind] || dist < best[h.kind].distanceMeters) best[h.kind] = { ...h, distanceMeters: Math.round(dist) };
    }
    return ["rail", "school", "bump"].map((k) => best[k]).filter(Boolean);
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
