/**
 * devices-panel.js - "🔐 მოწყობილობები" in the settings window, for the owner only (v3.10.60).
 *
 * When the settings window opens, the page asks /api/admin/devices. The server answers only a device signed in with the
 * MASTER PIN; a guest gets 403 and the section stays hidden (the server also refuses every action from a guest, so hiding
 * is not the protection). The panel lists the owner's devices and the guest PINs (bound device or free) and can sign one
 * out, or every other device at once. PINs and device tokens never reach the page: rows carry short ids only.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DevicesPanel = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** "ახლა", "5 წთ წინ", "3 სთ წინ", "2 დღის წინ", "" for unknown. */
  function ago(ts, now) {
    if (!ts) return "";
    const s = Math.max(0, ((now || Date.now()) - ts) / 1000);
    if (s < 90) return "ახლა";
    if (s < 3600) return Math.round(s / 60) + " წთ წინ";
    if (s < 48 * 3600) return Math.round(s / 3600) + " სთ წინ";
    return Math.round(s / 86400) + " დღის წინ";
  }

  function icon(label) {
    return { Tesla: "🚗", iPhone: "📱", Android: "📱", iPad: "📱", Windows: "💻", Mac: "💻", Linux: "💻" }[label] || "🔹";
  }

  /** Rows for the view: [{ id, title, sub, current, action }] (action: button text or null). */
  function rows(data, now) {
    const out = { masters: [], guests: [] };
    for (const m of (data && data.masters) || []) {
      const sub = m.id === "legacy" ? "განახლებამდე შესული ყველა მოწყობილობა" : [m.ip, m.lastSeen ? "ბოლოს: " + ago(m.lastSeen, now) : ""].filter(Boolean).join(" · ");
      out.masters.push({ id: m.id, title: (m.id === "legacy" ? "🗝️ " : icon(m.label) + " ") + m.label + (m.current ? " (ეს მოწყობილობა)" : ""), sub, current: !!m.current, action: m.current && m.id !== "legacy" ? null : "გამოყვანა" });
    }
    for (const g of (data && data.guests) || []) {
      out.guests.push(g.bound
        ? { id: g.id, title: "👤 სტუმარი " + g.n + ": " + icon(g.label) + " " + g.label, sub: [g.ip, g.lastSeen ? "ბოლოს: " + ago(g.lastSeen, now) : "", g.boundAt ? "მიბმულია " + ago(g.boundAt, now) : ""].filter(Boolean).join(" · "), current: false, action: "მოხსნა" }
        : { id: g.id, title: "👤 სტუმარი " + g.n + ": თავისუფალი", sub: "PIN-ს ჯერ არავინ შეუყვანია", current: false, action: null });
    }
    return out;
  }

  // ------------------------------------------------------------------ browser part
  function init() {
    if (typeof document === "undefined") return;
    const box = document.getElementById("devices-panel"), btn = document.getElementById("btn-settings");
    if (!box || !btn) return;
    let busy = false;

    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

    function render(data) {
      const r = rows(data);
      box.textContent = "";
      box.appendChild(el("h3", "devices-title", "🔐 მოწყობილობები (ხედავს მხოლოდ მთავარი PIN)"));
      if (data.degraded) box.appendChild(el("div", "devices-note", "⚠️ საცავი დროებით მიუწვდომელია: სია შეიძლება არასრული იყოს, ცვლილებები ახლა არ შეინახება."));
      const list = (title, items, kind) => {
        box.appendChild(el("div", "devices-sub", title));
        for (const it of items) {
          const row = el("div", "devices-row" + (it.current ? " current" : ""));
          const info = el("div", "devices-info");
          info.appendChild(el("div", "devices-name", it.title));
          if (it.sub) info.appendChild(el("div", "devices-meta", it.sub));
          row.appendChild(info);
          if (it.action) {
            const b = el("button", "devices-btn", it.action);
            b.type = "button";
            let armed = null;
            b.addEventListener("click", (e) => {
              e.stopPropagation();
              if (!armed) { b.textContent = "დარწმუნებული ხარ?"; b.classList.add("armed"); armed = setTimeout(() => { armed = null; b.textContent = it.action; b.classList.remove("armed"); }, 4000); return; }
              clearTimeout(armed);
              act("/api/admin/revoke", { id: it.id });
            });
            row.appendChild(b);
          }
          box.appendChild(row);
        }
        if (!items.length) box.appendChild(el("div", "devices-meta", kind === "guests" ? "სტუმრის PIN-ები არ არის გაწერილი" : "—"));
      };
      list("ჩემი მოწყობილობები (მთავარი PIN)", r.masters, "masters");
      list("სტუმრის PIN-ები (თითო ერთ მოწყობილობაზე)", r.guests, "guests");
      const all = el("button", "devices-btn devices-all", "🚪 ყველა სხვა მოწყობილობის გამოყვანა");
      all.type = "button";
      let armedAll = null;
      all.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!armedAll) { all.textContent = "დარწმუნებული ხარ? სტუმრებიც გამოვლენ"; all.classList.add("armed"); armedAll = setTimeout(() => { armedAll = null; all.textContent = "🚪 ყველა სხვა მოწყობილობის გამოყვანა"; all.classList.remove("armed"); }, 4000); return; }
        clearTimeout(armedAll);
        act("/api/admin/revoke-others", {});
      });
      box.appendChild(all);
      box.appendChild(el("div", "devices-note", "„მოხსნა“ სტუმრის PIN-ს ათავისუფლებს: მისი მოწყობილობა გამოვა და PIN-ის შეყვანა ისევ პირველ მოწყობილობას შეეძლება."));
      box.hidden = false;
    }

    async function load() {
      try {
        const res = await fetch("/api/admin/devices", { cache: "no-store" });
        if (!res.ok) { box.hidden = true; return; }   // guest / open mode: nothing to show
        render(await res.json());
      } catch (_) { box.hidden = true; }
    }

    async function act(url, body) {
      if (busy) return;
      busy = true;
      try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await res.json().catch(() => ({}));
        if (res.ok) { render(j); if (window.showToast) window.showToast("🔐 შესრულდა", "success", 2000); }
        else if (window.showToast) window.showToast(j.error === "current-device" ? "ამ მოწყობილობას აქედან ვერ გამოიყვან" : "ვერ შესრულდა (" + (j.error || res.status) + ")", "error", 3000);
      } catch (_) {
        if (window.showToast) window.showToast("კავშირის შეცდომა", "error", 3000);
      } finally { busy = false; }
    }

    btn.addEventListener("click", load);
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  }

  return { ago, rows, icon };
});
