/* Registration details: payment record, registration record, and self-service corrections.
 *
 * Accepts either the private receipt token from the confirmation email (#token=)
 * or the Stripe Checkout session the buyer was returned with (?session_id=).
 * The credential is stripped from the address bar immediately and is never stored.
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
  let latest = null;

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

  function row(container, label, value) {
    if (!value) return;
    const cell = document.createElement("div");
    const key = document.createElement("span");
    key.textContent = label;
    const val = document.createElement("strong");
    val.textContent = value;
    cell.append(key, val);
    container.append(cell);
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

  function renderRegistration(data) {
    const block = byId("registration-block");
    const rows = byId("registration-rows");
    const note = byId("registration-note");
    const actions = byId("registration-actions");
    const registration = data && typeof data.registration === "object" ? data.registration : null;
    if (!registration) { block.hidden = true; return; }

    const name = [registration.first_name, registration.last_name]
      .filter((part) => typeof part === "string" && part.trim()).join(" ").trim();
    rows.replaceChildren();
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

    const seated = typeof data.seats_total === "number" && data.seats_total > 1;
    note.textContent = seated
      ? "These are your own details. The other seats on this order are managed from the private table link sent to the table lead."
      : "";
    note.hidden = !seated;
    actions.hidden = data.editable !== true;
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

  function toggleConditional(form) {
    const dietary = form.elements.has_dietary_or_allergy_needs;
    const accessibility = form.elements.has_accessibility_needs;
    byId("dietary-field").hidden = !dietary.checked;
    byId("accessibility-field").hidden = !accessibility.checked;
    form.elements.dietary_or_allergy_details.required = dietary.checked;
    form.elements.accessibility_details.required = accessibility.checked;
  }

  function fillForm(form, registration, howHeard) {
    const set = (field, value) => { if (form.elements[field]) form.elements[field].value = value || ""; };
    set("first_name", registration.first_name);
    set("last_name", registration.last_name);
    set("job_title", registration.job_title);
    set("company", registration.company);
    set("secondary_email", registration.secondary_email);
    set("phone", registration.phone);
    set("meal_preference", registration.meal_preference);
    set("how_heard", howHeard);
    form.elements.has_dietary_or_allergy_needs.checked = registration.has_dietary_or_allergy_needs === true;
    set("dietary_or_allergy_details", registration.dietary_or_allergy_details);
    form.elements.has_accessibility_needs.checked = registration.has_accessibility_needs === true;
    set("accessibility_details", registration.accessibility_details);
    toggleConditional(form);
  }

  function showForm(open) {
    byId("registration-form").hidden = !open;
    byId("registration-actions").hidden = open || !(latest && latest.editable === true);
    byId("registration-rows").hidden = open;
    byId("registration-note").hidden = open || !byId("registration-note").textContent;
    if (!open) setFormStatus("");
  }

  async function save(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    if (!latest || !latest.registration || !latest.registration.attendee_id) return;
    const base = apiBase();
    if (!base) { setFormStatus("This page is not configured. Please write to ssuite@salute.community.", "error"); return; }

    const value = (field) => String(form.elements[field] ? form.elements[field].value : "").trim();
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
            first_name: value("first_name"), last_name: value("last_name"),
            job_title: value("job_title"), company: value("company"),
            secondary_email: value("secondary_email"), phone: value("phone"),
            meal_preference: value("meal_preference"), how_heard: value("how_heard"),
            has_dietary_or_allergy_needs: form.elements.has_dietary_or_allergy_needs.checked,
            dietary_or_allergy_details: value("dietary_or_allergy_details"),
            has_accessibility_needs: form.elements.has_accessibility_needs.checked,
            accessibility_details: value("accessibility_details"),
          },
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.saved !== true) {
        setFormStatus(payload && typeof payload.error === "string" ? payload.error : "We could not save those changes. Please try again.", "error");
        return;
      }
      // Re-read from the server so the page shows the stored record, not the typed one.
      await lookup(0);
      showForm(false);
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
    const form = byId("registration-form");
    form.addEventListener("submit", save);
    form.elements.has_dietary_or_allergy_needs.addEventListener("change", () => toggleConditional(form));
    form.elements.has_accessibility_needs.addEventListener("change", () => toggleConditional(form));
    byId("edit-registration").addEventListener("click", () => {
      if (!latest || !latest.registration) return;
      fillForm(form, latest.registration, latest.how_heard);
      showForm(true);
      form.elements.first_name.focus();
    });
    byId("cancel-registration").addEventListener("click", () => showForm(false));

    if (!credential) {
      byId("receipt-heading").textContent = "This page needs your private link.";
      setStatus("Open this page using the private link in your confirmation email. If you no longer have it, write to ssuite@salute.community and we will resend it.", "error");
      return;
    }
    lookup(0);
  });
})();
