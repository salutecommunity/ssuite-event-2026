/* Registration details: payment record, registration record, and self-service corrections.
 *
 * Accepts either the private receipt token from the confirmation email (#token=)
 * or the Stripe Checkout session the buyer was returned with (?session_id=).
 * The credential is stripped from the address bar immediately and is never stored.
 *
 * The registration details are a single list. "Edit details" turns the values in that
 * same list into inputs in place; it never shows a second copy of the form.
 *
 * This page states only what the server reports from the authoritative records, and it
 * only reports a change as saved after the event system confirms the write and the
 * details are re-read from the server. */
(() => {
  "use strict";
  const cfg = window.SSUITE_CONFIG || {};
  const byId = (id) => document.getElementById(id);
  const tokenPattern = /^[0-9a-f]{64}$/;
  const sessionPattern = /^cs_(live|test)_[A-Za-z0-9]{8,320}$/;
  const MEALS = ["Vegetarian", "Non-vegetarian"];
  const REFERRALS = ["SALUTE community", "S.Suite community or event", "Friend or colleague", "Email", "Social media", "Search", "Other"];
  let latest = null;
  let editing = false;

  function apiBase() {
    const value = (typeof cfg.apiBase === "string" ? cfg.apiBase : "").trim().replace(/\/$/, "");
    if (!value) return "";
    try {
      const url = new URL(value);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      return (url.protocol === "https:" || (url.protocol === "http:" && local)) && !url.username && !url.password ? url.origin : "";
    } catch { return ""; }
  }

  function setStatus(message, kind = "") {
    const el = byId("status");
    if (!el) return;
    el.hidden = false;
    el.textContent = message;
    el.className = `notice${kind ? ` ${kind}` : ""}`;
  }

  function setFormStatus(message, kind = "") {
    const el = byId("form-status");
    if (!el) return;
    el.hidden = !message;
    el.textContent = message;
    el.className = `notice${kind ? ` ${kind}` : ""}`;
  }

  function money(cents, currency) {
    if (typeof cents !== "number" || !Number.isFinite(cents)) return "";
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(cents / 100);
    } catch { return `$${(cents / 100).toFixed(2)}`; }
  }

  /* One row of the details list: a label cell and a value cell. */
  function addRow(container, label, node) {
    const cell = document.createElement("div");
    const key = document.createElement("span");
    key.textContent = label;
    cell.append(key, node);
    container.append(cell);
    return cell;
  }

  function value(text) {
    const el = document.createElement("strong");
    el.textContent = text;
    return el;
  }

  function row(container, label, text) {
    if (!text) return;
    addRow(container, label, value(text));
  }

  function note(text) {
    const el = document.createElement("span");
    el.className = "row-note";
    el.textContent = text;
    return el;
  }

  function control(spec, current) {
    let field;
    if (spec.type === "select") {
      field = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = spec.required ? "Select" : "Prefer not to say";
      field.append(blank);
      for (const option of spec.options) {
        const item = document.createElement("option");
        item.value = option;
        item.textContent = option;
        field.append(item);
      }
    } else if (spec.type === "textarea") {
      field = document.createElement("textarea");
    } else {
      field = document.createElement("input");
      field.type = spec.type || "text";
    }
    field.name = spec.key;
    field.value = current || "";
    if (spec.required) field.required = true;
    if (spec.max) field.maxLength = spec.max;
    if (spec.placeholder) field.placeholder = spec.placeholder;
    if (spec.autocomplete) field.autocomplete = spec.autocomplete;
    field.setAttribute("aria-label", spec.label);
    return field;
  }

  function wrap(...nodes) {
    const holder = document.createElement("div");
    holder.className = "field-control";
    holder.append(...nodes);
    return holder;
  }

  // Take the credential out of the address bar before anything else runs.
  function readCredential() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    const token = (hash.get("token") || "").trim().toLowerCase();
    const query = new URLSearchParams(location.search);
    const session = (query.get("session_id") || "").trim();
    const clean = () => { try { history.replaceState(null, "", location.pathname); } catch { /* ignore */ } };
    if (tokenPattern.test(token)) { clean(); return { token }; }
    if (sessionPattern.test(session)) { clean(); return { session_id: session }; }
    clean();
    return null;
  }

  const credential = readCredential();

  function offering(items) {
    if (!Array.isArray(items) || !items.length) return "";
    return items.map((item) => {
      const description = typeof item.description === "string" ? item.description : "";
      const quantity = typeof item.quantity === "number" ? item.quantity : 1;
      return quantity > 1 ? `${quantity} × ${description}` : description;
    }).filter(Boolean).join(", ");
  }

  /* Read-only view of the registration: the same rows the edit mode replaces. */
  function renderView(rows, registration, data) {
    const name = [registration.first_name, registration.last_name]
      .filter((part) => typeof part === "string" && part.trim()).join(" ").trim();
    row(rows, "Name", name);
    row(rows, "Email", registration.email || "");
    row(rows, "Secondary email", registration.secondary_email || "");
    row(rows, "Phone", registration.phone || "");
    row(rows, "Job title", registration.job_title || "");
    row(rows, "Company", registration.company || "");
    row(rows, "Meal preference", registration.meal_preference || "");
    row(rows, "Allergies / dietary needs",
      registration.has_dietary_or_allergy_needs ? (registration.dietary_or_allergy_details || "Noted") : "None noted");
    row(rows, "Accessibility needs",
      registration.has_accessibility_needs ? (registration.accessibility_details || "Noted") : "None noted");
    row(rows, "How you heard about us", data.how_heard || "");
    if (typeof data.seats_total === "number" && data.seats_total > 1) {
      row(rows, "Seats on this order", String(data.seats_total));
    }
  }

  /* Edit view: identical rows, with the values replaced by inputs in place. */
  function renderEdit(rows, registration, data) {
    const first = control({ key: "first_name", label: "First name", required: true, max: 120, autocomplete: "given-name", placeholder: "First name" }, registration.first_name);
    const last = control({ key: "last_name", label: "Last name", required: true, max: 120, autocomplete: "family-name", placeholder: "Last name" }, registration.last_name);
    const pair = document.createElement("div");
    pair.className = "name-pair";
    pair.append(first, last);
    addRow(rows, "Name", pair);

    addRow(rows, "Email", wrap(value(registration.email || ""),
      note("Your email is the delivery address for every secure link on this registration, so our team changes it for you. Write to ssuite@salute.community.")));

    addRow(rows, "Secondary email", control({ key: "secondary_email", label: "Secondary email", type: "email", max: 254, placeholder: "Optional — assistant or alternate email" }, registration.secondary_email));
    addRow(rows, "Phone", control({ key: "phone", label: "Phone", type: "tel", max: 100, placeholder: "Optional" }, registration.phone));
    addRow(rows, "Job title", control({ key: "job_title", label: "Job title", required: true, max: 160 }, registration.job_title));
    addRow(rows, "Company", control({ key: "company", label: "Company", required: true, max: 160 }, registration.company));
    addRow(rows, "Meal preference", control({ key: "meal_preference", label: "Meal preference", type: "select", required: true, options: MEALS }, registration.meal_preference));
    addRow(rows, "Allergies / dietary needs", control({ key: "dietary_or_allergy_details", label: "Allergies or dietary needs", max: 500, placeholder: "Leave blank if none" },
      registration.has_dietary_or_allergy_needs ? registration.dietary_or_allergy_details : ""));
    addRow(rows, "Accessibility needs", control({ key: "accessibility_details", label: "Accessibility needs", type: "textarea", max: 500, placeholder: "Leave blank if none" },
      registration.has_accessibility_needs ? registration.accessibility_details : ""));
    addRow(rows, "How you heard about us", control({ key: "how_heard", label: "How you heard about us", type: "select", options: REFERRALS }, data.how_heard));
    if (typeof data.seats_total === "number" && data.seats_total > 1) {
      row(rows, "Seats on this order", String(data.seats_total));
    }
  }

  function renderRegistration(data) {
    const block = byId("registration-block");
    const rows = byId("registration-rows");
    const noteEl = byId("registration-note");
    const registration = data && typeof data.registration === "object" ? data.registration : null;
    if (!registration) { block.hidden = true; return; }

    rows.replaceChildren();
    if (editing) renderEdit(rows, registration, data);
    else renderView(rows, registration, data);

    const seated = typeof data.seats_total === "number" && data.seats_total > 1;
    noteEl.textContent = seated
      ? "These are your own details. The other seats on this order are managed from the private table link sent to the table lead."
      : "";
    noteEl.hidden = !seated;
    byId("view-actions").hidden = editing || data.editable !== true;
    byId("edit-actions").hidden = !editing;
    block.hidden = false;
  }

  function render(data) {
    const heading = byId("receipt-heading");
    const eyebrow = byId("receipt-eyebrow");
    const lede = byId("receipt-lede");
    const panel = byId("receipt");
    const rows = byId("receipt-rows");
    const next = byId("receipt-next");
    const state = data && typeof data.state === "string" ? data.state : "";

    if (state === "pending") {
      heading.textContent = "We are still recording this payment.";
      setStatus("Your payment has not finished recording in the event system yet. This page will keep checking for a few moments.", "");
      return false;
    }

    if (state === "not_found") {
      heading.textContent = "We could not find this registration.";
      setStatus("This link does not match a registration in the event system. It may have expired or been replaced. Please write to ssuite@salute.community and we will help.", "error");
      return true;
    }

    latest = data;
    const name = typeof data.first_name === "string" && data.first_name.trim() ? data.first_name.trim() : "";
    rows.replaceChildren();
    row(rows, "Order reference", data.reference || "");
    row(rows, "Offering", offering(data.items));
    row(rows, state === "refunded" ? "Amount charged" : "Amount paid", money(data.total_cents, data.currency));
    row(rows, "Paid on", data.paid_on || "");
    if (state === "refunded") row(rows, "Refunded on", data.refunded_on || "");
    row(rows, "Confirmation sent to", data.email_masked || "");

    renderRegistration(data);

    if (state === "refunded") {
      eyebrow.textContent = "Refunded order";
      heading.textContent = "This order has been refunded.";
      lede.textContent = "This record is kept for your reference. The registration attached to this order is no longer active.";
      setStatus("This order was refunded. No admission is held against it.", "error");
      next.textContent = "If you believe this refund was made in error, please write to ssuite@salute.community.";
      panel.hidden = false;
      return true;
    }

    eyebrow.textContent = "Payment confirmed";
    heading.textContent = name ? `Thank you, ${name}. You're registered.` : "Thank you. You're registered.";
    lede.textContent = "Your payment was received and your registration for the S.Suite Honors Ceremony is confirmed. Please check the details below and keep this page for your records.";
    setStatus("Payment verified and registration confirmed.", "success");
    next.textContent = data.email_masked
      ? `A confirmation email has been sent to ${data.email_masked}. Event details and arrival information will follow closer to the date.`
      : "Event details and arrival information will follow closer to the date.";
    panel.hidden = false;
    return true;
  }

  async function lookup(attempt) {
    const base = apiBase();
    if (!base) { setStatus("This page is not configured. Please write to ssuite@salute.community.", "error"); return; }
    try {
      const response = await fetch(`${base}/functions/v1/checkout-status`, {
        method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(credential),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload) {
        setStatus("We could not load these details right now. Please try again shortly, or write to ssuite@salute.community.", "error");
        return;
      }
      const settled = render(payload);
      if (!settled && attempt < 10) setTimeout(() => lookup(attempt + 1), 3000);
      else if (!settled) {
        setStatus("Your payment is still being recorded. Your confirmation email will arrive once it completes. If you do not receive it, write to ssuite@salute.community with your name.", "");
      }
    } catch {
      setStatus("We could not reach the event system. Please check your connection and try again.", "error");
    }
  }

  function setEditing(open) {
    editing = open;
    setFormStatus("");
    if (latest) renderRegistration(latest);
    if (open) {
      const first = byId("registration-form").elements.first_name;
      if (first) first.focus();
    }
  }

  async function save(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!editing) return;
    if (!form.reportValidity()) return;
    if (!latest || !latest.registration || !latest.registration.attendee_id) return;
    const base = apiBase();
    if (!base) { setFormStatus("This page is not configured. Please write to ssuite@salute.community.", "error"); return; }

    const read = (field) => String(form.elements.namedItem(field)?.value ?? "").trim();
    const dietary = read("dietary_or_allergy_details");
    const accessibility = read("accessibility_details");
    const buttons = form.querySelectorAll("button");
    buttons.forEach((button) => { button.disabled = true; });
    setFormStatus("Saving your changes…");
    try {
      const response = await fetch(`${base}/functions/v1/registration-update`, {
        method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...credential,
          attendee_id: latest.registration.attendee_id,
          registration: {
            first_name: read("first_name"), last_name: read("last_name"),
            job_title: read("job_title"), company: read("company"),
            secondary_email: read("secondary_email"), phone: read("phone"),
            meal_preference: read("meal_preference"), how_heard: read("how_heard"),
            has_dietary_or_allergy_needs: Boolean(dietary), dietary_or_allergy_details: dietary,
            has_accessibility_needs: Boolean(accessibility), accessibility_details: accessibility,
          },
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.saved !== true) {
        setFormStatus(payload && typeof payload.error === "string" ? payload.error : "We could not save those changes. Please try again.", "error");
        return;
      }
      // Re-read from the server so the page shows the stored record, not the typed one.
      editing = false;
      await lookup(0);
      setFormStatus("");
      setStatus("Your registration details have been updated.", "success");
    } catch {
      setFormStatus("We could not reach the event system. Please check your connection and try again.", "error");
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const print = byId("print-receipt");
    if (print) print.addEventListener("click", () => window.print());
    byId("registration-form").addEventListener("submit", save);
    byId("edit-registration").addEventListener("click", () => setEditing(true));
    byId("cancel-registration").addEventListener("click", () => setEditing(false));

    if (!credential) {
      byId("receipt-heading").textContent = "This page needs your private link.";
      setStatus("Open this page using the private link in your confirmation email. If you no longer have it, write to ssuite@salute.community and we will resend it.", "error");
      return;
    }
    lookup(0);
  });
})();
