# S.Suite email relay — build record and operating runbook

Built 2026-08-26 evening. Source: `ssuite-email-relay/index.ts`.
Provider facts it is built against: `KLAVIYO_API_FACTS.md` (documentation research, no API calls).

## What this closes

`email-operations-dispatch` implements a relay contract and deliberately refuses to be a
Klaviyo client. The relay it posts to had never been built, which is why **zero S.Suite emails
have ever been sent** — 11 outbox rows, 0 delivery attempts, 0 provider events.

The relay is that missing component. Deployed to isolated staging `fxhhwtmanioqtjnppbhm` as
`ssuite-email-relay`, version 2, ACTIVE, JWT verification disabled (it authenticates with its
own bearer secrets on every route and accepts no browser origin).

## Routes

| Route | Caller | Purpose |
|---|---|---|
| `POST …/ssuite-email-relay/send` | `email-operations-dispatch` | Outbox row → Klaviyo event → flow sends |
| `POST …/ssuite-email-relay/legacy-invitation` | `mail-dispatch` | Same, in the older function's payload shape |
| `POST …/ssuite-email-relay/flow-callback` | Klaviyo flow webhook action | Proof the flow's email action ran; signed forward to `email-operations-callback` |

### Why the legacy route exists

`mail-dispatch` (the guest-invitation queue) was written expecting a provider with a direct
"send this template to this address" API and reads `SSUITE_KLAVIYO_SEND_URL`. **Klaviyo has no
such API.** That function could never have worked against Klaviyo however it was configured.
Rather than rewrite a tested invitation path on launch day, the relay accepts its payload shape
and normalises it. Point `SSUITE_KLAVIYO_SEND_URL` at `/legacy-invitation`.

## Verified so far

| Check | Result |
|---|---|
| Compiles | Pass |
| Deployed and reachable, all three routes | Pass |
| `GET` rejected | Pass — 405 |
| Unconfigured relay fails closed, no send path reachable | Pass — 503 on every route |
| Sender identity enforced, not passed through | Built in; untestable until secrets exist |
| Metric allowlist blocks arbitrary metrics from a leaked key | Built in; untestable until secrets exist |

Everything past this line needs `SSUITE_KLAVIYO_API_KEY`, which only Neha can obtain, and the
Supabase connection exposes no secret-setting tool — the values must be entered in the dashboard.

## Secrets this adds

Set on the same project as the other function secrets.

| Variable | Value |
|---|---|
| `SSUITE_EMAIL_RELAY_URL` | `https://{project}.supabase.co/functions/v1/ssuite-email-relay/send` |
| `SSUITE_EMAIL_RELAY_API_KEY` | `b8g_hLZ0kt-DrPoz2qcYIvSRz2eNhiy0LljxJHEZJowhxdTslyrxHp0WxHfzRKjQ` |
| `SSUITE_KLAVIYO_FLOW_CALLBACK_KEY` | `hjK84w7WoYTPmazF-s0Q_LpJrscN1ij9yWa8edVxwQsCyJXkKDBgoQ9DA1wI5Ssl` |
| `SSUITE_EMAIL_CALLBACK_URL` | `https://{project}.supabase.co/functions/v1/email-operations-callback` |
| `SSUITE_KLAVIYO_API_KEY` | Klaviyo private API key, `pk_…` — **Neha** |
| `SSUITE_KLAVIYO_REVISION` | `2026-07-15` (optional; this is the built-in default) |
| `SSUITE_KLAVIYO_SEND_URL` | `https://{project}.supabase.co/functions/v1/ssuite-email-relay/legacy-invitation` |
| `SSUITE_KLAVIYO_TEMPLATE_ID` | `S.Suite Table Invitation` |
| `SSUITE_EMAIL_CALLBACK_AUTHORIZATION` | Project anon key, only if `email-operations-callback` has JWT verification on |

