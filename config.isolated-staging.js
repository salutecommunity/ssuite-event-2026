window.SSUITE_CONFIG = Object.freeze({
  mode: "isolated-staging",
  apiBase: "https://fxhhwtmanioqtjnppbhm.supabase.co",
  turnstileSiteKey: "1x00000000000000000000AA",
  turnstileAction: "guest-registration",
  policy: Object.freeze({
    termsUrl: "https://event.ssuite.org/event-terms.html",
    privacyUrl: "https://event.ssuite.org/event-privacy.html",
    mediaReleaseUrl: "https://event.ssuite.org/media-release.html",
    termsVersion: "ssuite-event-terms-2026-08-25",
    privacyVersion: "ssuite-event-privacy-2026-08-25",
    mediaReleaseVersion: "ssuite-media-release-2026-08-25"
  }),
  donation: Object.freeze({ enabled: false, turnstileAction: "", receiptPolicyUrl: "" }),
  auction: Object.freeze({ enabled: false, turnstileAction: "" })
});
