(() => {
  "use strict";
  const cfg = window.SSUITE_CONFIG || {}, $ = (id) => document.getElementById(id), emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const TOKEN_PATTERN = /^[0-9a-f]{64}$/i, TOKEN_STORE = "ssuite.guest.invitation";

  /* The token arrives in the URL fragment and is removed from the address bar immediately.
     It is kept in session storage so a refresh, a back navigation or a second visit from the
     same email still works: the invitation link is meant to be usable more than once. */
  function readToken() {
    const fromLink = new URLSearchParams(location.hash.slice(1)).get("token") || "";
    if (TOKEN_PATTERN.test(fromLink)) { try { sessionStorage.setItem(TOKEN_STORE, fromLink.toLowerCase()); } catch { /* storage unavailable */ } return fromLink.toLowerCase(); }
    try { const stored = sessionStorage.getItem(TOKEN_STORE) || ""; if (TOKEN_PATTERN.test(stored)) return stored.toLowerCase(); } catch { /* storage unavailable */ }
    return "";
  }

  let invitationToken = readToken(), widget = null, loading = null;
  history.replaceState(null, "", `${location.pathname}${location.search}`);

  const text = (value) => (typeof value === "string" ? value.trim() : "");
  function base() { try { const u = new URL(String(cfg.apiBase || "")); return (cfg.mode === "live" || cfg.mode === "isolated-staging") && u.protocol === "https:" ? u.origin : ""; } catch { return ""; } }
  function turnstileAction() { const value = String(cfg.turnstileAction || "").trim(); return /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value : ""; }
  function policy() { const p = cfg.policy || {}; try { const urls = [new URL(p.termsUrl), new URL(p.privacyUrl), new URL(p.mediaReleaseUrl)]; return urls.every((u) => u.protocol === "https:") && [p.termsVersion, p.privacyVersion, p.mediaReleaseVersion].every((v) => typeof v === "string" && v.trim()) ? p : null; } catch { return null; } }
  function status(message, type = "") { const el = $("status"); el.textContent = message; el.className = `notice ${type}`; el.hidden = !message; }

  function agreement() { const p = policy(), slot = $("policy-agreement"); if (!p) return false; const label = document.createElement("label"), check = document.createElement("input"), span = document.createElement("span"); const documents = [["Event Terms & Conditions", "./event-terms.html"], ["Event Privacy Notice", "./event-privacy.html"], ["Media, Photo & Video Release", "./media-release.html"]]; label.className = "check"; check.type = "checkbox"; check.name = "combined_agreement"; check.required = true; span.append("I agree to the "); for (const [name, href] of documents) { const a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = name; span.append(a, document.createTextNode(name === "Media, Photo & Video Release" ? "." : ", ")); } label.append(check, span); slot.replaceChildren(label); return true; }

  function loadTurnstile() { if (window.turnstile && typeof window.turnstile.render === "function") return Promise.resolve(window.turnstile); if (loading) return loading; if (window.turnstile && typeof window.turnstile.render !== "function") { try { delete window.turnstile; } catch { window.turnstile = undefined; } } loading = new Promise((resolve, reject) => { const s = document.createElement("script"); s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; s.async = true; s.defer = true; s.onload = () => window.turnstile && typeof window.turnstile.render === "function" ? resolve(window.turnstile) : reject(new Error("Anti-bot control did not load")); s.onerror = () => reject(new Error("Anti-bot control could not load")); document.head.append(s); }); return loading; }
  async function turnstileToken() { const api = await loadTurnstile(); if (widget === null) { const action = turnstileAction(); if (!action) throw new Error("Guest registration is not configured for live use."); const options = { sitekey: String(cfg.turnstileSiteKey || ""), action, "error-callback": () => status("The anti-bot check failed. Please retry.", "error"), "expired-callback": () => status("The anti-bot check expired. Please retry.", "error") }; widget = api.render($("turnstile-widget"), options); } const result = api.getResponse(widget); if (!result) throw new Error("Please complete the anti-bot check."); return result; }

  async function api(payload) {
    const response = await fetch(`${base()}/functions/v1/guest-registration`, { method: "POST", mode: "cors", credentials: "omit", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invitation_token: invitationToken, ...payload }) });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, body };
  }

  /* Who invited them, to what, when and where. Rendered before anything is asked of the guest. */
  function renderContext(context) {
    const event = (context && context.event) || {}, host = text(context.lead_name), tableName = text(context.table_name);
    const note = text(context.personal_note) || "for an evening with SALUTE at the S.Suite Honors Ceremony.";
    let lede = host ? `${host} has invited you ${note}` : `You have been invited ${note}`;
    if (tableName) lede += ` You will be seated at ${tableName}.`;
    $("invite-lede").textContent = lede;

    const date = text(event.display_date), venue = [text(event.venue_name), text(event.city)].filter(Boolean).join(", ");
    const seat = Number.isInteger(context.seat_number) ? `Seat ${context.seat_number}` : "Assigned by your host";
    if (date || venue) {
      $("meta-date").textContent = date || "To be confirmed";
      $("meta-venue").textContent = venue || "To be confirmed";
      $("meta-seat").textContent = seat;
      $("invite-meta").hidden = false;
    }
  }

  function row(container, label, value) {
    const clean = text(value); if (!clean) return;
    const wrap = document.createElement("div"), span = document.createElement("span"), strong = document.createElement("strong");
    span.textContent = label; strong.textContent = clean; wrap.append(span, strong); container.append(wrap);
  }

  function renderRegistered(guest) {
    const container = $("registered-rows"); container.replaceChildren();
    const g = guest || {}, name = [text(g.first_name), text(g.last_name)].filter(Boolean).join(" ");
    row(container, "Name", name);
    row(container, "Email", g.email);
    row(container, "Secondary email", g.secondary_email);
    row(container, "Job title", g.job_title);
    row(container, "Company", g.company);
    row(container, "Meal preference", g.meal_preference);
    if (g.has_dietary_or_allergy_needs) row(container, "Dietary / allergies", text(g.dietary_or_allergy_details) || "Noted");
    if (g.has_accessibility_needs) row(container, "Accessibility", text(g.accessibility_details) || "Noted");
    $("registered").hidden = false;
    $("registration").hidden = true;
  }

  function openForm(context) {
    if (!agreement()) { status("Guest registration is not configured for live use.", "error"); return; }
    const invited = text(context.invited_email);
    if (invited) {
      const field = $("guest-form").elements.namedItem("email");
      if (field && !field.value) field.value = invited;
      const note = $("email-note");
      note.textContent = `This invitation was sent to ${invited}. You may register under a different address if you prefer.`;
      note.hidden = false;
    }
    $("registration").hidden = false;
    status("Nothing has been submitted yet. Your details are saved only when you confirm your seat.");
  }

  const UNAVAILABLE = {
    invalid: "This invitation link is not valid. Ask your table host to send it to you again.",
    revoked: "This invitation was withdrawn by your table host. Please contact them directly.",
    expired: "This invitation has expired. Ask your table host to send you a new one.",
    unavailable: "This invitation is not open. Email ssuite@salute.community and we will help."
  };

  async function load() {
    if (!invitationToken) { $("invite-lede").textContent = "This page opens from the private link in your invitation email."; status("Open the link in your invitation email to continue. The link is specific to your seat.", "error"); return; }
    if (!base() || !policy() || !String(cfg.turnstileSiteKey || "").trim() || !turnstileAction()) { $("invite-lede").textContent = "Guest registration is not available right now."; status("Guest registration is not configured for live use.", "error"); return; }
    let result;
    try { result = await api({ action: "lookup" }); } catch { status("We could not reach the invitation service. Please check your connection and refresh.", "error"); return; }
    const context = result.body;
    if (!result.ok || !context || typeof context.state !== "string") { status("We could not check your invitation right now. Please refresh in a moment.", "error"); return; }
    if (context.state !== "invalid") renderContext(context);
    if (context.state === "completed") { renderRegistered(context.guest); status("You are registered. You can return to this page whenever you like.", "success"); return; }
    if (context.state !== "open") { status(UNAVAILABLE[context.state] || UNAVAILABLE.unavailable, "error"); return; }
    openForm(context);
  }

  function data(form) {
    const get = (n) => String(form.elements.namedItem(n)?.value || "").trim();
    const primary = get("email").toLowerCase(), secondary = get("secondary_email").toLowerCase();
    const dietary = form.elements.dietary.checked, accessibility = form.elements.accessibility.checked;
    if (!emailPattern.test(primary) || (secondary && (!emailPattern.test(secondary) || secondary === primary))) throw new Error("Enter distinct, valid email addresses.");
    if (dietary && !get("dietary_or_allergy_details")) throw new Error("Describe dietary or allergy needs.");
    if (accessibility && !get("accessibility_details")) throw new Error("Describe accessibility requirements.");
    return { first_name: get("first_name"), last_name: get("last_name"), email: primary, secondary_email: secondary || undefined, job_title: get("job_title"), company: get("company"), meal_preference: get("meal_preference"), has_dietary_or_allergy_needs: dietary, dietary_or_allergy_details: dietary ? get("dietary_or_allergy_details") : undefined, has_accessibility_needs: accessibility, accessibility_details: accessibility ? get("accessibility_details") : undefined };
  }

  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const agreed = form.elements.namedItem("combined_agreement");
    if (!agreed || agreed.checked !== true) { status("Please accept the terms, privacy notice and media release to continue.", "error"); return; }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      status("Confirming your seat…");
      const attendee = data(form);
      const response = await api({ attendee, combined_agreement: agreed.checked === true, turnstile_token: await turnstileToken() });
      if (!response.ok || typeof response.body.attendee_id !== "string") throw new Error(typeof response.body.error === "string" ? response.body.error : "Your registration could not be completed.");
      /* Re-read from the server so the confirmation shows what was actually stored, not what was typed. */
      const confirmed = await api({ action: "lookup" }).catch(() => null);
      if (confirmed && confirmed.ok && confirmed.body && confirmed.body.state === "completed") renderRegistered(confirmed.body.guest);
      else renderRegistered(attendee);
      status("Your seat is confirmed. You can return to this page whenever you like.", "success");
    } catch (err) {
      status(err instanceof Error ? err.message : "Your registration could not be completed.", "error");
      if (widget !== null && window.turnstile && typeof window.turnstile.reset === "function") window.turnstile.reset(widget);
    } finally { button.disabled = false; }
  }

  function toggle(check, details) { check.addEventListener("change", () => { details.hidden = !check.checked; details.querySelector("textarea").required = check.checked; }); }
  toggle($("guest-form").elements.dietary, $("dietary-details"));
  toggle($("guest-form").elements.accessibility, $("accessibility-details"));
  $("guest-form").addEventListener("submit", submit);
  load();
})();
