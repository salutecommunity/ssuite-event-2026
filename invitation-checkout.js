/* Accepting an invitation, on the invitation page.
 *
 * A personal invitation used to hand the reader off to the event site's ticket
 * section: they pressed "Accept this invitation" and arrived on a page of three
 * tiers, being asked to choose. That is a shop, not an acceptance -- and it put
 * a general sale in front of somebody who had already been invited by name.
 *
 * So the registration drawer is mounted here instead. Pressing accept opens it
 * on the invitation itself, with the host's invitation already applied and the
 * rate settled, and the only journey off this page is to Stripe.
 *
 * Everything that decides anything is shared with the event site rather than
 * reimplemented: live-pricing.js supplies the price and the sale state from the
 * database, live-chain.js verifies the invitation, runs the security check,
 * builds the checkout request and hands over to Stripe, and guest-card.js
 * renders the attendee fields. This file is only the glue that index.html keeps
 * inline -- opening, closing, counting seats and totalling -- because that glue
 * is bound to a page's own layout.
 *
 * Load order matters and mirrors index.html: this file before live-chain.js, so
 * that live-chain's quantity handler is registered second and its coded total
 * wins over the tile arithmetic here.
 */
(() => {
  "use strict";

  const drawer = document.querySelector(".checkout-drawer");
  const backdrop = document.querySelector(".drawer-backdrop");
  const form = document.getElementById("registration-form");
  const guestFields = document.getElementById("guest-fields");
  const qty = document.getElementById("ticket-quantity");
  const choose = document.querySelector('.choose[data-ticket-code="community"]');
  if (!drawer || !backdrop || !form || !guestFields || !qty || !choose) return;

  // The invitation this page carries. Baked into the markup at build time, so
  // the page needs no query string and the code never reaches the address bar,
  // the browser history, or a referrer header. Read on use rather than captured
  // once, because the staff preview switches host in place.
  const invitationCode = () => String(document.body.dataset.invitationCode || "").trim();
  const hostName = () => String(document.body.dataset.hostName || "").trim();

  /* The group enquiry, addressed by host.
   *
   * An invitation covers up to four seats. Beyond that the answer is a table of
   * ten, which is not sold from this page -- so the one honest action is to
   * write to us, and the message should arrive already saying whose invitation
   * it came from. Built here rather than baked in so the subject cannot drift
   * from the name in the hero, and the plain address in the sentence still
   * works for anyone whose browser has no mail client.
   */
  function syncEnquiry() {
    const link = document.getElementById("table-enquiry");
    if (!link) return;
    const who = hostName();
    const subject = who ? `A table of ten at S.Suite — invitation from ${who}` : "A table of ten at S.Suite";
    const body = "I would like to bring a group to S.Suite on Friday, November 20. Please tell me about a table of ten.";
    link.href = `mailto:ssuite@salute.community?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }
  syncEnquiry();
  // The staff preview changes host without reloading; production never calls this.
  window.SSuiteInvitation = { refresh: syncEnquiry };

  const toast = document.querySelector(".toast");
  let toastTimer = 0;
  function notify(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  const usd = (amount) => new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(amount);

  function seatsChosen() {
    const wrap = qty.closest(".quantity-wrap");
    if (wrap && wrap.hidden) return 1;
    const chosen = Number(qty.value || 1);
    return Number.isInteger(chosen) && chosen >= 1 ? chosen : 1;
  }

  /* The running total, from the price the buy control carries.
   *
   * live-pricing.js keeps that attribute in step with the database, and
   * live-chain.js recomputes this from the verified invitation rate the moment
   * one is applied. Neither number is written into this file, so the figure on
   * screen is always the figure Stripe will charge.
   */
  window.updateTotal = function updateTotal() {
    const total = document.getElementById("ticket-total");
    const unit = Number(choose.dataset.price);
    if (!total || !Number.isFinite(unit)) return;
    total.textContent = usd(unit * seatsChosen());
  };

  function bindConditionalFields() {
    guestFields.querySelectorAll("[data-detail]").forEach((box) => {
      box.addEventListener("change", () => {
        const field = guestFields.querySelector(`[data-detail-fields="${box.dataset.detail}"]`);
        if (!field) return;
        field.hidden = !box.checked;
        field.querySelectorAll("input,textarea").forEach((input) => { input.required = box.checked; });
      });
    });
  }

  // Called by live-chain.js as well, whenever a verified invitation changes how
  // many people this order covers.
  window.renderGuests = function renderGuests() {
    const count = seatsChosen();
    guestFields.innerHTML = Array.from({ length: count }, (_, i) => window.ssuiteGuestCard(i, { isMember: false })).join("");
    bindConditionalFields();
  };

  /* The code entry, removed from view.
   *
   * The drawer is shared with the event site, where the Community tier asks for
   * an invitation code because a visitor there may hold one. Here the page holds
   * it already. Showing the field would invite someone to type over their own
   * invitation, and printing the code into a visible box would put it on screen
   * in every forwarded screenshot. The applied-rate line stays: that is the
   * confirmation, and it comes from the server.
   */
  function hideCodeEntry() {
    const input = document.getElementById("partner-code");
    const parts = [
      document.getElementById("partner-code-reveal-wrap"),
      document.getElementById("partner-code-eyebrow"),
      document.getElementById("partner-code-lede"),
      input ? input.closest("label") : null,
      document.getElementById("partner-code-apply") ? document.getElementById("partner-code-apply").closest(".member-note") : null,
    ];
    // Removed from the layout, not marked hidden: these elements carry classes
    // whose own display rules overrule the hidden attribute, so the attribute
    // alone left the code box on screen with the invitation typed into it.
    parts.forEach((part) => { if (part) { part.hidden = true; part.style.display = "none"; } });
    const fields = document.getElementById("partner-code-fields");
    if (fields) fields.hidden = false;
  }

  /* Apply the host's invitation.
   *
   * Runs after the shared handler has set the tier and built the code fields,
   * which is why it is deferred rather than called inline. The invitation is
   * checked by the server -- nothing here decides a price -- and if it cannot
   * be applied the submit control stays held and the reason is shown in the
   * drawer, before any details are typed and before any payment.
   */
  function applyInvitation() {
    hideCodeEntry();
    const live = window.SSuiteLive;
    if (!live || typeof live.applyPartnerCode !== "function") return;
    if (live.partnerState()) return;
    const input = document.getElementById("partner-code");
    const code = invitationCode();
    if (!input || !code) return;
    input.value = code;
    live.applyPartnerCode().catch(() => {});
  }

  function openDrawer() {
    const name = document.getElementById("ticket-name");
    if (name) name.textContent = String(choose.dataset.ticket || "Community Ticket");
    const note = document.getElementById("selection-note");
    if (note && !(window.SSuiteLive && window.SSuiteLive.partnerState())) note.textContent = "Your invitation";
    // Seats are not offered until the invitation says how many it covers.
    const wrap = qty.closest(".quantity-wrap");
    if (wrap && !(window.SSuiteLive && window.SSuiteLive.partnerState())) wrap.hidden = true;
    if (!guestFields.children.length) window.renderGuests();
    window.updateTotal();
    backdrop.hidden = false;
    drawer.setAttribute("aria-hidden", "false");
    drawer.scrollTop = 0;
    setTimeout(() => {
      const first = guestFields.querySelector("input");
      if (first) first.focus();
    }, 320);
  }

  function closeDrawer() {
    drawer.setAttribute("aria-hidden", "true");
    backdrop.hidden = true;
  }

  choose.addEventListener("click", () => {
    openDrawer();
    // After the shared click handler has run.
    setTimeout(applyInvitation, 0);
  });

  qty.addEventListener("change", () => { window.renderGuests(); window.updateTotal(); });

  const close = drawer.querySelector(".close");
  if (close) close.addEventListener("click", closeDrawer);
  backdrop.addEventListener("click", closeDrawer);
  addEventListener("keydown", (event) => { if (event.key === "Escape") closeDrawer(); });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    if (window.SSuiteLive && window.SSuiteLive.checkoutEnabled()) {
      window.SSuiteLive.submitCheckout(event.currentTarget);
      return;
    }
    notify("Secure checkout is unavailable right now. No payment was started and no registration was created.");
  });

  // The three agreement documents are rewritten to real URLs by live-chain.js
  // once it confirms they exist. Until then they must not open a dead link.
  document.querySelectorAll(".legal-consent a").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (link.dataset.policyLink && window.SSuiteLive && window.SSuiteLive.policy()) return;
      event.preventDefault();
      notify("Policy documents are unavailable in this preview.");
    });
  });

  // Somebody who stopped at Stripe comes back here. The shared chain writes the
  // "no payment was completed" line into the drawer, so the drawer has to be
  // open for them to read it -- and their details are still in front of them.
  const held = document.getElementById("checkout-submit");
  if (held) held.dataset.gatedPrompt = "Applying your invitation\u2026";
  if (new URLSearchParams(location.search).get("checkout") === "cancel") {
    setTimeout(() => { openDrawer(); setTimeout(applyInvitation, 0); }, 0);
  }
})();
