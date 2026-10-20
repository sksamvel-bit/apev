/**
 * geocharge-tariffs.js - network tariff medians from https://geocharge.ge/tarifebi/ (server only, v3.10.58).
 *
 * The page is server-rendered and updated daily by GeoCharge from the providers' public data (robots.txt allows all).
 * We read it once a day and keep only the per-network DC / AC medians; they fill in stations whose own record in the
 * dachar.ge data has no price. A page we cannot understand changes nothing: the last good medians stay.
 */
"use strict";

const URL_TARIFFS = "https://geocharge.ge/tarifebi/";

// GeoCharge network page slug (/qselebi/<slug>/) -> our operator id (the dachar.ge operatorId)
const SLUG_TO_OPERATOR = {
  "mart-ev": "martev",
  "e-space": "espace",
  "ev-power-ge": "evpower",
  "ev-power": "evpower",
  "charger-plus": "chargerplus",
  "ecocars": "ecocars",
  "tegeta": "tegeta",
  "tbilisi-city-hall": "ttc",
  "electrify-georgia": "electrify",
  "da-tene": "datene",
  "solar-station": "solarauto",
  "solarauto": "solarauto",
  "moveo": "moveo",
  "gadatene": "gadatene",
  "green-charge": "greencharge",
  "greencharge": "greencharge"
};

function operatorOf(slug) {
  const s = String(slug || "").toLowerCase();
  return SLUG_TO_OPERATOR[s] || s.replace(/[^a-z0-9]/g, "");
}

function median(cell) {
  const m = /მედიანა\s*([0-9]+(?:[.,][0-9]+)?)/.exec(cell || "");
  if (!m) return null;
  const v = parseFloat(m[1].replace(",", "."));
  return v > 0 && v < 2 ? Math.round(v * 100) / 100 : null;   // GeoCharge itself drops values above 2 GEL as data errors
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * HTML of /tarifebi/ -> { tariffs: { martev: { dc: 0.80, ac: 0.65, name: "mart EV" }, ... }, updated: "2026-10-20 09:02" | null }.
 * Networks without any median (free / unpublished prices) are left out.
 */
function parseTariffsPage(html) {
  const tariffs = {};
  const page = String(html || "");
  const body = (/<tbody>([\s\S]*?)<\/tbody>/.exec(page) || [])[1] || "";
  const rows = body.match(/<tr>[\s\S]*?<\/tr>/g) || [];
  for (const row of rows) {
    const cells = (row.match(/<td>[\s\S]*?<\/td>/g) || []);
    if (cells.length < 4) continue;
    const link = /href="\/qselebi\/([^/"]+)\/?"/.exec(cells[0]);
    if (!link) continue;
    const dc = median(cells[2]), ac = median(cells[3]);
    if (dc == null && ac == null) continue;
    const name = stripTags(cells[0]).replace(/\s*\(.*\)\s*$/, "");
    tariffs[operatorOf(link[1])] = { dc, ac, name };
  }
  const upd = /ბოლო განახლება:\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)/.exec(stripTags(page));
  return { tariffs, updated: upd ? upd[1] : null };
}

/** A parse is trusted only when it looks like the real table (several networks with sane medians). */
function looksValid(parsed) {
  return !!parsed && Object.keys(parsed.tariffs || {}).length >= 5;
}

module.exports = { URL_TARIFFS, SLUG_TO_OPERATOR, operatorOf, parseTariffsPage, looksValid };
