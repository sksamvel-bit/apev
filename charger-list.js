/**
 * charger-list.js - EV charger drawer (separate list, nearest first, "fast DC only" filter).
 *
 * Pure helpers (haversine, parsePowerKw, buildList) are unit-tested in Node; ChargerDrawer is the thin DOM layer.
 * The list is built only while the drawer is open (on open, on filter change, then every 10 s): nothing runs per frame.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ChargerList = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FAST_DC_KW = 50;
  const MAX_ROWS = 40;

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** "150 kW" -> 150, "22kW AC" -> 22, anything unparsable -> 0. */
  function parsePowerKw(power) {
    const m = String(power == null ? "" : power).replace(",", ".").match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  }

  function formatDistance(km) {
    return km < 1 ? Math.round(km * 10) * 100 + " მ" : (km < 10 ? km.toFixed(1) : String(Math.round(km))) + " კმ";
  }

  /** Nearest-first list. opts: { fastOnly, max }. Returns [{ st, km, kw }]. */
  function buildList(chargers, pos, opts) {
    opts = opts || {};
    const max = opts.max || MAX_ROWS;
    const out = [];
    for (const st of chargers || []) {
      if (!st || !isFinite(st.lat) || !isFinite(st.lon)) continue;
      const kw = parsePowerKw(st.power);
      if (opts.fastOnly && kw < FAST_DC_KW) continue;
      out.push({ st, km: haversineKm(pos.lat, pos.lng, st.lat, st.lon), kw });
    }
    out.sort((a, b) => a.km - b.km);
    return out.slice(0, max);
  }

  // ------------------------------------------------------------------ DOM layer
  class ChargerDrawer {
    constructor(engine, getPos, opts) {
      this.engine = engine;
      this.getPos = getPos;
      this.onFocus = (opts && opts.onFocus) || null;
      this.fastOnly = false;
      this.timer = null;
      this.el = document.getElementById("chargers-drawer");
      if (!this.el) return;
      this.listEl = this.el.querySelector(".cd-list");
      this.countEl = this.el.querySelector(".cd-count");
      this.filterBtn = this.el.querySelector(".cd-filter");
      this.el.querySelector(".cd-close").addEventListener("click", () => this.close());
      this.filterBtn.addEventListener("click", () => {
        this.fastOnly = !this.fastOnly;
        this.filterBtn.classList.toggle("active", this.fastOnly);
        this.render();
      });
    }

    isOpen() { return !!this.el && this.el.classList.contains("open"); }
    toggle() { this.isOpen() ? this.close() : this.open(); return this.isOpen(); }

    open() {
      if (!this.el) return;
      this.el.classList.add("open");
      this.render();
      this.timer = setInterval(() => this.render(), 10000);
    }

    close() {
      if (!this.el) return;
      this.el.classList.remove("open");
      clearInterval(this.timer);
      this.timer = null;
    }

    render() {
      if (!this.el || !this.engine) return;
      const rows = buildList(this.engine.chargers, this.getPos(), { fastOnly: this.fastOnly });
      this.countEl.textContent = rows.length ? rows.length + " უახლოესი" : "";
      this.listEl.textContent = "";
      if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "cd-empty";
        empty.textContent = "დამტენები ვერ მოიძებნა";
        this.listEl.appendChild(empty);
        return;
      }
      const frag = document.createDocumentFragment();
      for (const r of rows) frag.appendChild(this.row(r));
      this.listEl.appendChild(frag);
    }

    row(r) {
      const st = r.st;
      const row = document.createElement("div");
      row.className = "cd-row";

      const info = document.createElement("div");
      info.className = "cd-info";
      const name = document.createElement("div");
      name.className = "cd-name";
      name.textContent = st.name || "EV დამტენი";
      const meta = document.createElement("div");
      meta.className = "cd-meta";
      const kw = document.createElement("span");
      kw.className = "cd-kw" + (r.kw >= 100 ? " ultra" : r.kw >= FAST_DC_KW ? " fast" : "");
      kw.textContent = st.power || "—";
      meta.appendChild(kw);
      const rest = [st.type, st.operator, st.price].filter(Boolean).join(" · ");
      if (rest) meta.appendChild(document.createTextNode(" " + rest));
      info.appendChild(name);
      info.appendChild(meta);
      info.addEventListener("click", () => { if (this.onFocus) this.onFocus(st); });

      const side = document.createElement("div");
      side.className = "cd-side";
      const dist = document.createElement("div");
      dist.className = "cd-dist";
      dist.textContent = "~" + formatDistance(r.km);
      const go = document.createElement("button");
      go.className = "cd-go";
      go.type = "button";
      go.textContent = "მარშრუტი";
      go.addEventListener("click", () => {
        this.close();
        if (this.engine.onRouteToCharger) this.engine.onRouteToCharger({ lat: st.lat, lng: st.lon, name: st.name, address: st.name });
      });
      side.appendChild(dist);
      side.appendChild(go);

      row.appendChild(info);
      row.appendChild(side);
      return row;
    }
  }

  return { haversineKm, parsePowerKw, formatDistance, buildList, ChargerDrawer, FAST_DC_KW, MAX_ROWS };
});
