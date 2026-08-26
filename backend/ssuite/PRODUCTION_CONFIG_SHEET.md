# Production configuration sheet — project `iddzcbknnddkonrcwgpt`

Prepared 2026-08-26 evening for the launch attempt. Values below are ready to paste into
Supabase → Project Settings → Edge Functions → Secrets for the **production** project.

**Handling:** this file contains generated secrets. It lives in private agent storage only.
Never commit it to `salutecommunity/ssuite-event-2026` — that repository is **public**.

Legend: **READY** = paste as written · **NEEDED** = external credential only Neha can supply ·
**BLOCKED** = no value can exist yet because a component or decision is missing.

---

## 1. READY — paste exactly as written (10)

| Variable | Value |
|---|---|
| `SSUITE_ALLOWED_ORIGINS` | `https://event.ssuite.org` |
| `SSUITE_ADMIN_ALLOWED_ORIGINS` | `https://event.ssuite.org` |
| `SSUITE_TABLE_PORTAL_URL` | `https://event.ssuite.org/table-portal.html` |
| `SSUITE_GUEST_REGISTRATION_URL` | `https://event.ssuite.org/guest-registration.html` |
| `TURNSTILE_EXPECTED_HOSTNAME` | `event.ssuite.org` |
| `SSUITE_TURNSTILE_ACTION` | `guest-registration` |
| `SSUITE_TOKEN_DERIVATION_SECRET_V1` | `OoOZUx9ssacnAUlNpPnVnII4iM5c3dvl0PgHBKlJXH5HTMT3Jkf3WcWO7oR_0oer` |
| `SSUITE_EMAIL_CALLBACK_SHARED_SECRET` | `knzPLgD3DLxupp-pddfqn7yvgjhfDgCM8GWEVtOFp60HaFjeDmSKj1hsNFymJTri` |
| `SSUITE_AUCTION_IP_HASH_SECRET` | `1kL4iyhAkXPI15x9xzXvR1AfaPsmx-XNRv2bs60u0VdlGj63H89DIw_0E3PKCiGc` |
| `SSUITE_DONATION_IP_HASH_SECRET` | `ogGi2dLKP2c-xXBT0HB8w8453rkW5MvB1-SVZ-j8AXWab2aeUTu4LJ3pRleD0ybh` |

Notes:
- **No trailing slashes.** `SSUITE_ADMIN_ALLOWED_ORIGINS` is parsed more strictly than its
  sibling; a trailing slash silently locks every admin request out.
- The four generated secrets are 64 characters, well above the 32-character minimum the
  auction and donation functions hard-enforce (they return 503 on every request if shorter).
- `SSUITE_TOKEN_DERIVATION_SECRET_V1` is safe to set fresh because production has issued no
  links yet. **Once sales open, rotating it invalidates every table-management and invitation
  link ever issued.** Treat it as permanent.

## 2. MUST STAY UNSET (2)

`SSUITE_ALLOW_LOCAL_DEVELOPMENT` · `SSUITE_TURNSTILE_TEST_MODE`

Setting either weakens origin checking or accepts forged bot-protection tokens in production.

## 3. NEEDED — external credentials (5)

| Variable | Where it comes from | Shape |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys, **live mode** | `sk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Webhooks → `…/stripe-webhook` → signing secret | `whsec_…` |
| `SSUITE_DONATION_STRIPE_WEBHOOK_SECRET` | Stripe → Webhooks → `…/donation-stripe-webhook` | `whsec_…` |
| `TURNSTILE_SECRET_KEY` | Cloudflare → Turnstile → widget for `event.ssuite.org` | secret key |
| `SSUITE_KLAVIYO_API_KEY` | Klaviyo → Settings → API Keys → Private API Keys | `pk_…` |

Cloudflare Turnstile also yields a **site key**, which is public and goes in `config.js`
(section 6), not here.

## 4. ~~BLOCKED~~ RESOLVED 2026-08-26 — all five now have values

These were blocked only because the relay did not exist. It does now. Exact values,
including generated keys, are in **`EMAIL_RELAY_RUNBOOK.md` § "Secrets this adds"**, which is
the single source of truth for them. Substitute the project ref (`iddzcbknnddkonrcwgpt` for
production, `fxhhwtmanioqtjnppbhm` for staging).

| Variable | Value |
|---|---|
| `SSUITE_EMAIL_RELAY_URL` | `https://{project}.supabase.co/functions/v1/ssuite-email-relay/send` |
| `SSUITE_EMAIL_RELAY_API_KEY` | Generated — see runbook |
| `SSUITE_KLAVIYO_SEND_URL` | `https://{project}.supabase.co/functions/v1/ssuite-email-relay/legacy-invitation` |
| `SSUITE_KLAVIYO_TEMPLATE_ID` | `S.Suite Table Invitation` |
| `SSUITE_EMAIL_TEMPLATE_IDS_JSON` | The nine-entry map below |

