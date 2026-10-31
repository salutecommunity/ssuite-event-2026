/* S.Suite admin — Auction tab: lots, bidding window, bid log, bidders, close-out and
 * "Approve & charge", CSV export and the auction audit trail.
 * Every action goes to the auction-admin Edge Function, which verifies the staff JWT and
 * enforces role permissions (ssuite_auction_read / _pii_read / _manage / _charge) in the
 * database. Nothing here charges automatically: each charge is one explicit click per lot. */

const VIEWS = [["lots", "Lots & window"], ["bids", "Bid log"], ["bidders", "Bidders"], ["closeout", "Close-out & payment"], ["audit", "Audit"], ["submissions", "Submissions"]];
let view = "lots";
let bidLotFilter = "";

function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = String(text); return n; }
function money(c) { return c === null || c === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: c % 100 ? 2 : 0 }).format(c / 100); }
function when(v) { return v ? new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }).format(new Date(v)) + " ET" : "—"; }
function chip(v) { const s = el("span", `chip ${String(v || "unknown").toLowerCase()}`, String(v || "unknown").replaceAll("_", " ")); return s; }
function btn(label, cls, onClick) { const b = el("button", cls || "button outline compact", label); b.type = "button"; b.addEventListener("click", onClick); return b; }
function table(headers, rows) {
  const wrap = el("div", "table-wrap"); const t = document.createElement("table"); const th = document.createElement("thead"); const hr = document.createElement("tr");
  headers.forEach((h) => hr.append(el("th", "", h))); th.append(hr); t.append(th); const tb = document.createElement("tbody");
  rows.forEach((cells) => { const tr = document.createElement("tr"); cells.forEach((c) => { const td = document.createElement("td"); if (c instanceof Node) td.append(c); else td.textContent = c === null || c === undefined || c === "" ? "—" : String(c); tr.append(td); }); tb.append(tr); });
  t.append(tb); wrap.append(t); return wrap;
}
function dollarsToCents(v, { required = false } = {}) {
  const s = String(v ?? "").trim().replace(/[$,\s]/g, "");
  if (!s) { if (required) throw new Error("Enter an amount in whole dollars."); return null; }
  if (!/^[0-9]{1,7}$/.test(s)) throw new Error("Amounts must be whole dollars, for example 1200.");
  return Number(s) * 100;
}
function isoFromLocal(v) { if (!v) return null; const d = new Date(v); if (Number.isNaN(d.getTime())) throw new Error("Invalid date"); return d.toISOString(); }
function localInput(iso) { if (!iso) return ""; const d = new Date(iso); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }

