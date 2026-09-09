/* Public checkout integration. Tokens are held only in the Turnstile widget and
 * request body; this file never writes them to storage, URLs, or analytics. */
(() => {
  "use strict";
  const cfg = window.SSUITE_CONFIG || {};
  const byId = (id) => document.getElementById(id);
  const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const tokenPattern = /^[0-9a-f]{64}$/i;

  function text(value) { return typeof value === "string" ? value.trim() : ""; }
  function validAbsoluteHttps(value) {
    try { const url = new URL(value); return url.protocol === "https:" ? url.toString() : ""; } catch { return ""; }
  }
  function apiBase() {
    const value = text(cfg.apiBase).replace(/\/$/, "");
    if (!value) return "";
    try {
      const url = new URL(value);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      return (url.protocol === "https:" || (url.protocol === "http:" && local)) && !url.username && !url.password ? url.origin : "";
    } catch { return ""; }
  }
  function policy() {
    const p = cfg.policy;
    if (!p || typeof p !== "object") return null;
    const result = {
      termsUrl: validAbsoluteHttps(p.termsUrl), privacyUrl: validAbsoluteHttps(p.privacyUrl),
      mediaReleaseUrl: validAbsoluteHttps(p.mediaReleaseUrl), termsVersion: text(p.termsVersion),
      privacyVersion: text(p.privacyVersion), mediaReleaseVersion: text(p.mediaReleaseVersion),
    };
    return Object.values(result).every(Boolean) ? result : null;
  }
  function liveReadiness() {
    if (cfg.mode !== "live") return { ok: false, reason: "This site is in preview mode. No registration or payment will be created." };
    if (!apiBase()) return { ok: false, reason: "Checkout is temporarily unavailable. Please try again shortly, or write to ssuite@salute.community." };
    if (!policy()) return { ok: false, reason: "Checkout is temporarily unavailable. Please try again shortly, or write to ssuite@salute.community." };
    if (!text(cfg.turnstileSiteKey)) return { ok: false, reason: "Checkout is temporarily unavailable. Please try again shortly, or write to ssuite@salute.community." };
    return { ok: true, reason: "" };
  }
  function endpoint(name) { return `${apiBase()}/functions/v1/${name}`; }
  function setStatus(message, kind = "") {
    const el = byId("live-checkout-status");
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
    el.dataset.kind = kind;
  }
  function policyLinks() {
    // The public agreement always points to the event-specific, same-origin legal pages.
    // Server configuration still supplies the versions recorded with a live registration.
    const pages = { terms: "./event-terms.html", privacy: "./event-privacy.html", media: "./media-release.html" };
    document.querySelectorAll("[data-policy-link]").forEach((link) => {
      const value = pages[link.dataset.policyLink];
      if (!value) return;
      link.href = value;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    });
  }
  function createMemberFields() {
    const selection = document.querySelector(".selection");
    if (!selection || byId("member-verification")) return;
    const section = document.createElement("section");
    section.id = "member-verification";
    section.className = "member-verification";
    section.hidden = true;
    section.innerHTML = `<p class="micro">SALUTE MEMBERSHIP</p><p>The member rate is open to current and former SALUTE members. Enter the access code from your SALUTE email to unlock it.</p><label class="field"><span>MEMBER ACCESS CODE</span><input id="member-code" type="text" required maxlength="64" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="Code from your SALUTE email"></label><p class="member-note">Don’t have your code? Email <a href="mailto:ssuite@salute.community">ssuite@salute.community</a> and we’ll send it to you.</p>`;
    selection.insertAdjacentElement("afterend", section);
  }
  function updateMemberFields(code) {
    createMemberFields();
    const section = byId("member-verification");
    if (!section) return;
    section.hidden = code !== "salute_member";
    section.querySelectorAll("input").forEach((input) => { input.disabled = section.hidden; });
  }
  function ticketCode() { return text(document.querySelector(".checkout-drawer")?.dataset.ticketCode); }

  /* Partner organization access code.
   *
   * The nonprofit partner rate is confidential. It has no tile, the public
   * pricing feed withholds it, and -- deliberately -- its figure appears nowhere
   * in this file. A valid code is the only thing that reveals the price, and the
   * number shown comes from the server's answer to that code. Writing it in here
   * would both put a discounted rate on the public record and go stale the
   * moment early-bird pricing rolls over.
   *
   * It rides on the Community path because that is where someone buying a single
   * seat starts. Nothing is claimed before the code is checked, and the rate the
   * page shows is the rate checkout bills.
   */
  const PARTNER_HOST_TIER = "community";
  let partnerRate = null;
  let linkedPartnerCode = "";

  function normalizeCode(value) { return String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase(); }
  function partnerActive() { return partnerRate !== null && ticketCode() === PARTNER_HOST_TIER; }
  function money(cents) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
  }
  function partnerStatus(message) {
    const el = byId("partner-code-status");
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
  }
  function createPartnerFields() {
    const selection = document.querySelector(".selection");
    if (!selection || byId("partner-verification")) return;
    const section = document.createElement("section");
    section.id = "partner-verification";
    section.className = "member-verification";
    section.hidden = true;
    // Community is the open, general-admission tier. An access-code field sitting
    // in its default view made buyers ask whether a code was required at all, so
    // the field is kept behind one quiet line and only the few people who hold a
    // partner code ever open it. Partner links carrying ?code= open it themselves.
    section.innerHTML = `<p class="member-note" id="partner-code-reveal-wrap"><button type="button" class="reveal-link" id="partner-code-reveal" aria-expanded="false" aria-controls="partner-code-fields">Have a code from a partner organization?</button></p><div id="partner-code-fields" hidden><p class="micro" id="partner-code-eyebrow">PARTNER ORGANIZATION</p><p id="partner-code-lede">Enter the code from your invitation and your rate is applied here, before you pay.</p><label class="field"><span id="partner-code-label">ACCESS CODE</span><input id="partner-code" type="text" maxlength="64" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="Code from the organization that invited you"></label><div class="member-note"><button type="button" class="button button-outline" id="partner-code-apply">Apply code</button></div><p class="member-note" id="partner-code-status" role="status" aria-live="polite" hidden></p></div>`;
    selection.insertAdjacentElement("afterend", section);
    byId("partner-code-apply").addEventListener("click", () => { applyPartnerCode().catch(() => {}); });
    byId("partner-code-reveal").addEventListener("click", () => { revealPartnerFields(); byId("partner-code").focus(); });
    const input = byId("partner-code");
    // An edited code must never leave a partner price on screen. The rate is
    // dropped the moment the field stops matching what the server approved.
    input.addEventListener("input", () => {
      if (partnerRate && normalizeCode(input.value) !== partnerRate.code) clearPartnerRate("Code removed. The Community rate applies.");
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      applyPartnerCode().catch(() => {});
    });
  }
  function revealPartnerFields() {
    const fields = byId("partner-code-fields");
    if (fields) fields.hidden = false;
    const reveal = byId("partner-code-reveal");
    if (!reveal) return;
    reveal.setAttribute("aria-expanded", "true");
    if (reveal.parentElement) reveal.parentElement.hidden = true;
  }
  /* Is the chosen tier sold by invitation?
   *
   * Read off the buy control, which live-pricing.js sets from the database. A
   * gated tier cannot be bought without a code, so the field stops being an
   * optional aside and becomes the first thing asked for; an open tier keeps
   * the quiet reveal, so a general-admission buyer is never made to wonder
   * whether they need a code. Neither state is hardcoded here.
   */
  function tierIsGated(code) {
    const button = document.querySelector(`.choose[data-ticket-code="${code}"]`);
    return Boolean(button) && button.dataset.accessCodeRequired === "true";
  }

  function setCodeMode(gated) {
    const revealWrap = byId("partner-code-reveal-wrap");
    const fields = byId("partner-code-fields");
    const eyebrow = byId("partner-code-eyebrow");
    const lede = byId("partner-code-lede");
    const label = byId("partner-code-label");
    const input = byId("partner-code");
    if (!fields) return;
    if (gated) {
      if (revealWrap) revealWrap.hidden = true;
      fields.hidden = false;
      // The field label carries the words; an eyebrow saying the same thing
      // directly above it read as repetition, so it is hidden here.
      if (eyebrow) eyebrow.hidden = true;
      if (lede) lede.textContent = "Your rate is applied here, before you pay. No code? Close this and choose Request an invitation.";
      if (label) label.textContent = "INVITATION CODE";
      if (input) input.placeholder = "Enter your code";
      return;
    }
    if (revealWrap) revealWrap.hidden = false;
    if (eyebrow) { eyebrow.hidden = false; eyebrow.textContent = "PARTNER ORGANIZATION"; }
    if (lede) lede.textContent = "Enter the code from your invitation and your rate is applied here, before you pay.";
    if (label) label.textContent = "ACCESS CODE";
    if (input) input.placeholder = "Code from the organization that invited you";
    const reveal = byId("partner-code-reveal");
    if (reveal && reveal.getAttribute("aria-expanded") !== "true") fields.hidden = true;
  }

  /* A gated tier with no verified code cannot proceed. Say so on the control
   * itself rather than letting someone fill in a whole form and be refused. */
  function syncGateState() {
    const code = ticketCode();
    const gated = tierIsGated(code);
    const form = document.querySelector(".checkout-drawer form");
    const submit = form ? form.querySelector('button[type="submit"]') : null;
    if (!submit) return;
    if (!gated) {
      if (submit.dataset.gateHeld === "true") {
        submit.disabled = false;
        submit.removeAttribute("aria-disabled");
        delete submit.dataset.gateHeld;
        if (submit.dataset.gateLabel) { submit.textContent = submit.dataset.gateLabel; delete submit.dataset.gateLabel; }
      }
      return;
    }
    const verified = partnerRate !== null;
    if (verified) {
      if (submit.dataset.gateHeld === "true") {
        submit.disabled = false;
        submit.removeAttribute("aria-disabled");
        delete submit.dataset.gateHeld;
        if (submit.dataset.gateLabel) { submit.textContent = submit.dataset.gateLabel; delete submit.dataset.gateLabel; }
      }
      return;
    }
    if (submit.dataset.gateHeld !== "true") submit.dataset.gateLabel = submit.textContent;
    submit.dataset.gateHeld = "true";
    submit.disabled = true;
    submit.setAttribute("aria-disabled", "true");
    submit.textContent = "Enter your invitation code to continue";
  }

  function updatePartnerFields(code) {
    createPartnerFields();
    const section = byId("partner-verification");
    if (!section) return;
    const applies = code === PARTNER_HOST_TIER;
    section.hidden = !applies;
    section.querySelectorAll("input").forEach((input) => { input.disabled = !applies; });
    if (applies) setCodeMode(tierIsGated(code));
    syncGateState();
  }
  /* How many seats this code may still take, in one place.
   *
   * The cap on a code counts seats, not orders, and the server enforces that.
   * So a code with room for two can buy both in one checkout, and the selector
   * offered here never exceeds what the code actually covers -- a buyer is
   * never shown a quantity that checkout would refuse. An unknown remaining
   * count means one seat.
   */
  function codeSeatLimit() {
    if (!partnerRate) return 1;
    const remaining = Number.isInteger(partnerRate.seatsRemaining) ? partnerRate.seatsRemaining : 1;
    // A shared organization code is one seat per checkout, so ten seats cannot
    // be taken by the first two people to open the link. A personal invitation
    // carries the seats it was issued for. The server enforces both.
    const perOrder = Number.isInteger(partnerRate.maxSeatsPerOrder) ? partnerRate.maxSeatsPerOrder : 1;
    return Math.max(1, Math.min(remaining, perOrder, 4));
  }
  function codeSeatsChosen() {
    const quantity = byId("ticket-quantity");
    if (!quantity) return 1;
    const wrap = quantity.closest(".quantity-wrap");
    if (wrap && wrap.hidden) return 1;
    const chosen = Number(quantity.value || 1);
    return Number.isInteger(chosen) && chosen >= 1 ? Math.min(chosen, codeSeatLimit()) : 1;
  }
  // The drawer's own total is computed from the tile price, which is not the
  // price a code carries. Recompute it whenever a coded rate is on screen.
  function applyCodedTotal() {
    if (!partnerRate) return;
    const total = byId("ticket-total");
    if (total) total.textContent = money(partnerRate.amountCents * codeSeatsChosen());
  }
  function applyPartnerDisplay() {
    if (!partnerRate) return;
    const limit = codeSeatLimit();
    const name = byId("ticket-name");
    if (name) name.textContent = partnerRate.name || "Nonprofit Partner Ticket";
    const quantity = byId("ticket-quantity");
    if (quantity) {
      // Offer exactly the seats the code still covers, no more.
      const previous = Number(quantity.value || 1);
      quantity.innerHTML = "";
      for (let seat = 1; seat <= limit; seat += 1) {
        const option = document.createElement("option");
        option.textContent = String(seat);
        quantity.append(option);
      }
      quantity.value = String(Math.min(Math.max(previous, 1), limit));
      const wrap = quantity.closest(".quantity-wrap");
      if (wrap) wrap.hidden = limit <= 1;
    }
    const chosen = codeSeatsChosen();
    const note = byId("selection-note");
    if (note) {
      const seatWord = chosen === 1 ? "one seat" : `${chosen} seats`;
      note.textContent = partnerRate.organization ? `${partnerRate.organization} · ${seatWord}` : `Invitation code · ${seatWord}`;
    }
    // Rebuild the attendee list only when the number of people has changed, so
    // applying a code cannot discard details somebody has already typed.
    if (document.querySelectorAll("#guest-fields .guest-card").length !== chosen && typeof window.renderGuests === "function") {
      window.renderGuests();
    }
    applyCodedTotal();
    const seats = Number.isInteger(partnerRate.seatsRemaining)
      ? ` ${partnerRate.seatsRemaining} ${partnerRate.seatsRemaining === 1 ? "seat remains" : "seats remain"} on this code.`
      : "";
    const who = partnerRate.organization ? `${partnerRate.organization} rate` : "Invitation";
    const covers = chosen === 1 ? "one seat" : `${chosen} seats`;
    partnerStatus(`${who} applied — ${money(partnerRate.amountCents)} per seat, ${covers}.${seats}`);
    syncGateState();
  }
  function clearPartnerRate(message) {
    partnerRate = null;
    const drawer = document.querySelector(".checkout-drawer");
    if (drawer) delete drawer.dataset.partnerCode;
    const quantity = byId("ticket-quantity");
    if (quantity) {
      // Restore the tile's own range: dropping a code must not leave the
      // narrower list the code allowed.
      const previous = Number(quantity.value || 1);
      quantity.innerHTML = "";
      for (let seat = 1; seat <= 4; seat += 1) {
        const option = document.createElement("option");
        option.textContent = String(seat);
        quantity.append(option);
      }
      quantity.value = String(Math.min(Math.max(previous, 1), 4));
    }
    const wrap = quantity ? quantity.closest(".quantity-wrap") : null;
    // On a gated tier there is no quantity to choose until a code says how many
    // seats it covers, so the selector stays out of the way until then.
    if (wrap) wrap.hidden = ticketCode() !== PARTNER_HOST_TIER || tierIsGated(ticketCode());
    const button = document.querySelector(`.choose[data-ticket-code="${PARTNER_HOST_TIER}"]`);
    const name = byId("ticket-name");
    if (name && button && ticketCode() === PARTNER_HOST_TIER) name.textContent = text(button.dataset.ticket) || "Community Ticket";
    const note = byId("selection-note");
    if (note && ticketCode() === PARTNER_HOST_TIER) note.textContent = "Ticket selection";
    if (typeof window.updateTotal === "function") window.updateTotal();
    partnerStatus(message || "");
    syncGateState();
  }
  async function applyPartnerCode() {
    const input = byId("partner-code");
    if (!input) return;
    const code = normalizeCode(input.value);
    if (!code) { clearPartnerRate("Enter the code from your invitation."); return; }
    const base = apiBase();
    if (!base) { partnerStatus("Codes cannot be checked right now. Please try again shortly, or write to ssuite@salute.community."); return; }
    const apply = byId("partner-code-apply");
    if (apply) apply.disabled = true;
    partnerStatus("Checking your code…");
    try {
      const response = await fetch(`${base}/functions/v1/event-pricing?code=${encodeURIComponent(code)}`, {
        method: "GET", mode: "cors", credentials: "omit", cache: "no-store",
      });
      const payload = response.ok ? await response.json().catch(() => null) : null;
      const state = payload && typeof payload === "object" ? payload.access_code : null;
      if (!state || typeof state !== "object") {
        partnerStatus("Your code could not be checked just now. Please try again shortly, or write to ssuite@salute.community.");
        return;
      }
      if (state.result === "ok" && Number.isInteger(state.amount_cents) && state.amount_cents > 0
          && typeof state.ticket_type_code === "string" && /^[a-z0-9_]{1,64}$/.test(state.ticket_type_code)) {
        partnerRate = {
          code, tier: state.ticket_type_code, organization: text(state.organization), name: text(state.name),
          amountCents: state.amount_cents,
          seatsRemaining: Number.isInteger(state.seats_remaining) ? state.seats_remaining : null,
          maxSeatsPerOrder: Number.isInteger(state.max_seats_per_order) ? state.max_seats_per_order : null,
        };
        const drawer = document.querySelector(".checkout-drawer");
        if (drawer) drawer.dataset.partnerCode = code;
        applyPartnerDisplay();
        return;
      }
      if (state.result === "exhausted") {
        const org = text(state.organization);
        clearPartnerRate(`Every seat on this code has been taken${org ? ` for ${org}` : ""}. Please write to ssuite@salute.community and we will sort it out.`);
        return;
      }
      if (state.result === "rate_limited") {
        clearPartnerRate("Too many code checks from this connection. Please wait a few minutes and try again.");
        return;
      }
      if (state.result === "unavailable") {
        clearPartnerRate("This rate cannot be applied right now. Please write to ssuite@salute.community.");
        return;
      }
      clearPartnerRate("That code is not recognized. Please check it against your invitation, or write to ssuite@salute.community. If it is your SALUTE member code, choose the SALUTE Member ticket instead.");
    } catch {
      partnerStatus("Your code could not be checked just now. Please try again shortly, or write to ssuite@salute.community.");
    } finally {
      if (apply) apply.disabled = false;
    }
  }
  function turnstileContainer() { return byId("checkout-turnstile"); }
  let turnstileWidget = null;
  let turnstileLoading = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (turnstileLoading) return turnstileLoading;
    turnstileLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true; script.defer = true;
      script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("The security check could not load. Please refresh the page and try again."));
      script.onerror = () => reject(new Error("The security check could not load. Please refresh the page and try again."));
      document.head.appendChild(script);
    });
    return turnstileLoading;
  }
  // Render the challenge without demanding a token yet. Warming and waiting are
  // kept separate so warming early can never surface an error to someone who has
  // not pressed anything.
  async function warmTurnstile() {
    const readiness = liveReadiness();
    if (!readiness.ok) throw new Error(readiness.reason);
    const container = turnstileContainer();
    if (!container) throw new Error("Checkout is temporarily unavailable. Please try again shortly.");
    const api = await loadTurnstile();
    if (turnstileWidget === null) {
      turnstileWidget = api.render(container, {
        sitekey: text(cfg.turnstileSiteKey),
        action: "ssuite_checkout",
        // Clear a stale "complete the check" notice as soon as it is actually complete.
        "callback": () => { const el = byId("live-checkout-status"); if (el && /security check/i.test(el.textContent)) setStatus("", ""); },
        "error-callback": () => setStatus("The security check failed. Please retry.", "error"),
        "expired-callback": () => setStatus("The security check expired. Please retry.", "error"),
      });
    }
    return api;
  }
  async function ensureTurnstile() {
    const api = await warmTurnstile();
    const deadline = Date.now() + 15000;
    for (;;) {
      const response = api.getResponse(turnstileWidget);
      if (response) return response;
      if (Date.now() >= deadline) throw new Error("The security check has not cleared yet. This is usually a browser extension or network blocking it. Please refresh and try again, or write to ssuite@salute.community and we will take it from there.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  function value(form, name) { return text(form.elements.namedItem(name)?.value); }
  function agreedToPolicies(form) {
    const box = form.elements.namedItem("combined_agreement");
    if (!box || box.checked !== true) throw new Error("Please accept the Event Terms & Conditions, Event Privacy Notice, and Media, Photo & Video Release to continue.");
    return true;
  }
  function attendee(form, index) {
    const dietaryFlag = Boolean(form.querySelector(`[data-detail="dietary-${index}"]`)?.checked);
    const accessibilityFlag = Boolean(form.querySelector(`[data-detail="accessibility-${index}"]`)?.checked);
    const primary = value(form, `guest-${index}-email`).toLowerCase();
    const secondary = value(form, `guest-${index}-secondary-email`).toLowerCase();
    if (!emailPattern.test(primary) || (secondary && (!emailPattern.test(secondary) || secondary === primary))) throw new Error("Please enter a valid email address for each attendee, and make sure each one is different.");
    const result = {
      first_name: value(form, `guest-${index}-first`), last_name: value(form, `guest-${index}-last`), email: primary,
      secondary_email: secondary || undefined, phone: value(form, `guest-${index}-phone`) || undefined,
      job_title: value(form, `guest-${index}-title`), company: value(form, `guest-${index}-company`),
      meal_preference: value(form, `guest-${index}-meal`), has_dietary_or_allergy_needs: dietaryFlag,
      dietary_or_allergy_details: dietaryFlag ? value(form, `guest-${index}-dietary`) : undefined,
      has_accessibility_needs: accessibilityFlag, accessibility_details: accessibilityFlag ? value(form, `guest-${index}-accessibility`) : undefined,
    };
    if (!result.first_name || !result.last_name || !result.job_title || !result.company || !result.meal_preference || (dietaryFlag && !result.dietary_or_allergy_details) || (accessibilityFlag && !result.accessibility_details)) throw new Error("Complete all required attendee details.");
    return result;
  }
  function requestBody(form) {
    const p = policy();
    if (!p) throw new Error("Checkout is temporarily unavailable. Please try again shortly, or write to ssuite@salute.community.");
    const code = ticketCode();
    // A verified partner code re-prices this order onto its own tier. One seat
    // per use, no guest seats: the cap counts uses, so a code that could carry
    // extra seats would seat more people than the organization was given.
    const partner = partnerActive() ? partnerRate : null;
    const table = code === "full_table";
    const member = code === "salute_member";
    // The member rate covers exactly one seat. Any guests a member brings are
    // billed at the open Community rate on the same payment.
    const guestSelect = byId("member-guest-quantity");
    const guestSeats = member && guestSelect && !guestSelect.disabled ? Number(guestSelect.value || 0) : 0;
    if (!Number.isInteger(guestSeats) || guestSeats < 0 || guestSeats > 4) throw new Error("Choose a valid number of guest seats.");
    // A gated tier cannot be bought without a verified code. The server refuses
    // it either way; stopping here means nobody fills in a form to be told no.
    if (tierIsGated(code) && !partner) {
      throw new Error("These seats are by invitation. Enter the code from your invitation to continue, or close this and choose Request an invitation.");
    }
    const count = partner ? codeSeatsChosen() : (table ? 1 : (member ? 1 + guestSeats : Number(byId("ticket-quantity")?.value)));
    if (!Number.isInteger(count) || count < 1 || count > (table ? 10 : (member ? 5 : 4))) throw new Error("Choose a valid number of attendees.");
    const attendees = Array.from({ length: count }, (_, i) => attendee(form, i));
    if (new Set(attendees.map((a) => a.email)).size !== attendees.length) throw new Error("Each attendee must have a unique primary email address.");
    const purchaser = attendees[0];
    const howHeard = value(form, "referral-source");
    if (!code || !howHeard) throw new Error("Complete the registration details before checkout.");
    const memberCode = String(byId("member-code")?.value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (code === "salute_member" && !memberCode) throw new Error("Enter your member access code to use the member rate. It is in your SALUTE email — or write to ssuite@salute.community and we will send it.");
    return {
      ticket_type_code: partner ? partner.tier : code,
      order_type: table ? "table" : "ticket",
      quantity: table || member ? 1 : count,
      guest_quantity: partner ? 0 : guestSeats,
      purchaser: { first_name: purchaser.first_name, last_name: purchaser.last_name, email: purchaser.email, phone: purchaser.phone || undefined },
      member_code: partner ? partner.code : (code === "salute_member" ? memberCode : undefined),
      member_attestation: false,
      how_heard: howHeard, attendees, combined_agreement: agreedToPolicies(form),
      terms_version: p.termsVersion, privacy_version: p.privacyVersion, media_release_version: p.mediaReleaseVersion,
      success_url: `${location.origin}/registration.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${location.origin}${location.pathname}?checkout=cancel`,
    };
  }
  /* Stripe's hosted checkout URL carries the session reference. Remember it for this
     tab before handing the buyer over, so that if they return without it in the address
     bar we can still show them their own record rather than a dead end. */
  const RECEIPT_STORE = "ssuite.order.receipt";
  function rememberPendingCheckout(destination) {
    const match = /cs_(?:live|test)_[A-Za-z0-9]{8,320}/.exec(String(destination.pathname || ""));
    if (!match) return;
    try { sessionStorage.setItem(RECEIPT_STORE, JSON.stringify({ session_id: match[0] })); } catch { /* storage unavailable */ }
  }
  function forgetPendingCheckout() {
    try { sessionStorage.removeItem(RECEIPT_STORE); } catch { /* storage unavailable */ }
  }

  async function submitCheckout(form) {
    const readiness = liveReadiness();
    if (!readiness.ok) { setStatus(readiness.reason, "error"); return; }
    const submit = form.querySelector('button[type="submit"]');
    try {
      submit.disabled = true;
      setStatus("Verifying your details and preparing secure checkout…", "working");
      const body = requestBody(form);
      body.turnstile_token = await ensureTurnstile();
      const response = await fetch(endpoint("create-checkout"), {
        method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || typeof payload.checkout_url !== "string") throw new Error(text(payload.error) || "Checkout could not be started. No payment has been completed.");
      const destination = new URL(payload.checkout_url);
      if (destination.protocol !== "https:" || destination.hostname !== "checkout.stripe.com") throw new Error("Checkout could not be opened securely and was stopped. No payment was taken. Please try again, or write to ssuite@salute.community.");
      rememberPendingCheckout(destination);
      setStatus("Redirecting to secure checkout…", "working");
      location.assign(destination.toString());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Checkout could not be started. No payment has been completed.", "error");
      if (turnstileWidget !== null && window.turnstile) window.turnstile.reset(turnstileWidget);
    } finally { submit.disabled = false; }
  }
  function startForTicket(button) {
    const code = text(button.dataset.ticketCode);
    const drawer = document.querySelector(".checkout-drawer");
    if (drawer) drawer.dataset.ticketCode = code;
    updateMemberFields(code);
    updatePartnerFields(code);
    if (code !== PARTNER_HOST_TIER) {
      // The partner rate lives on the Community path only. Choosing another tier
      // drops it rather than carrying a price into a tier it does not apply to.
      if (partnerRate) clearPartnerRate("");
    } else {
      const input = byId("partner-code");
      if (input && linkedPartnerCode && !normalizeCode(input.value)) {
        // Arrived on a partner invitation link. Fill it in and check it, so the
        // rate is settled before any details are typed.
        revealPartnerFields();
        input.value = linkedPartnerCode;
        applyPartnerCode().catch(() => {});
      } else if (partnerRate) {
        revealPartnerFields();
        applyPartnerDisplay();
      }
    }
    const readiness = liveReadiness();
    const label = button.querySelector(".live-ticket-note");
    if (label) label.textContent = readiness.ok ? "Complete the details above to continue" : "Preview only — checkout is not available here";
    if (readiness.ok) warmTurnstile().catch(() => {});
  }
  function applyLiveLabels() {
    // Preview wording ships as the safe default in the HTML. Only replace it once
    // this deployment is genuinely wired for live payment, so the page never
    // promises a real charge it cannot make, or a preview it will not honour.
    if (!liveReadiness().ok) {
      // The closed state is stated here rather than shipped in the markup.
      // It used to be the other way round, which meant a slow, blocked or
      // failed script left a selling event reading "Ticket sales are not open
      // yet" with every control labelled "Sales opening soon" -- and the only
      // surviving sentence about eligibility mentioning an access code. People
      // read that as invitation-only. The markup is now neutral, so anything
      // that genuinely cannot take a payment has to say so from here.
      const closedNote = byId("attend-sales-note");
      if (closedNote) closedNote.textContent = "Ticket sales are not open yet. Pricing is shown for advance planning; registration and checkout will become available here when sales open.";
      document.querySelectorAll(".choose").forEach((button) => {
        const withheld = text(button.dataset.withheldLabel);
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
        if (withheld) button.textContent = withheld;
      });
      return;
    }
    const note = byId("attend-sales-note");
    // No deadline is asserted here. live-pricing.js adds the early-bird sentence from
    // the event database only while that window is genuinely open, so a stale build
    // can never advertise a discount that has already ended.
    if (note) note.textContent = "Registration is completed through secure checkout.";
    const submit = byId("checkout-submit");
    if (submit) submit.textContent = "Continue to secure checkout";
    const fineprint = byId("checkout-fineprint");
    if (fineprint) fineprint.textContent = "You will be taken to Stripe to complete payment securely. Your registration is confirmed only after your payment is verified.";
    const intro = byId("drawer-intro");
    if (intro) intro.textContent = "Enter each attendee's details. You will then be taken to Stripe to pay securely; your registration is created once your payment is verified.";
    const tableEyebrow = byId("table-head-eyebrow");
    if (tableEyebrow) tableEyebrow.textContent = "TABLE MANAGEMENT";
    const tableTitle = byId("table-head-title");
    if (tableTitle) tableTitle.textContent = "Set up your table.";
    const tableNote = byId("table-head-note");
    if (tableNote) tableNote.textContent = "After your payment is verified, you will receive a private link to manage your table: name it, assign each of your ten seats, invite your guests by email, and resend or revoke a link at any time.";
    const tablePageEyebrow = byId("table-page-eyebrow");
    if (tablePageEyebrow) tablePageEyebrow.textContent = "YOUR PRIVATE TABLE PAGE";
    const tablePageNote = byId("table-page-note");
    if (tablePageNote) tablePageNote.textContent = "10 seats · Guest status · Seating controls";
    // The local sample dashboard is a design preview only; it must not be offered
    // alongside a real purchase that issues a genuine private table page.
    const previewDashboard = byId("preview-dashboard");
    if (previewDashboard) previewDashboard.hidden = true;
    // Purchase controls ship disabled and labelled "Sales opening soon" so the
    // page is never able to start a checkout it cannot complete. They are only
    // enabled once this deployment is genuinely wired for live payment.
    document.querySelectorAll(".choose").forEach((button) => {
      const label = text(button.dataset.liveLabel);
      if (!label) return;
      // A tier can be withheld from public sale while the event as a whole is
      // selling -- a members-first window, for example. Server-side checkout
      // refuses it, so the page must not hand over a control that only errors.
      //
      // This reads as "enable only what is known to be open", not "disable what
      // is known to be closed". The difference matters: this pass runs on
      // DOMContentLoaded, while live-pricing.js learns the per-tier sale window
      // from the event database a few hundred milliseconds later. Treating an
      // unknown state as open enabled a withheld tier for that gap on every
      // single page load, so the control was briefly live before the database
      // answer arrived to take it away again. The shipped markup carries the
      // state for exactly this reason, and anything else now stays disabled
      // until the lookup confirms the tier is selling.
      if (button.dataset.publicSaleOpen !== "true") {
        const withheld = text(button.dataset.withheldLabel);
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
        if (withheld) button.textContent = withheld;
        return;
      }
      button.disabled = false;
      button.removeAttribute("aria-disabled");
      // A tier sold by invitation gets the label that says so. The state is
      // carried in the shipped markup for the same reason the sale window is:
      // this pass runs on DOMContentLoaded and the database answer arrives a
      // few hundred milliseconds later, so an unknown gate would leave a
      // by-invitation tier reading "Choose this ticket" on every page load.
      // live-pricing.js overrides both label and notes from server truth.
      const gatedLabel = text(button.dataset.gatedLabel);
      button.textContent = button.dataset.accessCodeRequired === "true" && gatedLabel ? gatedLabel : label;
    });
    applyShippedGate();
  }

  /* First-paint eligibility, from the shipped state.
   *
   * Both eligibility lines and the request-an-invitation control ship hidden,
   * so a browser with no JavaScript makes no claim about who may buy -- it
   * cannot buy anything either way. This reveals the right one immediately;
   * live-pricing.js re-runs the same decision from the database moments later
   * and wins if the two ever disagree.
   */
  function applyShippedGate() {
    const ready = liveReadiness().ok;
    document.querySelectorAll(".choose").forEach((button) => {
      const code = text(button.dataset.ticketCode);
      if (!code) return;
      const gated = button.dataset.accessCodeRequired === "true";
      const saleOpen = button.dataset.publicSaleOpen === "true";
      const card = button.closest(".ticket-card");
      if (card) {
        card.querySelectorAll("[data-eligibility]").forEach((line) => {
          line.hidden = line.dataset.eligibility !== (gated ? "gated" : "open");
        });
      }
      document.querySelectorAll(`[data-request-invitation="${code}"]`).forEach((request) => {
        request.hidden = !(gated && saleOpen && ready);
      });
    });
  }
  function init() {
    policyLinks();
    applyLiveLabels();
    createMemberFields();
    createPartnerFields();
    document.querySelectorAll(".choose").forEach((button) => button.addEventListener("click", () => startForTicket(button)));
    // The drawer's own total is computed from the tile price. When a code
    // carries a different rate, that total is wrong the instant the quantity
    // changes, so recompute after the drawer's handler has run. Registered
    // here, after the inline handler, so this one runs second and wins.
    const quantitySelect = byId("ticket-quantity");
    if (quantitySelect) {
      quantitySelect.addEventListener("change", () => {
        if (partnerActive()) applyPartnerDisplay();
      });
    }
    const params = new URLSearchParams(location.search);
    // A partner invitation link carries the organization's code. Remember it for
    // the moment the drawer opens; nothing is checked or shown until then.
    linkedPartnerCode = normalizeCode(params.get("code")).slice(0, 64);
    const result = params.get("checkout");
    if (result === "cancel") { forgetPendingCheckout(); setStatus("Checkout was cancelled. No payment was completed.", "error"); }
    if (result === "success") {
      // Hand the buyer to the receipt page, which reports only what the
      // authoritative order record proves. Never confirm anything here.
      const session = text(params.get("session_id"));
      if (/^cs_(live|test)_[A-Za-z0-9]{8,320}$/.test(session)) {
        location.replace(`./registration.html?session_id=${encodeURIComponent(session)}`);
        return;
      }
      // The address bar lost the reference. The receipt page can still recover it from
      // this tab, and if it cannot, it tells the buyer exactly how to reach their record.
      location.replace("./registration.html");
      return;
    }
  }
  window.SSuiteLive = {
    checkoutEnabled: () => liveReadiness().ok, submitCheckout, startForTicket, apiBase, policy, tokenPattern,
    applyPartnerCode, partnerState: () => (partnerRate ? { ...partnerRate } : null),
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true }); else init();
})();
