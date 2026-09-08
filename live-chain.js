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
    section.innerHTML = `<p class="micro">PARTNER ORGANIZATION</p><p>Invited by one of our nonprofit partner organizations? Enter the code from your invitation and your rate is applied here, before you pay.</p><label class="field"><span>ACCESS CODE <i>OPTIONAL</i></span><input id="partner-code" type="text" maxlength="64" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="Code from the organization that invited you"></label><div class="member-note"><button type="button" class="button button-outline" id="partner-code-apply">Apply code</button></div><p class="member-note" id="partner-code-status" role="status" aria-live="polite" hidden></p>`;
    selection.insertAdjacentElement("afterend", section);
    byId("partner-code-apply").addEventListener("click", () => { applyPartnerCode().catch(() => {}); });
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
  function updatePartnerFields(code) {
    createPartnerFields();
    const section = byId("partner-verification");
    if (!section) return;
    const applies = code === PARTNER_HOST_TIER;
    section.hidden = !applies;
    section.querySelectorAll("input").forEach((input) => { input.disabled = !applies; });
  }
  function applyPartnerDisplay() {
    if (!partnerRate) return;
    const name = byId("ticket-name");
    if (name) name.textContent = partnerRate.name || "Nonprofit Partner Ticket";
    const note = byId("selection-note");
    if (note) note.textContent = partnerRate.organization ? `${partnerRate.organization} · one seat` : "Partner rate · one seat";
    const quantity = byId("ticket-quantity");
    if (quantity) {
      quantity.value = "1";
      const wrap = quantity.closest(".quantity-wrap");
      if (wrap) wrap.hidden = true;
    }
    // Rebuild the attendee list only if it is not already a single person, so
    // applying a code cannot discard details somebody has already typed.
    if (document.querySelectorAll("#guest-fields .guest-card").length !== 1 && typeof window.renderGuests === "function") {
      window.renderGuests();
    }
    const total = byId("ticket-total");
    if (total) total.textContent = money(partnerRate.amountCents);
    const seats = typeof partnerRate.seatsRemaining === "number"
      ? ` ${partnerRate.seatsRemaining} ${partnerRate.seatsRemaining === 1 ? "seat remains" : "seats remain"} on this code.`
      : "";
    const who = partnerRate.organization ? `${partnerRate.organization} rate` : "Partner rate";
    partnerStatus(`${who} applied — ${money(partnerRate.amountCents)}, one seat.${seats}`);
  }
  function clearPartnerRate(message) {
    partnerRate = null;
    const drawer = document.querySelector(".checkout-drawer");
    if (drawer) delete drawer.dataset.partnerCode;
    const quantity = byId("ticket-quantity");
    const wrap = quantity ? quantity.closest(".quantity-wrap") : null;
    if (wrap) wrap.hidden = ticketCode() !== PARTNER_HOST_TIER;
    const button = document.querySelector(`.choose[data-ticket-code="${PARTNER_HOST_TIER}"]`);
    const name = byId("ticket-name");
    if (name && button && ticketCode() === PARTNER_HOST_TIER) name.textContent = text(button.dataset.ticket) || "Community Ticket";
    const note = byId("selection-note");
    if (note && ticketCode() === PARTNER_HOST_TIER) note.textContent = "Ticket selection";
    if (typeof window.updateTotal === "function") window.updateTotal();
    partnerStatus(message || "");
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
    const count = partner ? 1 : (table ? 1 : (member ? 1 + guestSeats : Number(byId("ticket-quantity")?.value)));
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
      quantity: table || member || partner ? 1 : count,
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
        input.value = linkedPartnerCode;
        applyPartnerCode().catch(() => {});
      } else if (partnerRate) {
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
    if (!liveReadiness().ok) return;
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
      button.textContent = label;
    });
  }
  function init() {
    policyLinks();
    applyLiveLabels();
    createMemberFields();
    createPartnerFields();
    document.querySelectorAll(".choose").forEach((button) => button.addEventListener("click", () => startForTicket(button)));
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
