/*
 * Public, non-secret deployment configuration.
 *
 * Live production wiring for https://event.ssuite.org.
 * Setting mode to "live" does not by itself open sales: the database remains
 * the authority and must also have SSuite sales_status='open'. Do not put
 * Supabase keys, Stripe keys, Turnstile secrets, management tokens, or
 * invitation tokens in this file.
 *
 * Give (donation) and Auction intake remain disabled until their independent
 * receipt, refund-reconciliation, and intake-safeguard gates are approved.
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
  donation: Object.freeze({ enabled: false, turnstileAction: "", receiptPolicyUrl: "" }), // SSUITE_DONATION_TURNSTILE_ACTION
  auction: Object.freeze({ enabled: false, turnstileAction: "" }) // SSUITE_AUCTION_TURNSTILE_ACTION
});
