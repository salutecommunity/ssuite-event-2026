# SSuite Supabase commerce backend

This directory contains the production migrations and Supabase Edge Functions for the seeded `SSuite` event:

- `20260819235900_ssuite_checkout_hardening.sql` — idempotent Stripe event ledger, payment-review order state, live price IDs, 30-minute holds, server-only checkout/order RPCs, payment finalization, table seating, and release handling.
- `create-checkout/index.ts` — unauthenticated browser checkout endpoint. It validates the CORS and redirect-origin allowlists, creates the DB hold/order, and creates a Stripe-hosted Checkout Session.
- `stripe-webhook/index.ts` — unauthenticated Stripe endpoint with raw-body HMAC signature verification, durable event claiming/deduplication, and Checkout Session handlers.
- `20260820030000_ssuite_auction_submissions.sql` — service-role-only auction submission tables, strict validation, atomic rate limiting, bounded ledger cleanup, and the submission RPC.
- `auction-submission/index.ts` — unauthenticated, Turnstile-protected public auction submission endpoint.
- `20260820160000_ssuite_email_operations.sql` — versioned service-role-only email catalog, generic durable outbox, verified-state hooks, leases/retries, provider-event ledger, and operator view. It does not configure or enable delivery.
- `email-operations-dispatch/index.ts` and `email-operations-callback/index.ts` — internal relay-contract worker and signed callback receiver; see `EMAIL_OPERATIONS.md`.
- `deno.json` — optional Deno compiler/import configuration.

The migration also creates the service-role-only `member_emails` soft-verification table and the atomic `claim_stripe_webhook_event` RPC. No member-email list is bundled: operators must import an approved, normalized list separately.

## Important launch warning

**Do not open `SSuite` sales until the event year, final terms/privacy/media-release policy URLs and versions, and the production Stripe account/prices have been confirmed.** The migration intentionally does not change `sales_status` from `draft` to `open`. Confirm the final policy URLs in the application before setting `SSuite.sales_status = 'open'`. Capacity is not exposed by the Edge Functions.

SMS is not enabled by this backend. Existing invitation delivery and the new generic email outbox both require a separately approved, configured internal worker and relay; this repository change neither configures nor enables a send. See `EMAIL_OPERATIONS.md`. No SMS delivery path exists.

## Apply the migration

Apply `20260819235900_ssuite_checkout_hardening.sql` through the Supabase SQL editor or the linked project's migration workflow **after** the supplied initial schema. It is written to be rerunnable for the event configuration and ledger/table definitions. Verify that:

1. `SSuite` has exactly the three expected active ticket types and the live Stripe price IDs.
2. `inventory_hold_minutes = 30`.
3. The migration's status constraint includes `payment_review`.
4. The `stripe_webhook_events` and `member_emails` tables have no grants to `anon` or `authenticated`.
5. The atomic `claim_stripe_webhook_event` RPC is executable only by `service_role` and reclaims `processing` rows only after five minutes.
6. The event remains `draft` until launch approval.
7. `TURNSTILE_SECRET_KEY` is configured and the frontend Turnstile widget is deployed on the checkout form; checkout must fail closed if either is missing.

The SQL functions are `service_role` only. The browser must call the Edge Function, never the RPCs or database tables directly.

## Edge Function secrets and configuration

Set these function/project secrets:

```text
SUPABASE_URL                 # Supabase built-in project URL
SUPABASE_SERVICE_ROLE_KEY   # Supabase built-in service-role key; never expose to browser
STRIPE_SECRET_KEY            # live or test key matching the configured Stripe prices
STRIPE_WEBHOOK_SECRET        # signing secret for this exact webhook endpoint
TURNSTILE_SECRET_KEY         # Cloudflare Turnstile server secret; never expose to browser
SSUITE_ALLOWED_ORIGINS       # comma-separated exact origins, e.g. https://tickets.example.org,https://www.example.org
```

`SSUITE_ALLOWED_ORIGINS` must contain origins, not paths. Checkout `success_url` and `cancel_url` are separately validated to have an origin in this list. Use HTTPS in production. The frontend must render a Cloudflare Turnstile widget, send its one-use token as `turnstile_token`, and never send the server secret. The backend calls Siteverify before creating any order or inventory hold and fails closed on missing, invalid, or unavailable verification.

