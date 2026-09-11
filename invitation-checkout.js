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

  /* A table of ten, from this invitation.
   *
   * An invitation covers four seats. Beyond that the answer is a table -- its
   * own tier, at its own price, with its own rules. That used to be a link to
   * the event site, which answered a personal invitation by throwing the
   * reader onto a general marketing page headed "Join the room": the host's
   * name, the invitation and the whole reason they were there vanished at the
   * click. The table checkout is opened here instead, on the invitation, in
   * the same drawer that accepts it.
   *
   * The address stays on the control as a no-JavaScript fallback and is never
   * followed while this file is running.
   */
  const tableChoose = document.querySelector('.choose[data-ticket-code="full_table"]');
  const tableOptions = document.querySelector(".table-options");
  // "invitation" (seats at the host's rate) or "table" (ten seats, one tier).
  let mode = "invitation";
  const activeChoose = () => (mode === "table" && tableChoose ? tableChoose : choose);

  function syncTableLink() {
    const link = document.getElementById("table-invitation");
    if (!link || link.dataset.wired === "true") return;
    link.dataset.wired = "true";
    link.addEventListener("click", (event) => {
      if (!tableChoose || !tableOptions) return;       // fall through to the address
      // A tier that is not open for sale must not be opened as though it were.
      // The shared chain settles that on this same control, so the reader is
      // told nothing this page cannot honour.
      if (tableChoose.disabled) {
        event.preventDefault();
        notify("Tables are not available for purchase right now.");
        return;
      }
      event.preventDefault();
      openTable();
    });
  }
  syncTableLink();
  // The staff preview changes host without reloading; production never calls this.
  window.SSuiteInvitation = { refresh: syncTableLink };

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
    const unit = Number(activeChoose().dataset.price);
    if (!total || !Number.isFinite(unit)) return;
    // A table is one price for ten seats, not a price per head.
    total.textContent = usd(mode === "table" ? unit : unit * seatsChosen());
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
    // A table takes the host's details only. The other nine seats are filled in
    // afterwards, by her, on the private table page.
    const count = mode === "table" ? 1 : seatsChosen();
    guestFields.innerHTML = Array.from({ length: count }, (_, i) => window.ssuiteGuestCard(i, { isMember: false })).join("");
    bindConditionalFields();
    if (tableOptions) tableOptions.hidden = mode !== "table";
    const live = window.SSuiteLive;
    if (live && typeof live.syncAgreementText === "function") live.syncAgreementText();
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
    live.applyPartnerCode().then(mountMemberOption).catch(() => {});
  }

  /* The member rate, offered on an invitation.
   *
   * An invitation prices every seat at the Community rate its code carries. A
   * SALUTE member or alumna who accepts one is still entitled to the member rate
   * on her own seat, and until now this page gave her no way to say so: her
   * choice was to overpay, or to abandon the invitation for the main site, which
   * left her host credited with nothing. One line, ticked by her, applies the
   * member rate to her own seat and leaves her guests on the invitation rate.
   *
   * Nothing here decides whether she is a member. The box states a claim; the
   * server checks it against the member list and refuses before any payment is
   * taken if it cannot be matched.
   */
  function memberRateCents() {
    const live = window.SSuiteLive;
    return live && typeof live.memberRateCents === "function" ? live.memberRateCents() : null;
  }
  function mountMemberOption() {
    const live = window.SSuiteLive;
    if (!live || typeof live.setMemberOnInvitation !== "function") return;
    const cents = memberRateCents();
    let box = document.getElementById("member-invite");
    // No published member rate, or no verified invitation yet: no offer. An
    // offer without a figure behind it could only quote a price of its own.
    if (!cents || !live.partnerState()) { if (box) box.hidden = true; return; }
    const fields = document.getElementById("member-verification");
    if (!box) {
      box = document.createElement("section");
      box.id = "member-invite";
      box.className = "member-verification";
      box.innerHTML = '<label class="check"><input type="checkbox" id="member-invite-toggle"><span>I am a current or former SALUTE member — apply the member rate to my own seat.</span></label><p class="member-note" id="member-invite-note"></p>';
      // Directly above the membership fields, so ticking the box reveals the
      // code and alternate-email boxes immediately beneath it.
      if (fields && fields.parentNode) fields.parentNode.insertBefore(box, fields);
      else {
        const selection = document.querySelector(".selection");
        if (!selection) return;
        selection.insertAdjacentElement("afterend", box);
      }
      document.getElementById("member-invite-toggle").addEventListener("change", (event) => {
        const applied = live.setMemberOnInvitation(event.currentTarget.checked);
        if (event.currentTarget.checked && !applied) {
          event.currentTarget.checked = false;
          notify("The member rate cannot be applied right now. Please write to ssuite@salute.community.");
        }
      });
    }
    const note = document.getElementById("member-invite-note");
    if (note) {
      note.textContent = "Members attend at " + usd(cents / 100) + ". Anyone you bring stays at the rate on your invitation.";
    }
    box.hidden = false;
  }
  document.addEventListener("ssuite:rates", mountMemberOption);

  function showDrawer() {
    backdrop.hidden = false;
    drawer.setAttribute("aria-hidden", "false");
    drawer.scrollTop = 0;
    setTimeout(() => {
      const first = guestFields.querySelector("input");
      if (first) first.focus();
    }, 320);
  }

  function openDrawer() {
    const returning = mode !== "invitation";
    mode = "invitation";
    if (tableOptions) tableOptions.hidden = true;
    const name = document.getElementById("ticket-name");
    if (name) name.textContent = String(choose.dataset.ticket || "Community Ticket");
    const note = document.getElementById("selection-note");
    if (note && !(window.SSuiteLive && window.SSuiteLive.partnerState())) note.textContent = "Your invitation";
    // Seats are not offered until the invitation says how many it covers.
    const wrap = qty.closest(".quantity-wrap");
    if (wrap && !(window.SSuiteLive && window.SSuiteLive.partnerState())) wrap.hidden = true;
    if (returning || !guestFields.children.length) window.renderGuests();
    window.updateTotal();
    showDrawer();
  }

  /* The table checkout, opened on the invitation.
   *
   * Everything that decides anything is the shared chain's, on the shared
   * control: the tier the order is billed on, the ten-seat rules, the price
   * from the database and the October rollover. This only makes the drawer
   * describe a table rather than a set of seats -- and makes sure nothing from
   * the invitation path follows it across.
   */
  function openTable() {
    if (!tableChoose || !tableOptions) return;
    mode = "table";
    const live = window.SSuiteLive;
    // The member rate prices one seat at a member price. A table is one price
    // for ten, so the claim has nothing to attach to and is withdrawn here
    // rather than carried into a tier that would refuse it.
    const toggle = document.getElementById("member-invite-toggle");
    if (toggle) toggle.checked = false;
    if (live && typeof live.setMemberOnInvitation === "function") live.setMemberOnInvitation(false);
    const memberBox = document.getElementById("member-invite");
    if (memberBox) memberBox.hidden = true;
    // Who this table is credited to. Set before the shared handler runs, because
    // that is what writes the line saying so. It changes no price.
    if (live && typeof live.setTableInvitation === "function") {
      live.setTableInvitation({
        code: invitationCode(), host: hostName(),
        note: "Your table is recorded to " + hostName() + "’s invitation. The price is unchanged.",
      });
    }
    // Ten seats, fixed. The selector is not offered and must not leave a stale
    // answer behind it for anything else to read.
    const wrap = qty.closest(".quantity-wrap");
    if (wrap) wrap.hidden = true;
    qty.value = "1";
    tableChoose.click();
    const name = document.getElementById("ticket-name");
    if (name) name.textContent = String(tableChoose.dataset.ticket || "Table for ten");
    const note = document.getElementById("selection-note");
    if (note) note.textContent = "Full table registration";
    window.renderGuests();
    window.updateTotal();
    showDrawer();
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
