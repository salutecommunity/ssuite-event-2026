/* Member code requests.
 *
 * "It needs to be easy can they request a member code?" — most members never
 * need one: the server prices the member rate when the purchaser email is on
 * the member roster. This covers everyone that roster cannot answer for, in one
 * step instead of "write to us and wait".
 *
 * The server decides what happens. A roster match sends the code immediately,
 * and only ever to the address that matched, so asking for somebody else's code
 * gets you nothing. No match goes to staff for review. This page is told which
 * of the two happened and nothing else — never the code, never the address.
 *
 * Self-contained on purpose: it carries its own Turnstile plumbing rather than
 * reaching into another module's closure, so neither can break the other. Same
 * patterns, same fail-closed posture.
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

  const memberConfig = () => (cfg.memberCode && typeof cfg.memberCode === "object" ? cfg.memberCode : {});

  function readiness() {
    if (memberConfig().enabled !== true) {
      return { ok: false, reason: "This is not available yet. Nothing entered here is saved or sent." };
    }
    if (!apiBase() || !text(cfg.turnstileSiteKey)) {
      return { ok: false, reason: "We cannot send codes from this page right now. Please write to ssuite@salute.community and we will send yours." };
    }
    return { ok: true, reason: "" };
  }

  function status(message, kind = "") {
    const el = byId("member-code-live-status");
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
    const slot = byId("member-code-turnstile");
    if (!slot) return undefined;
    if (widgetId !== undefined) return widgetId;
    const api = await loadTurnstile();
    if (widgetId !== undefined) return widgetId;
    widgetId = api.render(slot, {
      sitekey: text(cfg.turnstileSiteKey),
      appearance: "interaction-only",
      action: text(memberConfig().turnstileAction),
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
        throw new Error("The security check has not cleared yet. This is usually a browser extension or network blocking it. Please refresh and try again, or write to ssuite@salute.community and we will send your code.");
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
  let memberCodeOriginal = null;
  function memberCodeParts() {
    const dialog = byId("member-code-dialog");
    const form = byId("member-code-request-form");
    if (!dialog || !form) return null;
    const heading = dialog.querySelector("h2");
    const lede = dialog.querySelector(".dialog-lede");
    return heading && lede ? { dialog, form, heading, lede } : null;
  }
  function done(headline, body) {
    const p = memberCodeParts();
    if (!p) return;
    if (!memberCodeOriginal) memberCodeOriginal = { heading: p.heading.textContent, lede: p.lede.textContent };
    status("", "");
    p.heading.textContent = headline;
    p.lede.textContent = body;
    // Removed from the layout, not merely marked hidden: these carry classes
    // whose own display rules would overrule the attribute.
    p.form.hidden = true;
    p.form.style.display = "none";
    let close = byId("memberCode-done-close");
    if (!close) {
      close = document.createElement("button");
      close.id = "memberCode-done-close";
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
    const p = memberCodeParts();
    if (!p || !memberCodeOriginal) return;
    p.heading.textContent = memberCodeOriginal.heading;
    p.lede.textContent = memberCodeOriginal.lede;
    p.form.hidden = false;
    p.form.style.display = "";
    const close = byId("memberCode-done-close");
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
    const button = byId("member-code-submit-button");
    if (button) button.disabled = true;
    status("Sending…", "working");
    try {
      const body = {
        first_name: read(form, "first_name"),
        last_name: read(form, "last_name"),
        email: address,
        turnstile_token: await token(),
      };
      const response = await fetch(`${apiBase()}/functions/v1/member-code-request`, {
        method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 429) {
        throw new Error("Too many requests from this connection. Please wait a few minutes and try again.");
      }
      if (!response.ok || payload.accepted !== true) {
        throw new Error(text(payload.error) || "We could not send your code just now. Please try again shortly, or write to ssuite@salute.community.");
      }
      form.reset();
      resetTurnstile();
      if (payload.status === "sent") {
        done("Your request has been sent.",
          "Your member code is on its way to the address your membership is recorded under. It usually arrives within a minute.");
      } else {
        done("Your request has been sent.",
          "We could not match your membership automatically, so someone from S.Suite will check it and email you. Nothing has been reserved and nothing has been charged.");
      }
    } catch (error) {
      status(error instanceof Error ? error.message : "We could not send your code just now. Please try again shortly, or write to ssuite@salute.community.", "error");
      resetTurnstile();
    } finally {
      if (button) button.disabled = false;
    }
  }

  /* ---- Wiring ------------------------------------------------------------- */
  function init() {
    const dialog = byId("member-code-dialog");
    const form = byId("member-code-request-form");
    if (!dialog || !form) return;

    // The opener lives inside the member panel, which live-chain.js builds when
    // the member ticket is chosen, so bind on the document rather than to an
    // element that does not exist yet.
    document.addEventListener("click", (event) => {
      const opener = event.target instanceof Element ? event.target.closest("[data-request-member-code]") : null;
      if (!opener) return;
      event.preventDefault();
      status("", "");
      restore();
      // Whatever they have already typed into the checkout is almost certainly
      // the answer here too. Carrying it across saves retyping and makes a
      // roster match more likely.
      const carry = { first_name: "guest-0-first", last_name: "guest-0-last", email: "guest-0-email" };
      for (const [name, source] of Object.entries(carry)) {
        const from = document.querySelector(`[name="${source}"]`);
        const to = form.elements.namedItem(name);
        if (from && to && text(from.value) && !text(to.value)) to.value = text(from.value);
      }
      if (typeof dialog.showModal === "function") dialog.showModal();
      warm().catch(() => {});
    });

    const close = dialog.querySelector(".dialog-close");
    if (close) close.addEventListener("click", () => dialog.close());

    const ready = readiness();
    const button = byId("member-code-submit-button");
    const note = byId("member-code-preview-note");
    if (ready.ok) {
      if (button) {
        button.textContent = "Send my code";
        button.disabled = false;
        button.removeAttribute("aria-disabled");
      }
      if (note) {
        note.textContent = "We only ever send the code to an address on the SALUTE member list. If yours is not there yet, someone from S.Suite will check by hand.";
      }
      form.addEventListener("focusin", () => { warm().catch(() => {}); }, { once: true });
      form.addEventListener("input", () => { warm().catch(() => {}); }, { once: true });
    } else {
      // A live page must not carry a control that cannot do what it says.
      if (button) { button.textContent = "Unavailable"; button.disabled = true; button.setAttribute("aria-disabled", "true"); }
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