Deploy from the Supabase project root (adjust the project reference as appropriate):

```bash
supabase db push
supabase functions deploy create-checkout --no-verify-jwt
supabase functions deploy stripe-webhook --no-verify-jwt
supabase secrets set STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=... TURNSTILE_SECRET_KEY=... SSUITE_ALLOWED_ORIGINS=https://tickets.example.org
```

`--no-verify-jwt` is required because Stripe cannot send a Supabase JWT and checkout is intentionally unauthenticated. Authorization is enforced by the function's CORS allowlist, server-side validation, and service-role-only SQL functions. Keep the service-role key in function secrets only.

## Public auction item submissions

The auction endpoint is a separate public intake path. Apply
`20260820030000_ssuite_auction_submissions.sql` only after
`ssuite_supabase_initial_schema.sql` (or use the normal linked-project migration
workflow in timestamp order). It does not open sales and it does not expose
any auction table or RPC to browser roles. On reruns, legacy auction metadata is
normalized to the fixed safe source object before the strict metadata
constraint is installed; review that this loss of any rehearsal-only metadata
is acceptable.

### Required auction configuration

Set these Edge Function/project secrets before deployment. Values are never
sent to the browser:

```text
SUPABASE_URL                       # Supabase project URL
SUPABASE_SERVICE_ROLE_KEY         # service-role key; function secret only
SSUITE_AUCTION_IP_HASH_SECRET     # dedicated high-entropy HMAC secret, >= 32 non-whitespace characters
TURNSTILE_SECRET_KEY              # Cloudflare Turnstile server secret
SSUITE_ALLOWED_ORIGINS            # comma-separated exact origins; HTTPS in production
SSUITE_TRUSTED_CLIENT_IP_HEADER   # exactly cf-connecting-ip or x-ssuite-client-ip
SSUITE_ALLOW_LOCAL_DEVELOPMENT    # unset/false in production; literal true only for local HTTP origins
```

`SSUITE_ALLOWED_ORIGINS` is a strict comma-separated whitelist of origins, not
paths, wildcards, or a trailing URL path. Production entries must use `https:`.
`http://localhost`, `http://127.0.0.1`, and `http://[::1]` are accepted only
when `SSUITE_ALLOW_LOCAL_DEVELOPMENT=true`; this switch must not be set in
production. Invalid, duplicate, empty, or non-origin entries fail closed.

`SSUITE_TRUSTED_CLIENT_IP_HEADER` selects one exact header; the function never
falls back across multiple headers. `cf-connecting-ip` is valid only when the
request is known to have traversed Cloudflare. For a Cloudflare Worker or
other trusted ingress, use `x-ssuite-client-ip`: strip any client-supplied copy
at the edge, derive the address from the authenticated Cloudflare connection,
and inject exactly that header. Do not use `x-forwarded-for` or `x-real-ip`.
The production route must force traffic through this verified ingress (and
prevent an alternate direct route from supplying the header). The function
accepts only a canonical IPv4/IPv6 value and returns a generic failure when the
configured header is absent, duplicated/combined, or malformed. Only an HMAC
fingerprint is stored; the raw address is not persisted or logged.

Every non-honeypot request must include a one-use `turnstile_token` in its JSON
body. The function calls Cloudflare Siteverify before the database RPC; missing,
invalid, timed-out, or unavailable verification fails closed with a generic
response. The Turnstile secret is never accepted from the request. Honeypot
hits return a generic-looking accepted response without writing a row or
consuming quota.

The endpoint accepts `POST /functions/v1/auction-submission` with an
`Idempotency-Key` header (16–256 characters) and these JSON fields:

```json
{
  "name": "Donor Name",
  "email": "donor@example.org",
  "job_title": "Founder",
  "company": "Example Co",
  "item": "One private dinner experience",
  "estimated_value": "2500.00",
  "turnstile_token": "<one-use-token-from-widget>"
}
```

The SQL metadata is intentionally an exact whitelist:
`{"source":"public_auction_submission"}`. The endpoint supplies no client
metadata, IP value, request headers, or raw idempotency key to SQL.

Deploy the public function only after the migration and secrets are verified:

