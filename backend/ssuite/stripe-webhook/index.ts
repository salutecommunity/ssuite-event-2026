import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const SIGNATURE_TOLERANCE_SECONDS = 300;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type StripeEvent = {
  id: string;
  type: string;
  created?: number;
  data?: { object?: Record<string, unknown> };
};

type LedgerRow = { id: string; status: string };

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return new Uint8Array();
  const result = new Uint8Array(hex.length / 2);
  for (let index = 0; index < result.length; index++) result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return result;
}

async function verifyStripeSignature(rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature || !STRIPE_WEBHOOK_SECRET) return false;
  const parts = new Map<string, string[]>();
  for (const component of signature.split(",")) {
    const [key, value] = component.split("=", 2);
    if (key && value) parts.set(key, [...(parts.get(key) ?? []), value]);
  }
  const timestamp = Number(parts.get("t")?.[0]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const signedPayload = new TextEncoder().encode(`${timestamp}.${rawBody}`);
  const secret = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", secret, signedPayload));
  return (parts.get("v1") ?? []).some((candidate) => constantTimeEqual(expected, hexToBytes(candidate)));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function metadata(event: StripeEvent): { orderId: string; holdToken: string } | null {
  const object = event.data?.object ?? {};
  const values = (object.metadata ?? {}) as Record<string, unknown>;
  if (typeof values.order_id !== "string" || typeof values.hold_token !== "string" || !values.order_id || !values.hold_token) return null;
  return { orderId: values.order_id, holdToken: values.hold_token };
}

function paymentIntent(event: StripeEvent): string | null {
  const value = event.data?.object?.payment_intent;
  return typeof value === "string" && value ? value : null;
}

function refundMetadata(event: StripeEvent): { orderId: string; paymentIntentId: string } | null {
  const object = event.data?.object ?? {};
  const values = (object.metadata ?? {}) as Record<string, unknown>;
  const orderId = typeof values.order_id === "string" ? values.order_id : null;
  const paymentIntentId = paymentIntent(event);
  if (!orderId || !paymentIntentId) return null;
  return { orderId, paymentIntentId };
}

function stripeAmount(object: Record<string, unknown>, field: string): number | null {
  const value = object[field];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

async function claimLedger(event: StripeEvent): Promise<{ ledger: LedgerRow | null; duplicate: boolean }> {
  const { data, error } = await supabase.rpc("claim_stripe_webhook_event", {
    p_stripe_event_id: event.id,
    p_event_type: event.type,
    p_payload: event as unknown as Record<string, unknown>,
  });
  if (error) throw new Error(`ledger claim failed: ${error.message}`);
  if (!Array.isArray(data) || data.length !== 1) throw new Error("ledger claim returned an unexpected response");
  const row = data[0] as { ledger_id?: string; ledger_status?: string; claimed?: boolean };
  if (typeof row.ledger_id !== "string" || typeof row.ledger_status !== "string" || typeof row.claimed !== "boolean") {
    throw new Error("ledger claim returned an invalid row");
  }
  return {
    ledger: { id: row.ledger_id, status: row.ledger_status },
    duplicate: !row.claimed,
  };
}

async function markLedger(ledgerId: string, status: "processed" | "ignored" | "failed", errorMessage?: string): Promise<void> {
  const values: Record<string, unknown> = {
    status,
    last_error: errorMessage ?? null,
    processed_at: status === "failed" ? null : new Date().toISOString(),
  };
  const { error } = await supabase.from("stripe_webhook_events").update(values).eq("id", ledgerId);
  if (error) console.error("Unable to update Stripe webhook ledger", error.message);
}

async function provisionTableAccess(orderId: string): Promise<void> {
  const { data: table, error: tableError } = await supabase
    .from("event_tables")
    .select("id,lead_attendee_id")
    .eq("order_id", orderId)
    .maybeSingle();
  if (tableError) throw new Error(`table access lookup failed: ${tableError.message}`);
  if (!table) return;
  if (typeof table.id !== "string" || typeof table.lead_attendee_id !== "string") {
    throw new Error("paid table has no valid lead attendee");
  }

  const response = await fetch(`${SUPABASE_URL}/functions/v1/provision-table-access`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ table_id: table.id, lead_attendee_id: table.lead_attendee_id }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`table access provisioning failed (${response.status}): ${body.slice(0, 300)}`);
  }
}

async function finalize(event: StripeEvent, info: { orderId: string; holdToken: string }): Promise<string> {
  const holdHash = await sha256Hex(info.holdToken);
  const object = event.data?.object ?? {};
  const paidAt = typeof object.created === "number"
    ? new Date(object.created * 1000).toISOString()
    : new Date().toISOString();
  const { data, error } = await supabase.rpc("finalize_paid_order", {
    p_order_id: info.orderId,
    p_hold_token_hash: holdHash,
    p_stripe_checkout_session_id: typeof object.id === "string" ? object.id : event.id,
    p_stripe_payment_intent_id: paymentIntent(event),
    p_paid_at: paidAt,
    p_stripe_amount_subtotal: stripeAmount(object, "amount_subtotal"),
    p_stripe_amount_total: stripeAmount(object, "amount_total"),
    p_stripe_customer_id: typeof object.customer === "string" && object.customer ? object.customer : null,
  });
  if (error) throw new Error(`paid finalization failed: ${error.message}`);
  await provisionTableAccess(info.orderId);
  return String(data);
}

