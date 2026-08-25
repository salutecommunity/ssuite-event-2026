/*
 * Public, non-secret deployment configuration.
 *
 * This file deliberately ships in preview mode. Changing it to live does not
 * open sales: the database remains the authority and must still have SSuite
 * sales_status='open'. Do not put Supabase keys, Stripe keys, Turnstile
 * secrets, management tokens, or invitation tokens in this file.
 */
window.SSUITE_CONFIG = Object.freeze({
  mode: "preview", // "preview" until every launch gate in backend/ssuite/README.md is approved
  apiBase: "", // e.g. "https://<project-ref>.supabase.co"
  turnstileSiteKey: "", // public site key only; required for checkout and guest completion
  turnstileAction: "", // optional; must equal SSUITE_TURNSTILE_ACTION if that server check is configured
  policy: null,
  // These public switches remain false until their independent backend, Stripe,
  // Turnstile, trusted-ingress, legal receipt, and operational gates are approved.
  donation: Object.freeze({ enabled: false, turnstileAction: "", receiptPolicyUrl: "" }),
  auction: Object.freeze({ enabled: false, turnstileAction: "" }),
  // Once exact server-side versions are approved, use the event-specific pages:
  // policy: { termsUrl: "https://event.ssuite.org/event-terms.html", privacyUrl: "https://event.ssuite.org/event-privacy.html", mediaReleaseUrl: "https://event.ssuite.org/media-release.html", termsVersion: "approved version", privacyVersion: "approved version", mediaReleaseVersion: "approved version" },
});