```bash
supabase db push
supabase functions deploy auction-submission --no-verify-jwt
supabase secrets set \\
  SSUITE_AUCTION_IP_HASH_SECRET=... \\
  TURNSTILE_SECRET_KEY=... \\
  SSUITE_ALLOWED_ORIGINS=https://tickets.example.org \\
  SSUITE_TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip
```

The supplied `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` must remain
function secrets. Do not deploy this function with a browser key or expose the
service role. `--no-verify-jwt` is required for this intentionally unauthenticated
browser endpoint; authorization is instead enforced by the exact origin list,
trusted-ingress requirement, Turnstile, validation, and service-role-only SQL.

### Auction ledger retention and verification

Rate-limited attempts do not retain an idempotency row. Completed keys are
retained for replay safety and stale processing rows are bounded by a cleanup
RPC. Schedule a trusted service-role invocation (for example hourly):

```sql
select * from public.cleanup_ssuite_auction_submission_ledger(90, 2, 1000);
```

The first argument is completed-key retention in days, the second is the
minimum age in hours for an expired rate-limit fingerprint, and the third is a
per-table deletion batch limit. The RPC never deletes submissions, active
processing leases, or a current rate-limit window. Keep the retention period
longer than the maximum client retry/replay window chosen by operations.

### Donations and staff auction review (20260820170000)

`20260820170000_ssuite_donations_and_auction_review.sql` adds a separate,
**disabled-by-default** donation configuration, one-time and monthly donor
intents, hashed idempotency/rate-limit ledgers, durable Stripe settlement and
webhook records, receipt/tax snapshot fields, and a deliberately fail-closed
employer-matching information card using SALUTE Foundation’s public EIN and address; donors initiate matching in their employer portal. It also adds append-only auction review audit,
controlled review transitions, and status-notification hooks. It does not open
sales, donations, outbound mail, auction bidding, approved lots, or public
staff access.

Do not set `ssuite_donation_configuration.enabled = true` merely because the
migration applied. Before enabling it, require written approval of the legal
entity/address and receipt wording, tax treatment, Stripe account/mode,
monthly-donation policy, refund/cancellation process, exact public origins,
Turnstile hostname/action, trusted ingress, retention schedule, webhook route,
and email worker/receipt template. `receipt_email_enabled` must remain false
until the independent email outbox is approved and operational. This source
sets no tax-deductible amount; it records `tax_deductibility_note` rather than
making a tax claim.

Deploy only after those gates pass:

```bash
supabase db push
supabase functions deploy donation-create-checkout --no-verify-jwt
supabase functions deploy donation-stripe-webhook --no-verify-jwt
supabase functions deploy auction-submission --no-verify-jwt
supabase secrets set \
  SSUITE_DONATION_IP_HASH_SECRET=... \
  SSUITE_DONATION_STRIPE_WEBHOOK_SECRET=... \
  SSUITE_AUCTION_IP_HASH_SECRET=... \
  STRIPE_SECRET_KEY=... \
  TURNSTILE_SECRET_KEY=... \
  TURNSTILE_EXPECTED_HOSTNAME=donate.example.org \
  SSUITE_DONATION_TURNSTILE_ACTION=donation \
  SSUITE_AUCTION_TURNSTILE_ACTION=auction \
  SSUITE_TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip \
  SSUITE_ALLOWED_ORIGINS=https://donate.example.org
```

The donation checkout endpoint accepts a browser-provided donation amount only
as a requested dollar decimal. The database independently chooses whether the
intake is enabled, allowed bounds, USD, and the one-time/monthly model. It
creates a Stripe Checkout session with server-created price data; the browser
never supplies a Stripe price, product, mode, receipt data, tax amount, or
provider result. Stripe webhook signature verification is raw-body HMAC with a
five-minute tolerance. Subscribe the donation endpoint to
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`invoice.paid`, `checkout.session.expired`,
`checkout.session.async_payment_failed`, `customer.subscription.deleted`, and
`charge.refunded`. The latter operational hooks are durably marked ignored in
this source until an approved refund/cancellation policy is implemented.

Use `public.review_ssuite_auction_submission(submission_id, new_status,
staff_actor, staff_note)` only from a protected service-role staff workflow.
Direct status changes fail; every transition is immutable in
`auction_submission_review_audit`. `staff_actor` must be an auditable internal
identifier, not an unverified browser value. Existing status-email queueing is
a hook, not proof that a notification was sent.

