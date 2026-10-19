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
  // Values pasted into Render's multi-line field often carry a line break, spaces, quotes or the "NAME=" prefix; a line break in
  // the token made Node refuse the Authorization header ("Invalid character in header content"). URLs and tokens have no spaces.
  const clean = (v) => String(v || '').replace(/\s+/g, '').replace(/^[A-Z_]+=/, '').replace(/^["']+|["']+$/g, '');
  const baseUrl = clean(o.url).replace(/\/+$/, '');
  const token = clean(o.token);
  const key = o.key || 'routes_usage_quota';
  if (!baseUrl || !token) return null;

  const api = {
    name: 'upstash',
    lastError: '',
    // Resolves null only when the key really does not exist yet; a network error, timeout or bad answer REJECTS, so the guard
    // can tell "empty store" from "store unreachable" and never overwrites real counts after a failed read.
    load() {
      return new Promise((resolve, reject) => {
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
              if (res.statusCode !== 200) return reject(new Error('upstash read HTTP ' + res.statusCode + ': ' + String(data).slice(0, 160)));
              try {
                const j = JSON.parse(data);
                if (j.result == null) return resolve(null);
                const val = typeof j.result === 'string' ? JSON.parse(j.result) : j.result;
                if (val && typeof val === 'object') resolve(val); else reject(new Error('upstash: unexpected value'));
              } catch (e) { reject(e); }
            });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(new Error('upstash timeout')); });
          req.end();
        } catch (e) { reject(e); }
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
            // a refused write (wrong / read-only token: 401, 403) must not look like success
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
              const ok = res.statusCode >= 200 && res.statusCode < 300;
              api.lastError = ok ? '' : 'upstash write HTTP ' + res.statusCode + ': ' + body.slice(0, 160);
              resolve(ok);
            });
          });
          req.on('error', (e) => { api.lastError = 'upstash write: ' + e.message; resolve(false); });
          req.on('timeout', () => { api.lastError = 'upstash write timeout'; req.destroy(); resolve(false); });
          req.write(payload);
          req.end();
        } catch (e) { api.lastError = 'upstash write: ' + e.message; resolve(false); }
      });
    }
  };
  return api;
}

function createRouteQuota(opts) {
  const o = Object.assign({ file: null, adapter: null, dayCap: 100, monthCap: 4000, now: () => Date.now() }, opts || {});
  let st = { day: '', dayCount: 0, month: '', monthCount: 0 };
  const adapter = o.adapter || (o.file ? createFileAdapter(o.file) : null);
  const retryMs = o.retryMs || 60000;
  // Nothing is written to the store until its state has been read once. Before that the guard still counts in memory:
  // a write from a fresh instance (count 1) must not overwrite the real count, and a failed read must not reset the cap.
  let synced = !adapter || typeof adapter.load !== 'function';
  let loading = null, lastLoad = -Infinity;
  let lastError = '', lastSavedAt = 0;   // shown by /api/google-usage: is the store really written?

  /** Calls spent before the store answered are added to what it holds for the same day / month. */
  function merge(stored) {
    if (!stored || typeof stored !== 'object') return;
    if (stored.day) {
      if (stored.day === st.day) st.dayCount += stored.dayCount | 0;
      else if (!st.day || stored.day > st.day) { st.day = String(stored.day); st.dayCount = stored.dayCount | 0; }
    }
    if (stored.month) {
      if (stored.month === st.month) st.monthCount += stored.monthCount | 0;
      else if (!st.month || stored.month > st.month) { st.month = String(stored.month); st.monthCount = stored.monthCount | 0; }
    }
  }

  /** Reads the store once; on failure keeps counting in memory and tries again on a later call (after retryMs). */
  function load() {
    lastLoad = o.now();
    const done = (stored) => { merge(stored); synced = true; save(); return true; };
    let res;
    try { res = adapter.load(); } catch (e) { lastError = 'read: ' + (e && e.message); return Promise.resolve(false); }
    if (res && typeof res.then === 'function') {
      loading = res.then(done, (e) => { lastError = 'read: ' + (e && e.message); return false; }).then((ok) => { loading = null; return ok; });
      return loading;
    }
    return Promise.resolve(done(res));
  }

  const readyPromise = (synced ? Promise.resolve(true) : load()).then(() => st);

  function roll() {
    const s = tbilisiStamp(o.now());
    if (st.day !== s.day) { st.day = s.day; st.dayCount = 0; }
    if (st.month !== s.month) { st.month = s.month; st.monthCount = 0; }
  }

  function save() {
    if (!synced) return;
    if (adapter && typeof adapter.save === 'function') {
      const note = (ok) => { if (ok === false) lastError = adapter.lastError || 'write failed'; else { lastError = ''; lastSavedAt = o.now(); } };
      try {
        const p = adapter.save(st);
        if (p && typeof p.then === 'function') p.then(note, (e) => { lastError = 'write: ' + (e && e.message); });
        else note(p);
      } catch (e) { lastError = 'write: ' + (e && e.message); }
    }
  }

  return {
    tryConsume() {
      if (!synced && !loading && o.now() - lastLoad >= retryMs) load();
      roll();
      // month first: when both are used up, "resets tomorrow" would be wrong (tomorrow is still blocked by the month)
      if (st.monthCount >= o.monthCap) return { ok: false, reason: 'month', day: st.dayCount, month: st.monthCount };
      if (st.dayCount >= o.dayCap) return { ok: false, reason: 'day', day: st.dayCount, month: st.monthCount };
      st.dayCount++; st.monthCount++; save();
      return { ok: true, day: st.dayCount, month: st.monthCount };
    },
    snapshot() { roll(); return { day: st.dayCount, month: st.monthCount, dayCap: o.dayCap, monthCap: o.monthCap }; },
    init() { return readyPromise; },
    ready: readyPromise,
    isSynced() { return synced; },
    status() { return { store: adapter ? (adapter.name || 'custom') : 'memory', synced, lastError, lastSavedAt: lastSavedAt ? new Date(lastSavedAt).toISOString() : null }; },
    adapter
  };
}

module.exports = { createRouteQuota, tbilisiStamp, createFileAdapter, createUpstashRedisAdapter };
