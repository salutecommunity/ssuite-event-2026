/* S.Suite silent auction — public pages (index + lot).
 * The server is the authority for every rule; this file only renders state and sends
 * requests. Lot content comes from the database; inline markup is limited to em/b/i/br
 * and is rebuilt node by node (never assigned as raw HTML). */
(function () {
  "use strict";
  var CFG = window.SSUITE_CONFIG || {};
  var AB = CFG.auctionBidding || {};
  var ENABLED = AB.enabled === true && typeof CFG.apiBase === "string";
  var API = ENABLED ? new URL(CFG.apiBase).origin + "/functions/v1/auction-bidding" : null;
  var SESSION_KEY = "ssuite-auction-session";
  var page = document.body.getAttribute("data-auction-page");
  var $ = function (id) { return document.getElementById(id); };
  var serverOffset = 0;
  var state = null; var me = null; var lotSlug = null; var pending = null;

  // ---------- helpers ----------
  function money(cents) { if (cents === null || cents === undefined) return "—"; var d = cents / 100; return "$" + d.toLocaleString("en-US", { minimumFractionDigits: d % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined && text !== null) n.textContent = text; return n; }
  function safeInline(target, html) {
    target.replaceChildren();
    var doc = new DOMParser().parseFromString("<div>" + String(html || "") + "</div>", "text/html");
    (function copy(from, to) {
      Array.prototype.forEach.call(from.childNodes, function (n) {
        if (n.nodeType === 3) { to.appendChild(document.createTextNode(n.textContent)); return; }
        if (n.nodeType !== 1) return;
        var tag = n.tagName.toLowerCase();
        if (tag === "br") { to.appendChild(document.createElement("br")); return; }
        if (tag === "em" || tag === "b" || tag === "i" || tag === "strong") { var c = document.createElement(tag === "strong" ? "b" : tag); copy(n, c); to.appendChild(c); return; }
        copy(n, to);
      });
    })(doc.body.firstChild, target);
    return target;
  }
  function inlineEl(tag, cls, html) { return safeInline(el(tag, cls), html); }
  function assetUrl(src) { var s = String(src || ""); return /^assets\/[A-Za-z0-9._-]+$/.test(s) ? "./" + s : (/^https:\/\//.test(s) ? s : ""); }
  function now() { return Date.now() + serverOffset; }
  function fmtDate(iso) { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) + " ET"; }
  function countdown(iso) {
    var ms = new Date(iso).getTime() - now(); if (ms <= 0) return "Closed";
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    if (d > 0) return d + "d " + h + "h " + m + "m";
    if (h > 0) return h + "h " + m + "m " + String(sec).padStart(2, "0") + "s";
    return m + "m " + String(sec).padStart(2, "0") + "s";
  }
  function uuid() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/-/g, "") + "a"; }
  function session() { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } }
  function setSession(v) { try { v ? localStorage.setItem(SESSION_KEY, v) : localStorage.removeItem(SESSION_KEY); } catch (e) {} }

  async function api(body, extraHeaders) {
    var headers = Object.assign({ "Content-Type": "application/json" }, extraHeaders || {});
    var s = session(); if (s) headers["x-auction-session"] = s;
    var res = await fetch(API, { method: "POST", mode: "cors", credentials: "omit", cache: "no-store", headers: headers, body: JSON.stringify(body) });
    var data = await res.json().catch(function () { return {}; });
    if (res.status === 401 && body.action !== "verify_code") { setSession(null); me = null; }
    return { status: res.status, data: data };
  }
  async function loadState() {
    var url = API + "?action=state" + (lotSlug ? "&lot=" + encodeURIComponent(lotSlug) : "");
    var res = await fetch(url, { mode: "cors", credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error("state");
    var data = await res.json();
    if (data.server_now) serverOffset = new Date(data.server_now).getTime() - Date.now();
    state = data; return data;
  }
  async function loadMe() {
    if (!session()) { me = null; return null; }
    var r = await api({ action: "me" });
    me = r.status === 200 && r.data.result === "ok" ? r.data : null; return me;
  }

  // ---------- shared chrome ----------
  function stateLabel(s) { return ({ open: "Bidding open", not_open: "Bidding opens soon", closed: "Bidding closed", unavailable: "Catalogue opens soon" })[s] || "—"; }

  // ---------- INDEX ----------
  function renderIndex() {
    var a = state.auction || {};
    $("st-state").textContent = stateLabel(a.state);
    $("st-opens").textContent = a.opens_at ? fmtDate(a.opens_at) : "To be announced";
    $("st-closes").textContent = a.closes_at ? fmtDate(a.closes_at) : "To be announced";
    $("st-count").textContent = String((state.lots || []).length);
    var host = $("lots"); host.replaceChildren();
    if (!state.lots || !state.lots.length) { $("lots-empty").hidden = false; host.hidden = true; return; }
    $("lots-empty").hidden = true; host.hidden = false;
    state.lots.forEach(function (lot) {
      var a2 = el("a", "lotcard"); a2.href = "./lot.html?lot=" + encodeURIComponent(lot.slug);
      var fig = el("figure"); var cover = lot.cover || {}; var src = assetUrl(cover.src);
      if (src) { var img = el("img"); img.src = src; img.alt = cover.alt || ""; img.loading = "lazy"; fig.appendChild(img); }
      var meta = el("div", "meta");
      meta.appendChild(el("p", "cat", lot.category || "Silent auction"));
      meta.appendChild(el("h2", null, lot.title));
      var nums = el("div", "nums");
      var cur = el("div", null, lot.current_high_cents ? "Current bid" : "Opening bid"); cur.appendChild(el("strong", null, money(lot.current_high_cents || lot.opening_bid_cents)));
      var val = el("div", null, lot.value_label || "Value"); val.appendChild(el("strong", null, money(lot.fair_market_value_cents)));
      var bids = el("div", null, "Bids"); bids.appendChild(el("strong", null, String(lot.bid_count || 0)));
      nums.append(cur, val, bids); meta.appendChild(nums);
      var cta = el("p", "cta", lot.state === "open" ? "Bid now · closes in " + countdown(lot.closes_at) + " →" : lot.state === "closed" ? "Bidding closed" : "View lot →");
      cta.dataset.closes = lot.closes_at; cta.dataset.state = lot.state;
      meta.appendChild(cta);
      a2.append(fig, meta); host.appendChild(a2);
    });
  }

  // ---------- LOT ----------
  var rendered = false;
  function renderLotStatic(lot) {
    var c = lot.content || {};
    document.title = lot.title + " | S.Suite Silent Auction";
    $("lot-eyebrow").textContent = c.eyebrow || "Silent Auction";
    safeInline($("lot-title"), c.title_html || lot.title);
    safeInline($("lot-sub"), c.sub_html || lot.summary || "");
    var facts = $("lot-facts"); facts.replaceChildren();
    var f1 = el("div"); f1.appendChild(el("span", null, "Opening bid")); f1.appendChild(document.createTextNode(money(lot.opening_bid_cents)));
    var f2 = el("div"); f2.appendChild(el("span", null, lot.value_label || "Market value")); f2.appendChild(document.createTextNode(money(lot.fair_market_value_cents)));
    facts.append(f1, f2);
    (c.facts || []).forEach(function (f) { var d = el("div"); d.appendChild(el("span", null, f.label)); d.appendChild(document.createTextNode(f.value)); facts.appendChild(d); });
    var g = $("lot-gallery"); g.replaceChildren();
    (c.photos || []).forEach(function (p, i) {
      var fig = el("figure", "g" + (i + 1)); var img = el("img"); img.src = assetUrl(p.src); img.alt = p.alt || ""; fig.appendChild(img);
      if (p.caption) fig.appendChild(inlineEl("figcaption", null, p.caption)); g.appendChild(fig);
    });
    $("lot-intro-eyebrow").textContent = c.intro_eyebrow || "The experience";
    var prose = $("lot-prose"); prose.replaceChildren();
    (c.prose || []).forEach(function (b) { prose.appendChild(inlineEl("p", b.type === "lead" ? "lead" : null, b.html)); });
    var dg = $("lot-details"); dg.replaceChildren();
    (c.detail_groups || []).forEach(function (grp) {
      var lab = el("div", "label"); lab.appendChild(el("p", "eyebrow", grp.label)); dg.appendChild(lab);
      var dl = el("dl", "details");
      (grp.items || []).forEach(function (it) { var row = el("div"); row.appendChild(el("dt", null, it.label)); row.appendChild(inlineEl("dd", null, it.html)); dl.appendChild(row); });
      dg.appendChild(dl);
    });
    var hosts = c.hosts;
    if (hosts && hosts.people && hosts.people.length) {
      $("lot-hosts").hidden = false;
      $("hosts-eyebrow").textContent = hosts.eyebrow || "Your hosts";
      safeInline($("hosts-heading"), hosts.heading || "");
      var bios = $("lot-bios"); bios.replaceChildren();
      hosts.people.forEach(function (p) {
        var art = el("article", "person"); if (p.anchor && /^[a-z0-9-]+$/.test(p.anchor)) art.id = p.anchor;
        var wrap = el("div");
        if (p.portrait && assetUrl(p.portrait.src)) { var fig = el("figure", "portrait"); var im = el("img"); im.src = assetUrl(p.portrait.src); im.alt = p.portrait.alt || ""; fig.appendChild(im); if (p.portrait.caption) fig.appendChild(inlineEl("figcaption", null, p.portrait.caption)); wrap.appendChild(fig); }
        wrap.appendChild(el("p", "role", p.role || ""));
        wrap.appendChild(inlineEl("h3", null, p.name || ""));
        (p.blocks || []).forEach(function (b) {
          if (b.type === "chips") { var ch = el("div", "chips"); (b.items || []).forEach(function (t) { ch.appendChild(el("span", null, t)); }); wrap.appendChild(ch); }
          else if (b.type === "chips_label") wrap.appendChild(inlineEl("p", "chips-label", b.html));
          else if (b.type === "quote") wrap.appendChild(inlineEl("p", "quote", b.html));
          else if (b.type === "details") { var dl2 = el("dl", "details"); (b.items || []).forEach(function (it) { var r2 = el("div"); r2.appendChild(el("dt", null, it.label)); r2.appendChild(inlineEl("dd", null, it.html)); dl2.appendChild(r2); }); wrap.appendChild(dl2); }
          else wrap.appendChild(inlineEl("p", null, b.html));
        });
        art.appendChild(wrap); bios.appendChild(art);
      });
    }
    var wide = $("lot-wide"); wide.replaceChildren();
    (c.wide || []).forEach(function (w) { var fig = el("figure", "wide"); var im = el("img"); im.src = assetUrl(w.src); im.alt = w.alt || ""; fig.appendChild(im); if (w.caption) fig.appendChild(inlineEl("figcaption", null, w.caption)); wide.appendChild(fig); });
    var fine = $("lot-fine"); safeInline(fine, c.fine_html || "");
    if (c.credits_html) fine.appendChild(inlineEl("span", "credits", c.credits_html));
    fine.hidden = !(c.fine_html || c.credits_html);
    if (c.value_notes) $("value-note").textContent = c.value_notes;
  }

  function myLot() { return me && me.lots ? me.lots.filter(function (l) { return l.slug === lotSlug; })[0] : null; }
  function renderBidbox() {
    var lot = state.lots && state.lots[0]; if (!lot) return;
    var hasBids = !!lot.current_high_cents;
    $("bb-top-label").textContent = lot.state === "closed" ? (hasBids ? "Winning bid (pending staff confirmation)" : "Bidding closed") : hasBids ? "Current bid" : "Opening bid";
    $("bb-top").textContent = money(hasBids ? lot.current_high_cents : lot.opening_bid_cents);
    $("bb-top-meta").textContent = hasBids ? (lot.bid_count + (lot.bid_count === 1 ? " bid" : " bids") + (lot.high_bidder_number ? " · leading: bidder #" + lot.high_bidder_number : "")) : "No bids yet";
    $("bb-next").textContent = lot.next_minimum_cents ? money(lot.next_minimum_cents) : "—";
    $("bb-value-label").textContent = lot.value_label || "Market value";
    $("bb-value").textContent = money(lot.fair_market_value_cents);
    $("bb-inc").textContent = money(lot.min_increment_cents);
    $("bb-closes-label").textContent = lot.state === "not_open" ? "Opens" : lot.state === "closed" ? "Closed" : "Closes in";
    $("bb-closes").dataset.closes = lot.closes_at; $("bb-closes").dataset.state = lot.state;
    $("bb-closes").dataset.opens = state.auction && state.auction.opens_at || "";
    tick();
    var status = $("bb-status"); var mine = myLot();
    status.className = "bidstatus"; status.hidden = false;
    if (lot.state === "closed") { status.classList.add("closed"); status.textContent = mine && mine.is_high ? "Bidding has closed and you hold the winning bid. S.Suite staff will confirm and then charge your saved card; you will receive an email." : "Bidding on this lot has closed."; }
    else if (mine && mine.is_high) { status.classList.add("lead"); status.textContent = "You are the high bidder at " + money(mine.my_high_cents) + "."; }
    else if (mine) { status.classList.add("outbid"); status.textContent = "You have been outbid. Your last bid was " + money(mine.my_high_cents) + "."; }
    else if (lot.extended) { status.textContent = "Bidding was extended by a late bid (soft close)."; }
    else status.hidden = true;
    var open = lot.state === "open";
    $("bid-form").hidden = !open;
    $("bb-cta").hidden = open;
    $("bb-cta").textContent = lot.state === "not_open" ? "Bidding opens " + (state.auction && state.auction.opens_at ? fmtDate(state.auction.opens_at) : "soon") : "Bidding closed";
    var input = $("bid-amount");
    if (open && lot.next_minimum_cents) {
      input.min = String(lot.next_minimum_cents / 100); input.step = "1";
      if (!input.dataset.touched || Number(input.value) * 100 < lot.next_minimum_cents) { input.value = String(lot.next_minimum_cents / 100); input.dataset.touched = ""; }
      var q = $("quick"); q.replaceChildren();
      [0, 1, 2].forEach(function (k) {
        var amt = lot.next_minimum_cents + k * lot.min_increment_cents;
        var b = el("button", null, money(amt)); b.type = "button"; b.addEventListener("click", function () { input.value = String(amt / 100); input.dataset.touched = "1"; input.focus(); }); q.appendChild(b);
      });
    }
    var who = $("whoami");
    if (me && me.bidder) { who.hidden = false; $("who-text").textContent = "Signed in as bidder #" + me.bidder.bidder_number + (me.bidder.card ? " · card •••• " + me.bidder.card.last4 : " · no card saved yet"); }
    else who.hidden = true;
  }

  function tick() {
    document.querySelectorAll("[data-closes]").forEach(function (n) {
      var st = n.dataset.state;
      if (n.id === "bb-closes") { n.textContent = st === "not_open" ? (n.dataset.opens ? fmtDate(n.dataset.opens) : "Soon") : st === "closed" ? fmtDate(n.dataset.closes) : countdown(n.dataset.closes); return; }
      if (st === "open") n.textContent = "Bid now · closes in " + countdown(n.dataset.closes) + " →";
    });
    var lot = state && state.lots && state.lots[0];
    if (page === "lot" && lot && lot.state === "open" && new Date(lot.closes_at).getTime() <= now()) refresh();
  }

  function msg(text, kind) { var n = $("bid-msg"); n.textContent = text || ""; n.className = "formmsg" + (kind ? " " + kind : ""); }

  // ---------- bidder dialog ----------
  var tsWidgetId = null; var tsToken = null;
  function turnstile(slotId, cb) {
    tsToken = null;
    var slot = $(slotId); slot.replaceChildren();
    if (!CFG.turnstileSiteKey) { slot.textContent = "Security check unavailable."; return; }
    function render() {
      tsWidgetId = window.turnstile.render(slot, { sitekey: CFG.turnstileSiteKey, action: AB.turnstileAction || "auction-bidding", callback: function (t) { tsToken = t; cb && cb(); }, "expired-callback": function () { tsToken = null; } });
    }
    if (window.turnstile) render();
    else {
      var s = document.createElement("script"); s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; s.async = true; s.onload = render; document.head.appendChild(s);
    }
  }
  var dlg; var dEmail = "";
  function steps(n) { var s = $("dlg-steps"); s.replaceChildren(); for (var i = 1; i <= 4; i++) s.appendChild(el("i", i <= n ? "on" : null)); }
  function dmsg(text, kind) { var n = $("dlg-msg"); n.textContent = text || ""; n.className = "formmsg" + (kind ? " " + kind : ""); }
  function view(name) { ["v-email", "v-code", "v-profile", "v-card"].forEach(function (v) { $(v).hidden = v !== name; }); dmsg(""); }
  function openDialog() {
    dlg = $("bidder-dialog");
    if (!me) { view("v-email"); steps(1); turnstile("ts-email"); }
    else if (me.bidder.needs_profile) { view("v-profile"); steps(3); $("p-name").value = me.bidder.full_name || ""; $("p-phone").value = me.bidder.phone || ""; }
    else if (me.bidder.needs_card) { view("v-card"); steps(4); turnstile("ts-card"); }
    else return false;
    if (!dlg.open) dlg.showModal();
    return true;
  }
  function wireDialog() {
    $("dlg-close").addEventListener("click", function () { $("bidder-dialog").close(); });
    $("f-email").addEventListener("submit", async function (e) {
      e.preventDefault(); dEmail = $("e-email").value.trim();
      if (!tsToken) return dmsg("Please wait for the security check to finish.", "error");
      var btn = e.submitter || $("f-email").querySelector("button"); btn.disabled = true; dmsg("Sending your code…");
      try {
        var r = await api({ action: "request_code", email: dEmail, turnstile_token: tsToken });
        if (r.status === 202) { view("v-code"); steps(2); $("code-to").textContent = dEmail; $("c-code").focus(); }
        else { dmsg(r.data.error || "We could not send a code.", "error"); turnstile("ts-email"); }
      } finally { btn.disabled = false; }
    });
    $("c-back").addEventListener("click", function () { view("v-email"); steps(1); turnstile("ts-email"); });
    $("f-code").addEventListener("submit", async function (e) {
      e.preventDefault(); var btn = $("f-code").querySelector("button[type=submit]"); btn.disabled = true; dmsg("Checking…");
      try {
        var r = await api({ action: "verify_code", email: dEmail, code: $("c-code").value });
        if (r.status === 200 && r.data.session) { setSession(r.data.session); await loadMe(); renderBidbox(); if (!openDialog()) { $("bidder-dialog").close(); continueBid(); } }
        else dmsg(r.data.error || "That code did not work.", "error");
      } finally { btn.disabled = false; }
    });
    $("f-profile").addEventListener("submit", async function (e) {
      e.preventDefault(); var btn = $("f-profile").querySelector("button[type=submit]"); btn.disabled = true; dmsg("Saving…");
      try {
        var r = await api({ action: "profile", full_name: $("p-name").value, phone: $("p-phone").value, accept_terms: $("p-terms").checked, terms_version: state.auction && state.auction.terms_version });
        if (r.status === 200) { await loadMe(); renderBidbox(); if (!openDialog()) { $("bidder-dialog").close(); continueBid(); } }
        else dmsg(r.data.error || "Please check your details.", "error");
      } finally { btn.disabled = false; }
    });
    $("f-card").addEventListener("submit", async function (e) {
      e.preventDefault();
      if (!tsToken) return dmsg("Please wait for the security check to finish.", "error");
      var btn = $("f-card").querySelector("button[type=submit]"); btn.disabled = true; dmsg("Opening secure Stripe page…");
      try {
        try { if (pending) sessionStorage.setItem("ssuite-auction-pending-bid", JSON.stringify({ lot: lotSlug, amount: pending.amount })); } catch (x) {}
        var r = await api({ action: "card_start", lot: lotSlug, turnstile_token: tsToken });
        if (r.status === 200 && /^https:\/\/checkout\.stripe\.com\//.test(r.data.url)) { location.assign(r.data.url); return; }
        dmsg(r.data.error || "Card setup is unavailable right now.", "error"); turnstile("ts-card");
      } finally { btn.disabled = false; }
    });
    $("sign-out").addEventListener("click", async function () { await api({ action: "sign_out" }).catch(function () {}); setSession(null); me = null; renderBidbox(); msg("Signed out.", "ok"); });
  }

  // ---------- bidding ----------
  function continueBid() { if (pending) submitBid(pending.amount, false, pending.key); }
  async function submitBid(amountCents, confirmed, key) {
    var lot = state.lots[0];
    pending = { amount: amountCents, key: key || uuid() };
    if (!me) { await loadMe(); }
    if (!me || me.bidder.needs_profile || me.bidder.needs_card) { openDialog(); return; }
    var btn = $("bid-button"); btn.disabled = true; msg("Placing your bid…");
    try {
      var r = await api({ action: "bid", lot: lot.slug, amount_cents: amountCents, confirmed: !!confirmed }, { "Idempotency-Key": pending.key });
      var d = r.data || {};
      if (d.lot) { state.lots[0] = Object.assign({}, state.lots[0], d.lot); }
      switch (d.result) {
        case "accepted": msg("Bid placed: " + money(d.amount_cents) + ". You are the high bidder." + (d.extended ? " The close was extended by 2 minutes." : ""), "ok"); pending = null; $("bid-amount").dataset.touched = ""; await loadMe(); break;
        case "confirm_required":
          if (window.confirm("Please confirm your bid of " + money(d.amount_cents) + ". This is well above the next minimum of " + money(d.next_minimum_cents) + ". Bids are binding.")) { btn.disabled = false; return submitBid(amountCents, true, pending.key); }
          msg("Bid not placed.", ""); pending = null; break;
        case "below_minimum": msg("Someone bid first. The minimum is now " + money(d.next_minimum_cents) + ".", "error"); pending = null; $("bid-amount").dataset.touched = ""; break;
        case "above_maximum": msg("That is above the maximum bid for this lot (" + money(d.max_bid_cents) + "). Please check the amount, or contact ssuite@salute.community.", "error"); pending = null; break;
        case "already_high": msg("You are already the high bidder on this lot.", "ok"); pending = null; break;
        case "invalid_amount": msg("Please enter a whole-dollar amount.", "error"); pending = null; break;
        case "closed": msg("Bidding on this lot has closed.", "error"); pending = null; break;
        case "not_open": msg("Bidding has not opened yet.", "error"); pending = null; break;
        case "profile_required": case "card_required": await loadMe(); openDialog(); break;
        case "rate_limited": msg("Too many bids in a short time. Please wait a moment.", "error"); break;
        default: if (r.status === 401) { me = null; openDialog(); } else { msg(d.error || "Your bid was not placed. Please try again.", "error"); pending = null; }
      }
    } catch (e) { msg("Connection problem — your bid may not have been placed. Refreshing…", "error"); }
    finally { btn.disabled = false; renderBidbox(); }
  }

  async function refresh() {
    try { await loadState(); } catch (e) { return; }
    if (page === "index") renderIndex();
    if (page === "lot") {
      var lot = state.lots && state.lots[0];
      if (!lot) { $("lot-missing").hidden = false; $("lot-root").hidden = true; return; }
      if (!rendered) { renderLotStatic(lot); rendered = true; $("lot-root").hidden = false; }
      var before = $("bb-top").textContent; renderBidbox();
      if (before && before !== $("bb-top").textContent) { $("bb-top").parentNode.classList.remove("pulse"); void $("bb-top").offsetWidth; $("bb-top").parentNode.classList.add("pulse"); }
    }
  }

  async function boot() {
    if (!ENABLED) { var off = $("auction-off"); if (off) off.hidden = false; return; }
    if (CFG.mode !== "live" && $("staging-flag")) $("staging-flag").hidden = false;
    if (page === "lot") {
      lotSlug = new URLSearchParams(location.search).get("lot");
      if (!lotSlug || !/^[a-z0-9-]{1,80}$/.test(lotSlug)) { $("lot-missing").hidden = false; return; }
      wireDialog();
      $("bid-form").addEventListener("submit", function (e) {
        e.preventDefault(); var v = $("bid-amount").value.trim().replace(/[$,\s]/g, "");
        if (!/^[0-9]{1,7}$/.test(v)) return msg("Please enter a whole-dollar amount, for example 450.", "error");
        submitBid(Number(v) * 100, false);
      });
      $("bid-amount").addEventListener("input", function () { this.dataset.touched = "1"; });
      await loadMe();
      // Returning from Stripe Checkout.
      var qs = new URLSearchParams(location.search);
      if (qs.get("card") === "done" && session()) {
        var r = await api({ action: "card_finish", checkout_session_id: qs.get("cs") });
        history.replaceState(null, "", "./lot.html?lot=" + encodeURIComponent(lotSlug));
        await loadMe();
        await refresh();
        if (r.status === 200) {
          msg("Card saved (" + (r.data.card && r.data.card.brand || "card") + " •••• " + (r.data.card && r.data.card.last4 || "") + "). You can bid now.", "ok");
          try { var p = JSON.parse(sessionStorage.getItem("ssuite-auction-pending-bid") || "null"); sessionStorage.removeItem("ssuite-auction-pending-bid"); if (p && p.lot === lotSlug && p.amount) { $("bid-amount").value = String(p.amount / 100); $("bid-amount").dataset.touched = "1"; } } catch (x) {}
        } else msg(r.data.error || "Your card was not saved.", "error");
      } else if (qs.get("card") === "cancel") { history.replaceState(null, "", "./lot.html?lot=" + encodeURIComponent(lotSlug)); msg("Card setup was cancelled. A saved card is required to bid.", "error"); }
    }
    await refresh();
    setInterval(tick, 1000);
    var every = page === "lot" ? 5000 : 15000;
    setInterval(function () { if (!document.hidden) refresh(); }, every);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) { loadMe().then(refresh); } });
  }
  boot();
})();
