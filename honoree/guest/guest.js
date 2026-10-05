/* Honoree guest invitation.
 *
 * The page carries no honoree details of its own. The guest key in the link
 * (#g=…) is looked up once; the honoree-portal answers only after the honoree
 * has accepted, and returns her name, honor and guest code. Those are written
 * into the page exactly where a baked partner invitation keeps them, and only
 * then are the shared checkout scripts loaded, in the same order as every
 * other invitation page. Price and access are still decided by the server.
 */
(function () {
  "use strict";
  var API = "https://iddzcbknnddkonrcwgpt.supabase.co/functions/v1/honoree-portal";
  var CHAIN = ["/config.js?v=20260910a", "/guest-card.js?v=20260911h", "/invitation-checkout.js?v=20260916a",
               "/live-chain.js?v=20260916b", "/live-pricing.js?v=20260916a"];
  var msg = document.getElementById("gate-msg"), sub = document.getElementById("gate-sub");

  function fail(text) {
    msg.textContent = text || "This invitation is not available.";
    sub.innerHTML = 'Questions? Write to <a href="mailto:ssuite@salute.community">ssuite@salute.community</a>.';
  }
  function load(i) {
    if (i >= CHAIN.length) {
      var live = window.SSuiteLive;
      if (live && typeof live.syncAgreementText === "function") live.syncAgreementText();
      return;
    }
    var s = document.createElement("script");
    s.src = CHAIN[i];
    s.onload = function () { load(i + 1); };
    s.onerror = function () { fail("This page could not finish loading. Please refresh."); };
    document.body.appendChild(s);
  }
  function bind(name, value) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-bind="' + name + '"]'), function (el) { el.textContent = value; });
  }

  var m = /[#&]g=([0-9a-fA-F]{32})/.exec(location.hash || "");
  if (!m) { fail("This invitation link is incomplete. Please use the full link you were sent."); return; }

  fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit", referrerPolicy: "no-referrer",
               body: JSON.stringify({ action: "guest", key: m[1].toLowerCase() }) })
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (res) {
      if (!res.ok || !res.d || !res.d.host || !res.d.guest_code) { fail(res.d && res.d.error); return; }
      var host = res.d.host;
      bind("host", host.full_name);
      bind("first", host.first_name);
      if (host.honor) {
        bind("honor", "Inaugural S.Suite " + host.honor + " Honoree");
      } else {
        // Not (yet) an accepted honoree: keep the nomination confidential.
        Array.prototype.forEach.call(document.querySelectorAll('[data-bind="honor"]'), function (el) { el.hidden = true; });
        var to = document.querySelector(".invite-lockup .to");
        if (to) to.textContent = "You are invited by " + host.first_name + " to the inaugural";
        var swap = [[".seat-card .micro", "Guest seat"], [".seat-card .rate-note", "Special invitation rate · Regular price $400"]];
        swap.forEach(function (x) { var el = document.querySelector(x[0]); if (el) el.textContent = x[1]; });
        Array.prototype.forEach.call(document.querySelectorAll(".seat-card li"), function (li) { if (/honoree guest rate/i.test(li.textContent)) li.textContent = "The special invitation rate, applied for you"; });
        document.body.dataset.invitationLabel = "Special invitation rate";
      }
      document.title = "An invitation from " + host.full_name + " · S.Suite";
      document.body.dataset.invitationCode = res.d.guest_code;
      document.body.dataset.hostName = host.full_name;
      document.body.classList.remove("guest-pending");
      load(0);
      // Reconcile the card with the server-verified rate once the code is applied.
      document.addEventListener("ssuite:invitation-applied", function () {
        var live = window.SSuiteLive, st = live && live.partnerState && live.partnerState();
        if (!st || !Number.isInteger(st.amountCents) || st.amountCents <= 0) return;
        var p = document.querySelector(".seat-card .price");
        if (p) p.textContent = "$" + (st.amountCents / 100).toLocaleString("en-US");
      });
    })
    .catch(function () { fail("We could not open this invitation just now. Please try again in a moment."); });
})();
