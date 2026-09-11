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

  /* Where this tier's price is displayed.
   *
   * The event site shows it on a .ticket-card. The personal invitation pages
   * show it on their own card, which deliberately does not carry that class --
   * it has its own design and picking up the grid's styling would wreck it. So
   * the container is identified by intent rather than by appearance, and any
   * page that marks one gets live prices, a live early-bird state and the
   * October rollover for free.
   */
  function priceCard(button) { return button.closest(".ticket-card, [data-price-display]"); }

  function applyTicket(ticket) {
    const button = document.querySelector(`.choose[data-ticket-code="${ticket.code}"]`);
    if (!button) return;
    const card = priceCard(button);

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
    // (Prices quoted in running text are handled separately, by applyQuotedPrices.)
    const eyebrow = card.querySelector(".micro");
    if (eyebrow) {
      const base = text(eyebrow.textContent).replace(/^EARLY BIRD\s*\/\s*/i, "");
      if (base) eyebrow.textContent = ticket.early_bird_active === true ? `EARLY BIRD / ${base}` : base;
    }
  }

  /* A price quoted inside a sentence.
   *
   * The invitation pages mention the price of a table of ten in prose, on a page
   * that sells no table and therefore has no tile for the lookup above to fill.
   * A figure typed into that sentence would be honest today and wrong on
   * 1 October, so the sentence ships without one: the wrapper is hidden, and it
   * is revealed only once a live price has actually been written into it. An
   * unreachable lookup leaves the sentence priced by nobody rather than priced
   * wrongly, and the address beside it still works.
   */
  function applyQuotedPrices(tickets) {
    document.querySelectorAll("[data-live-price]").forEach((slot) => {
      const wanted = text(slot.dataset.livePrice);
      const ticket = tickets.find((candidate) => candidate.code === wanted);
      if (!ticket) return;
      slot.textContent = usd(ticket.amount_cents);
      const wrap = slot.closest("[data-live-price-wrap]");
      if (wrap) wrap.hidden = false;
    });
  }

  function applySalesNote(data) {
    const note = document.getElementById("attend-sales-note");
    if (!note || data.sales_open !== true) return;
    const deadline = text(data.early_bird_last_moment_display);
    note.textContent = data.early_bird_active === true && deadline
      ? `Early-bird pricing through ${deadline}.`
      : "";
    note.hidden = !note.textContent;
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
    /* The drawer's running total belongs to whoever owns the chosen tier.
     *
     * Priming it with the Community rate was only ever meant to fill the figure
     * before anything is chosen. This pass runs twice -- once from the shipped
     * prices and again when the lookup answers -- so somebody who opened the
     * drawer in between had their total overwritten: a member choosing the $275
     * ticket was shown $350 as their total while Stripe would charge $275.
     * Once a tier is chosen the figure is set by the drawer (or by the verified
     * code rate), and this pass must leave it alone.
     */
    const name = document.getElementById("ticket-name");
    const chosen = (!!name && text(name.textContent) !== "Event ticket")
      || document.querySelector(".checkout-drawer")?.getAttribute("aria-hidden") === "false";
    if (chosen) return;
    const total = document.getElementById("ticket-total");
    if (total) total.textContent = usd(community.amount_cents);
  }

  /* Per-tier sale window.
   *
   * A tier can be withheld from public sale while the event as a whole is selling
   * -- a members-first registration period, for example. This is server truth and
   * moves in both directions, so reopening a tier is one database update with no
   * redeploy. The shipped markup starts from the withheld state, so the first paint
   * never offers a control the server would refuse, and an unreachable lookup fails
   * towards not selling rather than towards a checkout that errors.
   */
  function applySaleWindows(data) {
    const tickets = Array.isArray(data.tickets) ? data.tickets : [];
    tickets.forEach((ticket) => {
      if (typeof ticket.code !== "string" || !/^[a-z0-9_]{1,64}$/.test(ticket.code)) return;
      const button = document.querySelector(`.choose[data-ticket-code="${ticket.code}"]`);
      if (!button) return;
      const card = priceCard(button);
      const note = card ? card.querySelector(".sale-window-note") : null;
      const isOpen = ticket.public_sale_open !== false;
      button.dataset.publicSaleOpen = isOpen ? "true" : "false";

      if (isOpen) {
        if (note) { note.hidden = true; note.textContent = ""; }
        const label = text(button.dataset.liveLabel);
        if (data.sales_open === true && label) {
          button.disabled = false;
          button.removeAttribute("aria-disabled");
          button.textContent = label;
        }
        return;
      }

      const withheld = text(button.dataset.withheldLabel);
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      if (withheld) button.textContent = withheld;
      if (note) {
        const sentence = text(ticket.public_sale_note);
        if (sentence) { note.textContent = sentence; note.hidden = false; }
        else { note.hidden = true; note.textContent = ""; }
      }
    });

    // Member guest seats are governed separately, so closing the Community tier to
    // the public does not strand a member part-way through bringing guests.
    document.body.dataset.guestSeatsOpen = data.member_guest_seats_open === false ? "false" : "true";
  }

  /* Per-tier access gate.
   *
   * A listed tier can be open to everyone or sold by invitation, and that is a
   * database fact, not a fact about this file. Community is sold by invitation:
   * the tile has to say so, the buy control has to ask for a code rather than
   * open an order the server would refuse, and the "request an invitation" door
   * has to appear. Reverting to an open tier is the same single update in the
   * other direction, with no redeploy.
   *
   * Both eligibility lines ship hidden. Exactly one is revealed here, so a
   * visitor whose lookup never answers is told nothing rather than told the
   * wrong thing -- and the buy controls stay disabled in that case anyway.
   */
  function applyAccessGate(data) {
    const tickets = Array.isArray(data.tickets) ? data.tickets : [];
    tickets.forEach((ticket) => {
      if (typeof ticket.code !== "string" || !/^[a-z0-9_]{1,64}$/.test(ticket.code)) return;
      const button = document.querySelector(`.choose[data-ticket-code="${ticket.code}"]`);
      if (!button) return;
      const gated = ticket.access_code_required === true;
      const saleOpen = ticket.public_sale_open !== false;
      button.dataset.accessCodeRequired = gated ? "true" : "false";

      const card = button.closest(".ticket-card");
      if (card) {
        card.querySelectorAll("[data-eligibility]").forEach((line) => {
          const wanted = gated ? "gated" : "open";
          line.hidden = line.dataset.eligibility !== wanted;
        });
      }

      // The request door is only offered for a tier that is both gated and
      // actually selling. Asking for an invitation to something withheld from
      // sale would be a request nobody can fulfil.
      document.querySelectorAll(`[data-request-invitation="${ticket.code}"]`).forEach((request) => {
        request.hidden = !(gated && saleOpen && data.sales_open === true);
      });

      if (gated && saleOpen && data.sales_open === true) {
        const label = text(button.dataset.gatedLabel);
        if (label) button.textContent = label;
      }
    });
  }

  // Nothing here can quote a price or open a purchase, so say what is true and
  // give people the one route that still works.
  function showUnavailableNote() {
    const note = document.getElementById("attend-sales-note");
    if (!note) return;
    note.innerHTML = "";
    note.append(
      document.createTextNode("Registration cannot be opened in this browser right now. Please email "),
    );
    const link = document.createElement("a");
    link.href = "mailto:ssuite@salute.community";
    link.textContent = "ssuite@salute.community";
    note.append(link, document.createTextNode(" and we will register you."));
  }

  /* The rates, where another script can read them.
   *
   * An invitation page shows one tier, so it has no buy control carrying the
   * member rate -- and offering a member rate needs the figure. Publishing what
   * the server already returned keeps that number in one place: no second
   * lookup, and nothing on the page quoting a price of its own.
   */
  function publish(tickets) {
    const rates = {};
    tickets.forEach((ticket) => {
      const cents = Number(ticket.amount_cents);
      if (typeof ticket.code === "string" && Number.isFinite(cents) && cents > 0) rates[ticket.code] = cents;
    });
    window.SSuiteRates = rates;
    document.dispatchEvent(new CustomEvent("ssuite:rates"));
  }

  function apply(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.tickets)) return false;
    const tickets = data.tickets.filter(usableTicket);
    if (tickets.length === 0) return false;
    tickets.forEach(applyTicket);
    publish(tickets);
    applyGuestRate(tickets);
    applyQuotedPrices(tickets);
    applySalesNote(data);
    applySaleWindows(data);
    applyAccessGate(data);
    applySalesState(data);
    return true;
  }

  /* Offline safety net.
   *
   * The lookup above is authoritative, but it can fail — an outage, a tightened
   * origin allowlist, a blocked request. Failing back to the figures written into
   * the HTML is only safe while those figures are current; once early-bird ends
   * they become a quote we would not honour. So each tier also carries both of its
   * published prices and the cut-over instant, and this pass picks the right one
   * before the network is consulted. Both numbers are real and already public, so
   * nothing is invented — the page simply stops asserting a discount that ended.
   *
   * It relies on the visitor's clock, which is why it is a fallback and not the
   * source of truth: the server response overrides it moments later.
   */
  function shippedTickets() {
    const tickets = [];
    document.querySelectorAll(".choose[data-price-cutover]").forEach((button) => {
      const code = text(button.dataset.ticketCode);
      const cutover = new Date(text(button.dataset.priceCutover));
      const early = Number(button.dataset.earlyPrice);
      const regular = Number(button.dataset.regularPrice);
      if (!/^[a-z0-9_]{1,64}$/.test(code) || Number.isNaN(cutover.getTime())) return;
      if (!Number.isFinite(early) || !Number.isFinite(regular) || early <= 0 || regular <= 0) return;
      const earlyBirdActive = Date.now() < cutover.getTime();
      tickets.push({
        code,
        amount_cents: Math.round((earlyBirdActive ? early : regular) * 100),
        compare_at_cents: earlyBirdActive ? Math.round(regular * 100) : null,
        early_bird_active: earlyBirdActive,
      });
    });
    return tickets;
  }

  function applyShipped() {
    const tickets = shippedTickets().filter(usableTicket);
    if (tickets.length === 0) return;
    tickets.forEach(applyTicket);
    applyGuestRate(tickets);
    applyQuotedPrices(tickets);
  }

  async function load() {
    applyShipped();
    const base = apiBase();
    if (!base) { showUnavailableNote(); return; }
    try {
      const response = await fetch(`${base}/functions/v1/event-pricing`, {
        method: "GET", mode: "cors", credentials: "omit", cache: "no-store",
      });
      if (!response.ok) { showUnavailableNote(); return; }
      if (!apply(await response.json())) showUnavailableNote();
    } catch {
      // Leave the shipped prices in place. Nothing is claimed that cannot be
      // billed -- and because the buy controls are only ever enabled from a
      // successful lookup, they stay closed. Say so, with a way through.
      showUnavailableNote();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load, { once: true });
  else load();
})();
