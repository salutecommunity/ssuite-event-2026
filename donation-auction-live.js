/* Public donation and auction intake integration. Both flows stay opt-in through
 * config.js; no credentials or bearer values are persisted in the browser. */
(() => {
  "use strict";
  const cfg = window.SSUITE_CONFIG || {};
  const text = (value) => typeof value === "string" ? value.trim() : "";
  const byId = (id) => document.getElementById(id);
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const money = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/;
  // People type money the way they say it: "$1,500", "1 500", "$100.". Accept that
  // and normalise to the plain amount the API expects, rather than rejecting them.
  const normalizeMoney = (raw) => text(raw).replace(/[$,\s]/g, "").replace(/\.$/, "").replace(/^\./, "0.");
  function apiBase() {
    const raw = text(cfg.apiBase).replace(/\/$/, "");
    try {
      const url = new URL(raw); const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      return (url.protocol === "https:" || (url.protocol === "http:" && local)) && !url.username && !url.password ? url.origin : "";
    } catch { return ""; }
  }
  function safeHttps(value) { try { const url = new URL(text(value)); return url.protocol === "https:" && !url.username && !url.password ? url.toString() : ""; } catch { return ""; } }
  function status(id, message, kind = "") { const element = byId(id); if (!element) return; element.textContent = message; element.hidden = !message; element.dataset.kind = kind; }
  function idempotencyKey() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(24); crypto.getRandomValues(bytes); return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  let turnstileLoad;
  const widgets = new Map();
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (turnstileLoad) return turnstileLoad;
    turnstileLoad = new Promise((resolve, reject) => {
      const script = document.createElement("script"); script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; script.async = true; script.defer = true;
      script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("Anti-bot verification did not load.")); script.onerror = () => reject(new Error("Anti-bot verification could not load.")); document.head.appendChild(script);
    });
    return turnstileLoad;
  }
  async function token(slotId, action) {
    const slot = byId(slotId); if (!slot) throw new Error("Anti-bot verification is unavailable.");
    const api = await loadTurnstile(); let id = widgets.get(slotId);
    if (id === undefined) { id = api.render(slot, { sitekey: text(cfg.turnstileSiteKey), action: text(action), "error-callback": () => status(slotId === "donation-turnstile" ? "donation-live-status" : "auction-live-status", "The anti-bot check failed. Please retry.", "error"), "expired-callback": () => status(slotId === "donation-turnstile" ? "donation-live-status" : "auction-live-status", "The anti-bot check expired. Please retry.", "error") }); widgets.set(slotId, id); }
    const result = api.getResponse(id); if (!result) throw new Error("Please complete the anti-bot check before continuing."); return result;
  }
  function reset(slotId) { const id = widgets.get(slotId); if (id !== undefined && window.turnstile) window.turnstile.reset(id); }
  function post(name, key, body) { return fetch(`${apiBase()}/functions/v1/${name}`, { method: "POST", mode: "cors", credentials: "omit", cache: "no-store", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) }); }

  const donationConfig = () => cfg.donation && typeof cfg.donation === "object" ? cfg.donation : {};
  function configuredTurnstileAction(flow) {
    const action = text(flow?.turnstileAction);
    return /^[A-Za-z0-9_-]{1,32}$/.test(action) ? action : "";
  }
  function donationReadiness() {
    const d = donationConfig();
    if (cfg.mode !== "live" || d.enabled !== true) return { ok: false, reason: "This site is in preview mode. No donation will be submitted or charged." };
    if (!apiBase() || !text(cfg.turnstileSiteKey) || !configuredTurnstileAction(d) || !safeHttps(d.receiptPolicyUrl)) return { ok: false, reason: "Donation checkout is not fully configured." };
    return { ok: true, reason: "" };
  }
  function donationAmount() { const custom = normalizeMoney(byId("custom-amount")?.value); if (custom) return custom; const selected = document.querySelector(".amounts button.selected"); return text(selected?.dataset.amount); }
  async function submitDonation(form) {
    const ready = donationReadiness(); if (!ready.ok) { status("donation-live-status", ready.reason, "error"); return; }
    if (!form.reportValidity()) return;
    const amount = donationAmount(), donorName = text(form.elements.donor_name?.value), address = text(form.elements.email?.value).toLowerCase();
    if (!money.test(amount)) { status("donation-live-status", "Enter a donation amount in dollars, for example 250 or 250.00.", "error"); return; }
    if (!donorName || !email.test(address)) { status("donation-live-status", "Please add the donor name and a valid email address.", "error"); return; }
    const submit = byId("donate-button");
    try {
      submit.disabled = true; status("donation-live-status", "Preparing secure donation checkout…", "working");
      const turnstileToken = await token("donation-turnstile", configuredTurnstileAction(donationConfig()));
      const response = await post("donation-create-checkout", idempotencyKey(), { donor_name: donorName, email: address, amount, frequency: document.querySelector(".segmented button.selected")?.dataset.frequency === "Monthly" ? "recurring_monthly" : "one_time", turnstile_token: turnstileToken });
      const payload = await response.json().catch(() => ({})); if (!response.ok || typeof payload.checkout_url !== "string") throw new Error(text(payload.error) || "Donation checkout could not be started.");
      const destination = new URL(payload.checkout_url); if (destination.protocol !== "https:" || destination.hostname !== "checkout.stripe.com") throw new Error("Checkout returned an unsafe redirect and was stopped.");
      status("donation-live-status", "Redirecting to secure checkout…", "working"); location.assign(destination.toString());
    } catch (error) { status("donation-live-status", error instanceof Error ? error.message : "Donation checkout could not be started.", "error"); reset("donation-turnstile"); } finally { submit.disabled = false; }
  }

  const auctionConfig = () => cfg.auction && typeof cfg.auction === "object" ? cfg.auction : {};
  function auctionReadiness() {
    const a = auctionConfig();
    if (cfg.mode !== "live" || a.enabled !== true) return { ok: false, reason: "This site is in preview mode. No auction item will be submitted." };
    if (!apiBase() || !text(cfg.turnstileSiteKey) || !configuredTurnstileAction(a)) return { ok: false, reason: "Auction intake is not fully configured." };
    return { ok: true, reason: "" };
  }
  async function submitAuction(form) {
    const ready = auctionReadiness(); if (!ready.ok) { status("auction-live-status", ready.reason, "error"); return; }
    if (!form.reportValidity()) return;
    const read = (name) => text(form.elements[name]?.value), amountValue = normalizeMoney(read("estimated_value"));
    if (!money.test(amountValue)) { status("auction-live-status", "Enter the estimated value in dollars, for example 1500 or 1500.00.", "error"); return; }
    if (!email.test(read("email").toLowerCase())) { status("auction-live-status", "Please enter a valid email address.", "error"); return; }
    const submit = byId("auction-submit-button");
    try {
      submit.disabled = true; status("auction-live-status", "Submitting for committee review…", "working");
      const turnstileToken = await token("auction-turnstile", configuredTurnstileAction(auctionConfig()));
      const response = await post("auction-submission", idempotencyKey(), { name: read("name"), email: read("email").toLowerCase(), job_title: read("job_title"), company: read("company"), item: read("item"), estimated_value: amountValue, website: read("website"), turnstile_token: turnstileToken });
      if (!response.ok) throw new Error("Unable to accept submission. Please try again later.");
      const payload = await response.json().catch(() => ({})); if (payload.accepted !== true) throw new Error("Unable to accept submission. Please try again later.");
      status("auction-live-status", "Thank you. Your item was submitted for committee consideration.", "success"); form.reset(); reset("auction-turnstile");
    } catch (error) { status("auction-live-status", error instanceof Error ? error.message : "Unable to accept submission. Please try again later.", "error"); reset("auction-turnstile"); } finally { submit.disabled = false; }
  }
  function init() {
    const donation = donationReadiness(), auction = auctionReadiness();
    if (donation.ok) { const button = byId("donate-button"), note = byId("donation-preview-note"), receiptPolicy = byId("donation-receipt-policy"); if (button) { button.textContent = "Continue to secure donation checkout"; button.disabled = false; button.removeAttribute("aria-disabled"); } if (note) note.textContent = "You will be redirected to Stripe. A receipt is issued only after verified payment and configured receipt review."; if (receiptPolicy) { const link = receiptPolicy.querySelector("a"); if (link) link.href = safeHttps(donationConfig().receiptPolicyUrl); receiptPolicy.hidden = false; } const slot = document.createElement("div"); slot.id = "donation-turnstile"; slot.className = "turnstile-slot"; byId("donation-live-status")?.before(slot); }
    if (auction.ok) { const button = byId("auction-submit-button"), note = byId("auction-preview-note"); if (button) { button.textContent = "Submit for committee review"; button.disabled = false; button.removeAttribute("aria-disabled"); } if (note) note.textContent = "Your item will be considered by the auction committee; submission does not promise acceptance, valuation, publication, or tax treatment."; const form = byId("auction-submission-form"); if (form) form.querySelectorAll("input, select, textarea").forEach((field) => { field.disabled = false; }); }
    // A live public page must not carry controls that cannot perform their stated
    // action. Where giving or auction intake is not open, close the control
    // honestly instead of offering a simulated run-through.
    if (!donation.ok) {
      const button = byId("donate-button");
      if (button) { button.textContent = "Giving opens soon"; button.disabled = true; button.setAttribute("aria-disabled", "true"); }
      const note = byId("donation-preview-note");
      if (note) note.textContent = "Online giving is not open yet. No donation can be submitted, charged, or receipted here.";
      const form = byId("donation-form");
      if (form) form.querySelectorAll("input, select, textarea").forEach((field) => { field.disabled = true; });
    }
    if (!auction.ok) {
      const button = byId("auction-submit-button");
      if (button) { button.textContent = "Submissions open soon"; button.disabled = true; button.setAttribute("aria-disabled", "true"); }
      const note = byId("auction-preview-note");
      if (note) note.textContent = "Auction item submissions are not open yet. Nothing entered here is saved or sent.";
      const form = byId("auction-submission-form");
      if (form) form.querySelectorAll("input, select, textarea").forEach((field) => { field.disabled = true; });
    }
  }
  window.SSuiteDonation = { enabled: () => donationReadiness().ok, submit: submitDonation };
  window.SSuiteAuction = { enabled: () => auctionReadiness().ok, submit: submitAuction };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true }); else init();
})();
