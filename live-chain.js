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
    if (!apiBase()) return { ok: false, reason: "Checkout is not configured for this site." };
    if (!policy()) return { ok: false, reason: "Final policy links and versions are not configured." };
    if (!text(cfg.turnstileSiteKey)) return { ok: false, reason: "Checkout is unavailable until the anti-bot check is configured." };
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
      script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not load"));
      script.onerror = () => reject(new Error("Turnstile could not load"));
      document.head.appendChild(script);
    });
    return turnstileLoading;
  }
  async function ensureTurnstile() {
    const readiness = liveReadiness();
    if (!readiness.ok) throw new Error(readiness.reason);
    const container = turnstileContainer();
    if (!container) throw new Error("Checkout anti-bot control is unavailable.");
    const api = await loadTurnstile();
    if (turnstileWidget === null) {
      turnstileWidget = api.render(container, {
        sitekey: text(cfg.turnstileSiteKey),
        action: "ssuite_checkout",
        // Clear a stale "complete the check" notice as soon as it is actually complete.
        "callback": () => { const el = byId("live-checkout-status"); if (el && /anti-bot check/i.test(el.textContent)) setStatus("", ""); },
        "error-callback": () => setStatus("The anti-bot check failed. Please retry.", "error"),
        "expired-callback": () => setStatus("The anti-bot check expired. Please retry.", "error"),
      });
    }
    const response = api.getResponse(turnstileWidget);
    if (!response) throw new Error("Please complete the anti-bot check before continuing.");
    return response;
  }
  function value(form, name) { return text(form.elements.namedItem(name)?.value); }
  function attendee(form, index) {
    const dietaryFlag = Boolean(form.querySelector(`[data-detail="dietary-${index}"]`)?.checked);
    const accessibilityFlag = Boolean(form.querySelector(`[data-detail="accessibility-${index}"]`)?.checked);
    const primary = value(form, `guest-${index}-email`).toLowerCase();
    const secondary = value(form, `guest-${index}-secondary-email`).toLowerCase();
    if (!emailPattern.test(primary) || (secondary && (!emailPattern.test(secondary) || secondary === primary))) throw new Error("Please provide distinct, valid attendee email addresses.");
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
    if (!p) throw new Error("Final policies are not configured.");
    const code = ticketCode();
    const table = code === "full_table";
    const member = code === "salute_member";
    // The member rate covers exactly one seat. Any guests a member brings are
    // billed at the open Community rate on the same payment.
    const guestSelect = byId("member-guest-quantity");
    const guestSeats = member && guestSelect && !guestSelect.disabled ? Number(guestSelect.value || 0) : 0;
    if (!Number.isInteger(guestSeats) || guestSeats < 0 || guestSeats > 4) throw new Error("Choose a valid number of guest seats.");
    const count = table ? 1 : (member ? 1 + guestSeats : Number(byId("ticket-quantity")?.value));
    if (!Number.isInteger(count) || count < 1 || count > (table ? 10 : (member ? 5 : 4))) throw new Error("Choose a valid number of attendees.");
    const attendees = Array.from({ length: count }, (_, i) => attendee(form, i));
    if (new Set(attendees.map((a) => a.email)).size !== attendees.length) throw new Error("Each attendee must have a unique primary email address.");
    const purchaser = attendees[0];
    const howHeard = value(form, "referral-source");
    if (!code || !howHeard) throw new Error("Complete the registration details before checkout.");
    const memberCode = String(byId("member-code")?.value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (code === "salute_member" && !memberCode) throw new Error("Enter your member access code to use the member rate. It is in your SALUTE email — or write to ssuite@salute.community and we will send it.");
    return {
      ticket_type_code: code, order_type: table ? "table" : "ticket", quantity: table || member ? 1 : count,
      guest_quantity: guestSeats,
      purchaser: { first_name: purchaser.first_name, last_name: purchaser.last_name, email: purchaser.email, phone: purchaser.phone || undefined },
      member_code: code === "salute_member" ? memberCode : undefined,
      member_attestation: false,
      how_heard: howHeard, attendees, combined_agreement: true,
      terms_version: p.termsVersion, privacy_version: p.privacyVersion, media_release_version: p.mediaReleaseVersion,
      success_url: `${location.origin}/registration.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${location.origin}${location.pathname}?checkout=cancel`,
    };
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
      if (destination.protocol !== "https:" || destination.hostname !== "checkout.stripe.com") throw new Error("Checkout returned an unsafe redirect and was stopped.");
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
    const readiness = liveReadiness();
    const label = button.querySelector(".live-ticket-note");
    if (label) label.textContent = readiness.ok ? "Secure checkout available after details" : "Preview only — checkout is not configured";
    if (readiness.ok) ensureTurnstile().catch((error) => setStatus(error.message, "error"));
  }
  function applyLiveLabels() {
    // Preview wording ships as the safe default in the HTML. Only replace it once
    // this deployment is genuinely wired for live payment, so the page never
    // promises a real charge it cannot make, or a preview it will not honour.
    if (!liveReadiness().ok) return;
    const note = byId("attend-sales-note");
    if (note) note.textContent = "Early-bird pricing is available through September 30, 2026, 11:59 p.m. Eastern. Registration is completed through secure checkout.";
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
      button.disabled = false;
      button.removeAttribute("aria-disabled");
      button.textContent = label;
    });
  }
  function init() {
    policyLinks();
    applyLiveLabels();
    createMemberFields();
    document.querySelectorAll(".choose").forEach((button) => button.addEventListener("click", () => startForTicket(button)));
    const params = new URLSearchParams(location.search);
    const result = params.get("checkout");
    if (result === "cancel") setStatus("Checkout was cancelled. No payment was completed.", "error");
    if (result === "success") {
      // Hand the buyer to the receipt page, which reports only what the
      // authoritative order record proves. Never confirm anything here.
      const session = text(params.get("session_id"));
      if (/^cs_(live|test)_[A-Za-z0-9]{8,320}$/.test(session)) {
        location.replace(`./registration.html?session_id=${encodeURIComponent(session)}`);
        return;
      }
      setStatus("Checkout returned, but this browser did not carry the reference needed to display your receipt. Your confirmation email is the authoritative record. Write to ssuite@salute.community if it does not arrive.", "working");
    }
  }
  window.SSuiteLive = { checkoutEnabled: () => liveReadiness().ok, submitCheckout, startForTicket, apiBase, policy, tokenPattern };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true }); else init();
})();
