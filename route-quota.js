'use strict';
/**
 * route-quota.js - server-side spending guard for the Google Routes API (v3.10.33).
 * Google's console cannot cap Routes API usage ("Adjustable: No"), so the server counts every paid call itself and refuses
 * past the day / month caps; the client then falls back to OSRM. Counters are kept in a small JSON file (best effort:
 * if the disk is read-only they live in memory) so a restart does not reset the day.
 * Days/months are counted in Asia/Tbilisi time (UTC+4) because that is when the owner thinks of "today".
 */
const fs = require('fs');

function tbilisiStamp(nowMs) {
  const d = new Date(nowMs + 4 * 3600 * 1000).toISOString();
  return { day: d.slice(0, 10), month: d.slice(0, 7) };
}

function createRouteQuota(opts) {
  const o = Object.assign({ file: null, dayCap: 100, monthCap: 4000, now: () => Date.now() }, opts || {});
  let st = { day: '', dayCount: 0, month: '', monthCount: 0 };
  if (o.file) {
    try {
      const j = JSON.parse(fs.readFileSync(o.file, 'utf8'));
      if (j && typeof j === 'object') st = Object.assign(st, { day: String(j.day || ''), dayCount: j.dayCount | 0, month: String(j.month || ''), monthCount: j.monthCount | 0 });
    } catch (_) { /* first run or unreadable: start from zero */ }
  }
  function roll() {
    const s = tbilisiStamp(o.now());
    if (st.day !== s.day) { st.day = s.day; st.dayCount = 0; }
    if (st.month !== s.month) { st.month = s.month; st.monthCount = 0; }
  }
  function save() { if (o.file) { try { fs.writeFileSync(o.file, JSON.stringify(st)); } catch (_) { /* memory only */ } } }
  return {
    /** Reserves one call. Returns { ok, reason?, day, month }. Reserved before the request, so a failing Google call still counts (safe side). */
    tryConsume() {
      roll();
      if (st.dayCount >= o.dayCap) return { ok: false, reason: 'day', day: st.dayCount, month: st.monthCount };
      if (st.monthCount >= o.monthCap) return { ok: false, reason: 'month', day: st.dayCount, month: st.monthCount };
      st.dayCount++; st.monthCount++; save();
      return { ok: true, day: st.dayCount, month: st.monthCount };
    },
    snapshot() { roll(); return { day: st.dayCount, month: st.monthCount, dayCap: o.dayCap, monthCap: o.monthCap }; }
  };
}

module.exports = { createRouteQuota, tbilisiStamp };