### Correction — the map holds metric names, not template IDs

An earlier draft of this sheet listed Klaviyo **template IDs** (`RXG4VE`, `WuE9QE`, …) as the
values. That was wrong and would have failed at send time for all nine messages.

The dispatcher passes each value through to the relay as `template_id`, and the relay triggers
it as a **Klaviyo metric name**. The flow bound to that metric selects the template. The nine
templates are still used exactly as built; the flow, not this map, chooses them.

```json
{
  "ssuite_paid_order_confirmation": "S.Suite Paid Order Confirmation",
  "ssuite_table_lead_access": "S.Suite Table Lead Access",
  "ssuite_table_invitation": "S.Suite Table Invitation",
  "ssuite_guest_registration_confirmation": "S.Suite Guest Registration Confirmation",
  "ssuite_incomplete_table_reminder": "S.Suite Incomplete Table Reminder",
  "ssuite_event_logistics": "S.Suite Event Logistics",
  "ssuite_auction_submission_acknowledgment": "S.Suite Auction Submission Acknowledgment",
  "ssuite_donation_receipt": "S.Suite Donation Receipt",
  "ssuite_post_event_thanks": "S.Suite Post Event Thanks"
}
```

`SSUITE_KLAVIYO_ALLOWED_METRICS_JSON` is those same nine names as a JSON array. The relay
refuses any metric outside the list with `400 Unknown message type`, so a leaked relay key
cannot fire arbitrary metrics into the Klaviyo account.

`templateMap()` imposes **no required key set** — an earlier concern about a mandatory
`wallet-pass-update` key was incorrect. Wallet passes are out of scope and need no entry; the
wallet-pass template has been quarantined as untruthful.

## 5. The missing component: the email relay — BUILT 2026-08-26

> **Status update.** The relay described below was built, deployed to both projects, and
> committed to the release branch on the evening of 2026-08-26, together with the scheduled
> worker that drains the outbox. Exact variable values, the metric-name routing change, and the
> nine Klaviyo flows still to be constructed are in **`EMAIL_RELAY_RUNBOOK.md`**, which
> supersedes the analysis below. The original diagnosis is retained for the record.

`email-operations-dispatch/index.ts` states its own design in its header:

> *"It implements a relay contract; it is not a Klaviyo API client and never guesses provider
> endpoints or payloads. The relay must accept `idempotency_key` and return exactly
> `{accepted:true, provider_message_id:"…"}` only after provider acceptance."*

So the dispatcher deliberately refuses to talk to Klaviyo. It posts to a relay that **has never
been built**. Until that service exists and is hosted, no S.Suite email can be sent by any
automated path, in staging or production.

Database evidence, isolated staging, 2026-08-26:

| Fact | Value |
|---|---|
| Outbox rows ever created | 11 (paid confirmation, table lead access, guest registration confirmation) |
| Rows with a delivery attempt | **0** |
| Rows accepted by a provider | **0** |
| Rows delivered | **0** |
| Provider callback events ever received | **0** |
| Table invitations ever created | 3, all suppressed |

Every row carries a deliberate suppression reason such as *"Isolated release-gate test
recipient; delivery intentionally disabled."* The queue and its triggers work — rows appear on
the right events. Nothing has ever been handed to a provider.

