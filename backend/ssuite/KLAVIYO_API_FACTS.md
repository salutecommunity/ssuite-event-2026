# Klaviyo REST API facts (documentation research)

Research date: 2026-08-26. This is documentation research only; no Klaviyo API request, connection, or credential was used.

## 1. CREATE EVENT ENDPOINT

**Sources:** [Create Event reference](https://developers.klaviyo.com/en/reference/create_event), [Create Event OpenAPI](https://raw.githubusercontent.com/klaviyo/openapi/main/openapi/stable/apis/create_event.json), and [Events API overview](https://developers.klaviyo.com/en/reference/events_api_overview).

- **Method:** `POST`
- **URL:** `https://a.klaviyo.com/api/events`
- **Documented request headers:**

  ```http
  Authorization: Klaviyo-API-Key your-private-api-key
  accept: application/vnd.api+json
  content-type: application/vnd.api+json
  revision: 2026-07-15
  ```

  The API reference marks `revision` required and states: `API endpoint revision (format: YYYY-MM-DD[.suffix])`. The current stable/default revision shown by the live reference and OpenAPI document is `2026-07-15`. The OpenAPI security scheme names the actual header `Authorization` and its value format `Klaviyo-API-Key your-private-api-key`. The request media type is `application/vnd.api+json`; the reference’s generated request includes both lower-case `accept` and `content-type` header names exactly as shown above. Formally, OpenAPI expresses authentication through the security scheme and `Content-Type` through the request media type rather than marking those as separate header parameters; the four headers above are the complete generated request-header set.

- **Complete documented single-event JSON body** (custom metric name, email-only profile identifier, arbitrary event properties, and caller-selected deduplication identifier):

  ```json
  {
      "data": {
          "type": "event",
          "attributes": {
              "properties": {
                  "action": "Reset Password",
                  "PasswordResetLink": "https://www.website.com/reset/1234567890987654321"
              },
              "metric": {
                  "data": {
                      "type": "metric",
                      "attributes": {
                          "name": "Reset Password"
                      }
                  }
              },
              "profile": {
                  "data": {
                      "type": "profile",
                      "attributes": {
                          "email": "sarah.mason@klaviyo-demo.com"
                      }
                  }
              },
              "unique_id": "4b5d3f33-2e21-4c1c-b392-2dae2a74a2ed"
          }
      }
  }
  ```

- The exact deduplication field is **`data.attributes.unique_id`**. Klaviyo says deduplication is on `(profile, metric, unique_id)`: “If two events are submitted with the same profile, the same metric, and the same `unique_id`, only the first processed event is recorded — the duplicate is silently discarded.” Thus a retry with the same tuple is a no-op if the first event was processed. The Events API overview documents the unique identifier as 1–255 characters and says it is represented in a retrieved event as `event_properties.$event_id`. If omitted, the default is the event timestamp truncated to seconds, which can cause same-profile/same-metric events in one second to collide.

## 2. RESPONSE

**Sources:** [Create Event reference](https://developers.klaviyo.com/en/reference/create_event), [Create Event OpenAPI](https://raw.githubusercontent.com/klaviyo/openapi/main/openapi/stable/apis/create_event.json), [Events API overview](https://developers.klaviyo.com/en/reference/events_api_overview), and [rate limits and error handling](https://developers.klaviyo.com/en/docs/rate_limits_and_error_handling).

- Success is **HTTP `202 Accepted`**. The Create Event OpenAPI response is `"202": { "description": "Success" }`; it defines no response `content` or response-body schema for that status.
- `202` means the request/event was accepted for asynchronous processing, not that processing has completed. Klaviyo says events “may take up to a few minutes to see them in the UI or returned via the Get Events API.”
- **No documented response body or event identifier is returned on Create Event success.** In particular, the `202` response does not document an event ID, flow-message ID, email-message ID, or other caller-usable correlation identifier. A later Get Events query can expose the event’s Klaviyo ID and `event_properties.$event_id`, but that is a separate read and is not returned by the create response. There is no documented identifier that correlates the create response directly to the eventual email send.

## 3. RATE LIMITS

**Source:** [Rate limits and error handling](https://developers.klaviyo.com/en/docs/rate_limits_and_error_handling), corroborated by the [Create Event OpenAPI](https://raw.githubusercontent.com/klaviyo/openapi/main/openapi/stable/apis/create_event.json).

Create Event is in the documented **XL** tier:

- **Burst:** `350/s` (1-second window)
- **Steady:** `3500/m` (1-minute window)

The Create Event operation itself declares `x-klaviyo-ratelimit` values `"burst": "350/s"` and `"steady": "3500/m"`.

- A limit hit returns **HTTP `429`**.
- On a `429`, the retry header is **`Retry-After`**, whose value is an integer number of seconds before requests can resume.
- Klaviyo says `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` are not returned when the `429` is hit; they are replaced by `Retry-After`. The normal (non-429) steady-window headers are spelled exactly `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset`.

## 4. FLOW TRIGGERING

**Sources:** [Events API overview](https://developers.klaviyo.com/en/reference/events_api_overview), [How to create a metric-triggered flow](https://help.klaviyo.com/hc/en-us/articles/360003057151), and [Understanding Smart Sending](https://help.klaviyo.com/hc/en-us/articles/115002779311).

- **Yes.** Klaviyo explicitly lists “Creating custom events that can be used to trigger flows” as an Events API use case, including a custom “Reset Password” event that triggers an email with a reset URL. A metric-triggered flow is configured by selecting the metric; available metrics include custom metrics set up through the developer portal. The flow guide says contacts receive the flow every time they complete the corresponding action unless filters say otherwise.
- **Timing:** `202 Accepted` and event ingestion are asynchronous. Klaviyo documents that an accepted event “may take up to a few minutes to see” in the UI or Get Events API. The documentation does **not** give a guaranteed event-arrival-to-flow-email-send delay for this API-to-flow path. **NOT CONFIRMED:** an exact maximum or SLA for the flow email’s send time. Integration sync delays described in the flow guide apply to integrations; they are not a stated timing guarantee for direct Create Event calls.
- **Smart Sending:** the current Smart Sending documentation says it applies only to marketing messages, with a default **16-hour email** window; a marketing message can be skipped during that window. It also says: “Transactional messages are never skipped, and receiving a transactional message does not cause recipients to be skipped by Smart Sending.” For a non-transactional flow email, turn it off per message by opening the flow message, scrolling to **Skip recently email profiles** (the UI wording in the doc), and toggling off **Smart Sending**. A metric-triggered flow can also be subject to filters, which are separate from Smart Sending.

## 5. CONSENT / SUPPRESSION

**Sources:** [Understanding transactional messages](https://help.klaviyo.com/hc/en-us/articles/26024442679835), [How to use flows to send transactional emails](https://help.klaviyo.com/hc/en-us/articles/360003165732), [Troubleshooting why a flow message skipped a profile](https://help.klaviyo.com/hc/en-us/articles/1260805003210), and [Email deliverability best practices reference](https://help.klaviyo.com/hc/en-us/articles/25620771311643).

### Will the flow email reach an unsubscribed/suppressed profile?

- For an ordinary marketing flow email, an unsubscribed/suppressed profile is not eligible for marketing delivery. Klaviyo’s flow skip-reason documentation says: “Skipped because they unsubscribed or hard bounced from all emails.”
- For a flow email that has been approved/designated as **transactional**, Klaviyo explicitly says **“Yes, suppressed profiles still receive transactional emails.”** The deliverability documentation is even more direct: “Even if a customer has unsubscribed from marketing emails, they would still expect to receive transactional messages around orders or administrative account activity. Because of this, emails marked as transactional in Klaviyo will still be sent to suppressed recipients.”
- Exceptions where suppressed profiles are skipped are explicitly documented as: (1) 7 consecutive soft bounces; (2) a hard bounce, including profiles marked suspicious; (3) the customer previously marked an email as spam; or (4) the email is pending transactional status or is being edited. For pending/edited status, Klaviyo says to set the flow to manual to avoid automatic skipping.
- This is not a guarantee that the receiving mailbox will place the message in the inbox; it is Klaviyo’s send/suppression rule. Also, the event must be a valid eligible transactional message—not merely an event named “transactional.”

### What “transactional” means and how it is enabled

Klaviyo’s exact definition is:

> “A transactional message is an automated message that’s sent when an individual takes an action and contains information directly related to the action.”

It contrasts them as:

> “Promotional (also known as marketing) messages are sale-driven and are initiated by the business, while transactional messages are user-driven.”

For email, the consent rule is:

> “A customer doesn’t need to explicitly opt in to receive transactional emails.”

The transactional-message designation is applied to an **individual flow message** in the flow editor, not to the Create Event request itself. The current documentation says that, “In approved cases and with a paid account, you can mark SMS or email messages in flows as transactional,” and limits email designation to **metric-triggered flows** (excluding price-drop flows). The setup instructions are: ensure the message is in **Manual** mode, click the message, then in the right sidebar click **Apply for transactional status**; Klaviyo says approval can take **up to 24 hours (1 business day)**. The message must be designated transactional in the flow editor and approved by Klaviyo. Editing a message removes its transactional status and requires re-submission. List- or segment-triggered requests must go through Klaviyo Support and may take longer to approve. The docs establish approval and a paid-account requirement; they do not describe a separate general account-level “transactional mode” switch beyond the per-message designation/approval process.

The policy’s transactional examples are:

- Account activation or deactivation
- New device login alert
- Password reset
- Order confirmation or cancellation
- Shipping or delivery alerts
- Booking or ticket confirmation

The policy says a transactional message should contain details directly related to the user action. It expressly prohibits unrelated/promotional content, including:

- Coupons
- Products that someone hasn’t bought
- Newsletter information
- Links to sign-up forms or subscribe pages
- Marketing calls to action (CTAs)

It also says welcome-series messages cannot be marked transactional in Klaviyo, and follow-up welcome-series messages are always promotional. “Invitation” is not one of the policy’s listed examples; the message would need to satisfy the action-related/content rules and receive approval—do not assume an invitation qualifies.

## 6. FLOW WEBHOOK ACTION

**Sources:** [How to add a webhook action to a flow](https://developers.klaviyo.com/en/docs/how_to_add_a_webhook_action_to_a_flow), [Getting started with Klaviyo webhooks](https://help.klaviyo.com/hc/en-us/articles/4534329515931), and [Understanding webhook status codes](https://developers.klaviyo.com/en/docs/understanding_webhook_status_codes).

- **Yes.** A Flow has a **Webhook** action that performs a `POST` to a configured external endpoint. The endpoint must be a valid URL, start with `HTTPS://`, not use a self-signed certificate, and not redirect.
- The payload is entered as a JSON block; only JSON formatting is supported. For metric-triggered flows, the payload can include profile properties and dynamic event data associated with the triggering event. The developer guide says to click **View profile and event variables** and copy/paste the variables into the JSON. (For list/segment/date-property flows, only profile properties are available.)
- The templating language is Django-style. For a simple custom event property, use `{{ event.property_name }}`; for example, if the triggering event’s JSON contains `"PasswordResetLink": "https://example.com/reset/abc"`, a JSON webhook body can contain:

  ```json
  {
    "email": "{{ email }}",
    "reset_url": "{{ event.PasswordResetLink }}"
  }
  ```

  Property names with spaces or special characters use lookup notation, e.g. `{{ event|lookup:'property name' }}`. The documentation says event variables are only available in flows triggered by that event.
- **Custom static headers: yes.** The UI has **+ Add Headers** for arbitrary key/value pairs, “e.g., for authentication.” Klaviyo states that webhook-header information is partially hashed in the UI for security. The flow webhook request also includes Klaviyo’s own `X-Klaviyo-Flow-ID` header.
- **Retries:** Klaviyo considers any `2xx` response successful. Non-`2xx` responses are classified as retryable or not. Documented retryable codes are `429`, `500`, `502`, and `503` (the status-code page lists `503` twice with two descriptions). Retryable requests are retried using exponential backoff, **up to 17 times over 24 hours**; after repeated failure they enter the failed queue. Non-retryable errors go to the Skipped queue. This is the documented Flow-webhook-action behavior; it is separate from system-webhook retry behavior.

## 7. DELIVERY WEBHOOKS

**Sources:** [Working with system webhooks](https://developers.klaviyo.com/en/docs/working_with_system_webhooks), [Get Webhook Topics](https://developers.klaviyo.com/en/reference/get_webhook_topics), and [Webhooks API overview](https://developers.klaviyo.com/en/reference/webhooks_api_overview).

Klaviyo does offer account-level **system webhooks** for event/metric outcomes, but access is restricted: the system-webhook guide says only **Advanced KDP customers and Klaviyo app partners** can access/manage webhooks with the Webhooks API. The guide says its common-topic table is not exhaustive and that the full account-specific list is obtained via Get Webhook Topics.

The exact common email outcome topic names and IDs requested here are:

| Outcome | Topic ID | Documentation description |
|---|---|---|
| Bounced Email | `event:klaviyo.bounced_email` | “When an email soft or hard bounced.” |
| Email Delivered | `event:klaviyo.received_email` in the common-topics table | “When an email is delivered to a recipient.” **Caveat:** the same guide’s request-structure text gives `event:klaviyo.email_delivered` as an example topic ID, so the exact delivered-email topic ID is inconsistent in Klaviyo’s documentation; account-specific topics must be checked with Get Webhook Topics. |
| Marked Email as Spam | `event:klaviyo.marked_email_as_spam` | “When a recipient marks an email as spam.” |
| Unsubscribed from Email Marketing | `event:klaviyo.unsubscribed_from_email_marketing` | “When a user unsubscribes from email marketing.” |

The exact system-webhook request headers are `Klaviyo-Webhook-Id`, `Klaviyo-Signature`, and `Klaviyo-Timestamp`. The body’s `data` array items contain:

- `external_id`: “ID of the event.”
- `payload`: payload with the same structure as a Get Event API call.
- `topic`: topic ID for that event.

The payload therefore contains an identifier for the **outcome event** (`external_id` and the nested event `data.id`), plus profile/metric relationships and event properties when present. However, the system-webhook documentation does **not** promise that a delivery outcome payload carries the original Create Event request’s `unique_id`/`event_properties.$event_id`, nor does it document a flow-email/message ID that links the outcome to the triggering event. **NOT CONFIRMED:** a guaranteed direct correlation from any of these delivery webhook outcomes to the caller-supplied Create Event `unique_id` or to the eventual flow email. The original event’s `unique_id` is shown by the Events API as `event_properties.$event_id` when that original event is retrieved, but that is not documented as a delivery-outcome correlation field.

Klaviyo signs system webhooks. The exact signature header is **`Klaviyo-Signature`** and the algorithm is **HMAC-SHA256**. The guide says to generate HMAC-SHA256 using the request body, the webhook `secret_key`, and the `Klaviyo-Timestamp` header, then compare it with `Klaviyo-Signature`. `Klaviyo-Webhook-Id` must match the same ID in the body’s `meta.klaviyo_webhook_id`.

## 8. TEMPLATE DATA

**Sources:** [Message personalization reference](https://help.klaviyo.com/hc/en-us/articles/4408802648731), [How to add personalization to messages](https://help.klaviyo.com/hc/en-us/articles/18986347580827), and [Events API overview](https://developers.klaviyo.com/en/reference/events_api_overview).

For a custom property attached to the triggering event, the exact simple-property syntax is:

```text
{{ event.property_name }}
```

Concrete example using the Create Event body above:

```text
Reset your password here: {{ event.PasswordResetLink }}
```

The personalization reference documents `{{ event.URL }}` as the simple event-variable example and says to use dot notation for names without spaces or special characters. For a property containing spaces or special characters, use lookup syntax, for example `{{ event|lookup:'property name' }}`. Event tags are available in metric-triggered flows for the event that triggered the flow.

## Confidence and gaps

- **NOT CONFIRMED:** Klaviyo does not document an exact maximum/SLA for the time from Create Event acceptance/ingestion to the Flow email send. It documents asynchronous processing and “up to a few minutes” for event visibility.
- **NOT CONFIRMED:** A system delivery webhook’s guaranteed direct correlation to the caller’s Create Event `unique_id`/`$event_id` or to a Flow email/message ID. The delivery webhook has an outcome-event ID, but the docs do not promise the requested cross-event mapping.
- **NOT CONFIRMED:** The exact topic ID for “Email Delivered” is internally inconsistent in the system-webhook guide: its common-topic table says `event:klaviyo.received_email`, while its request-structure example says `event:klaviyo.email_delivered`. The Get Webhook Topics endpoint requires account access to resolve available topics; no Klaviyo API was called here.
- The Create Event success response is documented as `202` with no response content schema; therefore no response-body identifier is documented. This does not claim that a raw HTTP implementation can never emit incidental bytes—only that Klaviyo documents no body/ID for the success response.
- The system-webhook common-topic table is explicitly not exhaustive; account-specific topics must be enumerated with Get Webhook Topics, and access is restricted to Advanced KDP customers and Klaviyo app partners.
