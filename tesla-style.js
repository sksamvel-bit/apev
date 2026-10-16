/**
 * tesla-style.js - "Tesla look" for the vector map (opt-in: ?style=tesla, ?style=classic switches back).
 *
 * Recolors the OpenFreeMap style the way the in-car Tesla map looks: flat muted land, white/grey roads on light,
 * charcoal on dark, flat buildings, few quiet labels, blue route. It works on the layer's source-layer / class so it does
 * not depend on exact layer ids. The dark palette is native (no CSS invert filter, which is expensive on the car's GPU).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TeslaStyle = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PALETTE = {
    day: {
      land: "#eceff2", land2: "#e4e8ec", park: "#d9e6dc", water: "#c5d8e8", building: "#dde1e6",
      minor: "#f8f9fb", major: "#ffffff", hwy: "#ffffff", casing: "#c3c9d1", rail: "#cfd4da", path: "#f6f7f9",
      text: "#4a5058", textMinor: "#8b929c", halo: "#eceff2", route: "#3e6ae1", routeCasing: "#ffffff"
    },
    night: {
      land: "#1b1d21", land2: "#202328", park: "#1d2722", water: "#121c27", building: "#25282e",
      minor: "#383c44", major: "#4a5059", hwy: "#5a616b", casing: "#131518", rail: "#2c2f35", path: "#2b2e34",
      text: "#9aa1ab", textMinor: "#6c737d", halo: "#1b1d21", route: "#4f8dff", routeCasing: "#0b1a3d"
    }
  };

  // "mono": no colour at all (white / light grey by day, black / dark grey by night), no park fills, flat map (see app.js).
  const PALETTE_MONO = {
    day: {
      land: "#e9e9e9", land2: "#e4e4e4", park: "#e9e9e9", water: "#cfd3d8", building: "#dcdcdc",
      minor: "#ffffff", major: "#ffffff", hwy: "#ffffff", casing: "#bdbdbd", rail: "#cfcfcf", path: "#f7f7f7",
      text: "#2b2b2b", textMinor: "#707070", halo: "#e9e9e9", route: "#3e6ae1", routeCasing: "#ffffff"
    },
    night: {
      land: "#0d0d0d", land2: "#121212", park: "#0d0d0d", water: "#1a1d21", building: "#1b1b1b",
      minor: "#333333", major: "#454545", hwy: "#585858", casing: "#080808", rail: "#222222", path: "#262626",
      text: "#c4c4c4", textMinor: "#7d7d7d", halo: "#0d0d0d", route: "#4f8dff", routeCasing: "#0b1a3d"
    }
  };

  function pal(night, mode) {
    const set = mode === "mono" ? PALETTE_MONO : PALETTE;
    return night ? set.night : set.day;
  }

  function roadClass(id) {
    id = String(id || "").toLowerCase();
    if (/casing|outline/.test(id)) return "casing";
    if (/rail|transit|subway|funicular/.test(id)) return "rail";
    if (/path|pedestrian|footway|cycle|track|steps|trail/.test(id)) return "path";
    if (/motorway|trunk|highway/.test(id)) return "hwy";
    if (/primary|secondary|tertiary|major/.test(id)) return "major";
    return "minor";
  }

  /** Returns a recolored copy of `style` (never mutates the input). night: boolean. */
  function apply(style, night, mode) {
    const P = pal(night, mode);
    const mono = mode === "mono";
    const out = Object.assign({}, style);
    out.layers = (style.layers || []).map((l) => {
      const sl = l["source-layer"] || "";
      const id = String(l.id || "");
      const paint = Object.assign({}, l.paint || {});
      const layout = Object.assign({}, l.layout || {});
      const touch = () => Object.assign({}, l, { paint, layout });

      if (l.type === "background") { paint["background-color"] = P.land; return touch(); }

      if (l.type === "fill-extrusion") { layout.visibility = "none"; return touch(); }

      if (l.type === "fill") {
        delete paint["fill-pattern"];
        delete paint["fill-outline-color"];
        let c = P.land2;
        if (sl === "water" || /(^|[_-])water([_-]|$)/.test(id)) c = P.water;
        else if (sl === "park" || sl === "landcover" || /park|wood|forest|grass|green/i.test(id)) { c = P.park; if (mono) layout.visibility = "none"; }
        else if (sl === "building" || /building/.test(id)) c = P.building;
        paint["fill-color"] = c;
        return touch();
      }

      if (l.type === "line") {
        if (sl === "waterway" || /waterway/.test(id)) { paint["line-color"] = P.water; return touch(); }
        if (sl === "boundary" || /boundary/.test(id)) { layout.visibility = "none"; return touch(); }
        if (sl === "transportation" || /road|bridge|tunnel|highway|rail/.test(id)) {
          delete paint["line-pattern"];
          paint["line-color"] = P[roadClass(id)];
          return touch();
        }
        return touch();
      }

      if (l.type === "symbol") {
        // Quiet hierarchy: street names and POI labels recede, place names stay strong; POI icons are dimmed.
        const quiet = sl === "transportation_name" || sl === "poi" || sl === "housenumber" || /road|street|poi|housenumber/i.test(id);
        paint["text-color"] = quiet ? P.textMinor : P.text;
        if (sl === "poi" || /poi/i.test(id)) paint["icon-opacity"] = night ? 0.35 : 0.6;
        paint["text-halo-color"] = P.halo;
        paint["text-halo-width"] = 1.5;
        delete paint["icon-color"];
        return touch();
      }
      return l;
    });
    return out;
  }

  /**
   * Day <-> night without reloading the style: the list of paint properties that differ between the two palettes.
   * [{id, prop, value}] to feed map.setPaintProperty (cheap; a full setStyle rebuild freezes the Atom MCU2 and blanks the map).
   */
  function diff(base, fromNight, toNight, mode) {
    const a = apply(base, fromNight, mode).layers, b = apply(base, toNight, mode).layers;
    const out = [];
    for (let i = 0; i < b.length; i++) {
      const pa = (a[i] && a[i].paint) || {}, pb = b[i].paint || {};
      for (const k of Object.keys(pb)) {
        if (JSON.stringify(pa[k]) !== JSON.stringify(pb[k])) out.push({ id: b[i].id, prop: k, value: pb[k] });
      }
    }
    return out;
  }

  /** Colors the route layers use in the Tesla look. */
  function routeColors(night, mode) {
    const P = pal(night, mode);
    return { line: P.route, casing: P.routeCasing };
  }

  return { apply, diff, routeColors, roadClass, PALETTE, PALETTE_MONO };
});
