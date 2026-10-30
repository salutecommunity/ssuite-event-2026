/*
 * Public, non-secret deployment configuration.
 *
 * Live production wiring for https://event.ssuite.org.
 * Setting mode to "live" does not by itself open sales: the database remains
 * the authority and must also have SSuite sales_status='open'. Do not put
 * Supabase keys, Stripe keys, Turnstile secrets, management tokens, or
 * invitation tokens in this file.
 *
 * Auction intake is OPEN: item submissions persist to the private S.Suite
 * database. Bidding is not open and no lots are published.
 *
 * Give (donation) is OPEN. ssuite_donation_configuration holds the approved
 * legal_entity_name, legal_entity_address, and tax_identifier, so
 * finalize_ssuite_donation issues receipt_status='ready' and a donor receives
 * a receipt after verified payment. Donations are benefit-free.
 *
 * turnstileAction values below are hash-verified against the production
 * secrets, not copied from README placeholders, which are wrong.
 */
window.SSUITE_CONFIG = Object.freeze({
  mode: "live",
  apiBase: "https://iddzcbknnddkonrcwgpt.supabase.co",
  turnstileSiteKey: "0x4AAAAAAEdV18cDQPUcfZOG",
  turnstileAction: "guest-registration", // must match SSUITE_TURNSTILE_ACTION exactly
  policy: Object.freeze({
    termsUrl: "https://event.ssuite.org/event-terms.html",
    privacyUrl: "https://event.ssuite.org/event-privacy.html",
    mediaReleaseUrl: "https://event.ssuite.org/media-release.html",
    termsVersion: "ssuite-event-terms-2026-08-25",
    privacyVersion: "ssuite-event-privacy-2026-08-25",
    mediaReleaseVersion: "ssuite-media-release-2026-08-25"
  }),
  donation: Object.freeze({ enabled: true, turnstileAction: "donation", receiptPolicyUrl: "https://event.ssuite.org/donation-receipt-policy.html" }), // must match SSUITE_DONATION_TURNSTILE_ACTION exactly
  auction: Object.freeze({ enabled: true, turnstileAction: "auction-submission" }), // must match SSUITE_AUCTION_TURNSTILE_ACTION exactly
  // Invitation requests. Unlike the three flows above, no expected-action secret
  // is provisioned for this endpoint, so this string is a label for
  // observability rather than something the server matches. Origin and
  // Turnstile hostname checks still apply, and the token is still verified.
  invitation: Object.freeze({ enabled: true, turnstileAction: "invitation-request" }),
  // Member code requests. Same situation as invitation requests: no
  // expected-action secret is provisioned, so this string is a label for
  // observability rather than something the server matches. Origin and
  // Turnstile hostname checks still apply, and the token is still verified.
  memberCode: Object.freeze({ enabled: true, turnstileAction: "member-code-request" }),
  // Keep Ambassador intake enabled alongside the other live request flows.
  ambassador: Object.freeze({ enabled: true, turnstileAction: "ambassador-interest", privacyUrl: "https://event.ssuite.org/event-privacy.html" })
});

// Phone input cleanup (2026-10-30). Autofill and paste on phones can insert invisible
// direction/zero-width marks, non-breaking spaces and dash look-alikes. Clean them on
// input, blur and submit (same rules as the server), and show a clear inline message
// under the phone field instead of a generic error by the button.
(function () {
  if (typeof document === "undefined" || window.__ssuitePhoneCleanup) return;
  window.__ssuitePhoneCleanup = true;
  var MSG = "Please enter a mobile number with the area code, for example (212) 555-0147.";
  function soft(v) {
    return String(v || "")
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u00AD]/g, "")
      .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\t\r\n]/g, " ")
      .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
      .replace(/[\uFF10-\uFF19]/g, function (d) { return String.fromCharCode(d.charCodeAt(0) - 0xFF10 + 48); })
      .replace(/\uFF0B/g, "+").replace(/\uFF08/g, "(").replace(/\uFF09/g, ")");
  }
  function full(v) { return soft(v).trim().replace(/^tel:\s*/i, "").replace(/\s+/g, " ").trim(); }
  function isTel(el) { return el && el.tagName === "INPUT" && (el.type === "tel" || /phone/i.test(el.name || el.id || "")) && el.type !== "hidden" && el.type !== "checkbox"; }
  function set(el, v) { if (el.value !== v) { var s = el.selectionStart, d = el.value.length - v.length; el.value = v; try { if (s != null && document.activeElement === el) el.setSelectionRange(Math.max(0, s - d), Math.max(0, s - d)); } catch (e) {} } }
  function errId(el) { if (!el.id) el.id = "ssp-" + Math.random().toString(36).slice(2, 9); return el.id + "-phone-error"; }
  function clearErr(el) { var e = document.getElementById(errId(el)); if (e) e.remove(); el.removeAttribute("aria-invalid"); }
  function showErr(el) {
    clearErr(el);
    var p = document.createElement("p"); p.id = errId(el); p.className = "field-error phone-field-error"; p.setAttribute("role", "alert");
    p.style.cssText = "color:#b42318;font-size:.9rem;margin:.35rem 0 0;font-weight:500;"; p.textContent = MSG;
    el.setAttribute("aria-invalid", "true"); el.setAttribute("aria-describedby", p.id);
    el.insertAdjacentElement("afterend", p);
    try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { el.scrollIntoView(); }
    setTimeout(function () { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } }, 50);
  }
  function valid(v) { var n = v.replace(/[^0-9]/g, "").length; return /^[0-9+().\- ]+$/.test(v) && n >= 10 && n <= 15; }
  document.addEventListener("input", function (ev) { var el = ev.target; if (!isTel(el)) return; set(el, soft(el.value).replace(/^tel:\s*/i, "")); clearErr(el); }, true);
  document.addEventListener("blur", function (ev) { var el = ev.target; if (isTel(el)) set(el, full(el.value)); }, true);
  document.addEventListener("change", function (ev) { var el = ev.target; if (isTel(el)) set(el, full(el.value)); }, true);
  document.addEventListener("submit", function (ev) {
    var form = ev.target; if (!form || !form.querySelectorAll) return;
    var bad = null;
    Array.prototype.forEach.call(form.querySelectorAll("input"), function (el) {
      if (!isTel(el) || el.disabled || !el.offsetParent) return;
      set(el, full(el.value));
      if (!el.value && !el.required) { clearErr(el); return; }
      if (!el.value) return; // let the browser's own required message handle empty fields
      if (!valid(el.value)) { if (!bad) bad = el; } else clearErr(el);
    });
    if (bad) { ev.preventDefault(); ev.stopImmediatePropagation(); showErr(bad); }
  }, true);
})();
