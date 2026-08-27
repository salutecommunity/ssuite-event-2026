/* Read-only registration receipt.
 *
 * Accepts either the private receipt token from the confirmation email (#token=)
 * or the Stripe Checkout session the buyer was returned with (?session_id=).
 * The credential is stripped from the address bar immediately and is never stored.
 * This page states only what the server reports from the authoritative order record;
 * it never asserts a payment, registration, or delivery on its own. */
(() => {
  "use strict";
  const cfg = window.SSUITE_CONFIG || {};
  const byId = (id) => document.getElementById(id);
  const tokenPattern = /^[0-9a-f]{64}$/;
  const sessionPattern = /^cs_(live|test)_[A-Za-z0-9]{8,320}$/;

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

    const name = typeof data.first_name === "string" && data.first_name.trim() ? data.first_name.trim() : "";
    rows.replaceChildren();
    row(rows, "Order reference", data.reference || "");
    row(rows, "Offering", offering(data.items));
    row(rows, state === "refunded" ? "Amount charged" : "Amount paid", money(data.total_cents, data.currency));
    row(rows, "Paid on", data.paid_on || "");
    if (state === "refunded") row(rows, "Refunded on", data.refunded_on || "");
    row(rows, "Registered to", data.purchaser_name || "");
    row(rows, "Confirmation sent to", data.email_masked || "");

    if (state === "refunded") {
      eyebrow.textContent = "Refunded order";
      heading.textContent = "This order has been refunded.";
      lede.textContent = "This receipt is kept for your records. The registration attached to this order is no longer active.";
      setStatus("This order was refunded. No admission is held against it.", "error");
      next.textContent = "If you believe this refund was made in error, please write to ssuite@salute.community.";
      panel.hidden = false;
      return true;
    }

    eyebrow.textContent = "Payment confirmed";
    heading.textContent = name ? `Thank you, ${name}. You're registered.` : "Thank you. You're registered.";
    lede.textContent = "Your payment was received and your registration for the S.Suite Honors Ceremony is confirmed. Please keep this receipt for your records.";
    setStatus("Payment verified and registration confirmed.", "success");
    next.textContent = data.email_masked
      ? `A confirmation email has been queued to ${data.email_masked}. Event details and arrival information will follow closer to the date.`
      : "Event details and arrival information will follow closer to the date.";
    panel.hidden = false;
    return true;
  }

  async function lookup(attempt) {
    const base = apiBase();
    if (!base) { setStatus("This receipt page is not configured. Please write to ssuite@salute.community.", "error"); return; }
    try {
      const response = await fetch(`${base}/functions/v1/checkout-status`, {
        method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(credential),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload) {
        setStatus("We could not load this receipt right now. Please try again shortly, or write to ssuite@salute.community.", "error");
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

  document.addEventListener("DOMContentLoaded", () => {
    const print = byId("print-receipt");
    if (print) print.addEventListener("click", () => window.print());
    if (!credential) {
      byId("receipt-heading").textContent = "This page needs your private link.";
      setStatus("Open this page using the private link in your confirmation email. If you no longer have it, write to ssuite@salute.community and we will resend it.", "error");
      return;
    }
    lookup(0);
  });
})();