export async function renderAuction(host, ctx) {
  // ctx: { token(): Promise<string>, apiBase(): string, status(msg, kind), loadSubmissions(host) }
  async function call(body, csv = false) {
    const res = await fetch(`${ctx.apiBase()}/functions/v1/auction-admin`, {
      method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${await ctx.token()}` }, body: JSON.stringify(body),
    });
    if (csv && res.ok) return res.blob();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "The auction admin is unavailable.");
    return data;
  }
  async function act(button, fn, okMessage) {
    if (button) button.disabled = true; ctx.status("Working…");
    try { const r = await fn(); await draw(); ctx.status(typeof okMessage === "function" ? okMessage(r) : okMessage || "Done.", "success"); return r; }
    catch (e) { ctx.status(e.message || "That did not work.", "error"); }
    finally { if (button) button.disabled = false; }
  }
  async function download(kind, button) {
    button.disabled = true;
    try { const blob = await call({ action: "export", kind }, true); const a = el("a"); a.href = URL.createObjectURL(blob); a.download = `ssuite-auction-${kind}.csv`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); ctx.status(`Downloaded ${kind} CSV. The export is recorded in the audit log.`, "success"); }
    catch (e) { ctx.status(e.message, "error"); } finally { button.disabled = false; }
  }

  const nav = el("div", "toolbar"); nav.setAttribute("role", "tablist");
  const body = el("div", "auction-admin");
  host.append(nav, body);
  function drawNav() {
    nav.replaceChildren();
    VIEWS.forEach(([k, label]) => { const b = btn(label, k === view ? "button dark" : "button outline", () => { view = k; drawNav(); draw(); }); b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(k === view)); nav.append(b); });
  }
  async function draw() {
    body.replaceChildren(); ctx.status("Loading auction data…");
    try {
      if (view === "submissions") { await ctx.loadSubmissions(body); return; }
      const state = await call({ action: "state" });
      if (view === "lots") drawLots(state);
      else if (view === "bids") drawBids(state, await call({ action: "bids", lot_id: bidLotFilter || null }));
      else if (view === "bidders") drawBidders(state, await call({ action: "bidders" }));
      else if (view === "closeout") drawCloseout(state, await call({ action: "closeout" }));
      else if (view === "audit") drawAudit(await call({ action: "audit" }));
      ctx.status("");
    } catch (e) { ctx.status(e.message || "Unable to load auction data.", "error"); }
  }

  // ---------- Lots & window ----------
  function drawLots(state) {
    const s = state.settings || {}; const c = state.counts || {}; const perm = state.permissions || {};
    const grid = el("div", "summary");
    [["Auction", s.bidding_enabled ? (new Date(s.closes_at) <= new Date(state.server_now) ? "Closed" : new Date(s.opens_at) > new Date(state.server_now) ? "Scheduled" : "Open") : "Off"],
     ["Registered bidders", c.bidders], ["Bidders with card", c.bidders_with_card], ["Accepted bids", c.bids], ["Current high bids", money(c.raised_high_cents)], ["Charged", money(c.paid_cents)]]
      .forEach(([k, v]) => { const m = el("article", "metric"); m.append(el("span", "", k), el("strong", "", v ?? 0)); grid.append(m); });
    body.append(el("h2", "band-title", "Bidding window"), grid);

    const win = el("div", "detail-section");
    win.append(el("p", "fineprint", `Opens ${when(s.opens_at)} · Closes ${when(s.closes_at)} · Bidding switch: ${s.bidding_enabled ? "ON" : "OFF"} · Soft close: a bid in the final ${Math.round((s.soft_close_window_seconds || 0) / 60)} min extends that lot by ${Math.round((s.soft_close_extension_seconds || 0) / 60)} min.`));
    if (perm.manage) {
      const row = el("div", "table-controls"); row.style.justifyContent = "flex-start";
      const w = (action, extra = {}) => call({ action: "window", window_action: action, ...extra });
      row.append(
        btn("Open bidding now", "button dark compact", (e) => { if (confirm("Open bidding now? Published lots become biddable immediately.")) act(e.currentTarget, () => w("open_now"), "Bidding is open."); }),
        btn("Pause", "button outline compact", (e) => act(e.currentTarget, () => w("pause"), "Bidding paused. Bids are refused until you resume.")),
        btn("Resume", "button outline compact", (e) => act(e.currentTarget, () => w("resume"), "Bidding resumed.")),
        btn("Close all lots now", "button outline compact", (e) => { if (confirm("Close bidding on every lot now? This locks lots and emails provisional winners. It cannot be undone.")) act(e.currentTarget, () => w("close_now"), (r) => `Closed ${r.lots_closed} lot(s).`); }),
      );
      const ext = el("form", "table-controls"); ext.style.justifyContent = "flex-start";
      const mins = el("input"); mins.type = "number"; mins.min = "1"; mins.max = "1440"; mins.value = "15"; mins.style.width = "90px"; mins.setAttribute("aria-label", "Minutes to extend");
      const extBtn = el("button", "button outline compact", "Extend close by minutes"); extBtn.type = "submit";
      ext.append(mins, extBtn); ext.addEventListener("submit", (e) => { e.preventDefault(); act(extBtn, () => w("extend", { minutes: Number(mins.value) }), "Close time extended."); });
      const times = el("form", "table-controls"); times.style.justifyContent = "flex-start";
      const o = el("input"); o.type = "datetime-local"; o.value = localInput(s.opens_at); o.setAttribute("aria-label", "Opens (your local time)");
      const cl = el("input"); cl.type = "datetime-local"; cl.value = localInput(s.closes_at); cl.setAttribute("aria-label", "Closes (your local time)");
      const tBtn = el("button", "button outline compact", "Save open/close times"); tBtn.type = "submit";
      times.append(el("span", "fineprint", "Open"), o, el("span", "fineprint", "Close"), cl, tBtn);
      times.addEventListener("submit", (e) => { e.preventDefault(); act(tBtn, () => w("set_times", { opens_at: isoFromLocal(o.value), closes_at: isoFromLocal(cl.value) }), "Times saved."); });
      win.append(row, ext, times, el("p", "fineprint", "Times are entered in this computer's local time zone and shown above in Eastern Time."));
    }
    body.append(win);

    body.append(el("h2", "band-title", "Lots"));
    if (perm.manage) body.append(btn("New lot", "button dark compact", () => editLot(null)));
    const rows = (state.lots || []).map((l) => {
      const actions = el("div", "table-controls"); actions.style.justifyContent = "flex-start";
      const preview = el("a", "quiet compact", "View"); preview.href = `../auction/lot.html?lot=${encodeURIComponent(l.slug)}`; preview.target = "_blank"; preview.rel = "noopener"; actions.append(preview);
      if (perm.manage && l.status !== "closed") actions.append(btn("Edit", "quiet compact", () => editLot(l)));
      if (perm.manage && (l.status === "draft" || l.status === "withdrawn")) actions.append(btn("Publish", "button dark compact", (e) => {
        if (!l.donor_confirmed) { ctx.status("Confirm with the donor first: tick “Donor confirmed” in Edit, then publish.", "error"); return; }
        if (confirm(`Publish “${l.title}”? It becomes visible on the public auction page.`)) act(e.currentTarget, () => call({ action: "set_lot_status", lot_id: l.id, status: "published" }), "Lot published.");
      }));
      if (perm.manage && l.status === "published") {
        actions.append(btn(l.bid_count > 0 ? "Withdraw" : "Unpublish", "quiet compact", (e) => { if (confirm(l.bid_count > 0 ? "This lot has bids. Withdraw it (bids kept, no winner)?" : "Unpublish this lot?")) act(e.currentTarget, () => call({ action: "set_lot_status", lot_id: l.id, status: "draft" }), (r) => `Lot is now ${r.status}.`); }));
        actions.append(btn("Close lot", "quiet compact", (e) => { if (confirm(`Close bidding on “${l.title}” now?`)) act(e.currentTarget, () => call({ action: "close_lot", lot_id: l.id }), "Lot closed."); }));
      }
      const st = el("div"); st.append(chip(l.status)); if (l.status !== "draft") st.append(el("small", "", ` ${l.public?.state || ""}`));
      return [el("strong", "", l.title), st, l.donor_confirmed ? "Yes" : "No", money(l.fair_market_value_cents), money(l.opening_bid_cents), money(l.min_increment_cents), money(l.current_high_cents), l.bid_count, when(l.effective_closes_at), actions];
    });
    body.append(table(["Lot", "Status", "Donor confirmed", "Value", "Opening", "Increment", "High bid", "Bids", "Closes", "Actions"], rows));
    body.append(el("p", "fineprint", "A lot can be published only after the donor has confirmed it and its value, opening bid and increment are set. Opening bid and increment are locked once bidding starts."));
  }

  function editLot(lot) {
    const dlg = el("dialog"); dlg.setAttribute("aria-label", lot ? "Edit lot" : "New lot"); dlg.style.width = "min(760px, calc(100% - 30px))";
    const close = btn("×", "close", () => dlg.close()); close.setAttribute("aria-label", "Close");
    const form = el("form", "attendee-edit"); form.noValidate = true;
    const f = (label, name, value, opts = {}) => { const l = el("label", "", label); const c = opts.multiline ? el("textarea") : el("input"); c.name = name; c.value = value ?? ""; if (!opts.multiline) c.type = opts.type || "text"; if (opts.rows) c.rows = opts.rows; l.append(c); return l; };
    const d = (c) => (c === null || c === undefined ? "" : String(c / 100));
    const confirmed = el("label", "", ""); const cb = el("input"); cb.type = "checkbox"; cb.name = "donor_confirmed"; cb.checked = !!lot?.donor_confirmed; confirmed.append(cb, document.createTextNode(" Donor confirmed this lot, its description and values"));
    const vl = el("label", "", "Value label"); const sel = el("select"); sel.name = "value_label"; ["Market value", "Retail value", "Estimated value"].forEach((v) => { const o = el("option", "", v); o.value = v; if ((lot?.value_label || "Market value") === v) o.selected = true; sel.append(o); }); vl.append(sel);
    const grid = el("div", "edit-grid");
    grid.append(f("Title", "title", lot?.title), f("Slug (URL)", "slug", lot?.slug), f("Category", "category", lot?.category), f("Donor", "donor_name", lot?.donor_name),
      f("Value (USD)", "fmv", d(lot?.fair_market_value_cents)), vl, f("Opening bid (USD)", "open", d(lot?.opening_bid_cents)), f("Increment (USD)", "inc", d(lot?.min_increment_cents)),
      f("Maximum bid (USD, optional; default 10× value)", "max", d(lot?.max_bid_cents)), f("Sort order", "sort_order", lot?.sort_order ?? 100, { type: "number" }));
    const summary = f("Summary", "summary", lot?.summary, { multiline: true, rows: 3 });
    const content = f("Page content (JSON: title_html, sub_html, facts, photos, prose, detail_groups, hosts…)", "content", JSON.stringify(lot?.content || {}, null, 2), { multiline: true, rows: 12 });
    content.querySelector("textarea").style.fontFamily = "ui-monospace, Menlo, monospace"; content.querySelector("textarea").style.fontSize = "12px";
    const msg = el("p", "notice"); msg.setAttribute("role", "status");
    const actions = el("div", "dialog-actions"); const cancel = btn("Cancel", "button outline", () => dlg.close()); const save = el("button", "button dark", "Save lot"); save.type = "submit"; actions.append(cancel, save);
    form.append(grid, summary, confirmed, content, msg, actions);
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); const v = (n) => form.elements[n].value;
      let payload;
      try {
        payload = { title: v("title").trim(), slug: v("slug").trim(), category: v("category"), donor_name: v("donor_name"), summary: v("summary"), value_label: v("value_label"),
          donor_confirmed: cb.checked, sort_order: Number(v("sort_order")) || 100, fair_market_value_cents: dollarsToCents(v("fmv")),
          opening_bid_cents: dollarsToCents(v("open")), min_increment_cents: dollarsToCents(v("inc")), max_bid_cents: dollarsToCents(v("max")), content: JSON.parse(v("content") || "{}") };
        if (lot) { payload.id = lot.id; if (lot.bid_count > 0) { delete payload.opening_bid_cents; delete payload.min_increment_cents; } }
      } catch (err) { msg.textContent = err instanceof SyntaxError ? "Page content is not valid JSON." : err.message; msg.className = "notice error"; return; }
      save.disabled = true; msg.textContent = "Saving…"; msg.className = "notice";
      try { await call({ action: "save_lot", lot: payload }); dlg.close(); ctx.status("Lot saved.", "success"); await draw(); }
      catch (err) { msg.textContent = err.message; msg.className = "notice error"; }
      finally { save.disabled = false; }
    });
    dlg.append(close, el("p", "eyebrow", lot ? "Edit lot" : "New lot"), el("h2", "", lot ? lot.title : "New lot"), form);
    dlg.addEventListener("close", () => dlg.remove()); document.body.append(dlg); dlg.showModal();
  }

  // ---------- Bid log ----------
  function drawBids(state, bids) {
    const bar = el("div", "toolbar"); const sel = el("select"); sel.setAttribute("aria-label", "Filter by lot"); sel.style.maxWidth = "420px";
    const all = el("option", "", "All lots"); all.value = ""; sel.append(all);
    (state.lots || []).forEach((l) => { const o = el("option", "", l.title); o.value = l.id; if (l.id === bidLotFilter) o.selected = true; sel.append(o); });
    sel.addEventListener("change", () => { bidLotFilter = sel.value; draw(); });
    bar.append(sel); if (state.permissions?.pii) bar.append(btn("Download bids CSV", "button outline", (e) => download("bids", e.currentTarget)));
    body.append(bar);
    if (!bids.length) { body.append(el("p", "empty", "No bids yet.")); return; }
    body.append(table(["Lot", "Amount", "Bidder #", "Name", "Email", "Placed", "Status", "Notes"], bids.map((b) => [b.lot_title, money(b.amount_cents), `#${b.bidder_number}`, b.bidder_name, b.bidder_email, when(b.placed_at), chip(b.status),
      [b.is_winner ? "Winner" : b.is_current_high ? "Current high" : "", b.extended_close ? `Extended close to ${when(b.extended_close)}` : ""].filter(Boolean).join(" · ")])));
    if (!state.permissions?.pii) body.append(el("p", "fineprint", "Bidder names and emails are hidden for your role."));
  }

  // ---------- Bidders ----------
  function drawBidders(state, bidders) {
    if (state.permissions?.pii) { const bar = el("div", "toolbar"); bar.append(btn("Download bidders CSV", "button outline", (e) => download("bidders", e.currentTarget))); body.append(bar); }
    if (!bidders.length) { body.append(el("p", "empty", "No bidders have registered yet.")); return; }
    body.append(table(["Bidder #", "Name", "Email", "Phone", "Card", "Terms accepted", "Bids", "Leading", "Status"], bidders.map((b) => [`#${b.bidder_number}`, b.full_name, b.email, b.phone, b.card || "No card", when(b.terms_accepted_at), b.bids, b.leading, chip(b.status)])));
  }

  // ---------- Close-out & payment ----------
  function drawCloseout(state, lots) {
    const perm = state.permissions || {};
    const bar = el("div", "toolbar");
    bar.append(btn("Close lots whose time has passed", "button outline", (e) => act(e.currentTarget, () => call({ action: "close_due" }), (r) => `Closed ${r.lots_closed} lot(s).`)));
    if (perm.pii) bar.append(btn("Download winners CSV", "button outline", (e) => download("winners", e.currentTarget)));
    body.append(bar);
    body.append(el("p", "fineprint", "Provisional winners. Nothing is charged automatically. “Approve & charge” makes one off-session charge to the winner’s saved card for the winning amount. If it fails you can retry, or offer the lot to the next-highest bidder (who is emailed and must then be charged the same way)."));
    if (!lots.length) { body.append(el("p", "empty", "No lots have closed yet.")); return; }
    lots.forEach((l) => {
      const card = el("article", "detail-section"); card.style.borderTop = "1px solid #090909"; card.style.padding = "18px 0";
      const head = el("div", "table-heading"); head.style.padding = "0"; const h = el("h3", "", l.title); const st = el("div"); st.append(chip(l.closeout_status)); head.append(h, st); card.append(head);
      const w = l.winning_bid;
      card.append(el("p", "", w ? `Winning bid ${money(w.amount_cents)} · bidder #${w.bidder_number}${w.name ? ` · ${w.name}` : ""}${w.email ? ` · ${w.email}` : ""} · card ${w.card} · ${l.bid_count} bid(s) · value ${money(l.fair_market_value_cents)}` : l.closeout_status === "no_bids" ? "Closed with no bids." : "No current winner."));
      if (l.next_candidate && ["pending_review", "failed", "offered_next"].includes(l.closeout_status)) card.append(el("p", "fineprint", `Next-highest eligible bidder: #${l.next_candidate.bidder_number} at ${money(l.next_candidate.amount_cents)}`));
      if (l.attempts?.length) card.append(table(["Attempt", "Bidder #", "Amount", "Result", "Stripe PaymentIntent", "Reason", "When"], l.attempts.map((a) => [`#${a.attempt}`, `#${a.bidder_number}`, money(a.amount_cents), chip(a.status), a.payment_intent, [a.failure_code, a.failure_message].filter(Boolean).join(": "), when(a.completed_at || a.created_at)])));
      const actions = el("div", "table-controls"); actions.style.justifyContent = "flex-start";
      const awaiting = ["pending_review", "failed", "offered_next"].includes(l.closeout_status);
      if (perm.charge && awaiting && w) {
        actions.append(btn(`${l.closeout_status === "failed" ? "Retry charge" : "Approve & charge"} ${money(w.amount_cents)}`, "button dark compact", (e) => {
          const lastNetwork = (l.attempts || []).some((a) => a.failure_code === "network_error");
          if (!confirm(`Charge ${money(w.amount_cents)} to bidder #${w.bidder_number}'s saved card (${w.card}) for “${l.title}”?${lastNetwork ? "\n\nA previous attempt had a network error. Check the Stripe dashboard first so the bidder is not charged twice." : ""}`)) return;
          act(e.currentTarget, () => call({ action: "charge", lot_id: l.lot_id }), (r) => r.result === "succeeded" ? `Charged ${money(r.amount_cents)}${r.test_mode ? " (Stripe test mode)" : ""}. Receipt email queued.` : `Charge ${r.result}: ${r.failure_message || r.failure_code || ""}`);
        }));
        if (l.next_candidate) actions.append(btn("Offer to next-highest bidder", "button outline compact", (e) => {
          if (confirm(`Decline bidder #${w.bidder_number}'s bid and offer “${l.title}” to bidder #${l.next_candidate.bidder_number} at ${money(l.next_candidate.amount_cents)}? They will be emailed.`)) act(e.currentTarget, () => call({ action: "offer_next", lot_id: l.lot_id }), (r) => r.result === "ok" ? `Offered to bidder #${r.bidder_number} at ${money(r.amount_cents)}.` : "No other eligible bidder; the lot is void.");
        }));
      }
      if (actions.childNodes.length) card.append(actions);
      body.append(card);
    });
  }

  // ---------- Audit ----------
  function drawAudit(rows) {
    if (!rows.length) { body.append(el("p", "empty", "No auction staff actions yet.")); return; }
    body.append(table(["When", "Staff", "Action", "Details"], rows.map((a) => [when(a.occurred_at), a.actor_email, String(a.action).replace(/^ssuite_auction_/, "").replaceAll("_", " "), JSON.stringify(a.metadata || {})])));
  }

  // First load: if the auction backend is not reachable (e.g. not yet deployed), throw so the
  // dashboard falls back to the original submissions list instead of an empty tab.
  await call({ action: "state" }).catch((e) => { host.replaceChildren(); throw e; });
  drawNav(); await draw();
}
