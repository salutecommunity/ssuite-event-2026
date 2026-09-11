/* Public checkout integration. Tokens are held only in the Turnstile widget and
 * request body; this file never writes them to storage, URLs, or analytics. */
(() => {
  "use strict";
  const cfg = window.SSUITE_CONFIG || {};
  const byId = (id) => document.getElementById(id);
  const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const tokenPattern = /^[0-9a-f]{64}$/i;

  function text(value) { return typeof value === "string" ? value.trim() : ""; }
  function validAbsoluteHttps(value) {
    try { const url = new URL(value); return url.protocol === "https:" ? url.toString() : ""; } catch { return ""; }
  }
  function apiBase() {
    const value = text(cfg.apiBase).replace(/\/$/, "");
    if (!value) return "";
    try {
      const url = new URL(value);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      return (url.protocol === "https:" || (url.protocol === "http:" && local)) && !url.username && !url.password ? url.origin : "";
    } catch { return ""; }
  }
  function policy() {
    const p = cfg.policy;
    if (!p || typeof p !== "object") return null;
    const result = {
      termsUrl: validAbsoluteHttps(p.termsUrl), privacyUrl: validAbsoluteHttps(p.privacyUrl),
      mediaReleaseUrl: validAbsoluteHttps(p.mediaReleaseUrl), termsVersion: text(p.termsVersion),
      privacyVersion: text(p.privacyVersion), mediaReleaseVersion: text(p.mediaReleaseVersion),
    };
    return Object.values(result).every(Boolean) ? result : null;
  }
  function liveReadiness() {
    if (cfg.mode !== "live") return { ok: false, reason: "This site is in preview mode. No registration or payment will be created." };
    if (!apiBase()) return { ok: false, reason: "Checkout is temporarily unavailable. Please try again shortly, or write to ssuite@salute.community." };
    if (!policy()) return { ok: false, reason: "Checkout is temporarily unavailable. Please try again shortly, or write to ssuite@salute.community." };
    if (!text(cfg.turnstileSiteKey)) return { ok: false, reason: "Checkout is temporarily unavailable. Please try again shortly, or write to ssuite@salute.community." };
    return { ok: true, reason: "" };
  }
  function endpoint(name) { return `${apiBase()}/functions/v1/${name}`; }
  function setStatus(message, kind = "") {
    const el = byId("live-checkout-status");
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
    el.dataset.kind = kind;
  }
  function policyLinks() {
    // The public agreement always points to the event-specific, same-origin legal pages.
    // Server configuration still supplies the versions recorded with a live registration.
    //
    // Root-absolute, not relative: this drawer is also mounted on the personal
    // invitation pages at /i/{slug}/, where "./event-terms.html" resolved inside
    // the invitation's own folder and returned a 404. Someone would have been
    // asked to agree to three documents they could not open.
    const pages = { terms: "/event-terms.html", privacy: "/event-privacy.html", media: "/media-release.html" };
    document.querySelectorAll("[data-policy-link]").forEach((link) => {
      const value = pages[link.dataset.policyLink];
      if (!value) return;
      link.href = value;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    });
  }
  function createMemberFields() {
    const selection = document.querySelector(".selection");
    if (!selection || byId("member-verification")) return;
    const section = document.createElement("section");
    section.id = "member-verification";
    section.className = "member-verification";
    section.hidden = true;
    // The member list is checked by email first, so a member registering under
    // her own address needs nothing here at all. The alternate email and the
    // code are fallbacks for the few she cannot be matched on, and they stay
    // collapsed: two optional fields sitting open read as a demand and made
    // members think a code was required. The server is the authority either
    // way and refuses before any payment is taken, so a wrong guess costs
    // nothing.
    section.innerHTML = `<p class="micro">SALUTE MEMBERSHIP</p><p id="member-lede">We check your membership against the email you register with, before any payment is taken. If it is under that address, there is nothing else to do.</p><p class="member-note" id="member-fallback-wrap"><button type="button" class="reveal-link" id="member-fallback-reveal" aria-expanded="false" aria-controls="member-fallback">Membership under a different email, or have a member code?</button></p><div id="member-fallback" hidden><label class="field"><span>MEMBERSHIP EMAIL</span><input id="membership-email" type="email" maxlength="320" autocomplete="email" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="The address your membership is under"></label><label class="field"><span>MEMBER ACCESS CODE</span><input id="member-code" type="text" maxlength="64" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="If you have it to hand"></label><p class="member-note">Either one is enough. ${memberCodeRequestOpen() ? `<button type="button" class="reveal-link" data-request-member-code>Have your code emailed to you</button>.` : ""}</p></div>`;    // The two fields are a fallback, not a requirement: the member list is
    // checked by email first, so most members need neither. Keeping them
    // collapsed stops an optional field from reading as a demand.
    const reveal = section.querySelector("#member-fallback-reveal");
    reveal.addEventListener("click", () => {
      const fields = section.querySelector("#member-fallback");
      fields.hidden = false;
      reveal.setAttribute("aria-expanded", "true");
      section.querySelector("#member-fallback-wrap").hidden = true;
      const first = section.querySelector("#membership-email");
      if (first) first.focus();
    });
    selection.insertAdjacentElement("afterend", section);
  }
  function updateMemberFields(code) {
    createMemberFields();
    const section = byId("member-verification");
    if (!section) return;
    section.hidden = code !== "salute_member";
    section.querySelectorAll("input").forEach((input) => { input.disabled = section.hidden; });
  }
  function ticketCode() { return text(document.querySelector(".checkout-drawer")?.dataset.ticketCode); }

  /* Partner organization access code.
   *
   * The nonprofit partner rate is confidential. It has no tile, the public
   * pricing feed withholds it, and -- deliberately -- its figure appears nowhere
   * in this file. A valid code is the only thing that reveals the price, and the
   * number shown comes from the server's answer to that code. Writing it in here
   * would both put a discounted rate on the public record and go stale the
   * moment early-bird pricing rolls over.
   *
   * It rides on the Community path because that is where someone buying a single
   * seat starts. Nothing is claimed before the code is checked, and the rate the
   * page shows is the rate checkout bills.
   */
  const PARTNER_HOST_TIER = "community";
  const INVITED_LABEL = "Continue with your invitation";
  // The request-a-code door is only offered while the email behind it can
  // actually go out. Offering it otherwise would promise a message the site
  // cannot send.
  const memberCodeRequestOpen = () => {
    const cfg = window.SSUITE_CONFIG || {};
    return !!(cfg.memberCode && cfg.memberCode.enabled === true);
  };
  let partnerRate = null;
  let linkedPartnerCode = "";

  /* A table of ten, bought from a personal invitation.
   *
   * An invitation covers four seats. A larger party is a table, which is its
   * own tier at its own price -- so the invitation page sends the reader here
   * rather than to an email address nobody can answer at midnight. The host
   * travels in session storage, not the address bar: same origin, same tab,
   * and the private code never reaches browser history or a referrer header.
   * It prices nothing. It records who brought the party, exactly as it does on
   * a member registration. If storage is refused the table is still bought --
   * only the credit is lost, and the staff notice then names no invitation
   * rather than guessing at one.
   */
  const TABLE_HANDOFF = "ssuite.table.invitation";
  let tableInvitation = null;
  function readTableInvitation() {
    try {
      const raw = sessionStorage.getItem(TABLE_HANDOFF);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const code = normalizeCode(parsed && parsed.code).slice(0, 64);
      const host = text(parsed && parsed.host).slice(0, 120);
      const at = Number(parsed && parsed.at);
      // An hour is long enough to finish a checkout and short enough that a
      // shared machine cannot credit a stranger table to this host tomorrow.
      if (!code || !host || !Number.isFinite(at) || Date.now() - at > 3600000) return null;
      return { code, host };
    } catch (error) { return null; }
  }
  function syncTableInvitationNote(code) {
    const selection = document.querySelector(".selection");
    if (!selection) return;
    const show = code === "full_table" && tableInvitation !== null;
    let note = byId("table-invitation-note");
    if (!note) {
      if (!show) return;
      note = document.createElement("p");
      note.id = "table-invitation-note";
      note.className = "member-note";
      selection.insertAdjacentElement("afterend", note);
    }
    note.hidden = !show;
    note.textContent = show
      ? "You came from " + tableInvitation.host + "’s invitation. It is recorded with your table, and the price is unchanged."
      : "";
  }

  /* A SALUTE member accepting a personal invitation.
   *
   * An invitation page prices every seat at the Community rate its code carries.
   * A member or alumna who accepts one is still entitled to the member rate on
   * her own seat -- and before this, her only way to it was to abandon the
   * invitation and buy from the main site, which credited her host with nothing.
   * Ticking the box sets this flag: her seat is billed at the member rate, her
   * guests stay at the Community rate the invitation carries, and the invitation
   * still credits the host with the whole party. Membership itself is decided by
   * the server against the member list, exactly as it is everywhere else.
   */
  let memberOnInvitation = false;
  function memberRateCents() {
    const rates = window.SSuiteRates;
    const cents = rates && typeof rates === "object" ? Number(rates.salute_member) : NaN;
    return Number.isFinite(cents) && cents > 0 ? cents : null;
  }
  function memberInviteActive() { return memberOnInvitation && partnerActive() && memberRateCents() !== null; }
  function setMemberOnInvitation(on) {
    // Without a published member rate there is no figure to show and no total to
    // compute, so the offer is simply not made rather than made and mispriced.
    memberOnInvitation = !!on && memberRateCents() !== null;
    createMemberFields();
    const section = byId("member-verification");
    if (section) {
      section.hidden = !memberOnInvitation;
      section.querySelectorAll("input").forEach((input) => { input.disabled = section.hidden; });
    }
    applyPartnerDisplay();
    return memberOnInvitation;
  }

  function normalizeCode(value) { return String(value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase(); }
  function partnerActive() { return partnerRate !== null && ticketCode() === PARTNER_HOST_TIER; }
  function money(cents) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
  }
  function partnerStatus(message) {
    const el = byId("partner-code-status");
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
  }
  function createPartnerFields() {
    const selection = document.querySelector(".selection");
    if (!selection || byId("partner-verification")) return;
    const section = document.createElement("section");
    section.id = "partner-verification";
    section.className = "member-verification";
    section.hidden = true;
    // Community is the open, general-admission tier. An access-code field sitting
    // in its default view made buyers ask whether a code was required at all, so
    // the field is kept behind one quiet line and only the few people who hold a
    // partner code ever open it. Partner links carrying ?code= open it themselves.
    section.innerHTML = `<p class="member-note" id="partner-code-reveal-wrap"><button type="button" class="reveal-link" id="partner-code-reveal" aria-expanded="false" aria-controls="partner-code-fields">Have a code from a partner organization?</button></p><div id="partner-code-fields" hidden><p class="micro" id="partner-code-eyebrow">PARTNER ORGANIZATION</p><p id="partner-code-lede">Enter the code from your invitation and your rate is applied here, before you pay.</p><label class="field"><span id="partner-code-label">ACCESS CODE</span><input id="partner-code" type="text" maxlength="64" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="Code from the organization that invited you"></label><div class="member-note"><button type="button" class="button button-outline" id="partner-code-apply">Apply code</button></div><p class="member-note" id="partner-code-status" role="status" aria-live="polite" hidden></p></div>`;
    selection.insertAdjacentElement("afterend", section);
    byId("partner-code-apply").addEventListener("click", () => { applyPartnerCode().catch(() => {}); });
    byId("partner-code-reveal").addEventListener("click", () => { revealPartnerFields(); byId("partner-code").focus(); });
    const input = byId("partner-code");
    // An edited code must never leave a partner price on screen. The rate is
    // dropped the moment the field stops matching what the server approved.
    input.addEventListener("input", () => {
      if (partnerRate && normalizeCode(input.value) !== partnerRate.code) clearPartnerRate("Code removed. The Community rate applies.");
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      applyPartnerCode().catch(() => {});
    });
  }
  function revealPartnerFields() {
    const fields = byId("partner-code-fields");
    if (fields) fields.hidden = false;
    const reveal = byId("partner-code-reveal");
    if (!reveal) return;
    reveal.setAttribute("aria-expanded", "true");
    if (reveal.parentElement) reveal.parentElement.hidden = true;
  }
  /* Is the chosen tier sold by invitation?
   *
   * Read off the buy control, which live-pricing.js sets from the database. A
   * gated tier cannot be bought without a code, so the field stops being an
   * optional aside and becomes the first thing asked for; an open tier keeps
   * the quiet reveal, so a general-admission buyer is never made to wonder
   * whether they need a code. Neither state is hardcoded here.
   */
  function tierIsGated(code) {
    const button = document.querySelector(`.choose[data-ticket-code="${code}"]`);
    return Boolean(button) && button.dataset.accessCodeRequired === "true";
  }

  function setCodeMode(gated) {
    const revealWrap = byId("partner-code-reveal-wrap");
    const fields = byId("partner-code-fields");
    const eyebrow = byId("partner-code-eyebrow");
    const lede = byId("partner-code-lede");
    const label = byId("partner-code-label");
    const input = byId("partner-code");
    if (!fields) return;
    if (gated) {
      if (revealWrap) revealWrap.hidden = true;
      fields.hidden = false;
      // The field label carries the words; an eyebrow saying the same thing
      // directly above it read as repetition, so it is hidden here.
      if (eyebrow) eyebrow.hidden = true;
      if (lede) lede.textContent = "Your rate is applied here, before you pay. No code? Close this and choose Request an invitation.";
      if (label) label.textContent = "INVITATION CODE";
      if (input) input.placeholder = "Enter your code";
      return;
    }
    if (revealWrap) revealWrap.hidden = false;
    if (eyebrow) { eyebrow.hidden = false; eyebrow.textContent = "PARTNER ORGANIZATION"; }
    if (lede) lede.textContent = "Enter the code from your invitation and your rate is applied here, before you pay.";
    if (label) label.textContent = "ACCESS CODE";
    if (input) input.placeholder = "Code from the organization that invited you";
    const reveal = byId("partner-code-reveal");
    if (reveal && reveal.getAttribute("aria-expanded") !== "true") fields.hidden = true;
  }

  /* A gated tier with no verified code cannot proceed. Say so on the control
   * itself rather than letting someone fill in a whole form and be refused. */
  function syncGateState() {
    const code = ticketCode();
    const gated = tierIsGated(code);
    const form = document.querySelector(".checkout-drawer form");
    const submit = form ? form.querySelector('button[type="submit"]') : null;
    if (!submit) return;
    if (!gated) {
      if (submit.dataset.gateHeld === "true") {
        submit.disabled = false;
        submit.removeAttribute("aria-disabled");
        delete submit.dataset.gateHeld;
        if (submit.dataset.gateLabel) { submit.textContent = submit.dataset.gateLabel; delete submit.dataset.gateLabel; }
      }
      return;
    }
    const verified = partnerRate !== null;
    if (verified) {
      if (submit.dataset.gateHeld === "true") {
        submit.disabled = false;
        submit.removeAttribute("aria-disabled");
        delete submit.dataset.gateHeld;
        if (submit.dataset.gateLabel) { submit.textContent = submit.dataset.gateLabel; delete submit.dataset.gateLabel; }
      }
      return;
    }
    if (submit.dataset.gateHeld !== "true") submit.dataset.gateLabel = submit.textContent;
    submit.dataset.gateHeld = "true";
    submit.disabled = true;
    submit.setAttribute("aria-disabled", "true");
    // A page that applies the invitation for the visitor says so instead of
    // asking them for a code they were never given.
    submit.textContent = text(submit.dataset.gatedPrompt) || "Enter your invitation code to continue";
  }

  function updatePartnerFields(code) {
    createPartnerFields();
    const section = byId("partner-verification");
    if (!section) return;
    const applies = code === PARTNER_HOST_TIER;
    section.hidden = !applies;
    section.querySelectorAll("input").forEach((input) => { input.disabled = !applies; });
    if (applies) setCodeMode(tierIsGated(code));
    syncGateState();
  }
  /* Seats, named as the reader thinks of them.
   *
   * "QUANTITY: 4" asks somebody to work out whether they are one of the four.
   * A host was told they may bring three guests, so the control says exactly
   * that, and the value stays a seat count because that is what the server
   * reserves and what Stripe charges.
   */
  const NUMBER_WORDS = ["zero", "one", "two", "three", "four"];
  const numberWord = (n) => NUMBER_WORDS[n] || String(n);
  function seatOption(seat) {
    const option = document.createElement("option");
    option.value = String(seat);
    option.textContent = seat === 1 ? "Just me" : `Me and ${seat - 1} ${seat === 2 ? "guest" : "guests"}`;
    return option;
  }
  function guestPhrase(limit) {
    const guests = Math.max(0, limit - 1);
    if (guests === 0) return "one seat, your own";
    if (guests === 1) return "you and one guest";
    return `you and up to ${numberWord(guests)} guests`;
  }
  // A member's own seat plus guest seats at the Community rate. Three guests,
  // the same allowance an invitation carries, so no self-service registration
  // seats more than four people. Raise here and in the drawer's options to undo.
  const MEMBER_GUEST_MAX = 3;

  /* How many seats this code may still take, in one place.
   *
   * The cap on a code counts seats, not orders, and the server enforces that.
   * So a code with room for two can buy both in one checkout, and the selector
   * offered here never exceeds what the code actually covers -- a buyer is
   * never shown a quantity that checkout would refuse. An unknown remaining
   * count means one seat.
   */
  function codeSeatLimit() {
    if (!partnerRate) return 1;
    // A null remaining count is not an unknown — the pricing lookup returns null
    // for a code with no overall cap, which is what the shared codes are. Reading
    // it as "one seat left" silently narrowed an uncapped code to a single seat,
    // so a founder's guest could not bring anybody. The per-order cap below, and
    // the server, are what actually limit a single checkout.
    const remaining = Number.isInteger(partnerRate.seatsRemaining) ? partnerRate.seatsRemaining : Infinity;
    // A shared organization code is one seat per checkout, so ten seats cannot
    // be taken by the first two people to open the link. A personal invitation
    // carries the seats it was issued for. The server enforces both.
    const perOrder = Number.isInteger(partnerRate.maxSeatsPerOrder) ? partnerRate.maxSeatsPerOrder : 1;
    return Math.max(1, Math.min(remaining, perOrder, 4));
  }
  function codeSeatsChosen() {
    const quantity = byId("ticket-quantity");
    if (!quantity) return 1;
    const wrap = quantity.closest(".quantity-wrap");
    if (wrap && wrap.hidden) return 1;
    const chosen = Number(quantity.value || 1);
    return Number.isInteger(chosen) && chosen >= 1 ? Math.min(chosen, codeSeatLimit()) : 1;
  }
  // The drawer's own total is computed from the tile price, which is not the
  // price a code carries. Recompute it whenever a coded rate is on screen.
  function applyCodedTotal() {
    if (!partnerRate) return;
    const total = byId("ticket-total");
    if (!total) return;
    const seats = codeSeatsChosen();
    // One member seat, the rest at the invitation rate. The member rate covers
    // the member only; a guest is never billed at it.
    const memberCents = memberInviteActive() ? memberRateCents() : null;
    total.textContent = memberCents === null
      ? money(partnerRate.amountCents * seats)
      : money(memberCents + partnerRate.amountCents * (seats - 1));
  }
  function applyPartnerDisplay() {
    if (!partnerRate) return;
    const limit = codeSeatLimit();
    const name = byId("ticket-name");
    if (name) name.textContent = partnerRate.name || "Nonprofit Partner Ticket";
    const quantity = byId("ticket-quantity");
    if (quantity) {
      // Offer exactly the seats the code still covers, no more.
      const previous = Number(quantity.value || 1);
      quantity.innerHTML = "";
      for (let seat = 1; seat <= limit; seat += 1) quantity.append(seatOption(seat));
      quantity.value = String(Math.min(Math.max(previous, 1), limit));
      const wrap = quantity.closest(".quantity-wrap");
      if (wrap) wrap.hidden = limit <= 1;
    }
    const chosen = codeSeatsChosen();
    /* What the invitation actually covers, said once, in words.
     *
     * "QUANTITY" over a select is a shop's control: it offers a number without
     * saying whether the invitation stretches to cover it, and an invited
     * person reasonably assumes an invitation is for one. So state the
     * allowance from the verified code itself -- the same number the selector
     * offers and the server will accept -- and say that guests are included.
     * Hidden when a code covers a single seat, because then there is nothing
     * to choose and nothing to explain.
     */
    const allowance = byId("seat-allowance");
    if (allowance) {
      if (limit > 1) {
        const allowanceMember = memberInviteActive() ? memberRateCents() : null;
        allowance.textContent = allowanceMember === null
          ? `Your invitation covers ${guestPhrase(limit)} — ${numberWord(limit)} seats at ${money(partnerRate.amountCents)} each, on one registration and one payment. Your guests do not need an invitation of their own.`
          : `Your invitation covers ${guestPhrase(limit)}, on one registration and one payment — your own seat at the SALUTE member rate of ${money(allowanceMember)}, and each guest at ${money(partnerRate.amountCents)}. Your guests do not need an invitation of their own.`;
        allowance.hidden = false;
      } else {
        allowance.textContent = "";
        allowance.hidden = true;
      }
    }
    const note = byId("selection-note");
    if (note) {
      const seatWord = chosen === 1 ? "one seat" : `${chosen} seats`;
      // On a page that carries the invitation for the reader, "Invitation code"
      // names a thing they were never shown and never typed.
      const label = text(document.body.dataset.invitationLabel) || "Invitation code";
      note.textContent = partnerRate.organization ? `${partnerRate.organization} · ${seatWord}` : `${label} · ${seatWord}`;
    }
    // Rebuild the attendee list only when the number of people has changed, so
    // applying a code cannot discard details somebody has already typed.
    if (document.querySelectorAll("#guest-fields .guest-card").length !== chosen && typeof window.renderGuests === "function") {
      window.renderGuests();
    }
    applyCodedTotal();
    const seats = Number.isInteger(partnerRate.seatsRemaining)
      ? ` ${partnerRate.seatsRemaining} ${partnerRate.seatsRemaining === 1 ? "seat remains" : "seats remain"} on this code.`
      : "";
    const who = partnerRate.organization ? `${partnerRate.organization} rate` : "Invitation";
    const covers = chosen === 1 ? "one seat" : `${chosen} seats`;
    const statusMember = memberInviteActive() ? memberRateCents() : null;
    const guestsHere = chosen - 1;
    partnerStatus(statusMember === null
      ? `${who} applied — ${money(partnerRate.amountCents)} per seat, ${covers}.${seats}`
      : `${who} applied with the SALUTE member rate — your seat at ${money(statusMember)}${guestsHere > 0 ? `, ${guestsHere === 1 ? `one guest at ${money(partnerRate.amountCents)}` : `${guestsHere} guests at ${money(partnerRate.amountCents)} each`}` : ""}.${seats}`);
    syncGateState();
  }
  function clearPartnerRate(message) {
    partnerRate = null;
    // The member rate here rides on a verified invitation. With the invitation
    // gone there is nothing to attach it to, and leaving it set would price a
    // seat the server would refuse.
    memberOnInvitation = false;
    const memberSection = byId("member-verification");
    if (memberSection && ticketCode() !== "salute_member") {
      memberSection.hidden = true;
      memberSection.querySelectorAll("input").forEach((input) => { input.disabled = true; });
    }
    const drawer = document.querySelector(".checkout-drawer");
    if (drawer) delete drawer.dataset.partnerCode;
    // The allowance describes a verified invitation. With no invitation applied
    // it would be an unbacked claim about how many seats are available.
    const allowance = byId("seat-allowance");
    if (allowance) { allowance.textContent = ""; allowance.hidden = true; }
    const quantity = byId("ticket-quantity");
    if (quantity) {
      // Restore the tile's own range: dropping a code must not leave the
      // narrower list the code allowed.
      const previous = Number(quantity.value || 1);
      quantity.innerHTML = "";
      for (let seat = 1; seat <= 4; seat += 1) quantity.append(seatOption(seat));
      quantity.value = String(Math.min(Math.max(previous, 1), 4));
    }
    const wrap = quantity ? quantity.closest(".quantity-wrap") : null;
    // On a gated tier there is no quantity to choose until a code says how many
    // seats it covers, so the selector stays out of the way until then.
    if (wrap) wrap.hidden = ticketCode() !== PARTNER_HOST_TIER || tierIsGated(ticketCode());
    const button = document.querySelector(`.choose[data-ticket-code="${PARTNER_HOST_TIER}"]`);
    const name = byId("ticket-name");
    if (name && button && ticketCode() === PARTNER_HOST_TIER) name.textContent = text(button.dataset.ticket) || "Community Ticket";
    const note = byId("selection-note");
    if (note && ticketCode() === PARTNER_HOST_TIER) note.textContent = "Ticket selection";
    if (typeof window.updateTotal === "function") window.updateTotal();
    partnerStatus(message || "");
    syncGateState();
  }
  async function applyPartnerCode() {
    const input = byId("partner-code");
    if (!input) return;
    const code = normalizeCode(input.value);
    if (!code) { clearPartnerRate("Enter your code."); return; }
    const base = apiBase();
    if (!base) { partnerStatus("Codes cannot be checked right now. Please try again shortly, or write to ssuite@salute.community."); return; }
    const apply = byId("partner-code-apply");
    if (apply) apply.disabled = true;
    partnerStatus("Checking your code…");
    try {
      const response = await fetch(`${base}/functions/v1/event-pricing?code=${encodeURIComponent(code)}`, {
        method: "GET", mode: "cors", credentials: "omit", cache: "no-store",
      });
      const payload = response.ok ? await response.json().catch(() => null) : null;
      const state = payload && typeof payload === "object" ? payload.access_code : null;
      if (!state || typeof state !== "object") {
        partnerStatus("Your code could not be checked just now. Please try again shortly, or write to ssuite@salute.community.");
        return;
      }
      if (state.result === "ok" && Number.isInteger(state.amount_cents) && state.amount_cents > 0
          && typeof state.ticket_type_code === "string" && /^[a-z0-9_]{1,64}$/.test(state.ticket_type_code)) {
        partnerRate = {
          code, tier: state.ticket_type_code, organization: text(state.organization), name: text(state.name),
          amountCents: state.amount_cents,
          seatsRemaining: Number.isInteger(state.seats_remaining) ? state.seats_remaining : null,
          maxSeatsPerOrder: Number.isInteger(state.max_seats_per_order) ? state.max_seats_per_order : null,
        };
        const drawer = document.querySelector(".checkout-drawer");
        if (drawer) drawer.dataset.partnerCode = code;
        applyPartnerDisplay();
        return;
      }
      if (state.result === "exhausted") {
        const org = text(state.organization);
        clearPartnerRate(`Every seat on this code has been taken${org ? ` for ${org}` : ""}. Please write to ssuite@salute.community and we will sort it out.`);
        return;
      }
      if (state.result === "rate_limited") {
        clearPartnerRate("Too many code checks from this connection. Please wait a few minutes and try again.");
        return;
      }
      if (state.result === "unavailable") {
        clearPartnerRate("This rate cannot be applied right now. Please write to ssuite@salute.community.");
        return;
      }
      clearPartnerRate("That code is not recognized. Please check it, or write to ssuite@salute.community. If it is your SALUTE member code, choose the SALUTE Member ticket instead.");
    } catch {
      partnerStatus("Your code could not be checked just now. Please try again shortly, or write to ssuite@salute.community.");
    } finally {
      if (apply) apply.disabled = false;
    }
  }
  function turnstileContainer() { return byId("checkout-turnstile"); }
  let turnstileWidget = null;
  let turnstileLoading = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (turnstileLoading) return turnstileLoading;
    turnstileLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true; script.defer = true;
      script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("The security check could not load. Please refresh the page and try again."));
      script.onerror = () => reject(new Error("The security check could not load. Please refresh the page and try again."));
      document.head.appendChild(script);
    });
    return turnstileLoading;
  }
  // Render the challenge without demanding a token yet. Warming and waiting are
  // kept separate so warming early can never surface an error to someone who has
  // not pressed anything.
  async function warmTurnstile() {
    const readiness = liveReadiness();
    if (!readiness.ok) throw new Error(readiness.reason);
    const container = turnstileContainer();
    if (!container) throw new Error("Checkout is temporarily unavailable. Please try again shortly.");
    const api = await loadTurnstile();
    if (turnstileWidget === null) {
      turnstileWidget = api.render(container, {
        sitekey: text(cfg.turnstileSiteKey),
        action: "ssuite_checkout",
        // Clear a stale "complete the check" notice as soon as it is actually complete.
        "callback": () => { const el = byId("live-checkout-status"); if (el && /security check/i.test(el.textContent)) setStatus("", ""); },
        "error-callback": () => setStatus("The security check failed. Please retry.", "error"),
        "expired-callback": () => setStatus("The security check expired. Please retry.", "error"),
      });
    }
    return api;
  }
  async function ensureTurnstile() {
    const api = await warmTurnstile();
    const deadline = Date.now() + 15000;
    for (;;) {
      const response = api.getResponse(turnstileWidget);
      if (response) return response;
      if (Date.now() >= deadline) throw new Error("The security check has not cleared yet. This is usually a browser extension or network blocking it. Please refresh and try again, or write to ssuite@salute.community and we will take it from there.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  function value(form, name) { return text(form.elements.namedItem(name)?.value); }
  function agreedToPolicies(form) {
    const box = form.elements.namedItem("combined_agreement");
    if (!box || box.checked !== true) throw new Error("Please accept the Event Terms & Conditions, Event Privacy Notice, and Media, Photo & Video Release to continue.");
    return true;
  }
  function attendee(form, index) {
    const dietaryFlag = Boolean(form.querySelector(`[data-detail="dietary-${index}"]`)?.checked);
    const accessibilityFlag = Boolean(form.querySelector(`[data-detail="accessibility-${index}"]`)?.checked);
    const primary = value(form, `guest-${index}-email`).toLowerCase();
    const secondary = value(form, `guest-${index}-secondary-email`).toLowerCase();
    if (!emailPattern.test(primary) || (secondary && (!emailPattern.test(secondary) || secondary === primary))) throw new Error("Please enter a valid email address for each attendee, and make sure each one is different.");
    const result = {
      first_name: value(form, `guest-${index}-first`), last_name: value(form, `guest-${index}-last`), email: primary,
      secondary_email: secondary || undefined, phone: value(form, `guest-${index}-phone`) || undefined,
      job_title: value(form, `guest-${index}-title`), company: value(form, `guest-${index}-company`),
      meal_preference: value(form, `guest-${index}-meal`), has_dietary_or_allergy_needs: dietaryFlag,
      dietary_or_allergy_details: dietaryFlag ? value(form, `guest-${index}-dietary`) : undefined,
      has_accessibility_needs: accessibilityFlag, accessibility_details: accessibilityFlag ? value(form, `guest-${index}-accessibility`) : undefined,
    };
    if (!result.first_name || !result.last_name || !result.job_title || !result.company || !result.meal_preference || (dietaryFlag && !result.dietary_or_allergy_details) || (accessibilityFlag && !result.accessibility_details)) throw new Error("Complete all required attendee details.");
    return result;
  }
  function requestBody(form) {
    const p = policy();
    if (!p) throw new Error("Checkout is temporarily unavailable. Please try again shortly, or write to ssuite@salute.community.");
    const code = ticketCode();
    // A verified partner code re-prices this order onto its own tier. One seat
    // per use, no guest seats: the cap counts uses, so a code that could carry
    // extra seats would seat more people than the organization was given.
    const partner = partnerActive() ? partnerRate : null;
    // A member accepting a personal invitation: priced on the member tier for her
    // own seat, Community for her guests, with the invitation carried alongside
    // so the host is still credited for the party she brought.
    const memberInvite = memberInviteActive();
    const table = code === "full_table";
    const member = code === "salute_member";
    // The member rate covers exactly one seat. Any guests a member brings are
    // billed at the open Community rate on the same payment.
    const guestSelect = byId("member-guest-quantity");
    const guestSeats = memberInvite
      ? codeSeatsChosen() - 1
      : (member && guestSelect && !guestSelect.disabled ? Number(guestSelect.value || 0) : 0);
    if (!Number.isInteger(guestSeats) || guestSeats < 0 || guestSeats > MEMBER_GUEST_MAX) throw new Error("Choose a valid number of guest seats.");
    // A gated tier cannot be bought without a verified code. The server refuses
    // it either way; stopping here means nobody fills in a form to be told no.
    if (tierIsGated(code) && !partner) {
      throw new Error("These seats are by invitation. Enter the code from your invitation to continue, or close this and choose Request an invitation.");
    }
    const count = partner ? codeSeatsChosen() : (table ? 1 : (member ? 1 + guestSeats : Number(byId("ticket-quantity")?.value)));
    if (!Number.isInteger(count) || count < 1 || count > (table ? 10 : (member ? 5 : 4))) throw new Error("Choose a valid number of attendees.");
    const attendees = Array.from({ length: count }, (_, i) => attendee(form, i));
    if (new Set(attendees.map((a) => a.email)).size !== attendees.length) throw new Error("Each attendee must have a unique primary email address.");
    const purchaser = attendees[0];
    const howHeard = value(form, "referral-source");
    if (!code || !howHeard) throw new Error("Complete the registration details before checkout.");
    const memberCode = String(byId("member-code")?.value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    // No client-side wall here on purpose. The member list is the primary proof
    // and the browser cannot see it, so demanding a code in front of the server
    // turned every member without one away at the door.
    const membershipEmail = String(byId("membership-email")?.value || "").trim().toLowerCase();
    if (code === "salute_member" && membershipEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(membershipEmail)) {
      throw new Error("Check the membership email address, or leave it blank if your membership is under the email above.");
    }
    return {
      ticket_type_code: memberInvite ? "salute_member" : (partner ? partner.tier : code),
      order_type: table ? "table" : "ticket",
      quantity: table || member || memberInvite ? 1 : count,
      guest_quantity: memberInvite ? guestSeats : (partner ? 0 : guestSeats),
      purchaser: { first_name: purchaser.first_name, last_name: purchaser.last_name, email: purchaser.email, phone: purchaser.phone || undefined },
      member_code: memberInvite ? (memberCode || undefined) : (partner ? partner.code : (code === "salute_member" && memberCode ? memberCode : undefined)),
      // A member on an invitation credits her host; a table bought from an
      // invitation credits the same way. Neither changes what is charged.
      attribution_code: memberInvite ? partner.code : (table && tableInvitation ? tableInvitation.code : undefined),
      membership_email: (code === "salute_member" || memberInvite) && membershipEmail ? membershipEmail : undefined,
      // Self-declared membership stays off: it would price a seat at $275 on an
      // unchecked claim and leave staff to unpick it after the money moved.
      member_attestation: false,
      how_heard: howHeard, attendees, combined_agreement: agreedToPolicies(form),
      terms_version: p.termsVersion, privacy_version: p.privacyVersion, media_release_version: p.mediaReleaseVersion,
      success_url: `${location.origin}/registration.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${location.origin}${location.pathname}?checkout=cancel`,
    };
  }
  /* Stripe's hosted checkout URL carries the session reference. Remember it for this
     tab before handing the buyer over, so that if they return without it in the address
     bar we can still show them their own record rather than a dead end. */
  const RECEIPT_STORE = "ssuite.order.receipt";
  function rememberPendingCheckout(destination) {
    const match = /cs_(?:live|test)_[A-Za-z0-9]{8,320}/.exec(String(destination.pathname || ""));
    if (!match) return;
    try { sessionStorage.setItem(RECEIPT_STORE, JSON.stringify({ session_id: match[0] })); } catch { /* storage unavailable */ }
  }
  function forgetPendingCheckout() {
    try { sessionStorage.removeItem(RECEIPT_STORE); } catch { /* storage unavailable */ }
  }

  async function submitCheckout(form) {
    const readiness = liveReadiness();
    if (!readiness.ok) { setStatus(readiness.reason, "error"); return; }
    const submit = form.querySelector('button[type="submit"]');
    try {
      submit.disabled = true;
      setStatus("Verifying your details and preparing secure checkout…", "working");
      const body = requestBody(form);
      body.turnstile_token = await ensureTurnstile();
      const response = await fetch(endpoint("create-checkout"), {
        method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || typeof payload.checkout_url !== "string") throw new Error(text(payload.error) || "Checkout could not be started. No payment has been completed.");
      const destination = new URL(payload.checkout_url);
      if (destination.protocol !== "https:" || destination.hostname !== "checkout.stripe.com") throw new Error("Checkout could not be opened securely and was stopped. No payment was taken. Please try again, or write to ssuite@salute.community.");
      rememberPendingCheckout(destination);
      setStatus("Redirecting to secure checkout…", "working");
      location.assign(destination.toString());
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Checkout could not be started. No payment has been completed.", "error");
      if (turnstileWidget !== null && window.turnstile) window.turnstile.reset(turnstileWidget);
    } finally { submit.disabled = false; }
  }
  function startForTicket(button) {
    const code = text(button.dataset.ticketCode);
    const drawer = document.querySelector(".checkout-drawer");
    if (drawer) drawer.dataset.ticketCode = code;
    updateMemberFields(code);
    updatePartnerFields(code);
    syncTableInvitationNote(code);
    if (code !== PARTNER_HOST_TIER) {
      // The partner rate lives on the Community path only. Choosing another tier
      // drops it rather than carrying a price into a tier it does not apply to.
      if (partnerRate) clearPartnerRate("");
    } else {
      const input = byId("partner-code");
      if (input && linkedPartnerCode && !normalizeCode(input.value)) {
        // Arrived on a partner invitation link. Fill it in and check it, so the
        // rate is settled before any details are typed.
        revealPartnerFields();
        input.value = linkedPartnerCode;
        applyPartnerCode().catch(() => {});
      } else if (partnerRate) {
        revealPartnerFields();
        applyPartnerDisplay();
      }
    }
    const readiness = liveReadiness();
    const label = button.querySelector(".live-ticket-note");
    if (label) label.textContent = readiness.ok ? "Complete the details above to continue" : "Preview only — checkout is not available here";
    if (readiness.ok) warmTurnstile().catch(() => {});
  }
  function applyLiveLabels() {
    // Preview wording ships as the safe default in the HTML. Only replace it once
    // this deployment is genuinely wired for live payment, so the page never
    // promises a real charge it cannot make, or a preview it will not honour.
    if (!liveReadiness().ok) {
      // The closed state is stated here rather than shipped in the markup.
      // It used to be the other way round, which meant a slow, blocked or
      // failed script left a selling event reading "Ticket sales are not open
      // yet" with every control labelled "Sales opening soon" -- and the only
      // surviving sentence about eligibility mentioning an access code. People
      // read that as invitation-only. The markup is now neutral, so anything
      // that genuinely cannot take a payment has to say so from here.
      const closedNote = byId("attend-sales-note");
      if (closedNote) closedNote.textContent = "Ticket sales are not open yet. Pricing is shown for advance planning; registration and checkout will become available here when sales open.";
      document.querySelectorAll(".choose").forEach((button) => {
        const withheld = text(button.dataset.withheldLabel);
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
        if (withheld) button.textContent = withheld;
      });
      return;
    }
    const note = byId("attend-sales-note");
    // No deadline is asserted here. live-pricing.js adds the early-bird sentence from
    // the event database only while that window is genuinely open, so a stale build
    // can never advertise a discount that has already ended.
    if (note) note.textContent = "Registration is completed through secure checkout.";
    const submit = byId("checkout-submit");
    if (submit) submit.textContent = "Continue to secure checkout";
    const fineprint = byId("checkout-fineprint");
    if (fineprint) fineprint.textContent = "You will be taken to Stripe to complete payment securely. Your registration is confirmed only after your payment is verified.";
    const intro = byId("drawer-intro");
    if (intro) intro.textContent = "Enter each attendee's details. You will then be taken to Stripe to pay securely; your registration is created once your payment is verified.";
    const tableEyebrow = byId("table-head-eyebrow");
    if (tableEyebrow) tableEyebrow.textContent = "TABLE MANAGEMENT";
    const tableTitle = byId("table-head-title");
    if (tableTitle) tableTitle.textContent = "Set up your table.";
    const tableNote = byId("table-head-note");
    if (tableNote) tableNote.textContent = "After your payment is verified, you will receive a private link to manage your table: name it, assign each of your ten seats, invite your guests by email, and resend or revoke a link at any time.";
    const tablePageEyebrow = byId("table-page-eyebrow");
    if (tablePageEyebrow) tablePageEyebrow.textContent = "YOUR PRIVATE TABLE PAGE";
    const tablePageNote = byId("table-page-note");
    if (tablePageNote) tablePageNote.textContent = "10 seats · Guest status · Seating controls";
    // The local sample dashboard is a design preview only; it must not be offered
    // alongside a real purchase that issues a genuine private table page.
    const previewDashboard = byId("preview-dashboard");
    if (previewDashboard) previewDashboard.hidden = true;
    // Purchase controls ship disabled and labelled "Sales opening soon" so the
    // page is never able to start a checkout it cannot complete. They are only
    // enabled once this deployment is genuinely wired for live payment.
    document.querySelectorAll(".choose").forEach((button) => {
      const label = text(button.dataset.liveLabel);
      if (!label) return;
      // A tier can be withheld from public sale while the event as a whole is
      // selling -- a members-first window, for example. Server-side checkout
      // refuses it, so the page must not hand over a control that only errors.
      //
      // This reads as "enable only what is known to be open", not "disable what
      // is known to be closed". The difference matters: this pass runs on
      // DOMContentLoaded, while live-pricing.js learns the per-tier sale window
      // from the event database a few hundred milliseconds later. Treating an
      // unknown state as open enabled a withheld tier for that gap on every
      // single page load, so the control was briefly live before the database
      // answer arrived to take it away again. The shipped markup carries the
      // state for exactly this reason, and anything else now stays disabled
      // until the lookup confirms the tier is selling.
      if (button.dataset.publicSaleOpen !== "true") {
        const withheld = text(button.dataset.withheldLabel);
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
        if (withheld) button.textContent = withheld;
        return;
      }
      button.disabled = false;
      button.removeAttribute("aria-disabled");
      // A tier sold by invitation gets the label that says so. The state is
      // carried in the shipped markup for the same reason the sale window is:
      // this pass runs on DOMContentLoaded and the database answer arrives a
      // few hundred milliseconds later, so an unknown gate would leave a
      // by-invitation tier reading "Choose this ticket" on every page load.
      // live-pricing.js overrides both label and notes from server truth.
      const gatedLabel = text(button.dataset.gatedLabel);
      button.textContent = button.dataset.accessCodeRequired === "true" && gatedLabel ? gatedLabel : label;
    });
    applyShippedGate();
  }

  /* First-paint eligibility, from the shipped state.
   *
   * Both eligibility lines and the request-an-invitation control ship hidden,
   * so a browser with no JavaScript makes no claim about who may buy -- it
   * cannot buy anything either way. This reveals the right one immediately;
   * live-pricing.js re-runs the same decision from the database moments later
   * and wins if the two ever disagree.
   */
  function applyShippedGate() {
    const ready = liveReadiness().ok;
    document.querySelectorAll(".choose").forEach((button) => {
      const code = text(button.dataset.ticketCode);
      if (!code) return;
      const gated = button.dataset.accessCodeRequired === "true";
      const saleOpen = button.dataset.publicSaleOpen === "true";
      const card = button.closest(".ticket-card");
      if (card) {
        card.querySelectorAll("[data-eligibility]").forEach((line) => {
          line.hidden = line.dataset.eligibility !== (gated ? "gated" : "open");
        });
      }
      document.querySelectorAll(`[data-request-invitation="${code}"]`).forEach((request) => {
        request.hidden = !(gated && saleOpen && ready);
      });
    });
  }
  function init() {
    policyLinks();
    const params = new URLSearchParams(location.search);
    // A partner or circle invitation link carries the code. Remember it for the
    // moment the drawer opens; nothing is checked or shown until then.
    linkedPartnerCode = normalizeCode(params.get("code")).slice(0, 64);
    if (linkedPartnerCode) {
      // Someone who followed an invitation link has already been invited. Meeting
      // them with "Enter your invitation code" reads as a refusal of the thing
      // they just accepted, so the control names the next step instead. It makes
      // no claim about the code itself -- that is settled by the server when the
      // drawer opens, and an unusable code is still told so there.
      const invited = document.querySelector(`.choose[data-ticket-code="${PARTNER_HOST_TIER}"]`);
      if (invited) invited.dataset.gatedLabel = INVITED_LABEL;
    }
    tableInvitation = readTableInvitation();
    applyLiveLabels();
    createMemberFields();
    createPartnerFields();
    document.querySelectorAll(".choose").forEach((button) => button.addEventListener("click", () => startForTicket(button)));
    // Arrived from an invitation page asking for a table. The reader already
    // pressed a control that said so, so open that checkout rather than
    // landing them on the page to find it again. Only ever the table: this
    // opens a tier that is public, open, and priced the same for everyone.
    if (params.get("table") === "1") {
      const table = document.querySelector('.choose[data-ticket-code="full_table"]');
      if (table && !table.disabled) table.click();
    }
    // The drawer's own total is computed from the tile price. When a code
    // carries a different rate, that total is wrong the instant the quantity
    // changes, so recompute after the drawer's handler has run. Registered
    // here, after the inline handler, so this one runs second and wins.
    const quantitySelect = byId("ticket-quantity");
    if (quantitySelect) {
      quantitySelect.addEventListener("change", () => {
        if (partnerActive()) applyPartnerDisplay();
      });
    }
    const result = params.get("checkout");
    if (result === "cancel") { forgetPendingCheckout(); setStatus("Checkout was cancelled. No payment was completed.", "error"); }
    if (result === "success") {
      // Hand the buyer to the receipt page, which reports only what the
      // authoritative order record proves. Never confirm anything here.
      const session = text(params.get("session_id"));
      if (/^cs_(live|test)_[A-Za-z0-9]{8,320}$/.test(session)) {
        location.replace(`/registration.html?session_id=${encodeURIComponent(session)}`);
        return;
      }
      // The address bar lost the reference. The receipt page can still recover it from
      // this tab, and if it cannot, it tells the buyer exactly how to reach their record.
      location.replace("/registration.html");
      return;
    }
  }
  window.SSuiteLive = {
    checkoutEnabled: () => liveReadiness().ok, submitCheckout, startForTicket, apiBase, policy, tokenPattern,
    applyPartnerCode, partnerState: () => (partnerRate ? { ...partnerRate } : null),
    setMemberOnInvitation, memberInviteActive, memberRateCents,
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true }); else init();
})();
