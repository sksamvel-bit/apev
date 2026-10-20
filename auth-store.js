/**
 * auth-store.js - signed-in devices that survive a Render deploy (server only, v3.10.60).
 *
 * Before: guest PIN bindings lived in pin-bindings.json on Render's disk, which every deploy wipes, so guests were signed
 * out and a guest PIN could be taken by any device after a deploy. Master PIN cookies were all the same ("master"), so a
 * single lost phone could not be signed out.
 *
 * Now one small JSON document (Upstash Redis when configured, else a local file) holds:
 *   masters:  { <deviceToken>: { createdAt, lastSeen, ua, ip } }   every device signed in with the master PIN
 *   guests:   { <pinId>: { deviceToken, boundAt, lastSeen, ua, ip } } the one device each guest PIN is bound to
 *   legacyOff: true once the owner signs out the pre-v3.10.60 master cookies ("master" token)
 * Keys are a one-way pinId, never a PIN. If the store cannot be read at start, the server runs "degraded": a validly signed
 * cookie is accepted as before (nobody is locked out by an Upstash outage) and nothing is written over the real data.
 */
"use strict";
const fs = require("fs");
const crypto = require("crypto");

const LASTSEEN_PERSIST_MS = 10 * 60 * 1000;   // lastSeen is kept in memory and written at most every 10 minutes

/** "a3f9c2d1": short public id for a device token (the token itself never leaves the server). */
function shortId(token) {
  return crypto.createHash("sha256").update("dev:" + String(token)).digest("hex").slice(0, 8);
}

/** Human device name from the user agent ("Tesla", "iPhone", "Android", "Windows", "Mac", "Linux", "მოწყობილობა"). */
function deviceLabel(ua) {
  const s = String(ua || "");
  if (/Tesla\//i.test(s) || /QtCarBrowser/i.test(s)) return "Tesla";
  // the car's browser does not name itself: it reports desktop Chrome on Linux x86_64 (measured 2026-10-20, Chrome/148)
  if (/X11; Linux x86_64/.test(s) && /Chrome\//.test(s) && !/Android/i.test(s)) return "Tesla";
  if (/iPhone/i.test(s)) return "iPhone";
  if (/iPad/i.test(s)) return "iPad";
  if (/Android/i.test(s)) return "Android";
  if (/Windows/i.test(s)) return "Windows";
  if (/Macintosh|Mac OS X/i.test(s)) return "Mac";
  if (/Linux/i.test(s)) return "Linux";
  return "მოწყობილობა";
}

/** "1.2.3.4" -> "1.2.x.x" (enough to tell places apart in the panel, no full address). */
function maskIp(ip) {
  const s = String(ip || "");
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(s);
  if (v4) return v4[1] + "." + v4[2] + ".x.x";
  return s ? s.split(":").slice(0, 2).join(":") + ":…" : "";
}

function emptyState() { return { masters: {}, guests: {}, legacyOff: false }; }

function normalize(st) {
  const s = emptyState();
  if (st && typeof st === "object") {
    if (st.masters && typeof st.masters === "object") s.masters = st.masters;
    if (st.guests && typeof st.guests === "object") s.guests = st.guests;
    s.legacyOff = !!st.legacyOff;
    // v3.10.61: guest PINs set in the owner's panel, [{ n, id, changedAt }] (ids only; absent = use ACCESS_PIN's guests)
    if (Array.isArray(st.guestPins)) s.guestPins = st.guestPins.filter((x) => x && Number.isInteger(x.n) && typeof x.id === "string");
  }
  return s;
}

/**
 * opts: { adapter (Upstash-style { load(): Promise<obj|null>, save(obj): Promise<bool> }) | null, file, readyTimeoutMs, now }
 * Returns the store; `ready` resolves once the first read finished (or timed out -> degraded).
 */
function createAuthStore(opts) {
  const o = opts || {};
  const now = o.now || (() => Date.now());
  let state = emptyState();
  let degraded = false;
  let readyDone = false;
  let saveTimer = null;
  let lastPersist = 0;

  const store = {
    get state() { return state; },
    get degraded() { return degraded; },
    isReady: () => readyDone,
    storeName: o.adapter ? "upstash" : "file",
    ready: null
  };

  function readFile() {
    try { if (o.file && fs.existsSync(o.file)) return JSON.parse(fs.readFileSync(o.file, "utf8")); } catch (_) {}
    return null;
  }

  async function load() {
    if (o.adapter) return o.adapter.load();   // rejects when unreachable
    return readFile();
  }

  function persistNow() {
    saveTimer = null;
    if (degraded) return Promise.resolve(false);   // never overwrite real data we could not read
    lastPersist = now();
    if (o.adapter) return o.adapter.save(state);
    try { if (o.file) fs.writeFileSync(o.file, JSON.stringify(state, null, 2), "utf8"); return Promise.resolve(true); } catch (_) { return Promise.resolve(false); }
  }

  /** Writes right after the current request's changes (same tick batched): a sign-in must survive an immediate deploy. */
  store.save = () => { if (!saveTimer) saveTimer = Promise.resolve().then(persistNow); };
  store.flush = () => persistNow();

  store.ready = new Promise((resolve) => {
    let settled = false;
    const finish = (val, failed) => {
      if (settled) return;
      settled = true;
      if (failed) degraded = true; else state = normalize(val);
      readyDone = true;
      resolve();
    };
    const t = setTimeout(() => finish(null, true), o.readyTimeoutMs || 4000);
    if (t && t.unref) t.unref();
    load().then((v) => { clearTimeout(t); finish(v, false); }, () => { clearTimeout(t); finish(null, true); });
  });

  /** Keep trying to read the real data while degraded; merges what was added meanwhile. */
  store.retry = async () => {
    if (!degraded) return true;
    try {
      const v = normalize(await load());
      Object.assign(v.masters, state.masters);
      for (const k of Object.keys(state.guests)) if (!v.guests[k]) v.guests[k] = state.guests[k];
      state = v;
      degraded = false;
      store.save();
      return true;
    } catch (_) { return false; }
  };

  /** lastSeen for a device; written to the store at most every 10 minutes. */
  store.touch = (rec) => {
    if (!rec) return;
    rec.lastSeen = now();
    if (now() - lastPersist > LASTSEEN_PERSIST_MS) store.save();
  };

  return store;
}

module.exports = { createAuthStore, shortId, deviceLabel, maskIp, normalize, LASTSEEN_PERSIST_MS };