Schedule both cleanup functions from a trusted service-role scheduler:

```sql
select * from public.cleanup_ssuite_auction_submission_ledger(90, 2, 1000);
select * from public.cleanup_ssuite_donation_ledger(90, 2, 1000);
```

For an actual public launch, set `config.js` to explicit `mode: "live"` plus
its public `donation`/`auction` flags, HTTPS API base, public Turnstile key and
actions, and donation receipt-policy URL **only after** all server-side gates
above are complete. A frontend flag cannot enable a database intake. Keep the
committed preview configuration otherwise.

After applying the auction migration, verify from a protected SQL session:

1. `auction_item_submissions`, `auction_submission_idempotency`, and
   `auction_submission_rate_limits` have RLS enabled and no `anon` or
   `authenticated` table grants.
2. `submit_ssuite_auction_item` and
   `cleanup_ssuite_auction_submission_ledger` are executable only by
   `service_role`; no public or authenticated execute grant exists.
3. The submission metadata constraint permits only the exact source object,
   and the rate-limit/idempotency indexes and cleanup RPC are present.
4. A valid integration request is accepted with HTTP 202, an identical retry
   is also HTTP 202, a changed payload using the same key is generic HTTP 400,
   the sixth accepted request in an hour from one trusted address is generic
   HTTP 429, and no raw address or token appears in rows/logs.
5. OPTIONS and POST requests from an unlisted origin, requests without the
   trusted header, malformed IP values, missing/invalid Turnstile tokens,
   invalid UTF-8 JSON, non-JSON bodies, and non-HTTPS production origins fail
   closed with generic responses.

Do not treat a successful parser/build check as deployment verification. Test
Siteverify failure/timeouts, direct-origin bypass attempts, duplicate header
injection, cleanup batches, and concurrent idempotency/rate-limit requests in
staging before launch.

## Stripe webhook setup

Create a Stripe webhook endpoint for:

```text
https://<project-ref>.supabase.co/functions/v1/stripe-webhook
```

Use the Stripe account/mode that owns the three configured price IDs. Subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `charge.refunded`

Copy the endpoint's signing secret to `STRIPE_WEBHOOK_SECRET`; do not use a Dashboard secret from a different endpoint or mode. Stripe must receive the raw request body unchanged. The function verifies `Stripe-Signature` with a five-minute timestamp tolerance before parsing or recording an event.

## Checkout request contract

`POST /functions/v1/create-checkout` accepts JSON of this shape:

```json
{
  "ticket_type_code": "community",
  "order_type": "ticket",
  "quantity": 2,
  "purchaser": {"first_name":"A","last_name":"Buyer","email":"buyer@example.org","phone":"+1..."},
  "membership_email": "member@example.org",
  "member_attestation": false,
  "how_heard": "Community partner",
  "attendees": [
    {"first_name":"A","last_name":"Buyer","email":"buyer@example.org","job_title":"Director","company":"Example","meal_preference":"Vegetarian","has_dietary_or_allergy_needs":false,"has_accessibility_needs":false},
    {"first_name":"B","last_name":"Guest","email":"guest@example.org","job_title":"Founder","company":"Example Co","meal_preference":"Standard","has_dietary_or_allergy_needs":true,"dietary_or_allergy_details":"No peanuts","has_accessibility_needs":false}
  ],
  "combined_agreement": true,
  "terms_version": "terms-2026-01",
  "privacy_version": "privacy-2026-01",
  "media_release_version": "media-2026-01",
  "turnstile_token": "<one-use-token-from-widget>",
  "success_url": "https://tickets.example.org/thanks?session_id={CHECKOUT_SESSION_ID}",
  "cancel_url": "https://tickets.example.org/checkout"
}
```

`membership_email` is optional and `member_attestation` is a boolean. For `salute_member`, the server marks the order `matched` when the purchaser email is active in `member_emails`, `alternate_email_matched` when the optional alternate is active, or `attested_review` when an unmatched purchaser attests. An unmatched attesting purchaser is never blocked; without a match or attestation, the member checkout is rejected. Other products are `not_applicable`. Primary attendee emails must be plausible and unique within an order. Secondary Email remains optional, but if supplied it must be plausible and differ from that attendee's primary email.