**Recommended build:** a Supabase Edge Function `ssuite-email-relay` that satisfies the contract
by posting a Klaviyo event per message type, letting the existing Klaviyo flows render and send,
and returning the Klaviyo event ID as `provider_message_id`. This preserves the dispatcher's
contract and reuses the nine templates as built. Precedent exists: the 2026-08-21 probe posted
one event and Klaviyo sent the paid-order template from
`"S.Suite by SALUTE" <ssuite@salute.community>`.

Also required alongside it:
- Activate the nine Klaviyo flows and **remove the `Email equals neha@salute.community` filter**
  that currently restricts them to a single test recipient.
- Deploy a scheduled worker to drain the outbox; the dispatcher is not self-triggering.
- Point `email-operations-callback` at Klaviyo webhooks so rows can reach `delivered`/`bounced`.
  Provider callbacks have never been received, so delivery tracking is currently unproven.

## 6. Public site wiring — `config.js` (currently all blank)

The deployed site is not connected to any backend. Present state:

```js
mode: "preview", apiBase: "", turnstileSiteKey: "", turnstileAction: "", policy: null,
donation: { enabled: false, ... }, auction: { enabled: false, ... }
```

For launch it needs:

| Field | Value |
|---|---|
| `mode` | `"live"` |
| `apiBase` | `https://iddzcbknnddkonrcwgpt.supabase.co` |
| `turnstileSiteKey` | Cloudflare site key (public) |
| `turnstileAction` | `guest-registration` — must match `SSUITE_TURNSTILE_ACTION` exactly |
| `policy` | Terms/privacy/media URLs **plus approved version strings** |

`policy: null` is a hard blocker independent of everything else: the required combined
Terms/Privacy/Media agreement cannot be recorded without approved version strings, and
registration requires that acceptance.

Changing `mode` to `"live"` does **not** open sales. The database remains the authority and
still requires `SSuite.sales_status = 'open'`.

## 7. Stripe webhook endpoints

| Endpoint | Events |
|---|---|
| `https://iddzcbknnddkonrcwgpt.supabase.co/functions/v1/stripe-webhook` | `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded` |
| `https://iddzcbknnddkonrcwgpt.supabase.co/functions/v1/donation-stripe-webhook` | the same five, plus `invoice.paid`, `customer.subscription.deleted` |

Must be created in **live** mode. Signing secrets feed section 3.

### These must be created by Neha — the connected Stripe key cannot do it

Attempted 2026-08-26 and refused at the key level, for both read and write:

```
stripe_api_read  GetWebhookEndpoints  → "Your API key does not have the required
                                         permissions for 'GetWebhookEndpoints'."
stripe_api_write PostWebhookEndpoints → "Your API key does not have the required
                                         permissions for 'PostWebhookEndpoints'."
```

The connected key has no webhook-endpoint scope, so the endpoints can neither be listed
nor created from here. Two ways forward, Neha's choice:

- **Create both endpoints in the Stripe dashboard** (Developers → Webhooks → Add endpoint),
  selecting the events above, and paste the two signing secrets into section 3. Roughly
  five minutes.
- **Grant the connected key webhook-endpoint permissions**, after which this can be done
  here and verified automatically.

Either way the signing secrets are required before any payment can be honoured: without
them the webhook rejects Stripe's calls, and a buyer would be charged with no registration
created. This is a hard gate, not a nicety.

## 8. Open decision

`SSUITE_TRUSTED_CLIENT_IP_HEADER` — governs which header is trusted for rate limiting and IP
hashing. Because `event.ssuite.org` is GitHub Pages and browser calls go directly to
`*.supabase.co` rather than through Cloudflare, the correct value is `x-forwarded-for`.
Confirm before setting: trusting a header the infrastructure does not actually set lets a
client spoof its own address and evade rate limits.

---

## Ordered path to opening sales

1. Neha supplies the five credentials in section 3 and the Cloudflare site key.
2. Build, deploy, and test the email relay (section 5); activate the nine Klaviyo flows and
   remove the single-recipient filters.
3. Set all secrets; create both Stripe webhook endpoints.
4. Wire `config.js`, including approved policy versions.
5. Bootstrap the sole administrator.
6. Prove delivery end to end for paid confirmation, table lead access, and guest invitation.
7. One controlled live $275 purchase, refunded immediately — approved by Neha 2026-08-26.
8. Backup and restore verification.
9. Set `sales_status = 'open'`.
