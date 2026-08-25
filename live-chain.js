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
    section.innerHTML = `<p class="micro">SALUTE MEMBERSHIP</p><p>Use the active member email if it differs from the purchaser email. If it cannot be matched, you may request review by attesting below.</p><label class="field"><span>MEMBERSHIP EMAIL <i>OPTIONAL</i></span><input id="membership-email" type="email" autocomplete="email" maxlength="320"></label><label class="condition-check"><input id="member-attestation" type="checkbox"><span>I confirm that I am a current SALUTE member and understand this ticket may require review.</span></label>`;
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
        "error-callback": () => setStatus("The anti-bot check failed. Please retry.", "error"),
        "expired-callback": () => setStatus("The anti-bot check expired. Please retry.", "error"),
      });
    }
    const response = api.getResponse(turnstileWidget);
    if (!response) throw new Error("Please complete the anti-bot check before continuing.");
    return response;
  }
  function value(form, name) { return text(form.elements[name]?.value); }
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
    const count = table ? 1 : Number(byId("ticket-quantity")?.value);
    if (!Number.isInteger(count) || count < 1 || count > (table ? 10 : 4)) throw new Error("Choose a valid number of attendees.");
    const attendees = Array.from({ length: count }, (_, i) => attendee(form, i));
    if (new Set(attendees.map((a) => a.email)).size !== attendees.length) throw new Error("Each attendee must have a unique primary email address.");
    const purchaser = attendees[0];
    const howHeard = value(form, "referral-source");
    if (!code || !howHeard) throw new Error("Complete the registration details before checkout.");
    const membership = value(form, "membership-email").toLowerCase();
    if (membership && !emailPattern.test(membership)) throw new Error("Enter a valid membership email address.");
    return {
      ticket_type_code: code, order_type: table ? "table" : "ticket", quantity: table ? 1 : count,
      purchaser: { first_name: purchaser.first_name, last_name: purchaser.last_name, email: purchaser.email, phone: purchaser.phone || undefined },
      membership_email: code === "salute_member" && membership ? membership : undefined,
      member_attestation: code === "salute_member" && Boolean(byId("member-attestation")?.checked),
      how_heard: howHeard, attendees, combined_agreement: true,
      terms_version: p.termsVersion, privacy_version: p.privacyVersion, media_release_version: p.mediaReleaseVersion,
      success_url: `${location.origin}${location.pathname}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
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
  function init() {
    policyLinks();
    createMemberFields();
    document.querySelectorAll(".choose").forEach((button) => button.addEventListener("click", () => startForTicket(button)));
    const result = new URLSearchParams(location.search).get("checkout");
    if (result === "cancel") setStatus("Checkout was cancelled. No payment was completed.", "error");
    if (result === "success") setStatus("Checkout returned successfully. Your registration is confirmed only after Stripe and the event system finish processing.", "working");
  }
  window.SSuiteLive = { checkoutEnabled: () => liveReadiness().ok, submitCheckout, startForTicket, apiBase, policy, tokenPattern };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true }); else init();
})();
