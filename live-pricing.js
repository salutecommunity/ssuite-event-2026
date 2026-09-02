/* Live pricing display.
 *
 * Every price on this page is billed from the event database at the moment of
 * purchase. The prices written into the HTML are only a starting point, and they
 * go stale the instant early-bird pricing rolls over. This script replaces them
 * with what checkout will actually charge, so the page can never quote a number
 * the buyer is not billed.
 *
 * It is deliberately fail-safe: if the lookup does not answer, or answers with
 * anything it cannot fully verify, it changes nothing and the page renders exactly
 * as shipped. A stale price is bad; a blank or half-written price is worse.
 */
(() => {
  "use strict";
  const cfg = window.SSUITE_CONFIG || {};

  function text(value) { return typeof value === "string" ? value.trim() : ""; }

  function apiBase() {
    const value = text(cfg.apiBase).replace(/\/$/, "");
    if (!value) return "";
    try {
      const url = new URL(value);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      return (url.protocol === "https:" || (url.protocol === "http:" && local)) && !url.username && !url.password ? url.origin : "";
    } catch { return ""; }
  }

  const usd = (cents) => new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(cents / 100);

  function isPositiveInteger(value) {
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
  }

  // A tier is only usable if it carries a real, whole-cent price we can render and
  // hand to the drawer's total. Anything else is ignored rather than guessed at.
  function usableTicket(ticket) {
    return Boolean(ticket)
      && typeof ticket.code === "string" && /^[a-z0-9_]{1,64}$/.test(ticket.code)
      && isPositiveInteger(ticket.amount_cents)
      && (ticket.compare_at_cents === null || isPositiveInteger(ticket.compare_at_cents));
  }

  function applyTicket(ticket) {
    const button = document.querySelector(`.choose[data-ticket-code="${ticket.code}"]`);
    if (!button) return;
    const card = button.closest(".ticket-card");

    // The drawer computes its running total from this attribute, so updating it
    // keeps the itemised total and the Stripe charge in step automatically.
    button.dataset.price = String(ticket.amount_cents / 100);
    if (!card) return;

    const price = card.querySelector(".price");
    if (price) price.textContent = usd(ticket.amount_cents);

    // The struck-through figure is a claim of a saving. Show it only while the
    // discount is genuinely live; afterwards the regular price is simply the price.
    const original = card.querySelector(".original-price");
    if (original) {
      if (isPositiveInteger(ticket.compare_at_cents) && ticket.early_bird_active === true) {
        original.hidden = false;
        original.textContent = "";
        const label = document.createElement("span");
        label.className = "sr-only";
        label.textContent = "Original price ";
        original.append(label, document.createTextNode(usd(ticket.compare_at_cents)));
      } else {
        original.hidden = true;
        original.textContent = "";
      }
    }

    const note = card.querySelector(".price-note");
    if (note) note.textContent = ticket.early_bird_active === true ? "Early-bird price" : "Regular price";

    // "EARLY BIRD / INDIVIDUAL" becomes plain "INDIVIDUAL" once the window closes.
    const eyebrow = card.querySelector(".micro");
    if (eyebrow) {
      const base = text(eyebrow.textContent).replace(/^EARLY BIRD\s*\/\s*/i, "");
      if (base) eyebrow.textContent = ticket.early_bird_active === true ? `EARLY BIRD / ${base}` : base;
    }
  }

  function applySalesNote(data) {
    const note = document.getElementById("attend-sales-note");
    if (!note || data.sales_open !== true) return;
    const deadline = text(data.early_bird_last_moment_display);
    note.textContent = data.early_bird_active === true && deadline
      ? `Early-bird pricing is available through ${deadline}. Registration is completed through secure checkout.`
      : "Registration is completed through secure checkout.";
  }

  // Checkout is refused server-side when sales are closed. Mirror that here rather
  // than offering a control that cannot succeed. Only an explicit "closed" disables
  // anything — an unreachable lookup leaves the page exactly as it was.
  function applySalesState(data) {
    if (data.sales_open !== false) return;
    document.querySelectorAll(".choose").forEach((button) => {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      button.textContent = "Sales are closed";
    });
  }

  function applyGuestRate(tickets) {
    const community = tickets.find((ticket) => ticket.code === "community");
    if (!community) return;
    const rate = document.getElementById("member-guest-rate");
    if (rate) rate.textContent = usd(community.amount_cents);
    const total = document.getElementById("ticket-total");
    if (total) total.textContent = usd(community.amount_cents);
  }

  function apply(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.tickets)) return;
    const tickets = data.tickets.filter(usableTicket);
    if (tickets.length === 0) return;
    tickets.forEach(applyTicket);
    applyGuestRate(tickets);
    applySalesNote(data);
    applySalesState(data);
  }

  async function load() {
    const base = apiBase();
    if (!base) return;
    try {
      const response = await fetch(`${base}/functions/v1/event-pricing`, {
        method: "GET", mode: "cors", credentials: "omit", cache: "no-store",
      });
      if (!response.ok) return;
      apply(await response.json());
    } catch {
      // Leave the shipped prices in place. Nothing is claimed that cannot be billed.
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load, { once: true });
  else load();
})();
