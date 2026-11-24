/* S.SUITE 2026 silent auction: live bidding. Bids are stored privately; the page
 * shows the current high bid without bid counts. */
(() => {
  "use strict";
  const API = "https://iddzcbknnddkonrcwgpt.supabase.co/functions/v1/ssuite-auction-bid";
  const script = document.currentScript;
  const pageLot = script && script.dataset.lot;
  const fmt = (n) => "$" + Number(n).toLocaleString("en-US");
  let state = {};
  let closesAt = null;

  const css = `
  .sa-bidbtn{display:inline-flex;align-items:center;justify-content:center;margin-top:14px;padding:13px 20px;background:#090909;color:#fff;border:1px solid #090909;font:600 11px/1 NeueSwiss,Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;cursor:pointer;width:100%}
  .sa-bidbtn:hover{background:#fff;color:#090909}
  .sa-bidbtn[disabled]{opacity:.45;cursor:default;background:#090909;color:#fff}
  .sa-live{display:block;font-weight:600}
  .sa-count{display:block;font-size:12px;color:#6a6a6a;margin-top:4px;font-weight:400;letter-spacing:0;text-transform:none}
  .sa-modal{position:fixed;inset:0;background:rgba(9,9,9,.55);display:flex;align-items:center;justify-content:center;padding:16px;z-index:9999}
  .sa-modal[hidden]{display:none}
  .sa-panel{background:#fff;width:100%;max-width:460px;max-height:92vh;overflow:auto;padding:30px 28px 26px;border:1px solid #090909;font-family:NeueSwiss,Arial,sans-serif;color:#090909;position:relative}
  .sa-panel h2{font:30px/1.05 Aperitif,Georgia,serif;font-weight:400;letter-spacing:-.02em;margin:8px 0 6px}
  .sa-panel .sa-eyebrow{font-size:10px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#6a6a6a;margin:0}
  .sa-panel .sa-cur{display:flex;gap:24px;border-top:1px solid rgba(0,0,0,.16);border-bottom:1px solid rgba(0,0,0,.16);padding:14px 0;margin:16px 0 18px}
  .sa-panel .sa-cur small{display:block;font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#6a6a6a;margin-bottom:6px}
  .sa-panel .sa-cur strong{font:28px/1 Aperitif,Georgia,serif;font-weight:400}
  .sa-panel label{display:block;font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;margin:12px 0 6px}
  .sa-panel input{width:100%;box-sizing:border-box;padding:12px;border:1px solid rgba(0,0,0,.3);font:16px NeueSwiss,Arial,sans-serif;border-radius:0}
  .sa-panel input:focus{outline:2px solid #090909;outline-offset:-1px}
  .sa-panel .sa-fine{font-size:12px;line-height:1.5;color:#6a6a6a;margin:14px 0 0}
  .sa-panel .sa-msg{margin:14px 0 0;font-size:14px;line-height:1.45}
  .sa-panel .sa-msg[data-kind=error]{color:#b42318}
  .sa-panel .sa-msg[data-kind=ok]{color:#0b6b3a;font-weight:600}
  .sa-close{position:absolute;top:10px;right:12px;background:none;border:0;font-size:26px;line-height:1;cursor:pointer;color:#090909}
  .sa-hp{position:absolute;left:-9999px}
  `;
  const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);

  const modal = document.createElement("div");
  modal.className = "sa-modal"; modal.hidden = true;
  modal.innerHTML = `<div class="sa-panel" role="dialog" aria-modal="true" aria-labelledby="sa-title">
    <button type="button" class="sa-close" aria-label="Close">×</button>
    <p class="sa-eyebrow" id="sa-lotno">Silent auction</p>
    <h2 id="sa-title"></h2>
    <div class="sa-cur"><div><small id="sa-curlabel">Current bid</small><strong id="sa-cur"></strong></div><div><small>Minimum next bid</small><strong id="sa-min"></strong></div></div>
    <form id="sa-form" novalidate>
      <label for="sa-amount">Your bid (USD)</label><input id="sa-amount" name="amount" inputmode="numeric" autocomplete="off" required>
      <label for="sa-name">Full name</label><input id="sa-name" name="name" autocomplete="name" required>
      <label for="sa-email">Email</label><input id="sa-email" name="email" type="email" autocomplete="email" required>
      <label for="sa-phone">Mobile number</label><input id="sa-phone" name="phone" type="tel" autocomplete="tel" required>
      <input class="sa-hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button type="submit" class="sa-bidbtn" id="sa-submit">Place bid</button>
      <p class="sa-msg" id="sa-msg" hidden></p>
      <p class="sa-fine">Bids are binding commitments to support SALUTE. Bid increments are $25 under $500 and $50 from $500. Your name and contact details are never shown publicly; the S.SUITE team will contact the winning bidder after bidding closes to arrange payment and introductions.</p>
    </form></div>`;
  document.body.appendChild(modal);
  const $ = (id) => document.getElementById(id);
  let activeLot = null;
  const close = () => { modal.hidden = true; activeLot = null; document.body.style.overflow = ""; };
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  modal.querySelector(".sa-close").addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });
  try { const saved = JSON.parse(localStorage.getItem("ssuite-bidder") || "{}"); ["name","email","phone"].forEach((k) => { if (saved[k]) $("sa-" + k).value = saved[k]; }); } catch {}

  function msg(text, kind) { const m = $("sa-msg"); m.textContent = text; m.hidden = !text; m.dataset.kind = kind || ""; }
  function fillModal() {
    const l = state[activeLot]; if (!l) return;
    $("sa-lotno").textContent = "Lot " + String(l.lot_number).padStart(2, "0");
    $("sa-title").textContent = l.title;
    $("sa-curlabel").textContent = l.high_bid ? "Current bid" : "Opening bid";
    $("sa-cur").textContent = fmt(l.high_bid || l.opening_bid);
    $("sa-min").textContent = fmt(l.min_next);
    $("sa-submit").disabled = !l.is_open;
    if (!l.is_open) msg("Bidding on this lot has closed.", "error");
  }
  function open(slug) {
    if (!state[slug]) return;
    activeLot = slug; msg("", "");
    $("sa-amount").value = state[slug].min_next;
    fillModal(); modal.hidden = false; document.body.style.overflow = "hidden";
    setTimeout(() => $("sa-amount").focus(), 30);
  }

  $("sa-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target; const lot = activeLot; if (!lot) return;
    const amount = Number(String(f.amount.value).replace(/[$,\s]/g, "").replace(/\.00$/, ""));
    if (!Number.isInteger(amount) || amount <= 0) return msg("Please enter a whole-dollar amount.", "error");
    if (amount < state[lot].min_next) return msg("The minimum bid is " + fmt(state[lot].min_next) + ".", "error");
    if (!f.name.value.trim() || !f.email.value.trim() || !f.phone.value.trim()) return msg("Please complete your name, email and mobile number.", "error");
    if (amount >= state[lot].min_next * 3 && !confirm("Please confirm your bid of " + fmt(amount) + ".")) return;
    const btn = $("sa-submit"); btn.disabled = true; btn.textContent = "Placing bid…"; msg("", "");
    try {
      const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lot, amount, name: f.name.value, email: f.email.value, phone: f.phone.value, website: f.website.value }) });
      const d = await r.json().catch(() => ({}));
      try { localStorage.setItem("ssuite-bidder", JSON.stringify({ name: f.name.value, email: f.email.value, phone: f.phone.value })); } catch {}
      await refresh();
      if (d.ok) { msg("Thank you! Your bid of " + fmt(amount) + " is the current high bid.", "ok"); }
      else { msg(d.error || "We couldn't place that bid. Please try again.", "error"); if (state[lot]) f.amount.value = state[lot].min_next; }
    } catch { msg("Connection problem. Please try again, or bid with the S.SUITE team.", "error"); }
    btn.textContent = "Place bid"; if (state[lot]) btn.disabled = !state[lot].is_open;
  });

  function render() {
    // Overview cards
    document.querySelectorAll(".card[id]").forEach((card) => {
      const l = state[card.id]; if (!l) return;
      const ob = card.querySelector(".ob");
      if (ob) ob.innerHTML = `<span class="sa-live">${l.high_bid ? "Current bid " + fmt(l.high_bid) : "Opening bid " + fmt(l.opening_bid)}</span>${l.is_open ? "" : '<span class="sa-count">Bidding closed</span>'}`;
      let b = card.querySelector(".sa-bidbtn");
      if (!b) {
        b = document.createElement("button"); b.type = "button"; b.className = "sa-bidbtn";
        b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); open(card.id); });
        card.appendChild(b);
      }
      b.textContent = l.is_open ? "Place a bid" : "Bidding closed"; b.disabled = !l.is_open;
    });
    // Lot page bid panel
    if (pageLot && state[pageLot]) {
      const l = state[pageLot]; const box = document.querySelector(".bidbox"); if (!box) return;
      const top = box.querySelector(".top");
      if (top) top.innerHTML = `<small>${l.high_bid ? "Current bid" : "Opening bid"}</small><strong>${fmt(l.high_bid || l.opening_bid)}</strong>`;
      box.querySelectorAll(".bidgrid > div").forEach((d) => { const s = d.querySelector("small"); if (s && /increment/i.test(s.textContent)) { const st = d.querySelector("strong"); if (st) st.textContent = "$25 / $50"; } });
      const note = box.querySelector(".note");
      if (note) note.textContent = l.is_open ? `Minimum next bid ${fmt(l.min_next)}. Every winning bid supports SALUTE.` : "Bidding on this lot has closed. Thank you for supporting SALUTE.";
      let b = box.querySelector("button.button, .sa-bidbtn");
      if (b && !b.dataset.saBound) { const nb = document.createElement("button"); nb.type = "button"; nb.className = "button sa-bidbtn"; nb.dataset.saBound = "1"; nb.addEventListener("click", () => open(pageLot)); b.replaceWith(nb); b = nb; }
      if (b) { b.textContent = l.is_open ? "Place a bid" : "Bidding closed"; b.disabled = !l.is_open; b.style.cursor = l.is_open ? "pointer" : "default"; }
    }
    const notice = document.querySelector(".notice");
    if (notice && closesAt) notice.innerHTML = `<small>How to bid</small>Bidding is live. Tap “Place a bid” on any lot. Bidding closes ${closesAt.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", hour: "numeric", minute: "2-digit" })} ET.`;
    if (activeLot) fillModal();
  }

  async function refresh() {
    try {
      const r = await fetch(API, { cache: "no-store" }); const d = await r.json();
      if (!d.ok) return;
      state = {}; d.lots.forEach((l) => { state[l.slug] = l; closesAt = new Date(l.closes_at); });
      render();
    } catch {}
  }
  refresh(); setInterval(refresh, 15000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})();
