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
  auction: Object.freeze({ enabled: true, turnstileAction: "auction-submission" }) // must match SSUITE_AUCTION_TURNSTILE_ACTION exactly
});
