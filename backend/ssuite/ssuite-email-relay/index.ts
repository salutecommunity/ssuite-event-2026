// S.Suite email relay.
//
// This is the component `email-operations-dispatch` posts to. The dispatcher deliberately
// refuses to be a Klaviyo client, so every provider-specific detail lives here and nowhere
// else. Built against documented Klaviyo behaviour recorded in KLAVIYO_API_FACTS.md; no
// endpoint, header, or payload here is guessed.
//
// Two routes, both POST:
//   /send           dispatcher -> Klaviyo Create Event (a flow renders and sends the email)
//   /flow-callback  Klaviyo flow webhook action -> signed forward to email-operations-callback
//
// Deploy with JWT verification DISABLED. Both routes authenticate with their own bearer
// secret; neither accepts a Supabase JWT, and no browser origin is ever allowed.
//
// TRUTHFULNESS NOTE, deliberate and load-bearing:
// Klaviyo's Create Event endpoint returns 202 with no body and no identifier of any kind.
// There is therefore no provider-issued message id to report. We return our own outbox id,
// prefixed so it can never be mistaken for one Klaviyo minted. A 202 proves Klaviyo accepted
// the trigger event. It does NOT prove an email was sent: the flow can still skip the profile
// for suppression or Smart Sending. Proof that the flow actually sent arrives only via the
// /flow-callback route, which is why each flow must carry a webhook action after its email.

const APPROVED_SENDER = {
  name: "S.Suite by SALUTE",
  email: "ssuite@salute.community",
  replyTo: "ssuite@salute.community",
} as const;

const RELAY_API_KEY = (Deno.env.get("SSUITE_EMAIL_RELAY_API_KEY") ?? "").trim();
const KLAVIYO_API_KEY = (Deno.env.get("SSUITE_KLAVIYO_API_KEY") ?? "").trim();
const KLAVIYO_REVISION = (Deno.env.get("SSUITE_KLAVIYO_REVISION") ?? "2026-07-15").trim();
const FLOW_CALLBACK_KEY = (Deno.env.get("SSUITE_KLAVIYO_FLOW_CALLBACK_KEY") ?? "").trim();
const CALLBACK_URL = (Deno.env.get("SSUITE_EMAIL_CALLBACK_URL") ?? "").trim();
const CALLBACK_SECRET = (Deno.env.get("SSUITE_EMAIL_CALLBACK_SHARED_SECRET") ?? "").trim();
const CALLBACK_AUTH = (Deno.env.get("SSUITE_EMAIL_CALLBACK_AUTHORIZATION") ?? "").trim();

const KLAVIYO_EVENTS_URL = "https://a.klaviyo.com/api/events";
const CALLBACK_EVENT_TYPES = new Set(["accepted", "delivered", "bounced", "complained", "unsubscribed", "suppressed"]);
const MESSAGE_ID_PREFIX = "klaviyo-event:";

type JsonObject = Record<string, unknown>;

function json(status: number, body: JsonObject): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Pragma": "no-cache" },
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length || !a.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

function bearerMatches(header: string | null, secret: string): boolean {
  return !!secret && secret.length >= 24 && constantTimeEqual((header ?? "").trim(), `Bearer ${secret}`);
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Allowed metric names. The relay may only ever trigger a metric on this list, so a leaked
 *  relay key cannot be used to fire arbitrary Klaviyo metrics into the account. */
function allowedMetrics(): Set<string> | null {
  try {
    const parsed: unknown = JSON.parse(Deno.env.get("SSUITE_KLAVIYO_ALLOWED_METRICS_JSON") ?? "");
    if (!Array.isArray(parsed) || !parsed.length || parsed.length > 50) return null;
    const names = parsed.map((value) => (typeof value === "string" ? value.trim() : ""));
    if (names.some((name) => !name || name.length > 120)) return null;
    return new Set(names);
  } catch {
    return null;
  }
}

const ALLOWED_METRICS = allowedMetrics();

function isEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Event properties are recipient-facing template data. Reject anything that is not a flat,
 *  renderable value so no nested object or oversized blob is shipped to the provider. */
function safeProperties(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as JsonObject);
  if (entries.length > 60) return null;
  const result: JsonObject = {};
  for (const [key, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(key)) return null;
    if (item === null || typeof item === "number" || typeof item === "boolean") {
      result[key] = item;
      continue;
    }
    if (typeof item === "string") {
      if (item.length > 2000) return null;
      result[key] = item;
      continue;
    }
    if (Array.isArray(item) && item.length <= 40 && item.every((entry) => typeof entry === "string" && entry.length <= 500)) {
      result[key] = item;
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const nested = Object.entries(item as JsonObject);
      if (nested.length > 30 || nested.some(([, entry]) => entry !== null && typeof entry === "object")) return null;
      result[key] = item;
      continue;
    }
    return null;
  }
  return result;
}

