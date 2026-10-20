/**
 * devices-panel.js - "🔐 მოწყობილობები და PIN-ები" in the settings window, for the owner only (v3.10.60, PINs v3.10.61).
 *
 * When the settings window opens, the page asks /api/admin/devices. The server answers only a device signed in with the
 * MASTER PIN; a guest gets 403 and the column stays hidden (the server also refuses every action from a guest, so hiding
 * is not the protection). The panel lists the owner's devices and the guest PINs and can sign a device out, free / change /
 * add / remove a guest PIN, or sign out every other device. PINs and device tokens never reach the page, except a PIN the
 * server generated, which it shows once.
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

  const ERRORS = {
    length: "PIN 6–32 სიმბოლო უნდა იყოს",
    chars: "მხოლოდ ლათინური ასოები, ციფრები და . _ -",
    "same-as-master": "მთავარ PIN-ს ემთხვევა",
    duplicate: "ეს PIN სხვა სტუმარს უკვე აქვს",
    "too-many": "მაქსიმუმ 10 სტუმარი",
    "current-device": "ამ მოწყობილობას აქედან ვერ გამოიყვან",
    "store-unavailable": "საცავი დროებით მიუწვდომელია, სცადე მოგვიანებით"
  };
  function errorText(code, status) { return ERRORS[code] || "ვერ შესრულდა (" + (code || status) + ")"; }

  /** Rows for the view: masters [{ id, title, sub, current, action }], guests [{ id, n, title, sub, bound }]. */
  function rows(data, now) {
    const out = { masters: [], guests: [] };
    for (const m of (data && data.masters) || []) {
      const sub = m.id === "legacy" ? "განახლებამდე შესული ყველა მოწყობილობა" : [m.ip, m.lastSeen ? "ბოლოს: " + ago(m.lastSeen, now) : ""].filter(Boolean).join(" · ");
      out.masters.push({ id: m.id, title: (m.id === "legacy" ? "🗝️ " : icon(m.label) + " ") + m.label + (m.current ? " (ეს)" : ""), sub, current: !!m.current, action: m.current && m.id !== "legacy" ? null : "გამოყვანა" });
    }
    for (const g of (data && data.guests) || []) {
      out.guests.push({
        id: g.id, n: g.n, bound: !!g.bound,
        title: "👤 სტუმარი " + g.n + ": " + (g.bound ? icon(g.label) + " " + g.label : "თავისუფალი"),
        sub: g.bound ? [g.ip, g.lastSeen ? "ბოლოს: " + ago(g.lastSeen, now) : ""].filter(Boolean).join(" · ") : (g.changedAt ? "PIN შეიცვალა " + ago(g.changedAt, now) : "PIN-ს ჯერ არავინ შეუყვანია")
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ browser part
  function init() {
    if (typeof document === "undefined") return;
    const box = document.getElementById("devices-panel"), btn = document.getElementById("btn-settings");
    if (!box || !btn) return;
    const win = box.closest ? box.closest(".settings-modal-window") : null;
    let busy = false, editing = null, shownPin = null, data = null;

    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const button = (cls, text, fn, confirmText) => {
      const b = el("button", "devices-btn " + cls, text);
      b.type = "button";
      let armed = null;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirmText && !armed) { b.textContent = confirmText; b.classList.add("armed"); armed = setTimeout(() => { armed = null; b.textContent = text; b.classList.remove("armed"); }, 4000); return; }
        if (armed) clearTimeout(armed);
        fn();
      });
      return b;
    };

    /** Inline editor: type a PIN or let the server make one. target: "guest-N" (change) or "new" (add). */
    function editor(target) {
      const wrap = el("div", "devices-edit");
      const input = el("input", "devices-input");
      input.type = "text"; input.autocomplete = "off"; input.spellcheck = false; input.maxLength = 32;
      input.placeholder = "ახალი PIN (6+ სიმბოლო)";
      input.addEventListener("click", (e) => e.stopPropagation());
      const url = target === "new" ? "/api/admin/guest-add" : "/api/admin/guest-pin";
      const id = target === "new" ? undefined : target;
      wrap.appendChild(input);
      wrap.appendChild(button("primary", "შენახვა", () => { if (input.value.trim()) act(url, { id, pin: input.value.trim() }); }));
      wrap.appendChild(button("", "🎲 შექმნა", () => act(url, { id, generate: true })));
      wrap.appendChild(button("", "✕", () => { editing = null; render(); }));
      setTimeout(() => { try { input.focus(); } catch (_) {} }, 0);
      return wrap;
    }

    function render() {
      const r = rows(data);
      box.textContent = "";
      box.appendChild(el("h3", "devices-title", "🔐 მოწყობილობები და PIN-ები"));
      if (data.degraded) box.appendChild(el("div", "devices-note warn", "⚠️ საცავი დროებით მიუწვდომელია: ცვლილებები ახლა არ შეინახება."));
      if (shownPin) {
        const pinBox = el("div", "devices-newpin");
        pinBox.appendChild(el("div", "devices-meta", "ახალი PIN (გადაეცი სტუმარს, მეორედ აღარ გამოჩნდება):"));
        pinBox.appendChild(el("div", "devices-pin", shownPin));
        box.appendChild(pinBox);
      }

      box.appendChild(el("div", "devices-sub", "ჩემი მოწყობილობები"));
      for (const it of r.masters) {
        const row = el("div", "devices-row" + (it.current ? " current" : ""));
        const info = el("div", "devices-info");
        info.appendChild(el("div", "devices-name", it.title));
        if (it.sub) info.appendChild(el("div", "devices-meta", it.sub));
        row.appendChild(info);
        if (it.action) row.appendChild(button("danger", it.action, () => act("/api/admin/revoke", { id: it.id }), "დარწმუნებული?"));
        box.appendChild(row);
      }

      box.appendChild(el("div", "devices-sub", "სტუმრები (თითო PIN ერთ მოწყობილობაზე)"));
      for (const it of r.guests) {
        const row = el("div", "devices-row");
        const info = el("div", "devices-info");
        info.appendChild(el("div", "devices-name", it.title));
        if (it.sub) info.appendChild(el("div", "devices-meta", it.sub));
        row.appendChild(info);
        const acts = el("div", "devices-acts");
        acts.appendChild(button("", "🔑 PIN", () => { editing = it.id; shownPin = null; render(); }));
        if (it.bound) acts.appendChild(button("danger", "მოხსნა", () => act("/api/admin/revoke", { id: it.id }), "დარწმუნებული?"));
        acts.appendChild(button("danger", "🗑", () => act("/api/admin/guest-remove", { id: it.id }), "წავშალო?"));
        row.appendChild(acts);
        box.appendChild(row);
        if (editing === it.id) box.appendChild(editor(it.id));
      }
      if (!r.guests.length) box.appendChild(el("div", "devices-meta", "სტუმრის PIN-ები არ არის"));
      if (editing === "new") box.appendChild(editor("new"));
      else if (r.guests.length < (data.maxGuests || 10)) box.appendChild(button("wide", "＋ სტუმრის დამატება", () => { editing = "new"; shownPin = null; render(); }));

      box.appendChild(button("danger wide", "🚪 ყველა სხვა მოწყობილობის გამოყვანა", () => act("/api/admin/revoke-others", {}), "დარწმუნებული? სტუმრებიც გამოვლენ"));
      box.appendChild(el("div", "devices-note", "„მოხსნა“: სტუმარი გამოდის, PIN რჩება. „🔑 PIN“: ახალი PIN, ძველით შესული გამოდის. მთავარი PIN იცვლება მხოლოდ Render-ში."));
      box.hidden = false;
      if (win) win.classList.add("has-devices");
    }

    async function load() {
      try {
        const res = await fetch("/api/admin/devices", { cache: "no-store" });
        if (!res.ok) { box.hidden = true; if (win) win.classList.remove("has-devices"); return; }   // guest / open mode
        data = await res.json();
        editing = null; shownPin = null;
        render();
      } catch (_) { box.hidden = true; if (win) win.classList.remove("has-devices"); }
    }

    async function act(url, body) {
      if (busy) return;
      busy = true;
      try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const j = await res.json().catch(() => ({}));
        if (res.ok) {
          data = j; editing = null; shownPin = j.newPin || null;
          render();
          if (window.showToast && !j.newPin) window.showToast("🔐 შესრულდა", "success", 2000);
        } else if (window.showToast) window.showToast(errorText(j.error, res.status), "error", 3500);
      } catch (_) {
        if (window.showToast) window.showToast("კავშირის შეცდომა", "error", 3000);
      } finally { busy = false; }
    }

    btn.addEventListener("click", load);
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  }

  return { ago, rows, icon, errorText };
});
