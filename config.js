/* Public, non-secret deployment configuration for https://event.ssuite.org. */
window.SSUITE_CONFIG = Object.freeze({
  mode: "live",
  apiBase: "https://iddzcbknnddkonrcwgpt.supabase.co",
  turnstileSiteKey: "0x4AAAAAAEdV18cDQPUcfZOG",
  turnstileAction: "guest-registration",
  policy: Object.freeze({
    termsUrl: "https://event.ssuite.org/event-terms.html",
    privacyUrl: "https://event.ssuite.org/event-privacy.html",
    mediaReleaseUrl: "https://event.ssuite.org/media-release.html",
    termsVersion: "ssuite-event-terms-2026-08-25",
    privacyVersion: "ssuite-event-privacy-2026-08-25",
    mediaReleaseVersion: "ssuite-media-release-2026-08-25"
  }),
  donation: Object.freeze({ enabled: true, turnstileAction: "donation", receiptPolicyUrl: "https://event.ssuite.org/donation-receipt-policy.html" }),
  auction: Object.freeze({ enabled: true, turnstileAction: "auction-submission" }),
  invitation: Object.freeze({ enabled: true, turnstileAction: "invitation-request" }),
  memberCode: Object.freeze({ enabled: true, turnstileAction: "member-code-request" }),
  ambassador: Object.freeze({ enabled: true, turnstileAction: "ambassador-interest", privacyUrl: "https://www.salute.community/privacy-policy" })
});
