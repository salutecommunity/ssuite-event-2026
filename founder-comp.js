/* Founder complimentary invitation — event.ssuite.org/i/neha-singh-invite/
 *
 * One complimentary seat, for the person registering. The comp is carried by the
 * page itself (no code to type); every rule that matters -- the overall cap, one
 * comp per email, rate limiting, the security check, the staff notices -- is
 * enforced by the server (founder-comp edge function + claim_ssuite_founder_comp).
 *
 * Additional guests (up to three) are never free. They are bought through the
 * ordinary create-checkout endpoint at the current Community price, read live
 * from the pricing feed, on Neha's existing personal invitation code, with the
 * comp holder as purchaser and only the guests as attendees. Registration for
 * those guests exists only after Stripe confirms payment, as on every paid path.
 *
 * Attendee fields come from guest-card.js, the same template the event site
 * uses, so the field names and choices cannot drift from the rest of the site.
 */
(() => {
  "use strict";
  const cfg = window.SSUITE_CONFIG || {};
  const api = (name) => `${String(cfg.apiBase || "").replace(/\/+$/, "")}/functions/v1/${name}`;
  const byId = (id) => document.getElementById(id);
  const PAID_CODE = String(document.body.dataset.paidInvitationCode || "");
  const PAID_PAGE = String(document.body.dataset.paidInvitationPage || "");
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const usd = (cents) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0 })}`;

  const drawer = document.querySelector(".checkout-drawer");
  const backdrop = document.querySelector(".drawer-backdrop");
  const openBtn = byId("fc-open");
  const claimForm = byId("fc-claim-form");
  const addonForm = byId("fc-addon-form");
  const done = byId("fc-done");
  if (!drawer || !backdrop || !openBtn || !claimForm || !addonForm || !done) return;

  let community = null; // { amount_cents, early_bird_active, deadline }
  let claimed = null;   // purchaser details kept in memory after a claim

  /* ---------------------------------------------------------------- drawer */
  function show(panel) {
    for (const p of [claimForm, done, addonForm]) p.hidden = p !== panel;
    drawer.classList.add("open"); drawer.setAttribute("aria-hidden", "false");
    backdrop.hidden = false; document.body.classList.add("drawer-open");
    drawer.scrollTop = 0;
  }
  function close() {
    drawer.classList.remove("open"); drawer.setAttribute("aria-hidden", "true");
    backdrop.hidden = true; document.body.classList.remove("drawer-open");
  }
  drawer.querySelector(".close")?.addEventListener("click", close);
  backdrop.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawer.classList.contains("open")) close(); });

  /* -------------------------------------------------------- attendee cards */
  function card(container, i, label, title) {
    const wrap = document.createElement("div");
    wrap.innerHTML = window.ssuiteGuestCard(i, {});
    const section = wrap.firstElementChild;
    const micro = section.querySelector(".guest-number .micro");
    const strong = section.querySelector(".guest-number strong");
    if (micro) micro.textContent = label;
    if (strong) strong.textContent = title;
    container.appendChild(section);
  }
  function wireConditionals(form) {
    form.addEventListener("change", (e) => {
      const box = e.target;
      if (!(box instanceof HTMLInputElement) || !box.dataset.detail) return;
      const field = form.querySelector(`[data-detail-fields="${box.dataset.detail}"]`);
      if (!field) return;
      field.hidden = !box.checked;
      const input = field.querySelector("input,textarea");
      if (input) { input.required = box.checked; if (!box.checked) input.value = ""; }
    });
  }
  const val = (form, name) => String(form.elements.namedItem(name)?.value || "").trim();
  function attendee(form, i) {
    const diet = Boolean(form.querySelector(`[data-detail="dietary-${i}"]`)?.checked);
    const acc = Boolean(form.querySelector(`[data-detail="accessibility-${i}"]`)?.checked);
    const email = val(form, `guest-${i}-email`).toLowerCase();
    const secondary = val(form, `guest-${i}-secondary-email`).toLowerCase();
    const a = {
      first_name: val(form, `guest-${i}-first`), last_name: val(form, `guest-${i}-last`), email,
      secondary_email: secondary || undefined, phone: val(form, `guest-${i}-phone`),
      job_title: val(form, `guest-${i}-title`), company: val(form, `guest-${i}-company`),
      meal_preference: val(form, `guest-${i}-meal`),
      has_dietary_or_allergy_needs: diet, dietary_or_allergy_details: diet ? val(form, `guest-${i}-dietary`) : undefined,
      has_accessibility_needs: acc, accessibility_details: acc ? val(form, `guest-${i}-accessibility`) : undefined,
    };
    if (!emailPattern.test(email) || (secondary && (!emailPattern.test(secondary) || secondary === email)))
      throw new Error("Please enter a valid email address for each person, and make sure each one is different.");
    if (!a.first_name || !a.last_name || !a.phone || !a.job_title || !a.company || !a.meal_preference ||
        (diet && !a.dietary_or_allergy_details) || (acc && !a.accessibility_details))
      throw new Error("Please complete every required field, including a mobile phone number.");
    return a;
  }

  /* ------------------------------------------------------------- Turnstile */
  let tsLoad;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (tsLoad) return tsLoad;
    tsLoad = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true; s.defer = true;
      s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("unavailable")));
      s.onerror = () => reject(new Error("unavailable"));
      document.head.appendChild(s);
    });
    return tsLoad;
  }
  const widgets = {};
  async function turnstileToken(slotId, action) {
    const ts = await loadTurnstile();
    if (widgets[slotId] === undefined) {
      widgets[slotId] = { token: "", waiters: [] };
      widgets[slotId].id = ts.render(byId(slotId), {
        sitekey: String(cfg.turnstileSiteKey || ""), action,
        callback: (t) => { widgets[slotId].token = t; widgets[slotId].waiters.splice(0).forEach((w) => w(t)); },
        "expired-callback": () => { widgets[slotId].token = ""; },
        "error-callback": () => { widgets[slotId].token = ""; },
      });
    }
    const w = widgets[slotId];
    if (w.token) return w.token;
    return await new Promise((resolve, reject) => {
      w.waiters.push(resolve);
      setTimeout(() => reject(new Error("Please complete the security check above, then press the button again. If it will not complete, write to ssuite@salute.community.")), 30000);
    });
  }
  function resetTurnstile(slotId) {
    const w = widgets[slotId];
    if (w && window.turnstile) { w.token = ""; window.turnstile.reset(w.id); }
  }

  function status(el, message, kind) { el.textContent = message; el.hidden = !message; el.dataset.state = kind || ""; }

  /* ------------------------------------------------------- state + pricing */
  async function loadState() {
    const note = byId("fc-state-note");
    try {
      const r = await fetch(api("founder-comp"), { method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "state" }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || typeof j.state !== "string") throw new Error();
      if (j.state === "open") {
        openBtn.disabled = false; openBtn.removeAttribute("aria-disabled");
        note.textContent = "No payment is taken for your seat.";
      } else if (j.state === "full") {
        showFull();
      } else {
        showClosed();
      }
    } catch {
      note.textContent = "Registration cannot be reached from this browser right now. Please try again shortly, or write to ssuite@salute.community and we will register you.";
    }
  }
  function showClosed() {
    byId("fc-open-wrap").hidden = true;
    byId("fc-closed").hidden = false;
  }
  function showFull() {
    byId("fc-open-wrap").hidden = true;
    byId("fc-full").hidden = false;
  }
  async function loadPricing() {
    try {
      const r = await fetch(api("event-pricing"), { method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: "{}" });
      const j = await r.json();
      const t = (j.tickets || []).find((x) => x.code === "community");
      if (!t || !Number.isInteger(t.amount_cents) || t.amount_cents <= 0) throw new Error();
      community = { amount_cents: t.amount_cents, early: t.early_bird_active === true, deadline: String(j.early_bird_last_moment_display || "") };
      document.querySelectorAll("[data-fc-community]").forEach((el) => { el.textContent = usd(t.amount_cents); });
      document.querySelectorAll("[data-fc-community-note]").forEach((el) => {
        el.textContent = community.early && community.deadline ? `Early-bird Community price until ${community.deadline}.` : "Current Community price.";
        el.hidden = false;
      });
      updateTotal();
    } catch {
      document.querySelectorAll("[data-fc-community]").forEach((el) => { el.textContent = "the current Community price"; });
    }
  }

  /* ----------------------------------------------------------- the claim */
  card(byId("fc-claim-card"), 0, "YOUR COMPLIMENTARY SEAT", "Your information");
  wireConditionals(claimForm);
  openBtn.addEventListener("click", () => {
    if (claimed) { show(done); return; }
    show(claimForm);
    turnstileToken("fc-claim-turnstile", "founder-comp").catch(() => {});
  });

  claimForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const st = byId("fc-claim-status");
    const submit = byId("fc-claim-submit");
    let a;
    try {
      a = attendee(claimForm, 0);
      if (!val(claimForm, "referral-source")) throw new Error("Please tell us how you heard about S.SUITE.");
      if (!claimForm.elements.namedItem("combined_agreement")?.checked) throw new Error("Please accept the Event Terms, Privacy Notice and Media Release to continue.");
    } catch (err) { status(st, err.message, "error"); return; }
    submit.disabled = true;
    status(st, "Confirming your seat…", "working");
    try {
      const token = await turnstileToken("fc-claim-turnstile", "founder-comp");
      const r = await fetch(api("founder-comp"), { method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "claim", ...a, how_heard: val(claimForm, "referral-source"), combined_agreement: true, turnstile_token: token }) });
      const j = await r.json().catch(() => ({}));
      if (j.status === "full") { close(); showFull(); return; }
      if (j.status === "closed") { close(); showClosed(); return; }
      if (!r.ok || j.status !== "claimed") throw new Error(String(j.error || "Your seat could not be confirmed. Nothing was saved. Please try again, or write to ssuite@salute.community."));
      claimed = { first_name: a.first_name, last_name: a.last_name, email: a.email, phone: a.phone, how_heard: val(claimForm, "referral-source") };
      byId("fc-done-name").textContent = a.first_name;
      byId("fc-done-ref").textContent = String(j.registration_id || "");
      byId("fc-done-email").textContent = a.email;
      openBtn.textContent = "View your confirmation";
      status(st, "", "");
      show(done);
    } catch (err) {
      status(st, err instanceof Error ? err.message : "Your seat could not be confirmed. Nothing was saved.", "error");
      resetTurnstile("fc-claim-turnstile");
    } finally { submit.disabled = false; }
  });

  /* ------------------------------------------------- paid additional guests */
  const qty = byId("fc-guest-qty");
  const guestBox = byId("fc-addon-guests");
  function renderGuests() {
    guestBox.innerHTML = "";
    const n = Number(qty.value || 1);
    for (let i = 1; i <= n; i++) card(guestBox, i, "ADDITIONAL GUEST · COMMUNITY PRICE", `Guest ${i}`);
    updateTotal();
  }
  function updateTotal() {
    const n = Number(qty.value || 1);
    byId("fc-addon-total").textContent = community ? usd(community.amount_cents * n) : "—";
  }
  qty.addEventListener("change", renderGuests);
  wireConditionals(addonForm);
  byId("fc-addon-open").addEventListener("click", () => {
    if (!guestBox.children.length) renderGuests();
    if (claimed) {
      for (const k of ["first_name", "last_name", "email", "phone"]) {
        const input = addonForm.elements.namedItem(`buyer-${k}`);
        if (input && !input.value) input.value = claimed[k];
      }
    }
    show(addonForm);
    turnstileToken("fc-addon-turnstile", String(cfg.turnstileAction || "guest-registration")).catch(() => {});
  });
  byId("fc-addon-back").addEventListener("click", () => show(done));

  addonForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const st = byId("fc-addon-status");
    const submit = byId("fc-addon-submit");
    let body;
    try {
      const p = cfg.policy;
      if (!p || !PAID_CODE) throw new Error("Checkout is unavailable right now. Please write to ssuite@salute.community.");
      const buyer = {
        first_name: val(addonForm, "buyer-first_name"), last_name: val(addonForm, "buyer-last_name"),
        email: val(addonForm, "buyer-email").toLowerCase(), phone: val(addonForm, "buyer-phone"),
      };
      if (!buyer.first_name || !buyer.last_name || !emailPattern.test(buyer.email) || !buyer.phone)
        throw new Error("Please complete your own details for the receipt, including a mobile phone number.");
      const n = Number(qty.value || 1);
      if (!Number.isInteger(n) || n < 1 || n > 3) throw new Error("Choose between one and three guests.");
      const guests = Array.from({ length: n }, (_, k) => attendee(addonForm, k + 1));
      const emails = guests.map((g) => g.email);
      if (new Set(emails).size !== emails.length || emails.includes(buyer.email))
        throw new Error("Each guest needs their own email address, different from yours — your own seat is already complimentary.");
      if (!addonForm.elements.namedItem("combined_agreement")?.checked)
        throw new Error("Please accept the Event Terms, Privacy Notice and Media Release to continue.");
      body = {
        ticket_type_code: "community", order_type: "ticket", quantity: n, guest_quantity: 0,
        purchaser: buyer, member_code: PAID_CODE, member_attestation: false,
        how_heard: (claimed && claimed.how_heard) || val(addonForm, "referral-source") || "Friend or colleague",
        attendees: guests, combined_agreement: true,
        terms_version: p.termsVersion, privacy_version: p.privacyVersion, media_release_version: p.mediaReleaseVersion,
        success_url: `${location.origin}/registration.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${location.origin}${location.pathname}?checkout=cancel`,
      };
    } catch (err) { status(st, err.message, "error"); return; }
    submit.disabled = true;
    status(st, "Verifying details and preparing secure checkout…", "working");
    try {
      body.turnstile_token = await turnstileToken("fc-addon-turnstile", String(cfg.turnstileAction || "guest-registration"));
      const r = await fetch(api("create-checkout"), { method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || typeof j.checkout_url !== "string") throw new Error(String(j.error || "Checkout could not be started. No payment has been taken."));
      const dest = new URL(j.checkout_url);
      if (dest.protocol !== "https:" || dest.hostname !== "checkout.stripe.com") throw new Error("Checkout could not be opened securely and was stopped. No payment was taken.");
      status(st, "Redirecting to secure checkout…", "working");
      location.assign(dest.toString());
    } catch (err) {
      status(st, err instanceof Error ? err.message : "Checkout could not be started. No payment has been taken.", "error");
      resetTurnstile("fc-addon-turnstile");
    } finally { submit.disabled = false; }
  });

  if (new URLSearchParams(location.search).get("checkout") === "cancel") {
    const n = byId("fc-state-note");
    if (n) n.textContent = "Checkout was cancelled. No payment was taken for your guests.";
  }
  if (PAID_PAGE) document.querySelectorAll("[data-fc-paid-page]").forEach((a) => a.setAttribute("href", PAID_PAGE));
  loadState();
  loadPricing();
})();
