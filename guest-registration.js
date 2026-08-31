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

  let invitationToken = readToken();
  history.replaceState(null, "", `${location.pathname}${location.search}`);

  const text = (value) => (typeof value === "string" ? value.trim() : "");
  function base() { try { const u = new URL(String(cfg.apiBase || "")); return (cfg.mode === "live" || cfg.mode === "isolated-staging") && u.protocol === "https:" ? u.origin : ""; } catch { return ""; } }
  function policy() { const p = cfg.policy || {}; try { const urls = [new URL(p.termsUrl), new URL(p.privacyUrl), new URL(p.mediaReleaseUrl)]; return urls.every((u) => u.protocol === "https:") && [p.termsVersion, p.privacyVersion, p.mediaReleaseVersion].every((v) => typeof v === "string" && v.trim()) ? p : null; } catch { return null; } }
  function reveal(el) { const box = el.getBoundingClientRect(); if (box.top < 0 || box.bottom > window.innerHeight) el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  function status(message, type = "") { const el = $("status"); el.textContent = message; el.className = `notice ${type}`; el.hidden = !message; if (message) reveal(el); }

  /* Everything about the act of confirming is reported directly above the button that was pressed.
     The page-level notice sits in the first card, which is several hundred pixels off screen once a
     guest has scrolled down to the button, so a message delivered there reads as nothing happening
     at all: the guest presses confirm, is told something in a place they cannot see, and reasonably
     concludes the page is broken or the seat is taken. */
  function formStatus(message, type = "", source = "attempt") {
    const el = $("form-status");
    if (!el) { status(message, type); return; }
    el.textContent = message; el.className = `notice form-notice${type ? ` ${type}` : ""}`; el.hidden = !message;
    el.dataset.tone = message ? type : "";
    el.dataset.source = message ? source : "";
    if (message) reveal(el);
  }


  function setConfirmEnabled(enabled) { const button = $("confirm-seat"); if (button) button.disabled = !enabled; }

  function agreement() { const p = policy(), slot = $("policy-agreement"); if (!p) return false; const label = document.createElement("label"), check = document.createElement("input"), span = document.createElement("span"); const documents = [["Event Terms & Conditions", "./event-terms.html"], ["Event Privacy Notice", "./event-privacy.html"], ["Media, Photo & Video Release", "./media-release.html"]]; label.className = "check"; check.type = "checkbox"; check.name = "combined_agreement"; check.required = true; span.append("I agree to the "); for (const [name, href] of documents) { const a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = name; span.append(a, document.createTextNode(name === "Media, Photo & Video Release" ? "." : ", ")); } label.append(check, span); slot.replaceChildren(label); return true; }


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

  /* The registered details are a single list. "Edit details" turns the values in that
     same list into inputs, rather than opening a second copy of the form below it.
     Guests may change their own details until the published deadline; the deadline
     itself is enforced by the event system, not by hiding this button. */
  const MEALS = ["Vegetarian", "Non-vegetarian"];
  let editing = false, guestOnFile = null, canEdit = false, cutoffDisplay = "", lastContext = null;

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
    if (spec.note) {
      const note = document.createElement("small"); note.className = "row-note"; note.textContent = spec.note;
      holder.append(note);
    }
    return holder;
  }

  function renderRows() {
    const container = $("registered-rows"); container.replaceChildren();
    const g = guestOnFile || {};
    if (editing) {
      const pair = document.createElement("div"); pair.className = "name-pair";
      pair.append(control({ key: "first_name", label: "First name", required: true, max: 120 }, g.first_name),
                  control({ key: "last_name", label: "Last name", required: true, max: 120 }, g.last_name));
      addRow(container, "Name", pair);
      const held = document.createElement("div"); held.className = "field-control";
      const shown = document.createElement("strong"); shown.textContent = text(g.email);
      const why = document.createElement("small"); why.className = "row-note";
      why.textContent = "Your email is where your invitation was sent, so our team updates it for you. Write to ssuite@salute.community.";
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
    if (canEdit && cutoffDisplay) {
      help.textContent = `You can change these details yourself until ${cutoffDisplay}. Can no longer attend? Email ssuite@salute.community and we will take care of it.`;
    } else if (!canEdit && cutoffDisplay) {
      help.textContent = `Guest details were final on ${cutoffDisplay}, so this list can no longer be edited here. If something needs to change, or you can no longer attend, email ssuite@salute.community and we will take care of it.`;
    } else {
      help.textContent = "Need to change anything, or can no longer attend? Email ssuite@salute.community and we will take care of it.";
    }
  }

  function renderRegistered(guest, context) {
    guestOnFile = guest || {};
    const ctx = context || {};
    canEdit = ctx.can_edit === true;
    cutoffDisplay = text(ctx.details_cutoff_display);
    editing = false;
    renderRows();
    $("registered").hidden = false;
    $("registration").hidden = true;
  }

  function openForm(context) {
    if (!agreement()) { status("Registration is temporarily unavailable. Please write to ssuite@salute.community and we will help you complete it.", "error"); return; }
    const invited = text(context.invited_email);
    if (invited) {
      const field = $("guest-form").elements.namedItem("email");
      if (field) {
        /* The seat is registered under the address the invitation was sent to, and the database
           enforces that exactly. So the field is filled from the invitation and held there.
           It used to be filled only when empty, which let browser autofill drop in a personal
           address; the server then refused the registration and the reason was discarded. */
        field.value = invited;
        field.readOnly = true;
        field.setAttribute("autocomplete", "off");
        field.setAttribute("aria-readonly", "true");
      }
      const note = $("email-note");
      note.textContent = `This invitation was sent to ${invited}. Your seat is held under that address. To use a different one, write to ssuite@salute.community.`;
      note.hidden = false;
    }
    $("registration").hidden = false;
    setConfirmEnabled(true);
    /* The "nothing is saved until you confirm" reassurance lives in the form lede, directly
       above the fields. Repeating it up in the notice region duplicates it and puts a neutral
       statement in the slot reserved for real errors and progress, so it reads as a warning on
       a clean page load. Clear the region instead and leave it for things that actually happen. */
    status("");
  }

  const UNAVAILABLE = {
    invalid: "This invitation link is not valid. Ask your table host to send it to you again.",
    revoked: "This invitation was withdrawn by your table host. Please contact them directly.",
    expired: "This invitation has expired. Ask your table host to send you a new one.",
    unavailable: "This invitation is not open. Email ssuite@salute.community and we will help."
  };

  async function load() {
    if (!invitationToken) { $("invite-lede").textContent = "This page opens from the private link in your invitation email."; status("Open the link in your invitation email to continue. The link is specific to your seat.", "error"); return; }
    if (!base() || !policy()) { $("invite-lede").textContent = "Registration is not available right now."; status("Registration is temporarily unavailable. Please write to ssuite@salute.community and we will help you complete it.", "error"); return; }
    let result;
    try { result = await api({ action: "lookup" }); } catch { status("We could not reach the invitation service. Please check your connection and refresh.", "error"); return; }
    const context = result.body; lastContext = context;
    if (!result.ok || !context || typeof context.state !== "string") { status("We could not check your invitation right now. Please refresh in a moment.", "error"); return; }
    if (context.state !== "invalid") renderContext(context);
    if (context.state === "completed") { renderRegistered(context.guest, context); status("You are registered. You can return to this page whenever you like.", "success"); return; }
    if (context.state !== "open") { status(UNAVAILABLE[context.state] || UNAVAILABLE.unavailable, "error"); return; }
    openForm(context);
  }

  function data(form) {
    const get = (n) => String(form.elements.namedItem(n)?.value || "").trim();
    /* The invitation is authoritative for the primary address. Reading it from the invitation
       rather than the input means no browser autofill, extension or stale value can produce a
       submission the server is bound to reject. */
    const invitedEmail = text(lastContext && lastContext.invited_email).toLowerCase();
    const primary = invitedEmail || get("email").toLowerCase(), secondary = get("secondary_email").toLowerCase();
    const dietary = form.elements.dietary.checked, accessibility = form.elements.accessibility.checked;
    if (!emailPattern.test(primary)) throw new Error("Please enter a valid email address.");
    /* A secondary address that repeats the primary one is what browser autofill produces,
       not a mistake worth stopping a registration over. It is dropped just below. */
    if (secondary && !emailPattern.test(secondary)) throw new Error("Please enter a valid secondary email address, or leave that field blank.");
    if (dietary && !get("dietary_or_allergy_details")) throw new Error("Please tell us about your dietary or allergy needs.");
    if (accessibility && !get("accessibility_details")) throw new Error("Please tell us what you need us to arrange.");
    return { first_name: get("first_name"), last_name: get("last_name"), email: primary, secondary_email: secondary && secondary !== primary ? secondary : undefined, job_title: get("job_title"), company: get("company"), meal_preference: get("meal_preference"), has_dietary_or_allergy_needs: dietary, dietary_or_allergy_details: dietary ? get("dietary_or_allergy_details") : undefined, has_accessibility_needs: accessibility, accessibility_details: accessibility ? get("accessibility_details") : undefined };
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
      formStatus("Confirming your seat…");
      const attendee = data(form);
      const response = await api({ attendee, combined_agreement: agreed.checked === true });
      if (!response.ok || typeof response.body.attendee_id !== "string") throw new Error(typeof response.body.error === "string" ? response.body.error : "Your registration could not be completed.");
      /* Re-read from the server so the confirmation shows what was actually stored, not what was typed. */
      const confirmed = await api({ action: "lookup" }).catch(() => null);
      if (confirmed && confirmed.ok && confirmed.body && confirmed.body.state === "completed") renderRegistered(confirmed.body.guest, confirmed.body);
      else renderRegistered(attendee, lastContext);
      formStatus("");
      status("Your seat is confirmed. You can return to this page whenever you like.", "success");
      /* The confirmation replaces the form higher up the page, so bring it into view instead of
         leaving the guest looking at the empty space where the button used to be. */
      $("registered").scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (err) {
      formStatus(err instanceof Error ? err.message : "Your registration could not be completed.", "error");
    } finally {
      button.disabled = false;
    }
  }

  function editedDetails(form) {
    const get = (n) => String(form.elements.namedItem(n)?.value || "").trim();
    const secondary = get("secondary_email").toLowerCase();
    if (secondary && !emailPattern.test(secondary)) throw new Error("Enter a valid secondary email address.");
    const ownAddress = String(guestOnFile.email || "").toLowerCase();
    const dietary = get("dietary_or_allergy_details"), accessibility = get("accessibility_details");
    return {
      first_name: get("first_name"), last_name: get("last_name"),
      job_title: get("job_title"), company: get("company"), meal_preference: get("meal_preference"),
      secondary_email: secondary && secondary !== ownAddress ? secondary : undefined,
      has_dietary_or_allergy_needs: Boolean(dietary), dietary_or_allergy_details: dietary || undefined,
      has_accessibility_needs: Boolean(accessibility), accessibility_details: accessibility || undefined
    };
  }

  /* A change is only reported as saved once the event system confirms the write, and the
     list is then redrawn from what the server actually holds rather than from the inputs. */
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
        guestOnFile = confirmed.body.guest || guestOnFile;
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
  toggle($("guest-form").elements.dietary, $("dietary-details"));
  toggle($("guest-form").elements.accessibility, $("accessibility-details"));
  $("guest-form").addEventListener("submit", submit);
  load();
})();