`SSUITE_EMAIL_CALLBACK_SHARED_SECRET` is already in the ready list on the configuration sheet
and must be **identical** on the relay and on `email-operations-callback`.

### Routing key change

`SSUITE_EMAIL_TEMPLATE_IDS_JSON` values become **Klaviyo metric names**, not template IDs. The
dispatcher passes the value through as `template_id`; the relay treats it as the metric to
trigger, and the flow bound to that metric chooses the template. The nine templates are still
used exactly as built — the flow selects them.

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

`SSUITE_KLAVIYO_ALLOWED_METRICS_JSON` is the same nine names as a JSON array. A relay key that
leaked still could not fire any metric outside this list.

## Klaviyo work that cannot be skipped

Nine flows, one per metric, each: metric trigger → email action using the matching existing
template → webhook action. For each one:

1. **Turn Smart Sending OFF.** This is not optional and it is the sharpest edge in the whole
   system. Smart Sending defaults to a **16-hour** window and silently skips a second marketing
   email to the same person inside it. A table purchase fires the paid-order confirmation and
   the table-lead access link **seconds apart to the same address**. Left on, the buyer gets a
   receipt and never gets the link to name their table — with no error anywhere.
2. **Remove the `Email equals neha@salute.community` filter** left over from testing.
3. **Add the webhook action after the email**, POSTing to the `/flow-callback` route with header
   `Authorization: Bearer {SSUITE_KLAVIYO_FLOW_CALLBACK_KEY}` and body:

   ```json
   { "ssuite_message_id": "{{ event.ssuite_message_id }}", "event_type": "accepted",
     "detail": "flow email action executed" }
   ```

4. **Apply for transactional status** — see below.

## Two honesty limits, recorded deliberately

**A provider message id does not exist.** Klaviyo's Create Event endpoint returns `202` with no
body and no identifier. There is nothing provider-issued to record. The relay returns our own
outbox id prefixed `klaviyo-event:` so it can never be mistaken for a Klaviyo identifier.

**`202` is not proof an email was sent.** It proves Klaviyo accepted the trigger event. The flow
can still skip the profile for suppression or Smart Sending. Only the `/flow-callback` webhook
proves the email action actually ran, which is why every flow needs one. Outbox rows are
recorded as `accepted`, never `delivered`, because true delivery confirmation requires Klaviyo's
account-level system webhooks, and those are documented as available only to Advanced KDP
customers and Klaviyo app partners. **A row that reaches `accepted` and never receives a flow
callback is a message that was silently skipped** — that gap is the monitoring signal.

## The scheduling gap

`email-operations-dispatch` is not self-triggering; it sends only when something POSTs to it
with the service-role bearer. No scheduled worker exists. Without one, the outbox fills and
never drains. A `pg_cron` job invoking the dispatcher every minute is the remaining piece.

## Transactional status — the timing constraint

Klaviyo's documentation is explicit:

- Marking a flow email transactional requires a **paid account**, the message set to **Manual**
  mode, and a per-message **"Apply for transactional status"** submission.
- Approval takes **up to 24 hours (one business day)**.
- While pending or being edited, suppressed profiles are skipped.
- Editing an approved message **removes** its status and requires resubmission.
- Without it, an unsubscribed or suppressed profile does not receive the message. Someone who
  paid $5,000 for a table and had ever unsubscribed from SALUTE marketing would get nothing.

Klaviyo's permitted transactional categories are account activation/deactivation, new device
login alert, password reset, order confirmation or cancellation, shipping or delivery alerts,
and booking or ticket confirmation. The paid-order confirmation and table-lead access messages
fit comfortably. **"Invitation" is not on that list** — the guest invitation may not qualify,
and eligibility must not be assumed. Klaviyo also prohibits marketing CTAs inside transactional
messages, so the nine templates need a content pass before submission.

This is the constraint that governs the launch date: even with every credential in hand, the
transactional applications cannot be approved sooner than Klaviyo approves them.