Individual ticket quantity `N` requires exactly `N` complete attendee payloads. A full table must use `order_type = "table"`, `ticket_type_code = "full_table"`, and `quantity = 1`; it accepts one through ten pre-entered attendees. Remaining table seats are created as unassigned numbered seats after payment so later guest invitations can use them.

No member list exists in this repository. Before launch, import only an approved list through the Supabase SQL editor or a protected service-role migration, normalized to lowercase trimmed addresses, for example:

```sql
insert into public.member_emails (normalized_email, active)
values ('member@example.org', true)
on conflict (normalized_email) do update set active = excluded.active;
```

Do not grant browser roles access to this table or expose it as a public membership lookup. Deactivate an address with `update public.member_emails set active = false ...`; do not use it to block attested review orders.

The browser supplies no price, amount, Stripe price ID, event capacity, hold expiration, or raw hold token. The database selects the event/ticket price and the function generates a cryptographically random raw hold token, storing only its SHA-256 hash in the database. The raw token is put in Stripe metadata so the webhook can prove which hold belongs to the paid session.

## Operational behavior

- A DB hold and order are created atomically before Stripe Session creation.
- Stripe Checkout uses DB-fetched Stripe price IDs, `mode=payment`, `allow_promotion_codes=true`, purchaser email, a 30-minute `expires_at`, an order-based idempotency key, and payment-intent metadata linking any PaymentIntent back to the order.
- Stripe-paid finalization validates nonnegative Session subtotal/total, caps total at the original DB subtotal with tax disabled, and persists Stripe subtotal, discount, total, and customer. A 100%-discount Session may have a null PaymentIntent; this is valid and idempotency is null-safe.
- If Stripe Session creation or DB attachment fails, the order is cancelled and its active hold released. A Stripe `expired` event releases with order status `expired`; asynchronous payment failure releases with `failed`.
- A paid event is finalized when `payment_status = paid` or `no_payment_required` (100%-discount Checkout), or via `async_payment_succeeded`. Finalization is idempotent, converts the hold, creates unique seat entitlements, marks pre-entered attendees complete, and for a full table creates ten numbered seats and a table with the first pre-entered attendee as lead.
- If a paid webhook arrives after a hold expired or an order was released, finalization does **not** confirm the order. It marks the order `payment_review`, stores a reason and Stripe references, and writes an `audit_log` record. The webhook returns HTTP 200 for this durable review outcome so Stripe does not generate endless retries.
- `stripe_webhook_events` claims duplicate deliveries atomically, increments `attempt_count`, and stores processing outcomes. A concurrent active duplicate returns HTTP 200 without reprocessing; a `processing` lease older than five minutes is reclaimable. Failed processing returns HTTP 500 so Stripe can retry; already processed/ignored deliveries return HTTP 200.

Before production launch, test duplicate deliveries (including a concurrent active duplicate and a stale processing lease), delayed asynchronous payment success after hold expiry, checkout Session creation failure, Stripe signature failure, Turnstile failure/network outage before any hold, member match/alternate/attested-review paths, duplicate and malformed emails, promotion reconciliation including a 100%-off Session with no PaymentIntent, and full-table orders with both one and ten pre-entered attendees in the intended Stripe mode. Keep the event `draft`, keep SMS disabled, and do not expose capacity until the event year, policy URLs/versions, member import, Stripe prices/account, Turnstile widget/secret, and launch approval are confirmed.

## Table portal, reproducible tokens, and guest self-registration

Apply `20260820010000_ssuite_table_portal_and_guest_registration.sql` only after the two earlier migrations. It leaves sales **draft** and does not enable SMS.

### Required configuration before using the portal

Set these secrets in Supabase Edge Functions (never in browser code):

```text
SSUITE_TOKEN_DERIVATION_SECRET_V1  # high-entropy dedicated HMAC secret; version 1
SSUITE_TABLE_PORTAL_URL            # absolute HTTPS page URL
SSUITE_GUEST_REGISTRATION_URL      # absolute HTTPS page URL
SSUITE_ALLOWED_ORIGINS             # exact browser origins
TURNSTILE_SECRET_KEY               # guest completion only
TURNSTILE_EXPECTED_HOSTNAME        # required; exact hostname binding for guest completion
SSUITE_TURNSTILE_ACTION            # required; exact action binding for guest completion
SSUITE_KLAVIYO_SEND_URL            # approved transactional relay/Klaviyo endpoint
SSUITE_KLAVIYO_API_KEY             # provider credential
SSUITE_KLAVIYO_TEMPLATE_ID         # provider template identifier
```

