/*
 * Isolated Turnstile browser-test configuration template.
 *
 * Copy this file to config.isolated-staging.js locally and fill in only the
 * isolated Supabase project's HTTPS API origin and its staging policy values.
 * The copy is intentionally ignored by the staging runbook and must never be
 * used by production pages. This public test sitekey is safe to expose; the
 * matching test secret belongs only in the isolated Supabase function secret.
 */
window.SSUITE_CONFIG = Object.freeze({
  mode: "isolated-staging",
  apiBase: "", // https://<isolated-project-ref>.supabase.co
  turnstileSiteKey: "1x00000000000000000000AA", // Cloudflare always-pass test key
  turnstileAction: "guest-registration",
  policy: null, // set exact values matching isolated ssuite_policy_versions
  donation: Object.freeze({ enabled: false, turnstileAction: "", receiptPolicyUrl: "" }),
  auction: Object.freeze({ enabled: false, turnstileAction: "" }),
});
