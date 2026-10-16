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
      minor: "#ffffff", major: "#ffffff", hwy: "#ffffff", casing: "#d3d8de", rail: "#cfd4da", path: "#f6f7f9",
      text: "#4a5058", halo: "#eceff2", route: "#3e6ae1", routeCasing: "#ffffff"
    },
    night: {
      land: "#1b1d21", land2: "#202328", park: "#1d2722", water: "#121c27", building: "#25282e",
      minor: "#343840", major: "#3f444c", hwy: "#4c525b", casing: "#131518", rail: "#2c2f35", path: "#2b2e34",
      text: "#9aa1ab", halo: "#1b1d21", route: "#4f8dff", routeCasing: "#0b1a3d"
    }
  };

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
  function apply(style, night) {
    const P = night ? PALETTE.night : PALETTE.day;
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
        else if (sl === "park" || sl === "landcover" || /park|wood|forest|grass|green/i.test(id)) c = P.park;
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
        paint["text-color"] = P.text;
        paint["text-halo-color"] = P.halo;
        paint["text-halo-width"] = 1.5;
        delete paint["icon-color"];
        return touch();
      }
      return l;
    });
    return out;
  }

  /** Colors the route layers use in the Tesla look. */
  function routeColors(night) {
    const P = night ? PALETTE.night : PALETTE.day;
    return { line: P.route, casing: P.routeCasing };
  }

  return { apply, routeColors, roadClass, PALETTE };
});
