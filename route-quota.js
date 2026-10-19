'use strict';
/**
 * route-quota.js - server-side spending guard for the Google Routes API (v3.10.33, updated v3.10.37).
 * Google's console cannot cap Routes API usage ("Adjustable: No"), so the server counts every paid call itself and refuses
 * past the day / month caps; the client then falls back to OSRM.
 *
 * Storage options:
 * 1. FileAdapter (default with file path): Writes to disk (e.g. Render Persistent Disk or local file).
 * 2. UpstashRedisAdapter: Cloud-based REST key-value store (free forever, survives deploys on Render ephemeral instances).
 * 3. Pluggable custom adapter: Any object implementing { load(), save(st) }.
 *
 * Days/months are counted in Asia/Tbilisi time (UTC+4) because that is when the owner thinks of "today".
 */
const fs = require('fs');
const https = require('https');

function tbilisiStamp(nowMs) {
  const d = new Date(nowMs + 4 * 3600 * 1000).toISOString();
  return { day: d.slice(0, 10), month: d.slice(0, 7) };
}

function createFileAdapter(filePath) {
  if (!filePath) return null;
  return {
    name: 'file',
    load() {
      try {
        const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return (j && typeof j === 'object') ? j : null;
      } catch (_) { return null; }
    },
    save(st) {
      try {
        fs.writeFileSync(filePath, JSON.stringify(st));
        return true;
      } catch (_) { return false; }
    }
  };
}

function createUpstashRedisAdapter(opts) {
  const o = opts || {};
  const baseUrl = (o.url || '').replace(/\/+$/, '');
  const token = o.token || '';
  const key = o.key || 'routes_usage_quota';
  if (!baseUrl || !token) return null;

  return {
    name: 'upstash',
    load() {
      return new Promise((resolve) => {
        try {
          const u = new URL(`${baseUrl}/get/${encodeURIComponent(key)}`);
          const req = https.request(u, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}` },
            timeout: o.timeoutMs || 4000
          }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', c => { data += c; });
            res.on('end', () => {
              try {
                const j = JSON.parse(data);
                const val = typeof j.result === 'string' ? JSON.parse(j.result) : j.result;
                resolve((val && typeof val === 'object') ? val : null);
              } catch (_) { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
          req.end();
        } catch (_) { resolve(null); }
      });
    },
    save(st) {
      return new Promise((resolve) => {
        try {
          const payload = JSON.stringify(['SET', key, JSON.stringify(st)]);
          const u = new URL(baseUrl);
          const req = https.request(u, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload)
            },
            timeout: o.timeoutMs || 4000
          }, (res) => {
            res.resume();
            res.on('end', () => resolve(true));
          });
          req.on('error', () => resolve(false));
          req.on('timeout', () => { req.destroy(); resolve(false); });
          req.write(payload);
          req.end();
        } catch (_) { resolve(false); }
      });
    }
  };
}

function createRouteQuota(opts) {
  const o = Object.assign({ file: null, adapter: null, dayCap: 100, monthCap: 4000, now: () => Date.now() }, opts || {});
  let st = { day: '', dayCount: 0, month: '', monthCount: 0 };
  const adapter = o.adapter || (o.file ? createFileAdapter(o.file) : null);

  function applyState(incoming) {
    if (incoming && typeof incoming === 'object') {
      if (incoming.day && (!st.day || incoming.day >= st.day)) {
        st.day = String(incoming.day);
        st.dayCount = incoming.dayCount | 0;
      }
      if (incoming.month && (!st.month || incoming.month >= st.month)) {
        st.month = String(incoming.month);
        st.monthCount = incoming.monthCount | 0;
      }
    }
  }

  let readyPromise = null;
  if (adapter && typeof adapter.load === 'function') {
    try {
      const res = adapter.load();
      if (res && typeof res.then === 'function') {
        readyPromise = res.then(loaded => {
          applyState(loaded);
          return st;
        }).catch(() => st);
      } else {
        applyState(res);
        readyPromise = Promise.resolve(st);
      }
    } catch (_) {
      readyPromise = Promise.resolve(st);
    }
  } else {
    readyPromise = Promise.resolve(st);
  }

  function roll() {
    const s = tbilisiStamp(o.now());
    if (st.day !== s.day) { st.day = s.day; st.dayCount = 0; }
    if (st.month !== s.month) { st.month = s.month; st.monthCount = 0; }
  }

  function save() {
    if (adapter && typeof adapter.save === 'function') {
      try {
        const p = adapter.save(st);
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) { /* ignore write failure */ }
    }
  }

  return {
    tryConsume() {
      roll();
      if (st.dayCount >= o.dayCap) return { ok: false, reason: 'day', day: st.dayCount, month: st.monthCount };
      if (st.monthCount >= o.monthCap) return { ok: false, reason: 'month', day: st.dayCount, month: st.monthCount };
      st.dayCount++; st.monthCount++; save();
      return { ok: true, day: st.dayCount, month: st.monthCount };
    },
    snapshot() { roll(); return { day: st.dayCount, month: st.monthCount, dayCap: o.dayCap, monthCap: o.monthCap }; },
    init() { return readyPromise; },
    ready: readyPromise,
    adapter
  };
}

module.exports = { createRouteQuota, tbilisiStamp, createFileAdapter, createUpstashRedisAdapter };