async function release(event: StripeEvent, info: { orderId: string; holdToken: string }, status: "expired" | "failed"): Promise<string> {
  // The raw token is intentionally not sent to the database. It is retained
  // only in Stripe metadata and hashed again for any future token checks.
  void info.holdToken;
  const { data, error } = await supabase.rpc("release_ssuite_order", {
    p_order_id: info.orderId,
    p_terminal_status: status,
    p_reason: `stripe_${event.type}`,
  });
  if (error) throw new Error(`order release failed: ${error.message}`);
  return String(data);
}

async function reconcileRefund(event: StripeEvent): Promise<string> {
  const info = refundMetadata(event);
  if (!info) throw new Error("Stripe refund has no order_id/payment_intent metadata");
  const object = event.data?.object ?? {};
  const chargeAmount = stripeAmount(object, "amount");
  const amountRefunded = stripeAmount(object, "amount_refunded");
  if (chargeAmount === null || amountRefunded === null) throw new Error("Stripe refund has invalid amounts");
  const refundedAt = typeof event.created === "number"
    ? new Date(event.created * 1000).toISOString()
    : new Date().toISOString();
  const { data, error } = await supabase.rpc("reconcile_ssuite_order_refund", {
    p_order_id: info.orderId,
    p_stripe_payment_intent_id: info.paymentIntentId,
    p_charge_amount: chargeAmount,
    p_amount_refunded: amountRefunded,
    p_refunded_at: refundedAt,
    p_stripe_event_id: event.id,
  });
  if (error) throw new Error(`refund reconciliation failed: ${error.message}`);
  return String(data);
}

async function handleEvent(event: StripeEvent): Promise<"processed" | "ignored"> {
  const supported = new Set([
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "checkout.session.expired",
    "charge.refunded",
  ]);
  if (!supported.has(event.type)) return "ignored";

  if (event.type === "charge.refunded") {
    const result = await reconcileRefund(event);
    console.log("Stripe refund reconciliation result", event.id, result);
    return "processed";
  }

  const info = metadata(event);
  if (!info) throw new Error("Supported Checkout event has no order_id/hold_token metadata");
  const object = event.data?.object ?? {};

  if (event.type === "checkout.session.completed") {
    // Finalize paid or fully discounted Checkout Sessions. Stripe uses
    // no_payment_required for a 100%-discount Session, which is still a
    // completed order and intentionally has no PaymentIntent.
    if (object.payment_status !== "paid" && object.payment_status !== "no_payment_required") return "ignored";
    const result = await finalize(event, info);
    console.log("Stripe paid finalization result", event.id, result);
    return "processed";
  }
  if (event.type === "checkout.session.async_payment_succeeded") {
    const result = await finalize(event, info);
    console.log("Stripe async paid finalization result", event.id, result);
    return "processed";
  }
  if (event.type === "checkout.session.async_payment_failed") {
    const result = await release(event, info, "failed");
    console.log("Stripe async failed release result", event.id, result);
    return "processed";
  }
  const result = await release(event, info, "expired");
  console.log("Stripe expired release result", event.id, result);
  return "processed";
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const rawBody = await request.text();
  if (!(await verifyStripeSignature(rawBody, request.headers.get("stripe-signature")))) {
    return jsonResponse({ error: "Invalid signature" }, 400);
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
    if (!event.id || !event.type || !event.data?.object) throw new Error("Malformed Stripe event");
  } catch {
    return jsonResponse({ error: "Invalid event" }, 400);
  }

  try {
    const claim = await claimLedger(event);
    if (!claim.ledger) return jsonResponse({ received: true }, 200);
    if (claim.duplicate && ["processed", "ignored", "processing"].includes(claim.ledger.status)) {
      return jsonResponse({ received: true, duplicate: true }, 200);
    }

    const result = await handleEvent(event);
    await markLedger(claim.ledger.id, result);
    // payment_review is an intentional durable outcome from the SQL RPC, not a
    // webhook failure. Returning 200 prevents Stripe from creating noise while
    // staff reconcile the payment in the database.
    return jsonResponse({ received: true }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook processing failed";
    console.error("Stripe webhook processing failed", message);
    try {
      const { data } = await supabase.from("stripe_webhook_events").select("id").eq("stripe_event_id", event.id).maybeSingle();
      if (data?.id) await markLedger(data.id, "failed", message);
    } catch (ledgerError) {
      console.error("Unable to persist webhook failure", ledgerError);
    }
    return jsonResponse({ error: "Webhook processing failed" }, 500);
  }
});
