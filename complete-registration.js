(() => {
  "use strict";
  const cfg = window.SSUITE_CONFIG || {}, $ = (id) => document.getElementById(id), emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const TOKEN_PATTERN = /^[0-9a-f]{64}$/i, TOKEN_STORE = "ssuite.registration.completion";

  /* The token arrives in the URL fragment and is removed from the address bar immediately.
     It is kept in session storage so a refresh, a back navigation or a second visit from the
     same email still works: this link is meant to be usable more than once. */
  function readToken() {
    const fromLink = new URLSearchParams(location.hash.slice(1)).get("token") || "";
    if (TOKEN_PATTERN.test(fromLink)) { try { sessionStorage.setItem(TOKEN_STORE, fromLink.toLowerCase()); } catch { /* storage unavailable */ } return fromLink.toLowerCase(); }
    try { const stored = sessionStorage.getItem(TOKEN_STORE) || ""; if (TOKEN_PATTERN.test(stored)) return stored.toLowerCase(); } catch { /* storage unavailable */ }
    return "";
  }

  let completionToken = readToken(), widget = null, loading = null;
  history.replaceState(null, "", `${location.pathname}${location.search}`);

  const text = (value) => (typeof value === "string" ? value.trim() : "");
  function base() { try { const u = new URL(String(cfg.apiBase || "")); return (cfg.mode === "live" || cfg.mode === "isolated-staging") && u.protocol === "https:" ? u.origin : ""; } catch { return ""; } }
  function turnstileAction() { const value = String(cfg.turnstileAction || "").trim(); return /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value : ""; }
  function policy() { const p = cfg.policy || {}; try { const urls = [new URL(p.termsUrl), new URL(p.privacyUrl), new URL(p.mediaReleaseUrl)]; return urls.every((u) => u.protocol === "https:") && [p.termsVersion, p.privacyVersion, p.mediaReleaseVersion].every((v) => typeof v === "string" && v.trim()) ? p : null; } catch { return null; } }
  function reveal(el) { const box = el.getBoundingClientRect(); if (box.top < 0 || box.bottom > window.innerHeight) el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  function status(message, type = "") { const el = $("status"); el.textContent = message; el.className = `notice ${type}`; el.hidden = !message; if (message) reveal(el); }

  function agreement() { const p = policy(), slot = $("policy-agreement"); if (!p) return false; const label = document.createElement("label"), check = document.createElement("input"), span = document.createElement("span"); const documents = [["Event Terms & Conditions", "./event-terms.html"], ["Event Privacy Notice", "./event-privacy.html"], ["Media, Photo & Video Release", "./media-release.html"]]; label.className = "check"; check.type = "checkbox"; check.name = "combined_agreement"; check.required = true; span.append("I agree to the "); for (const [name, href] of documents) { const a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = name; span.append(a, document.createTextNode(name === "Media, Photo & Video Release" ? "." : ", ")); } label.append(check, span); slot.replaceChildren(label); return true; }

  function loadTurnstile() { if (window.turnstile && typeof window.turnstile.render === "function") return Promise.resolve(window.turnstile); if (loading) return loading; if (window.turnstile && typeof window.turnstile.render !== "function") { try { delete window.turnstile; } catch { window.turnstile = undefined; } } loading = new Promise((resolve, reject) => { const s = document.createElement("script"); s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; s.async = true; s.defer = true; s.onload = () => window.turnstile && typeof window.turnstile.render === "function" ? resolve(window.turnstile) : reject(new Error("The security check could not load. Please refresh the page and try again.")); s.onerror = () => reject(new Error("The security check could not load. Please refresh the page and try again.")); document.head.append(s); }); return loading; }
  /* Everything about the act of finishing is reported directly above the button that was pressed.
     The page-level notice lives in the first card, well off screen once someone has scrolled down
     to the button, so a message delivered there reads as nothing happening at all. */
  function formStatus(message, type = "") {
    const el = $("form-status");
    if (!el) { status(message, type); return; }
    el.textContent = message; el.className = `notice form-notice${type ? ` ${type}` : ""}`; el.hidden = !message;
    if (message) reveal(el);
  }
  function setFinishEnabled(enabled) { const button = $("finish-registration"); if (button) button.disabled = !enabled; }
  function hasSecurityToken() { try { return Boolean(window.turnstile && widget !== null && window.turnstile.getResponse(widget)); } catch { return false; } }

  async function renderTurnstile() {
    const api = await loadTurnstile();
    if (widget === null) {
      const action = turnstileAction();
      if (!action) throw new Error("Registration is temporarily unavailable. Please write to ssuite@salute.community and we will finish this for you.");
      const options = {
        sitekey: String(cfg.turnstileSiteKey || ""), action,
        /* The button stays unavailable until the check has actually produced a token. Pressing a
           second too early would otherwise be refused for a reason shown off screen, while the
           check itself then turns green — which looks exactly like a finished registration. */
        callback: () => { setFinishEnabled(true); formStatus(""); },
        "error-callback": () => { setFinishEnabled(false); formStatus("The security check could not complete. Please refresh the page, or email ssuite@salute.community and we will finish this for you.", "error"); },
        /* Tokens lapse after a few minutes, so a slow, careful reader is not punished for it: the
           check refreshes silently and the button returns on its own. */
        "expired-callback": () => { setFinishEnabled(false); formStatus("The security check expired while this page was open. Refreshing it now — one moment."); try { api.reset(widget); } catch { /* refreshed on the next attempt */ } }
      };
      widget = api.render($("turnstile-widget"), options);
    }
    return api;
  }
  async function turnstileToken() { const api = await renderTurnstile(); const result = api.getResponse(widget); if (!result) throw new Error("The security check has not finished yet. It refreshes by itself — please try again in a moment."); return result; }

  async function api(payload) {
    const response = await fetch(`${base()}/functions/v1/registration-completion`, { method: "POST", mode: "cors", credentials: "omit", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ completion_token: completionToken, ...payload }) });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, body };
  }

  /* What they already hold, before anything is asked of them. A table host is told their
     table is paid and waiting; nobody is asked to re-establish what the event already knows. */
  const ROLE_LEDE = {
    table_host: "To finalize your registration, we need a few details from you. Your table is already reserved.",
    table_guest: "To finalize your registration, we need a few details from you. Your seat is already held.",
    attendee: "To finalize your registration and proceed to table assignments, we need a few details from you."
  };

  function renderContext(context) {
    const event = (context && context.event) || {}, role = text(context.role) || "attendee";
    const table = context && typeof context.table === "object" && context.table ? context.table : null;
    $("context-eyebrow").textContent = role === "table_host" ? "Your table" : "Your registration";
    if (context.state === "open") $("context-lede").textContent = ROLE_LEDE[role] || ROLE_LEDE.attendee;

    const date = text(event.display_date), venue = [text(event.venue_name), text(event.city)].filter(Boolean).join(", ");
    if (date || venue) {
      $("meta-date").textContent = date || "To be confirmed";
      $("meta-venue").textContent = venue || "To be confirmed";
      if (table) {
        $("meta-holding-label").textContent = role === "table_host" ? "Your table" : "Your seating";
        $("meta-holding").textContent = text(table.name) || "Reserved";
        $("meta-holding-row").hidden = false;
      }
      // Without a table there are two facts, not three: let the row sit as a pair
      // rather than leaving an empty cell where a start time is not yet published.
      $("context-meta").classList.toggle("two-up", !table);
      $("context-meta").hidden = false;
    }
  }

  function row(container, label, value) {
    const clean = text(value); if (!clean) return;
    const wrap = document.createElement("div"), span = document.createElement("span"), strong = document.createElement("strong");
    span.textContent = label; strong.textContent = clean; wrap.append(span, strong); container.append(wrap);
  }

  const MEALS = ["Vegetarian", "Non-vegetarian"];
  let editing = false, onFile = null, canEdit = false, cutoffDisplay = "", role = "attendee", portalUrl = "";

  function regStatus(message, tone) {
    const el = $("registered-status");
    el.textContent = message || ""; el.hidden = !message;
    el.className = "notice" + (tone ? ` ${tone}` : "");
  }

  function addRow(container, label, node) {
    const wrap = document.createElement("div"), span = document.createElement("span");
    span.textContent = label; wrap.append(span, node); container.append(wrap);
  }

  function control(spec, value) {
    const holder = document.createElement("div"); holder.className = "field-control";
    let field;
    if (spec.type === "select") {
      field = document.createElement("select");
      for (const option of ["", ...spec.options]) {
        const el = document.createElement("option");
        el.value = option; el.textContent = option || "Select one"; field.append(el);
      }
    } else {
      field = document.createElement(spec.type === "textarea" ? "textarea" : "input");
      if (spec.type && spec.type !== "textarea") field.type = spec.type;
      if (spec.placeholder) field.placeholder = spec.placeholder;
    }
    field.name = spec.key;
    field.value = text(value);
    if (spec.required) field.required = true;
    if (spec.max) field.maxLength = spec.max;
    field.setAttribute("aria-label", spec.label);
    holder.append(field);
    if (spec.note) { const note = document.createElement("small"); note.className = "row-note"; note.textContent = spec.note; holder.append(note); }
    return holder;
  }

  /* One list. "Edit details" turns the values in that same list into inputs rather than
     opening a second copy of the form underneath it. */
  function renderRows() {
    const container = $("registered-rows"); container.replaceChildren();
    const g = onFile || {};
    if (editing) {
      const pair = document.createElement("div"); pair.className = "name-pair";
      pair.append(control({ key: "first_name", label: "First name", required: true, max: 120 }, g.first_name),
                  control({ key: "last_name", label: "Last name", required: true, max: 120 }, g.last_name));
      addRow(container, "Name", pair);
      const held = document.createElement("div"); held.className = "field-control";
      const shown = document.createElement("strong"); shown.textContent = text(g.email);
      const why = document.createElement("small"); why.className = "row-note";
      why.textContent = "Your email is where this link was sent, so our team updates it for you. Write to ssuite@salute.community.";
      held.append(shown, why);
      addRow(container, "Email", held);
      addRow(container, "Secondary email", control({ key: "secondary_email", label: "Secondary email", type: "email", max: 254, placeholder: "Optional — assistant or alternate email" }, g.secondary_email));
      addRow(container, "Job title", control({ key: "job_title", label: "Job title", required: true, max: 160 }, g.job_title));
      addRow(container, "Company", control({ key: "company", label: "Company", required: true, max: 160 }, g.company));
      addRow(container, "Meal preference", control({ key: "meal_preference", label: "Meal preference", type: "select", required: true, options: MEALS }, g.meal_preference));
      addRow(container, "Allergies / dietary needs", control({ key: "dietary_or_allergy_details", label: "Allergies or dietary needs", type: "textarea", max: 500, placeholder: "Leave blank if none" }, g.has_dietary_or_allergy_needs ? g.dietary_or_allergy_details : ""));
      addRow(container, "Accessibility needs", control({ key: "accessibility_details", label: "Accessibility needs", type: "textarea", max: 500, placeholder: "Leave blank if none" }, g.has_accessibility_needs ? g.accessibility_details : ""));
    } else {
      row(container, "Name", [text(g.first_name), text(g.last_name)].filter(Boolean).join(" "));
      row(container, "Email", g.email);
      row(container, "Secondary email", g.secondary_email);
      row(container, "Job title", g.job_title);
      row(container, "Company", g.company);
      row(container, "Meal preference", g.meal_preference);
      row(container, "Allergies / dietary needs", g.has_dietary_or_allergy_needs ? (text(g.dietary_or_allergy_details) || "Noted") : "None noted");
      row(container, "Accessibility needs", g.has_accessibility_needs ? (text(g.accessibility_details) || "Noted") : "None noted");
    }
    $("view-actions").hidden = editing || !canEdit;
    $("edit-actions").hidden = !editing;
    const help = $("registered-help");
    if (canEdit && cutoffDisplay) help.textContent = `You can change these details yourself until ${cutoffDisplay}. Can no longer attend? Email ssuite@salute.community and we will take care of it.`;
    else if (!canEdit && cutoffDisplay) help.textContent = `Details were final on ${cutoffDisplay}, so this list can no longer be edited here. If something needs to change, or you can no longer attend, email ssuite@salute.community and we will take care of it.`;
    else help.textContent = "Need to change anything, or can no longer attend? Email ssuite@salute.community and we will take care of it.";
  }

  function renderTable() {
    const actions = $("table-actions"), link = $("open-table"), help = $("table-help");
    if (role === "table_host" && portalUrl) {
      link.href = portalUrl;
      actions.hidden = false;
      help.textContent = "Your table opens here: name it, invite your guests and see who has accepted. Keep the email this link came from — it is how you get back in on another device.";
      help.hidden = false;
    } else {
      actions.hidden = true;
      help.hidden = true;
    }
  }

  function renderRegistered(details, context, options) {
    onFile = details || {};
    const ctx = context || {};
    canEdit = ctx.can_edit === true;
    cutoffDisplay = text(ctx.details_cutoff_display);
    role = text(ctx.role) || role;
    editing = false;
    $("registered-heading").textContent = role === "table_host" ? "Your registration is complete, and your table is open." : "Your registration is complete.";
    $("registered-lede").textContent = options && options.justFinished
      ? "This is what we now have on file for you."
      : "This is what we have on file for you. Nothing further is needed.";
    renderTable();
    renderRows();
    $("registered").hidden = false;
    $("registration").hidden = true;
  }

  function openForm(context) {
    if (!agreement()) { status("Registration is temporarily unavailable. Please write to ssuite@salute.community and we will finish this for you.", "error"); return; }
    const form = $("completion-form"), a = (context && context.attendee) || {};
    const set = (name, value) => { const field = form.elements.namedItem(name); if (field && !field.value) field.value = text(value); };
    set("first_name", a.first_name); set("last_name", a.last_name);
    set("job_title", a.job_title); set("company", a.company); set("secondary_email", a.secondary_email);
    if (text(a.email)) { const note = $("email-note"); note.textContent = `Your registration is held under ${text(a.email)}. To use a different address, write to ssuite@salute.community.`; note.hidden = false; }
    if (context.needs_how_heard === true) $("how-heard-field").hidden = false;
    const note = $("agreement-note");
    note.textContent = role === "table_host"
      ? "Accepting covers you and the guests you seat at your table. Each guest you invite also accepts for themselves when they register."
      : "This agreement is yours alone.";
    note.hidden = false;
    $("registration").hidden = false;
    setFinishEnabled(false);
    formStatus("One moment — finishing the security check. Finish my registration becomes available as soon as it clears.");
    renderTurnstile().catch(() => { setFinishEnabled(false); formStatus("The security check could not load, so this cannot be completed here right now. Please refresh the page, or email ssuite@salute.community and we will finish this for you.", "error"); });
    /* A check that never resolves must not leave someone watching a message that never changes and
       a button that never wakes up. It normally clears in a second or two; if it has not, say what
       to look for and give a way through. If it clears later, its own callback takes over. */
    window.setTimeout(() => { if (!hasSecurityToken()) formStatus("The security check has not cleared yet. If it shows a box to tick, please tick it. If it never finishes, some networks and browser privacy extensions block it — try refreshing or another browser, or email ssuite@salute.community and we will finish this for you."); }, 15000);
    status("");
  }

  const UNAVAILABLE = {
    invalid: "This link is not valid. Email ssuite@salute.community and we will send you a new one.",
    revoked: "This link is no longer active. Email ssuite@salute.community and we will send you a new one.",
    expired: "This link has expired. Email ssuite@salute.community and we will send you a new one.",
    unavailable: "This registration cannot be completed here. Email ssuite@salute.community and we will help."
  };

  let lastContext = null;

  async function load() {
    if (!completionToken) { $("context-lede").textContent = "This page opens from the private link we sent you."; status("Open the link in your email to continue. The link is specific to you.", "error"); return; }
    if (!base() || !policy() || !String(cfg.turnstileSiteKey || "").trim() || !turnstileAction()) { $("context-lede").textContent = "Registration is not available right now."; status("Registration is temporarily unavailable. Please write to ssuite@salute.community and we will finish this for you.", "error"); return; }
    let result;
    try { result = await api({ action: "lookup" }); } catch { status("We could not reach the registration service. Please check your connection and refresh.", "error"); return; }
    const context = result.body; lastContext = context;
    if (!result.ok || !context || typeof context.state !== "string") { status("We could not open your registration right now. Please refresh in a moment.", "error"); return; }
    role = text(context.role) || "attendee";
    if (context.state !== "invalid") renderContext(context);
    if (context.state === "completed") {
      portalUrl = text(context.table_portal_url);
      renderRegistered(context.attendee, context);
      status("You are registered. You can return to this page whenever you like.", "success");
      return;
    }
    if (context.state !== "open") { status(UNAVAILABLE[context.state] || UNAVAILABLE.unavailable, "error"); return; }
    openForm(context);
  }

  function data(form) {
    const get = (n) => String(form.elements.namedItem(n)?.value || "").trim();
    const secondary = get("secondary_email").toLowerCase();
    const own = text((lastContext && lastContext.attendee && lastContext.attendee.email) || "").toLowerCase();
    const dietary = form.elements.dietary.checked, accessibility = form.elements.accessibility.checked;
    if (secondary && (!emailPattern.test(secondary) || secondary === own)) throw new Error("Please enter a valid secondary email that is different from your own address.");
    if (dietary && !get("dietary_or_allergy_details")) throw new Error("Please tell us about your dietary or allergy needs.");
    if (accessibility && !get("accessibility_details")) throw new Error("Please tell us what you need us to arrange.");
    return { first_name: get("first_name"), last_name: get("last_name"), email: own, secondary_email: secondary || undefined, job_title: get("job_title"), company: get("company"), meal_preference: get("meal_preference"), has_dietary_or_allergy_needs: dietary, dietary_or_allergy_details: dietary ? get("dietary_or_allergy_details") : undefined, has_accessibility_needs: accessibility, accessibility_details: accessibility ? get("accessibility_details") : undefined };
  }

  async function submit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const agreed = form.elements.namedItem("combined_agreement");
    if (!agreed || agreed.checked !== true) { formStatus("Please accept the terms, privacy notice and media release to continue.", "error"); return; }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      formStatus("Finishing your registration…");
      const attendee = data(form);
      const howHeard = String(form.elements.namedItem("how_heard")?.value || "").trim();
      const response = await api({ attendee, how_heard: howHeard || undefined, combined_agreement: agreed.checked === true, turnstile_token: await turnstileToken() });
      if (!response.ok || typeof response.body.attendee_id !== "string") throw new Error(typeof response.body.error === "string" ? response.body.error : "Your registration could not be completed.");
      portalUrl = text(response.body.table_portal_url);
      /* Re-read from the server so the confirmation shows what was actually stored, not what was typed. */
      const confirmed = await api({ action: "lookup" }).catch(() => null);
      if (confirmed && confirmed.ok && confirmed.body && confirmed.body.state === "completed") {
        lastContext = confirmed.body;
        if (!portalUrl) portalUrl = text(confirmed.body.table_portal_url);
        renderRegistered(confirmed.body.attendee, confirmed.body, { justFinished: true });
      } else renderRegistered(attendee, lastContext, { justFinished: true });
      formStatus("");
      status(role === "table_host" ? "You are registered. Your table is open below." : "You are registered. You can return to this page whenever you like.", "success");
      /* The record replaces the form higher up the page, so bring it into view rather than leaving
         someone looking at the empty space where the button used to be. */
      $("registered").scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (err) {
      formStatus(err instanceof Error ? err.message : "Your registration could not be completed.", "error");
      if (widget !== null && window.turnstile && typeof window.turnstile.reset === "function") window.turnstile.reset(widget);
    } finally {
      /* Only hand the button back while the check still holds a token. After a failure the check is
         reset, and its own callback re-enables the button once the fresh one clears. */
      button.disabled = !hasSecurityToken();
    }
  }

  function editedDetails(form) {
    const get = (n) => String(form.elements.namedItem(n)?.value || "").trim();
    const secondary = get("secondary_email").toLowerCase();
    if (secondary && !emailPattern.test(secondary)) throw new Error("Enter a valid secondary email address.");
    if (secondary && secondary === String(onFile.email || "").toLowerCase()) throw new Error("The secondary email must be different from your own email address.");
    const dietary = get("dietary_or_allergy_details"), accessibility = get("accessibility_details");
    return {
      first_name: get("first_name"), last_name: get("last_name"),
      job_title: get("job_title"), company: get("company"), meal_preference: get("meal_preference"),
      secondary_email: secondary || undefined,
      has_dietary_or_allergy_needs: Boolean(dietary), dietary_or_allergy_details: dietary || undefined,
      has_accessibility_needs: Boolean(accessibility), accessibility_details: accessibility || undefined
    };
  }

  async function saveDetails(event) {
    event.preventDefault();
    if (!editing) return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = $("save-details");
    button.disabled = true;
    try {
      regStatus("Saving your changes…");
      const response = await api({ action: "update", attendee: editedDetails(form) });
      if (!response.ok || response.body.saved !== true) throw new Error(typeof response.body.error === "string" ? response.body.error : "We could not save those changes. Please try again.");
      const confirmed = await api({ action: "lookup" }).catch(() => null);
      if (confirmed && confirmed.ok && confirmed.body && confirmed.body.state === "completed") {
        lastContext = confirmed.body;
        onFile = confirmed.body.attendee || onFile;
        canEdit = confirmed.body.can_edit === true;
        cutoffDisplay = text(confirmed.body.details_cutoff_display);
      }
      editing = false; renderRows();
      regStatus("Your details are updated.", "success");
    } catch (err) {
      regStatus(err instanceof Error ? err.message : "We could not save those changes.", "error");
    } finally { button.disabled = false; }
  }

  $("registered-form").addEventListener("submit", saveDetails);
  $("edit-details").addEventListener("click", () => { editing = true; renderRows(); regStatus("Nothing is saved until you select save changes."); });
  $("cancel-details").addEventListener("click", () => { editing = false; renderRows(); regStatus(""); });

  function toggle(check, details) { check.addEventListener("change", () => { details.hidden = !check.checked; details.querySelector("textarea").required = check.checked; }); }
  toggle($("completion-form").elements.dietary, $("dietary-details"));
  toggle($("completion-form").elements.accessibility, $("accessibility-details"));
  $("completion-form").addEventListener("submit", submit);
  load();
})();