type SendRequest = { idempotencyKey: string; metric: string; templateVersion: number; recipient: string; properties: JsonObject };

function parseSend(value: unknown): SendRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as JsonObject;
  const from = body.from as JsonObject | undefined;
  const to = body.to as JsonObject | undefined;

  if (!isUuid(body.idempotency_key)) return null;
  const metric = typeof body.template_id === "string" ? body.template_id.trim() : "";
  if (!metric || metric.length > 120) return null;
  const templateVersion = Number(body.template_version);
  if (!Number.isInteger(templateVersion) || templateVersion < 1 || templateVersion > 100000) return null;
  if (!to || !isEmail(to.email)) return null;

  // The approved sender is enforced here, not merely passed through. The relay will not send
  // as any other identity even if the caller asks it to.
  if (!from || from.name !== APPROVED_SENDER.name || from.email !== APPROVED_SENDER.email) return null;
  if (body.reply_to !== APPROVED_SENDER.replyTo) return null;

  const properties = safeProperties(body.data ?? {});
  if (!properties) return null;
  return { idempotencyKey: body.idempotency_key, metric, templateVersion, recipient: to.email, properties };
}

async function handleSend(request: Request): Promise<Response> {
  if (!bearerMatches(request.headers.get("authorization"), RELAY_API_KEY)) return json(401, { error: "Unauthorized" });
  if (!KLAVIYO_API_KEY || !/^pk_[A-Za-z0-9_-]{10,}$/.test(KLAVIYO_API_KEY)) return json(503, { error: "Relay is not configured" });
  if (!/^\d{4}-\d{2}-\d{2}(\.[A-Za-z0-9-]+)?$/.test(KLAVIYO_REVISION)) return json(503, { error: "Relay is not configured" });
  if (!ALLOWED_METRICS) return json(503, { error: "Relay is not configured" });

  const raw = await request.text();
  if (raw.length > 64 * 1024) return json(413, { error: "Payload too large" });
  let parsed: SendRequest | null;
  try { parsed = parseSend(JSON.parse(raw)); } catch { parsed = null; }
  if (!parsed) return json(400, { error: "Invalid relay request" });
  if (!ALLOWED_METRICS.has(parsed.metric)) return json(400, { error: "Unknown message type" });

  // ssuite_message_id travels into the flow so the flow's webhook action can report back and
  // prove the email action actually ran for this specific outbox row.
  return await sendEvent(parsed.idempotencyKey, parsed.metric, parsed.recipient, {
    ...parsed.properties,
    ssuite_message_id: parsed.idempotencyKey,
    ssuite_template_version: parsed.templateVersion,
  });
}

