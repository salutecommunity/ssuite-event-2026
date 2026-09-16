/* The rate on a partner organization's invitation page.
 *
 * Every other page on this site takes its prices from the public pricing feed.
 * A nonprofit partner rate is deliberately not in that feed -- it is a hidden
 * tier that only a code can reach, and publishing it would put a rate nobody
 * outside the invitation can buy in front of everybody. So this page cannot ask
 * the feed what it costs.
 *
 * It could ask the code gate, which answers for a single code. It deliberately
 * does not: that lookup is rate limited to twelve checks per connection per ten
 * minutes, and the people this page is sent to sit behind one office address. A
 * lookup on every page load would spend the allowance that accepting needs, and
 * the tenth colleague to open the link would be told to wait rather than shown
 * a seat.
 *
 * So the two published figures and the cut-over instant travel in the page, and
 * the right one is chosen here -- the same offline pattern live-pricing.js uses
 * as its own fallback. Both numbers are real, so nothing is invented, and the
 * page stops asserting the early-bird rate the moment it ends.
 *
 * The figure that matters is still the server's. Accepting checks the code, and
 * the drawer prices the order from what came back. When that happens this file
 * reconciles the card with it, so a rate changed in the database corrects
 * itself on screen rather than standing as a quote we would not honour.
 */
(() => {
  "use strict";

  const card = document.querySelector("[data-price-locked]");
  const button = document.querySelector('.choose[data-ticket-code="community"]');
  if (!card || !button) return;

  const row = card.querySelector(".price-row");
  const price = card.querySelector(".price");
  const original = card.querySelector(".original-price");
  const note = card.querySelector(".price-note");
  const eyebrow = card.querySelector(".micro");
  const trouble = document.getElementById("org-rate-trouble");

  const usd = (cents) => new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(cents / 100);

  const cents = (value) => {
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
  };

  const earlyCents = cents(card.dataset.partnerEarlyPrice);
  const regularCents = cents(card.dataset.partnerRegularPrice);
  const cutover = new Date(String(card.dataset.partnerCutover || ""));

  /* Show a rate, or show nothing and say so.
   *
   * A card with no price is a card that quotes nobody wrongly. If the figures
   * did not arrive intact the price stays hidden and the one route that still
   * works is offered instead -- the buy control is only ever enabled by a
   * successful pricing lookup, so nobody is left able to start an order they
   * cannot be quoted for.
   */
  function show(amountCents, compareAtCents, earlyBirdActive) {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      if (row) row.hidden = true;
      if (note) note.hidden = true;
      if (trouble) trouble.hidden = false;
      return;
    }
    if (price) price.textContent = usd(amountCents);
    if (original) {
      const saving = Number.isInteger(compareAtCents) && compareAtCents > amountCents && earlyBirdActive;
      original.hidden = !saving;
      original.textContent = "";
      if (saving) {
        const label = document.createElement("span");
        label.className = "sr-only";
        label.textContent = "Original price ";
        original.append(label, document.createTextNode(usd(compareAtCents)));
      }
    }
    if (note) { note.textContent = earlyBirdActive ? "Early-bird price" : "Regular price"; note.hidden = false; }
    if (eyebrow) {
      const base = String(eyebrow.textContent || "").trim().replace(/^EARLY BIRD\s*\/\s*/i, "");
      if (base) eyebrow.textContent = earlyBirdActive ? `EARLY BIRD / ${base}` : base;
    }
    if (row) row.hidden = false;
    if (trouble) trouble.hidden = true;
    // The drawer's opening total reads this. It is replaced by the verified rate
    // the moment the code is checked, but until then the two must agree.
    button.dataset.price = String(amountCents / 100);
  }

  const earlyBirdActive = !Number.isNaN(cutover.getTime()) && Date.now() < cutover.getTime();
  show(earlyBirdActive ? earlyCents : regularCents, regularCents, earlyBirdActive);

  // The server has now priced this code. Reconcile, quietly.
  document.addEventListener("ssuite:invitation-applied", () => {
    const live = window.SSuiteLive;
    const state = live && typeof live.partnerState === "function" ? live.partnerState() : null;
    if (!state || !Number.isInteger(state.amountCents) || state.amountCents <= 0) return;
    const active = state.amountCents < (regularCents || Infinity);
    show(state.amountCents, regularCents, active);
  });
})();
