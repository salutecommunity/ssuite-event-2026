# S.Suite live-browser integration (not a launch approval)

`config.js` is intentionally committed with `mode: "preview"`. It contains only public configuration and must never contain a service-role key, Stripe credential, Turnstile secret, management token, or invitation token.

## What the browser source now supports

- `index.html` can call `create-checkout` only when `mode`, HTTPS API base, public Turnstile site key, three final HTTPS policy URLs, and their exact server-approved versions are all configured. It sends no price, price ID, capacity, hold token, or policy URL; the server remains authoritative. Otherwise it remains an explicitly labelled preview.
- `table-portal.html#token=<management-token>` removes the fragment before rendering and keeps the token only in page memory. It uses the protected `table-portal` Edge Function for reads, invitation queueing, and resends. It never calls SQL directly or claims an email was sent.
- `guest-registration.html#token=<invitation-token>` also removes its fragment immediately, renders only after live prerequisites exist, and calls `guest-registration` after Turnstile and the guest's own agreement.

## Configuration and deployment gates

1. Keep `mode: "preview"` until every launch gate in `backend/ssuite/README.md`, `EMAIL_READINESS.md`, and `TEST_CHECKLIST.md` is completed. A browser setting never opens the event; `SSuite.sales_status` remains the database authority.
2. Set `apiBase` to the production Supabase HTTPS origin only after that origin appears exactly in `SSUITE_ALLOWED_ORIGINS`. For local HTTP development, use the server's explicit `SSUITE_ALLOW_LOCAL_DEVELOPMENT=true` setting only in local environments.
3. Configure final policy URLs and exact versions only after legal approval. The checkout contract sends the versions; the guest completion database function derives its server-configured versions.
4. Use a public Turnstile site key and set the matching `turnstileAction` for guest registration. The guest function requires both `SSUITE_TURNSTILE_ACTION` and `TURNSTILE_EXPECTED_HOSTNAME`; never expose `TURNSTILE_SECRET_KEY`. For the browser-valid isolated test, follow `backend/ssuite/TURNSTILE_ISOLATED_STAGING.md` instead of changing production `config.js`.
5. Publish `table-portal.html` and `guest-registration.html` on the exact HTTPS values configured in `SSUITE_TABLE_PORTAL_URL` and `SSUITE_GUEST_REGISTRATION_URL`. Retain the `no-referrer` and no-index headers/meta behavior. The portal URL must be delivered only by the internal table-access provisioning flow.
6. Deploy and verify the invitation worker/provider before representing a queued invitation as delivered or sent. This UI intentionally says only `queued`.

Run the deterministic source harness before deployment. The second check covers the isolated browser-valid Turnstile path and confirms production remains preview-only:

```sh
node apps/ssuite-event-experience/tests/verify-live-chain.mjs
node apps/ssuite-event-experience/tests/verify-guest-registration-turnstile.mjs
```

The isolated browser procedure is documented in `backend/ssuite/TURNSTILE_ISOLATED_STAGING.md`. These are source/syntax checks only; they do not verify a Supabase project, RLS, Stripe, Turnstile, email provider, cron, policy approval, or payment flow. It does not verify a Supabase project, RLS, Stripe, Turnstile, email provider, cron, policy approval, or payment flow.

## Donation and auction intake

`donation-auction-live.js` adds the accessible donation form and auction item
intake module. It is deliberately inert in the committed configuration:
`mode` remains `"preview"`, and both `donation.enabled` and `auction.enabled`
remain `false`. The preview labels are not merely cosmetic: no Turnstile
widget, fetch, checkout redirect, or submission is started while a gate is
missing.

Only after the backend launch checklist is signed off may public configuration
set `mode: "live"`, an HTTPS `apiBase`, a public `turnstileSiteKey`, the exact
public actions, and `donation: { enabled: true, receiptPolicyUrl: "https://…" }`
and/or `auction: { enabled: true }`. These switches are still not authority to
accept data—the server independently requires the donation configuration row,
Stripe and Turnstile secrets, trusted IP ingress, origin allowlist, and action/
hostname checks. Before receipt issuance is enabled, the server-side donation
configuration also needs the legally approved entity name and address, any
approved tax identifier, receipt policy, and receipt-operations workflow. Never
place a Stripe secret, service-role key, IP HMAC secret, webhook secret, or
approved staff identity in `config.js`.

The browser generates an idempotency key per intentional request, displays
only generic failures, preserves no tokens in storage, rejects non-Stripe
checkout redirects, and never claims a receipt, employer match, auction
acceptance, bid, or email delivery. The Give form supports one-time or monthly
frequency, preset or cents-precise custom amounts, donor name/email, and an
no gift-dedication collection. Employer matching instructions are available using SALUTE Foundation’s EIN and address; matching is initiated through the donor’s employer portal and
unavailable until an approved provider exists; it is not submitted as a
request. The auction module submits to committee review only; it does not add
bidding or selected/approved lots.
