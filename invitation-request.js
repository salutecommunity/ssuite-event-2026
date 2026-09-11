/* Invitation requests.
 *
 * Community seats are sold by invitation. Someone without a code can ask for
 * one here; the request is recorded in the private S.Suite database and staff
 * decide. Nothing about this flow reserves a seat or takes a payment, and the
 * copy says so at the point of asking.
 *
 * Self-contained on purpose: it carries its own Turnstile plumbing rather than
 * reaching into the donation/auction module's closure, so neither can break the
 * other. Same patterns, same fail-closed posture.
 */
(() => {
  "use strict";
  const cfg = window.SSUITE_CONFIG || {};
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const byId = (id) => document.getElementById(id);
  const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  function apiBase() {
    const raw = text(cfg.apiBase).replace(/\/$/, "");
    try {
      const url = new URL(raw);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      return (url.protocol === "https:" || (url.protocol === "http:" && local)) && !url.username && !url.password
        ? url.origin : "";
    } catch { return ""; }
  }

  const invitationConfig = () => (cfg.invitation && typeof cfg.invitation === "object" ? cfg.invitation : {});

  function readiness() {
    if (invitationConfig().enabled !== true) {
      return { ok: false, reason: "Invitation requests are not open yet. Nothing entered here is saved or sent." };
    }
    if (!apiBase() || !text(cfg.turnstileSiteKey)) {
      return { ok: false, reason: "Invitation requests cannot be accepted right now. Please write to ssuite@salute.community and we will take it from there." };
    }
    return { ok: true, reason: "" };
  }

  function status(message, kind = "") {
    const el = byId("invitation-live-status");
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
    el.dataset.kind = kind;
  }

  /* ---- Turnstile ---------------------------------------------------------- */
  let turnstileLoad;
  let widgetId;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (turnstileLoad) return turnstileLoad;
    turnstileLoad = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.onload = () => (window.turnstile
        ? resolve(window.turnstile)
        : reject(new Error("The security check could not load. Please refresh the page and try again.")));
      script.onerror = () => reject(new Error("The security check could not load. Please refresh the page and try again."));
      document.head.appendChild(script);
    });
    return turnstileLoad;
  }
  // Render early and read the token later: a freshly rendered challenge has no
  // token for a second or two, so asking in the same instant fails every time.
  async function warm() {
    const slot = byId("invitation-turnstile");
    if (!slot) return undefined;
    if (widgetId !== undefined) return widgetId;
    const api = await loadTurnstile();
    if (widgetId !== undefined) return widgetId;
    widgetId = api.render(slot, {
      sitekey: text(cfg.turnstileSiteKey),
      appearance: "interaction-only",
      action: text(invitationConfig().turnstileAction),
      "error-callback": () => status("The security check failed. Please retry.", "error"),
      "expired-callback": () => status("The security check expired. Please retry.", "error"),
    });
    return widgetId;
  }
  async function token() {
    const api = await loadTurnstile();
    const id = await warm();
    if (id === undefined) throw new Error("The security check is unavailable. Please refresh the page and try again.");
    const deadline = Date.now() + 15000;
    for (;;) {
      const value = api.getResponse(id);
      if (value) return value;
      if (Date.now() >= deadline) {
        throw new Error("The security check has not cleared yet. This is usually a browser extension or network blocking it. Please refresh and try again, or write to ssuite@salute.community and we will take it from there.");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  function resetTurnstile() {
    if (widgetId !== undefined && window.turnstile) window.turnstile.reset(widgetId);
  }


  /* ---- A finished request ------------------------------------------------- */
  // The dialog's own heading and lede carry the outcome, so it is typeset like
  // everything else the reader has just read rather than like a system notice.
  let invitationOriginal = null;
  function invitationParts() {
    const dialog = byId("invitation-dialog");
    const form = byId("invitation-request-form");
    if (!dialog || !form) return null;
    const heading = dialog.querySelector("h2");
    const lede = dialog.querySelector(".dialog-lede");
    return heading && lede ? { dialog, form, heading, lede } : null;
  }
  function done(headline, body) {
    const p = invitationParts();
    if (!p) return;
    if (!invitationOriginal) invitationOriginal = { heading: p.heading.textContent, lede: p.lede.textContent };
    status("", "");
    p.heading.textContent = headline;
    p.lede.textContent = body;
    // Removed from the layout, not merely marked hidden: these carry classes
    // whose own display rules would overrule the attribute.
    p.form.hidden = true;
    p.form.style.display = "none";
    let close = byId("invitation-done-close");
    if (!close) {
      close = document.createElement("button");
      close.id = "invitation-done-close";
      close.type = "button";
      close.className = "button button-dark full";
      close.textContent = "Close";
      close.addEventListener("click", () => p.dialog.close());
      p.form.parentNode.insertBefore(close, p.form.nextSibling);
    }
    close.hidden = false;
    close.style.display = "";
    close.focus();
  }
  // Reopening starts over: the same person may ask again for somebody else.
  function restore() {
    const p = invitationParts();
    if (!p || !invitationOriginal) return;
    p.heading.textContent = invitationOriginal.heading;
    p.lede.textContent = invitationOriginal.lede;
    p.form.hidden = false;
    p.form.style.display = "";
    const close = byId("invitation-done-close");
    if (close) { close.hidden = true; close.style.display = "none"; }
  }

  /* ---- Submission --------------------------------------------------------- */
  function read(form, name) {
    const field = form.elements.namedItem(name);
    return field ? text(field.value) : "";
  }

  async function submit(form) {
    const ready = readiness();
    if (!ready.ok) { status(ready.reason, "error"); return; }
    if (!form.reportValidity()) return;

    const address = read(form, "email").toLowerCase();
    if (!emailPattern.test(address)) {
      status("Please enter a valid email address.", "error");
      return;
    }
    const button = byId("invitation-submit-button");
    if (button) button.disabled = true;
    status("Sending your request…", "working");
    try {
      const body = {
        first_name: read(form, "first_name"),
        last_name: read(form, "last_name"),
        email: address,
        job_title: read(form, "job_title"),
        company: read(form, "company"),
        // Seat count and free-text note are deliberately not collected: the form
        // asks only what staff need to decide, and staff follow up by email.
        // Nothing is sent for them, so nothing is recorded for them either.
        referral_source: read(form, "referral_source") || undefined,
        turnstile_token: await token(),
      };
      const response = await fetch(`${apiBase()}/functions/v1/invitation-request`, {
        method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 429) {
        throw new Error("Too many requests from this connection. Please wait a few minutes and try again.");
      }
      if (!response.ok || payload.accepted !== true) {
        throw new Error(text(payload.error) || "We could not record your request. Please try again shortly, or write to ssuite@salute.community.");
      }
      form.reset();
      resetTurnstile();
      if (payload.status === "already_invited") {
        done("You have already been invited.",
          "Your invitation code is in your email from S.Suite — search for “S.Suite”, or write to ssuite@salute.community and we will send it again.");
        return;
      }
      done("Your request has been sent.",
        "We read every request and reply by email. No seat is reserved and nothing has been charged.");
    } catch (error) {
      status(error instanceof Error ? error.message : "We could not record your request. Please try again shortly, or write to ssuite@salute.community.", "error");
      resetTurnstile();
    } finally {
      if (button) button.disabled = false;
    }
  }

  /* ---- Wiring ------------------------------------------------------------- */
  function init() {
    const dialog = byId("invitation-dialog");
    const form = byId("invitation-request-form");
    if (!dialog || !form) return;

    // The buttons that open this dialog are revealed by live-pricing.js only when
    // the database says Community is code-gated, so there is never an invitation
    // request control on a page where Community is open to everyone.
    document.querySelectorAll("[data-request-invitation]").forEach((button) => {
      button.addEventListener("click", () => {
        status("", "");
        restore();
        if (typeof dialog.showModal === "function") dialog.showModal();
        warm().catch(() => {});
      });
    });

    const close = dialog.querySelector(".dialog-close");
    if (close) close.addEventListener("click", () => dialog.close());

    const ready = readiness();
    const button = byId("invitation-submit-button");
    const note = byId("invitation-preview-note");
    if (ready.ok) {
      if (button) {
        button.textContent = "Send request";
        button.disabled = false;
        button.removeAttribute("aria-disabled");
      }
      if (note) {
        note.textContent = "We review every request and reply by email. Requesting an invitation does not reserve a seat and takes no payment.";
      }
      form.addEventListener("focusin", () => { warm().catch(() => {}); }, { once: true });
      form.addEventListener("input", () => { warm().catch(() => {}); }, { once: true });
    } else {
      // A live page must not carry a control that cannot do what it says.
      if (button) { button.textContent = "Requests are closed"; button.disabled = true; button.setAttribute("aria-disabled", "true"); }
      if (note) note.textContent = ready.reason;
      form.querySelectorAll("input, select, textarea").forEach((field) => { field.disabled = true; });
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit(form).catch(() => {});
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