Raw management and invitation tokens are deterministic HMAC values with explicit domain separation:

- `HMAC-SHA-256(secret, "SSUITE/TABLE-MANAGEMENT/V1:<token UUID>")`
- `HMAC-SHA-256(secret, "SSUITE/INVITATION/V1:<invitation UUID>")`

Only `SHA-256(raw-token)`, the token UUID, and version are persisted. The raw token is never written to Supabase rows, a delivery row, logs, or an HTTP URL path. This lets trusted provisioning and mail code recreate the exact original link without escrow plaintext. Treat loss of the versioned derivation secret as token loss; rotation requires a deliberate new token version and replacement/revocation procedure.

Before registrations can complete, an operator must configure exact policy versions server-side. The migration seeds an intentionally unusable `UNCONFIGURED` row:

```sql
update public.ssuite_policy_versions p
set terms_version = 'terms-2026-final',
    privacy_version = 'privacy-2026-final',
    media_release_version = 'media-2026-final',
    configured_at = now(), updated_at = now()
from public.events e where p.event_id=e.id and e.name='SSuite';
```

The browser no longer supplies policy versions. The database reads and records these exact configured values when the guest personally accepts the combined agreement.

### Functions and mail delivery

- `table-portal` is the browser endpoint for table leads. It accepts high-entropy client idempotency keys for create, resend, and manual seat reservation. It returns queue status, **not** a raw guest token.
- `guest-registration` is the public, Turnstile-protected endpoint. It accepts an invitation token and the guest's own agreement. It has `Cache-Control: no-store` responses.
- `provision-table-access` is internal only; retain JWT verification and its service-role bearer check. It can regenerate an already-active management link from the protected HMAC secret.
- `mail-dispatch` is internal only; retain JWT verification and invoke it from the approved worker/cron with the service-role bearer. It atomically claims one (or a bounded batch of) queued delivery, reconstructs the exact same `#token=` guest link, calls the configured provider, and marks delivery sent **only after** provider success. It must be invoked for both initial and resend queues.

Deploy public endpoints only with `--no-verify-jwt`; do **not** use that flag for either internal function:

```bash
supabase functions deploy table-portal --no-verify-jwt
supabase functions deploy guest-registration --no-verify-jwt
supabase functions deploy provision-table-access
supabase functions deploy mail-dispatch
```

Configure an approved worker/cron to POST `{"max": 1}` (or a small bounded value, maximum 20) to `mail-dispatch`. The provider endpoint receives `{to, template_id, data: {guest_registration_url}}`; it must HTML-escape any template fields and must not log token-bearing payloads.

### Lifecycle and security rules

- Initial sends and resends create distinct `communication_deliveries` rows. Resend is authorized by `invitation_id` plus the table token; a browser never has to retain an invitation token.
- The delivery claim has a five-minute lease. Failed sends are requeued up to five attempts, then become `failed`. Only a claimed `processing` row can be marked sent.
- Revocation, completion, manual supersession, and expiry suppress queued/processing deliveries. A delayed sender cannot move a terminal invitation back to `sent`. As with all external-email systems, a provider call that races a revoke after claim cannot be recalled; the final status is nevertheless not resurrected.
- SQL rejects locked, occupied, missing, expired, and duplicate-reserved table seats. Locks are enforced in the database, not merely rendered by the portal.
- A manual table-lead action reserves a paid entitlement and numbered seat for the recipient, creates a pending attendee and secure completion invitation, and queues email. It creates **no** attendee-self consent and does not mark the attendee complete. The recipient must use the secure link and personally accept the combined agreement to finish registration.
- `ssuite_policy_versions`, token tables, request fingerprints, invitations, deliveries, and all RPCs remain service-role-only. SMS remains disabled.
- Frontends must read token fragments only locally, immediately remove them with `history.replaceState`, and exclude them from analytics, logging, and error reporting.

See `TEST_CHECKLIST.md` for required local and launch tests. Do not set `SSuite.sales_status = 'open'` until all policy, provider, secret, UI, price, member-import, and launch approvals are complete.