async function sendEvent(uniqueId: string, metric: string, recipient: string, properties: JsonObject): Promise<Response> {
  const event = {
    data: {
      type: "event",
      attributes: {
        properties,
        metric: { data: { type: "metric", attributes: { name: metric } } },
        profile: { data: { type: "profile", attributes: { email: recipient } } },
        unique_id: uniqueId,
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response: Response;
  try {
    response = await fetch(KLAVIYO_EVENTS_URL, {
      method: "POST",
      headers: {
        "Authorization": `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        "accept": "application/vnd.api+json",
        "content-type": "application/vnd.api+json",
        "revision": KLAVIYO_REVISION,
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
  } catch {
    return json(504, { error: "Provider did not respond" });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After") ?? "";
    return json(429, { error: "Provider rate limited", retry_after_seconds: Number(retryAfter) || null });
  }
  if (response.status !== 202) {
    // Provider error text is not echoed; it can contain account detail.
    return json(502, { error: `Provider rejected the message (HTTP ${response.status})` });
  }

  // 202 means accepted for asynchronous processing. See the truthfulness note at the top.
  return json(200, { accepted: true, provider_message_id: `${MESSAGE_ID_PREFIX}${uniqueId}` });
}

/** Legacy guest-invitation route.
 *
 *  `mail-dispatch` predates the outbox and posts a slightly different body: `to` is a bare
 *  string and there is no `from`, `reply_to`, or `template_version`. It was written expecting a
 *  provider with a direct "send this template to this address" API. Klaviyo has no such API, so
 *  that function could never have worked against Klaviyo as configured. Rather than change a
 *  tested invitation path on launch day, the relay accepts its shape here and normalises it.
 *  Point SSUITE_KLAVIYO_SEND_URL at this route. */
async function handleLegacyInvitation(request: Request): Promise<Response> {
  if (!bearerMatches(request.headers.get("authorization"), RELAY_API_KEY)) return json(401, { error: "Unauthorized" });
  if (!KLAVIYO_API_KEY || !ALLOWED_METRICS) return json(503, { error: "Relay is not configured" });

  const raw = await request.text();
  if (raw.length > 16 * 1024) return json(413, { error: "Payload too large" });
  let body: JsonObject | null;
  try {
    const parsed: unknown = JSON.parse(raw);
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch { body = null; }
  if (!body || !isUuid(body.idempotency_key) || !isEmail(body.to)) return json(400, { error: "Invalid relay request" });

  const metric = typeof body.template_id === "string" ? body.template_id.trim() : "";
  if (!metric || !ALLOWED_METRICS.has(metric)) return json(400, { error: "Unknown message type" });
  const properties = safeProperties(body.data ?? {});
  if (!properties) return json(400, { error: "Invalid relay request" });

  return await sendEvent(body.idempotency_key, metric, body.to, { ...properties, ssuite_message_id: body.idempotency_key });
}

type FlowCallback = { messageId: string; eventType: string; occurredAt: string; detail: string | null };

function parseFlowCallback(value: unknown): FlowCallback | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as JsonObject;
  if (!isUuid(body.ssuite_message_id)) return null;
  const eventType = typeof body.event_type === "string" ? body.event_type.trim() : "";
  if (!CALLBACK_EVENT_TYPES.has(eventType)) return null;
  const occurred = typeof body.occurred_at === "string" && body.occurred_at.trim() ? new Date(body.occurred_at.trim()) : new Date();
  if (Number.isNaN(occurred.valueOf())) return null;
  const detail = typeof body.detail === "string" ? body.detail.trim().slice(0, 1000) || null : null;
  return { messageId: body.ssuite_message_id, eventType, occurredAt: occurred.toISOString(), detail };
}

async function handleFlowCallback(request: Request): Promise<Response> {
  if (!bearerMatches(request.headers.get("authorization"), FLOW_CALLBACK_KEY)) return json(401, { error: "Unauthorized" });
  if (!CALLBACK_URL.startsWith("https://") || !CALLBACK_SECRET) return json(503, { error: "Callback forwarding is not configured" });

  const raw = await request.text();
  if (raw.length > 16 * 1024) return json(413, { error: "Payload too large" });
  let parsed: FlowCallback | null;
  try { parsed = parseFlowCallback(JSON.parse(raw)); } catch { parsed = null; }
  if (!parsed) return json(400, { error: "Invalid callback" });

  // provider_event_id is deterministic per (message, outcome) so Klaviyo's documented webhook
  // retries -- up to 17 attempts over 24 hours -- collapse into one recorded event.
  const forwarded = JSON.stringify({
    provider_event_id: `klaviyo-flow:${parsed.eventType}:${parsed.messageId}`,
    provider_message_id: `${MESSAGE_ID_PREFIX}${parsed.messageId}`,
    event_type: parsed.eventType,
    occurred_at: parsed.occurredAt,
    detail: parsed.detail ?? "flow email action executed",
  });

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await hmacHex(CALLBACK_SECRET, `${timestamp}.${forwarded}`);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-ssuite-relay-signature": `t=${timestamp},v1=${signature}`,
  };
  if (CALLBACK_AUTH) {
    headers["Authorization"] = `Bearer ${CALLBACK_AUTH}`;
    headers["apikey"] = CALLBACK_AUTH;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response: Response;
  try {
    response = await fetch(CALLBACK_URL, { method: "POST", headers, body: forwarded, signal: controller.signal });
  } catch {
    // 503 is on Klaviyo's documented retryable list, so a transient failure is retried.
    return json(503, { error: "Callback receiver did not respond" });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) return json(200, { received: true, unknown_message: true });
  if (!response.ok) return json(response.status === 401 ? 500 : 503, { error: "Callback was not recorded" });
  return json(200, { received: true });
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!RELAY_API_KEY) return json(503, { error: "Relay is not configured" });
  const route = new URL(request.url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  if (route === "flow-callback") return await handleFlowCallback(request);
  if (route === "legacy-invitation") return await handleLegacyInvitation(request);
  if (route === "send" || route === "ssuite-email-relay") return await handleSend(request);
  return json(404, { error: "Not found" });
});
