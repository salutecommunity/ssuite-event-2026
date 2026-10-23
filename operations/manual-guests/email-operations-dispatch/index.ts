// Internal S.Suite email-outbox worker. Do not deploy with --no-verify-jwt.
// It implements a relay contract; it is not a Klaviyo API client and never guesses
// provider endpoints or payloads. The relay must accept idempotency_key and return
// exactly {accepted:true,provider_message_id:"..."} only after provider acceptance.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { appendFragment, APPROVED_SENDER, json, requiredHttpsUrl, templateMap, type JsonObject } from "../email-operations/_shared.ts";

// Named PROJECT_URL, never URL: a module constant called URL shadows the global URL
// constructor, which silently broke completionPageUrl() with "URL is not a constructor".
const PROJECT_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RELAY_URL = requiredHttpsUrl(Deno.env.get("SSUITE_EMAIL_RELAY_URL") ?? "");
const RELAY_API_KEY = (Deno.env.get("SSUITE_EMAIL_RELAY_API_KEY") ?? "").trim();
const TEMPLATE_IDS = templateMap(Deno.env.get("SSUITE_EMAIL_TEMPLATE_IDS_JSON") ?? "");
const DERIVATION_SECRET = Deno.env.get("SSUITE_TOKEN_DERIVATION_SECRET_V1") ?? "";
const TABLE_PORTAL_URL = requiredHttpsUrl(Deno.env.get("SSUITE_TABLE_PORTAL_URL") ?? "");
const GUEST_REGISTRATION_URL = requiredHttpsUrl(Deno.env.get("SSUITE_GUEST_REGISTRATION_URL") ?? "");
const db = createClient(PROJECT_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

type Claimed = { outbox_id: string; message_type: string; template_key: string; template_version: number; recipient: string; payload: JsonObject; attempt_count: number };

function same(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false; let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function tableToken(tokenId: string): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(tokenId) || !DERIVATION_SECRET) throw new Error("table access material is unavailable");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(DERIVATION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`SSUITE/TABLE-MANAGEMENT/V1:${tokenId}`)));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** Routing approved in source rather than configuration, for message types added after the
 *  deployed env map was written. The relay reads this value as the Klaviyo metric name. */
const SOURCE_TEMPLATE_KEYS: Record<string, string> = {
  "finish-registration": "S.Suite Finish Registration",
  "admin-order-notice": "S.Suite Admin Order Notice",
  "admin-request-notice": "S.Suite Admin Request Notice",
  "host-guest-registered": "S.Suite Guest Registered Host Notice",
  "host-guest-declined": "S.Suite Guest Declined Host Notice",
  "invitation-approved": "S.Suite Invitation Approved",
};

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The portal recognises a link by the stored hash of its raw token. Tables created by
 *  the existing-paid-payment import are given a credential generated in the database,
 *  so the link this worker derives from the token id would not match and the lead would
 *  receive a private link that opens nothing. The staff reveal path already repairs that
 *  by rewriting the hash of an unused credential; this worker now does the same, and
 *  refuses to send at all when the stored credential has already been used — a link a
 *  lead is relying on is never silently replaced.
 *
 *  Every send therefore proves the emailed link matches the stored credential before the
 *  message leaves. */
async function secureTablePortalUrl(payload: JsonObject): Promise<string> {
  if (!TABLE_PORTAL_URL) throw new Error("table portal URL is unavailable");
  const tokenId = typeof payload.table_management_token_id === "string" ? payload.table_management_token_id : "";
  const query = db.from("table_management_tokens").select("id,token_hash,last_used_at").eq("status", "active").gt("expires_at", new Date().toISOString());
  const { data, error } = tokenId
    ? await query.eq("id", tokenId).limit(1)
    : typeof payload.table_id === "string"
      ? await query.eq("table_id", payload.table_id).order("created_at", { ascending: false }).limit(1)
      : { data: null, error: new Error("no table reference") };
  if (error || !Array.isArray(data) || data.length !== 1 || typeof data[0]?.id !== "string") throw new Error("active table access is unavailable");

  const row = data[0] as { id: string; token_hash: unknown; last_used_at: unknown };
  const raw = await tableToken(row.id);
  const derived = await digest(raw);
  if (String(row.token_hash) !== derived) {
    if (row.last_used_at) throw new Error("the stored table access credential is already in use and cannot be replaced by this send");
    const repaired = await db.from("table_management_tokens").update({ token_hash: derived, updated_at: new Date().toISOString() }).eq("id", row.id).eq("status", "active").is("last_used_at", null).select("id").maybeSingle();
    if (repaired.error || !repaired.data) throw new Error("table access could not be prepared for this send");
  }
  return appendFragment(TABLE_PORTAL_URL, raw);
}

type RecipientName = { first_name?: string; last_name?: string };
type RelayPayload = { data: JsonObject; name: RecipientName };

/** Display values only. Each has a truthful generic default in the template, so a
 *  lookup failure degrades the wording rather than blocking a delivery. Secure
 *  links are never sourced here. */
async function tableContext(tableId: string): Promise<RelayPayload> {
  try {
    const { data, error } = await db.rpc("ssuite_table_email_context", { p_table_id: tableId });
    if (error || !Array.isArray(data) || !data.length) return { data: {}, name: {} };
    const row = data[0] as Record<string, unknown>;
    const context: JsonObject = {};
    const name: RecipientName = {};
    if (typeof row.table_name === "string" && row.table_name) context.table_name = row.table_name;
    if (typeof row.table_progress === "string" && row.table_progress) context.table_progress = row.table_progress;
    if (typeof row.lead_first_name === "string" && row.lead_first_name) name.first_name = row.lead_first_name;
    if (typeof row.lead_last_name === "string" && row.lead_last_name) name.last_name = row.lead_last_name;
    return { data: context, name };
  } catch {
    return { data: {}, name: {} };
  }
}

/** The completion page sits beside the table portal on the same private surface. */
function completionPageUrl(): string {
  if (!TABLE_PORTAL_URL) throw new Error("the completion page address is unavailable");
  const url = new URL(TABLE_PORTAL_URL);
  url.hash = "";
  url.pathname = url.pathname.replace(/[^/]*$/, "complete-registration.html");
  return url.toString();
}

/** Same derivation the staff dashboard uses when it reveals the link, so the emailed link and
 *  the copied link are the same link. The raw credential is never stored in the outbox row. */
async function completionToken(invitationId: string): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(invitationId) || !DERIVATION_SECRET) throw new Error("completion link material is unavailable");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(DERIVATION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`SSUITE/REGISTRATION-COMPLETION/V1:${invitationId}`)));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** Proves, before the message leaves, that the link inside it opens the record it claims to and
 *  that the person still needs it. A revoked or expired link, a credential that no longer matches
 *  the stored hash, or a registration already finished all stop the send rather than mail someone
 *  a button that goes nowhere or asks them to do something they have already done. */
async function completionPayload(payload: JsonObject): Promise<RelayPayload> {
  const invitationId = typeof payload.invitation_id === "string" ? payload.invitation_id : "";
  const attendeeId = typeof payload.attendee_id === "string" ? payload.attendee_id : "";

  const invitation = await db.from("invitations").select("id,token_hash,status,expires_at,revoked_at,token_kind,attendee_id").eq("id", invitationId).maybeSingle();
  if (invitation.error || !invitation.data) throw new Error("that completion link no longer exists");
  const link = invitation.data as Record<string, unknown>;
  if (link.token_kind !== "registration_completion") throw new Error("that link is not a completion link");
  if (link.attendee_id !== attendeeId) throw new Error("that completion link belongs to someone else");
  if (link.revoked_at || link.status === "revoked") throw new Error("that completion link has been revoked");
  if (typeof link.expires_at === "string" && Date.parse(link.expires_at) <= Date.now()) throw new Error("that completion link has expired");

  const raw = await completionToken(invitationId);
  if (String(link.token_hash) !== (await digest(raw))) throw new Error("that completion link cannot be reconstructed and must be reissued");

  const found = await db.from("attendees").select("first_name,last_name,registration_status,is_table_lead").eq("id", attendeeId).maybeSingle();
  if (found.error || !found.data) throw new Error("that person is not on the guest list");
  const person = found.data as Record<string, unknown>;
  if (person.registration_status === "complete") throw new Error("that person has already completed their registration");

  const data: JsonObject = { completion_url: appendFragment(completionPageUrl(), raw), is_table_host: person.is_table_lead === true };
  const name: RecipientName = {};
  if (typeof person.first_name === "string" && person.first_name.trim()) name.first_name = person.first_name.trim();
  if (typeof person.last_name === "string" && person.last_name.trim()) name.last_name = person.last_name.trim();

  if (person.is_table_lead === true) {
    const table = await db.from("event_tables").select("name").eq("lead_attendee_id", attendeeId).limit(1);
    const tableName = Array.isArray(table.data) && table.data.length === 1 ? (table.data[0] as Record<string, unknown>).name : null;
    if (typeof tableName === "string" && tableName.trim()) data.table_name = tableName.trim();
  }
  return { data, name };
}

/** Same derivation `mail-dispatch` uses for the invitation link, so the link in the
 *  confirmation is the same link the guest already used — one address for their record
 *  rather than a second credential to keep track of. */
async function invitationToken(invitationId: string): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(invitationId) || !DERIVATION_SECRET) throw new Error("registration link material is unavailable");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(DERIVATION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`SSUITE/INVITATION/V1:${invitationId}`)));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** The guest registration page sits beside the table portal on the same private surface. */
function guestRegistrationPageUrl(): string {
  if (GUEST_REGISTRATION_URL) return GUEST_REGISTRATION_URL;
  if (!TABLE_PORTAL_URL) throw new Error("the registration page address is unavailable");
  const url = new URL(TABLE_PORTAL_URL);
  url.hash = "";
  url.pathname = url.pathname.replace(/[^/]*$/, "guest-registration.html");
  return url.toString();
}

/** The confirmation's whole job is to be the guest's record: the one message they can reopen
 *  in a new session to see and change their details. The queued row deliberately carries no
 *  link — raw credentials are not stored — so the link is rebuilt here and proved against the
 *  stored hash before the message leaves. Without this the relay correctly refused the send,
 *  which is why a completed guest registration produced no confirmation at all. */
async function guestConfirmationPayload(payload: JsonObject, recipient: string): Promise<RelayPayload> {
  const attendeeId = typeof payload.attendee_id === "string" ? payload.attendee_id : "";
  const found = await db.from("attendees").select("id,email,first_name,last_name,registration_status,table_id").eq("id", attendeeId).maybeSingle();
  if (found.error || !found.data) throw new Error("that person is not on the guest list");
  const person = found.data as Record<string, unknown>;
  if (person.registration_status !== "complete") throw new Error("that registration is not complete, so there is nothing to confirm");
  if (String(person.email).trim().toLowerCase() !== recipient.trim().toLowerCase()) throw new Error("confirmation recipient no longer matches the guest");

  const invitations = await db.from("invitations").select("id,token_hash,status,revoked_at,expires_at,token_kind").eq("attendee_id", attendeeId).in("token_kind", ["guest_completion", "registration_completion"]).order("created_at", { ascending: false }).limit(1);
  if (invitations.error || !Array.isArray(invitations.data) || invitations.data.length !== 1) throw new Error("that guest has no invitation link to return them to their record");
  const link = invitations.data[0] as Record<string, unknown>;
  if (link.revoked_at) throw new Error("that invitation link has been revoked");
  if (typeof link.expires_at === "string" && Date.parse(link.expires_at) <= Date.now()) throw new Error("that invitation link has expired");

  if (link.status !== "completed") throw new Error("the personal registration link is not completed");
  const manual = link.token_kind === "registration_completion";
  const raw = manual ? await completionToken(String(link.id)) : await invitationToken(String(link.id));
  if (String(link.token_hash) !== (await digest(raw))) throw new Error("that registration link cannot be reconstructed and must be reissued");

  const data: JsonObject = {
    secure_registration_url: appendFragment(manual ? completionPageUrl() : guestRegistrationPageUrl(), raw),
    // Derived from the record's own identifier, so a guest quoting it and staff searching
    // for it are looking at the same registration.
    registration_id: `SS-${String(person.id).slice(0, 8).toUpperCase()}`,
  };

  // Display only. A missing seat, table or host degrades to the template's own generic
  // wording rather than blocking a confirmation the guest is owed.
  if (typeof person.table_id === "string") {
    const seat = await db.from("table_seats").select("seat_number").eq("attendee_id", attendeeId).limit(1);
    const table = await db.from("event_tables").select("name,lead_attendee_id").eq("id", person.table_id).maybeSingle();
    const tableRow = (table.data as Record<string, unknown> | null) ?? {};
    const tableName = typeof tableRow.name === "string" ? String(tableRow.name).trim() : "";
    const seatNumber = Array.isArray(seat.data) && seat.data.length === 1 ? (seat.data[0] as Record<string, unknown>).seat_number : null;
    const parts = [tableName, Number.isFinite(Number(seatNumber)) && seatNumber !== null ? `Seat ${Number(seatNumber)}` : ""].filter(Boolean);
    if (parts.length) data.seat_label = parts.join(" — ");
    if (tableName) data.table_name = tableName;

    // A guest reads their seat as a person, not a table row: name the host who invited
    // them. Guests never see the host's contact details — the name alone is the context.
    if (typeof tableRow.lead_attendee_id === "string" && tableRow.lead_attendee_id !== attendeeId) {
      const host = await db.from("attendees").select("first_name,last_name").eq("id", tableRow.lead_attendee_id).maybeSingle();
      const hostRow = (host.data as Record<string, unknown> | null) ?? {};
      const hostName = [hostRow.first_name, hostRow.last_name].map((part) => (typeof part === "string" ? part.trim() : "")).filter(Boolean).join(" ");
      if (hostName) data.table_host_name = hostName;
    }
  }

  if (typeof data.table_host_name === "string") data.invited_by_name = data.table_host_name;
  try { Object.assign(data, await detailsFor(attendeeId)); } catch { /* display only */ }
  const name: RecipientName = {};
  if (typeof person.first_name === "string" && person.first_name.trim()) name.first_name = person.first_name.trim();
  if (typeof person.last_name === "string" && person.last_name.trim()) name.last_name = person.last_name.trim();
  return { data, name };
}

async function purchaserName(orderId: string): Promise<RecipientName> {
  try {
    const { data, error } = await db.from("orders").select("purchaser_first_name, purchaser_last_name").eq("id", orderId).limit(1);
    if (error || !Array.isArray(data) || data.length !== 1) return {};
    const row = data[0] as Record<string, unknown>;
    const name: RecipientName = {};
    if (typeof row.purchaser_first_name === "string" && row.purchaser_first_name.trim()) name.first_name = row.purchaser_first_name.trim();
    if (typeof row.purchaser_last_name === "string" && row.purchaser_last_name.trim()) name.last_name = row.purchaser_last_name.trim();
    return name;
  } catch {
    return {};
  }
}


// ---- Restored 2026-10-19: send-time bodies for details, host notices and staff notices. ----
const ADMIN_URL = "https://event.ssuite.org/admin/";
const ET = "America/New_York";
function money(cents: unknown): string {
  const n = Number(cents); if (!Number.isFinite(n)) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n / 100);
}
function etDate(value: unknown, withTime = false): string {
  if (typeof value !== "string" || !value) return "";
  const d = new Date(value); if (Number.isNaN(d.valueOf())) return "";
  const opts: Intl.DateTimeFormatOptions = withTime
    ? { timeZone: ET, month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }
    : { timeZone: ET, month: "long", day: "numeric", year: "numeric" };
  return new Intl.DateTimeFormat("en-US", opts).format(d) + (withTime ? " ET" : "");
}
function str(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }
function fullName(a: Record<string, unknown> | null | undefined): string { return a ? [str(a.first_name), str(a.last_name)].filter(Boolean).join(" ") : ""; }
function roleLine(a: Record<string, unknown>): string { return [str(a.job_title), str(a.company)].filter(Boolean).join(", "); }
const MEALS: Record<string, string> = {};
function mealLabel(v: unknown): string { const s = str(v); if (!s) return ""; return MEALS[s] ?? s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()); }

async function needsFor(attendeeId: string): Promise<Record<string, unknown>> {
  const r = await db.from("attendee_needs").select("*").eq("attendee_id", attendeeId).maybeSingle();
  return (r.data as Record<string, unknown> | null) ?? {};
}

/** "What you told us" block. Display only; missing values are simply omitted. */
async function detailsFor(attendeeId: string): Promise<JsonObject> {
  const a = await db.from("attendees").select("first_name,last_name,job_title,company").eq("id", attendeeId).maybeSingle();
  const person = (a.data as Record<string, unknown> | null);
  if (!person) return {};
  const n = await needsFor(attendeeId);
  const out: JsonObject = {};
  const name = fullName(person); if (name) out.detail_name = name;
  if (str(person.job_title)) out.detail_title = str(person.job_title);
  if (str(person.company)) out.detail_company = str(person.company);
  const meal = mealLabel(n.meal_preference); if (meal) out.detail_meal = meal;
  if (n.has_dietary_or_allergy_needs === true && str(n.dietary_or_allergy_details)) out.detail_dietary = str(n.dietary_or_allergy_details);
  if (n.has_accessibility_needs === true && str(n.accessibility_details)) out.detail_accessibility = str(n.accessibility_details);
  if (Object.keys(out).length) out.has_details = true;
  return out;
}

async function seatLabelFor(attendeeId: string, tableId: string | null, seatNumber?: unknown): Promise<string> {
  let num: unknown = seatNumber;
  if (num === undefined || num === null) {
    const s = await db.from("table_seats").select("seat_number").eq("attendee_id", attendeeId).limit(1);
    num = Array.isArray(s.data) && s.data.length ? (s.data[0] as Record<string, unknown>).seat_number : null;
  }
  let tableName = "";
  if (tableId) { const t = await db.from("event_tables").select("name").eq("id", tableId).maybeSingle(); tableName = str((t.data as Record<string, unknown> | null)?.name); }
  return [tableName, num !== null && num !== undefined && Number.isFinite(Number(num)) ? `Seat ${Number(num)}` : ""].filter(Boolean).join(" — ");
}

/** Host notices (guest registered / guest can no longer attend). Greets the host; names the guest.
 *  The private table link is deliberately not included: the template's fallback sends the host
 *  to their original table host email, which is true, and no credential is touched by a notice. */
async function hostNoticePayload(payload: JsonObject, declined: boolean): Promise<RelayPayload> {
  const data: JsonObject = { ...payload };
  const attendeeId = str(payload.attendee_id);
  const tableId = str(payload.table_id) || null;
  const g = await db.from("attendees").select("first_name,last_name,job_title,company").eq("id", attendeeId).maybeSingle();
  const guest = (g.data as Record<string, unknown> | null) ?? {};
  const guestName = str(payload.guest_name) || fullName(guest);
  if (guestName) data.guest_name = guestName;
  const role = roleLine(guest); if (role) data.guest_role = role;
  const seat = await seatLabelFor(attendeeId, tableId, declined ? payload.seat_number : undefined);
  if (seat) data.seat_label = seat;
  const name: RecipientName = {};
  if (tableId) {
    const ctx = await tableContext(tableId);
    if (typeof ctx.data.table_progress === "string") data.table_progress = ctx.data.table_progress;
    if (!payload.staff_copy_for) Object.assign(name, ctx.name);
  }
  delete data.table_management_url;
  return { data, name };
}

async function accessRoute(orderId: string, order: Record<string, unknown>): Promise<string> {
  const r = await db.rpc("ssuite_order_access_code_facts", { p_order_id: orderId });
  if (r.error) return "Not recorded — check the admin dashboard";
  const code = (r.data as Record<string, unknown> | null) ?? null;
  if (code && str(code.code)) {
    const k = str(code.code);
    const circles: Record<string, string> = { "SSUITE-FOUNDERS-2026": "Founders circle", "SSUITE-BOARD-2026": "SALUTE Board circle", "SSUITE-SLC-2026": "Strategic Leadership Council circle" };
    if (circles[k.toUpperCase()]) return `${circles[k.toUpperCase()]} (${k})`;
    if (code.purpose === "partner_organization") return `Nonprofit partner — ${str(code.organization) || "partner organization"} (${k})`;
    if (code.purpose === "salute_member") return `SALUTE member rate (${k})`;
    if (str(code.issued_to_name)) return `Invitation from ${str(code.issued_to_name)} (${k})`;
    if (str(code.organization)) return `${str(code.organization)} (${k})`;
    return k ? `Access code ${k}` : "Access code";
  }
  const md = (order.metadata as Record<string, unknown> | null) ?? {};
  const ms = str(md.membership_status) || str(order.member_verification_status);
  if (/member/.test(ms) && /verified|match|email/.test(ms)) return "SALUTE member rate — recognized by email";
  if (str(md.invitation_code)) return `Invitation code ${str(md.invitation_code)}`;
  return "Open purchase";
}

async function adminOrderNoticePayload(payload: JsonObject): Promise<RelayPayload> {
  const orderId = str(payload.order_id);
  const o = await db.from("orders").select("*").eq("id", orderId).maybeSingle();
  const order = o.data as Record<string, unknown> | null;
  if (o.error || !order) throw new Error("that order could not be found");
  const items = await db.from("order_items").select("description,quantity,unit_amount_cents,seats_reserved").eq("order_id", orderId).order("created_at");
  const rows = (Array.isArray(items.data) ? items.data : []) as Record<string, unknown>[];
  const seats = rows.reduce((s, r) => s + (Number(r.seats_reserved) || 0), 0);
  const purchase_lines = rows.map((r) => `${str(r.description) || "Item"} × ${Number(r.quantity) || 1} — ${money(r.unit_amount_cents)} each`);
  const buyer = [str(order.purchaser_first_name), str(order.purchaser_last_name)].filter(Boolean).join(" ") || str(order.purchaser_email);
  const att = await db.from("attendees").select("id,first_name,last_name,email,job_title,company,registration_status,is_purchaser,table_id").eq("order_id", orderId).order("created_at");
  const people = (Array.isArray(att.data) ? att.data : []) as Record<string, unknown>[];
  const attendee_lines: string[] = [];
  let pending = 0;
  for (const p of people.slice(0, 40)) {
    const n = await needsFor(String(p.id));
    const bits = [fullName(p) || "Guest not yet named", roleLine(p), str(p.email)].filter(Boolean);
    const needs = [mealLabel(n.meal_preference) && `Meal: ${mealLabel(n.meal_preference)}`,
      n.has_dietary_or_allergy_needs === true && str(n.dietary_or_allergy_details) && `Dietary: ${str(n.dietary_or_allergy_details)}`,
      n.has_accessibility_needs === true && str(n.accessibility_details) && `Accessibility: ${str(n.accessibility_details)}`].filter(Boolean);
    if (p.registration_status !== "complete") { pending++; needs.push("Registration not yet complete"); }
    attendee_lines.push([bits.join(" · "), needs.join(" · ")].filter(Boolean).join(" — "));
  }
  const tables = await db.from("event_tables").select("name,seat_count").eq("order_id", orderId);
  const tRows = (Array.isArray(tables.data) ? tables.data : []) as Record<string, unknown>[];
  const data: JsonObject = {
    notice_kind: tRows.length ? "New table order" : "New order",
    order_number: str(payload.order_number) || `SS-${orderId.slice(0, 8).toUpperCase()}`,
    buyer_name: buyer || "A buyer",
    headline: tRows.length ? `${tRows.map((t) => `${Number(t.seat_count) || seats}-seat table`).join(", ")}` : `${seats || people.length || 1} ${seats === 1 ? "seat" : "seats"}`,
    order_total: money(order.total_cents),
    paid_on: etDate(order.paid_at, true),
    purchase_lines,
    offering_name: purchase_lines[0] ?? "",
    access_route: await accessRoute(orderId, order),
    buyer_contact: [str(order.purchaser_email), str(order.purchaser_phone)].filter(Boolean).join(" · "),
    how_heard: str(order.how_heard),
    people_heading: "Who is coming",
    attendee_lines,
    admin_url: ADMIN_URL,
  };
  if (tRows.length) data.seating_note = `Table: ${tRows.map((t) => str(t.name) || "unnamed").join(", ")}. The table host names guests from their private table page.`;
  if (pending) data.needs_note = `${pending} of ${people.length} ${people.length === 1 ? "registration is" : "registrations are"} not yet complete.`;
  return { data, name: {} };
}

async function adminRequestNoticePayload(payload: JsonObject): Promise<RelayPayload> {
  const kind = str(payload.request_kind);
  const { data: f, error } = await db.rpc("ssuite_request_notice_facts", { p_kind: kind, p_request_id: str(payload.request_id) });
  const r = (f as Record<string, unknown> | null);
  if (error || !r || !r.id) throw new Error("that request could not be found");
  const name = fullName(r) || str(r.email) || "Someone";
  const data: JsonObject = { requester_name: name, requester_email: str(r.email), requested_on: etDate(r.created_at, true), admin_url: ADMIN_URL };
  if (kind === "member_code") {
    data.notice_kind = "Member code request"; data.headline = "asked for a SALUTE member code"; data.request_subject = "SALUTE member access code";
    data.reference = `MCR-${String(r.id).slice(0, 8).toUpperCase()}`;
    if (r.status === "sent" || r.code_sent_at) { data.status_line = r.auto_matched ? "Code already emailed — matched automatically against the member list." : "Code already emailed."; data.action_note = "Nothing is waiting on you."; }
    else { data.status_line = "Waiting for your review — no automatic match against the member list."; data.action_note = "Nothing has been sent to this person yet."; }
  } else {
    data.notice_kind = "Invitation request"; data.headline = "asked for an invitation"; data.request_subject = "Invitation to S.SUITE";
    data.reference = `INV-${String(r.id).slice(0, 8).toUpperCase()}`;
    const role = roleLine(r); if (role) data.role_line = role;
    if (r.seats_requested) data.seats_line = String(r.seats_requested);
    if (str(r.referral_source)) data.heard_via = str(r.referral_source);
    if (str(r.note)) data.requester_note = str(r.note);
    data.status_line = r.invitation_sent_at ? "Invitation already sent." : "Waiting for your review.";
    if (r.security_check === "unverified" || r.status === "unverified") data.status_line = "Waiting for your review — security check did not complete (unverified).";
    data.action_note = r.invitation_sent_at ? "Nothing is waiting on you." : "Nothing has been sent to this person yet.";
  }
  return { data, name: {} };
}

async function relayPayload(delivery: Claimed): Promise<RelayPayload> {
  // Copy rather than mutate the row payload; raw HMAC tokens are never stored in it.
  const data: JsonObject = { ...delivery.payload };
  const name: RecipientName = {};

  if (delivery.message_type === "ssuite_table_lead_access" || delivery.message_type === "ssuite_incomplete_table_reminder") {
    // The approved templates read {{ event.extra.table_management_url }}. This worker
    // supplied the link as `table_portal_url`, which no template reads, so the secure
    // link was discarded and the button fell back to the literal "#DRAFT_SECURE_URL"
    // anchor. Publish the key the templates actually read; the former key is retained
    // so nothing that already depends on it changes behaviour.
    const secureUrl = await secureTablePortalUrl(data);
    data.table_management_url = secureUrl;
    data.table_portal_url = secureUrl;
    if (typeof data.table_id === "string") {
      const context = await tableContext(data.table_id);
      Object.assign(data, context.data);
      Object.assign(name, context.name);
    }
  }

  // Identifiers stay here: this message's only recipient-facing value is the link itself,
  // which is rebuilt from the database rather than carried in the queued row.
  if (delivery.message_type === "ssuite_finish_registration") return await completionPayload(data);

  if (delivery.message_type === "ssuite_guest_registration_confirmation") return await guestConfirmationPayload(data, delivery.recipient);

  if (delivery.message_type === "ssuite_paid_order_confirmation" && typeof data.order_id === "string") {
    Object.assign(name, await purchaserName(data.order_id));
    try {
      const buyer = await db.from("attendees").select("id").eq("order_id", data.order_id).eq("is_purchaser", true).limit(1);
      const id = Array.isArray(buyer.data) && buyer.data.length ? String((buyer.data[0] as Record<string, unknown>).id) : "";
      if (id) Object.assign(data, await detailsFor(id));
    } catch { /* details are display-only */ }
  }
  if (delivery.message_type === "ssuite_host_guest_registered") return await hostNoticePayload(data, false);
  if (delivery.message_type === "ssuite_host_guest_declined") return await hostNoticePayload(data, true);
  if (delivery.message_type === "ssuite_admin_order_notice") return await adminOrderNoticePayload(data);
  if (delivery.message_type === "ssuite_admin_request_notice") return await adminRequestNoticePayload(data);

  return { data, name };
}

function acceptedId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as JsonObject;
  return body.accepted === true && typeof body.provider_message_id === "string" && body.provider_message_id.trim() && body.provider_message_id.length <= 500
    ? body.provider_message_id.trim() : null;
}

/** RFC 2606 / RFC 6761 reserve these so they can never resolve. A message addressed to one
 *  cannot be delivered by anybody, so attempting it would only manufacture a bounce, a junk
 *  profile at the provider, and a "sent" record that is not true. Returns the reason to
 *  record, or null when the address is genuinely deliverable. */
function undeliverableByReservation(recipient: string): string | null {
  const at = String(recipient ?? "").trim().toLowerCase().lastIndexOf("@");
  if (at < 0) return "recipient is not an email address";
  const domain = String(recipient).trim().toLowerCase().slice(at + 1);
  if (!domain) return "recipient has no domain";
  const reservedTlds = ["invalid", "test", "example", "localhost"];
  const label = domain.split(".").pop() ?? "";
  if (reservedTlds.includes(label)) return `reserved non-deliverable domain (.${label})`;
  if (["example.com", "example.net", "example.org"].includes(domain)) return "reserved non-deliverable domain (example)";
  return null;
}

async function sendOne(delivery: Claimed): Promise<void> {
  const templateId = TEMPLATE_IDS?.[delivery.template_key] ?? SOURCE_TEMPLATE_KEYS[delivery.template_key];
  if (!RELAY_URL || !RELAY_API_KEY || !templateId) throw new Error("email relay configuration is incomplete");
  const payload = await relayPayload(delivery);
  const response = await fetch(RELAY_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${RELAY_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": delivery.outbox_id },
    // Contract intentionally has no provider-specific metadata fields and no raw links except
    // the recipient-rendered template data (a table link is a URL fragment).
    body: JSON.stringify({
      idempotency_key: delivery.outbox_id,
      template_id: templateId,
      template_version: delivery.template_version,
      from: { name: APPROVED_SENDER.name, email: APPROVED_SENDER.email },
      reply_to: APPROVED_SENDER.replyTo,
      // The recipient's own name personalises the greeting; templates otherwise
      // address a paying purchaser as "there".
      to: { email: delivery.recipient, ...payload.name },
      data: payload.data,
    }),
  });
  if (!response.ok) {
    // The status alone said only that something was wrong. The relay always states which
    // requirement failed, and a refusal nobody can read is a refusal nobody can fix — that
    // is what turned a missing link into a silent retry loop. Record the stated reason.
    let detail = "";
    try {
      const refusal: unknown = await response.json();
      if (refusal && typeof refusal === "object" && !Array.isArray(refusal)) {
        const body = refusal as JsonObject;
        const parts = [typeof body.error === "string" ? body.error : "", typeof body.field === "string" ? `field: ${body.field}` : ""].filter(Boolean);
        detail = parts.join(" — ");
      }
    } catch { /* a body that is not JSON adds nothing the status has not already said */ }
    throw new Error(`relay HTTP ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  }
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error("relay returned invalid JSON"); }
  const providerMessageId = acceptedId(body);
  if (!providerMessageId) throw new Error("relay did not prove provider acceptance");
  const { data, error } = await db.rpc("mark_ssuite_email_provider_accepted", { p_outbox_id: delivery.outbox_id, p_provider_message_id: providerMessageId });
  if (error || data !== "sent") throw new Error("outbox was no longer claimable after relay acceptance");
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!PROJECT_URL || !SERVICE_KEY || !same(request.headers.get("authorization") ?? "", `Bearer ${SERVICE_KEY}`)) return json(401, { error: "Unauthorized" });
  let max = 1;
  try {
    const body: unknown = await request.json().catch(() => ({}));
    // Preview only: build the body for an existing outbox row without claiming or sending it.
    if (body && typeof body === "object" && typeof (body as JsonObject).preview_outbox_id === "string") {
      const id = String((body as JsonObject).preview_outbox_id);
      const row = await db.from("ssuite_email_outbox").select("id,message_type,payload,recipient,attempt_count").eq("id", id).maybeSingle();
      if (!row.data) return json(404, { error: "no such row" });
      const r = row.data as Record<string, unknown>;
      try {
        const built = await relayPayload({ outbox_id: id, message_type: String(r.message_type), template_key: "", template_version: 1, recipient: String(r.recipient), payload: r.payload as JsonObject, attempt_count: Number(r.attempt_count) });
        const d = { ...built.data } as JsonObject;
        for (const k of ["table_management_url", "table_portal_url", "completion_url", "secure_registration_url"]) if (typeof d[k] === "string") d[k] = String(d[k]).replace(/#.*/, "#[private]");
        return json(200, { preview: true, data: d, name: built.name as JsonObject });
      } catch (error) { return json(200, { preview: true, error: error instanceof Error ? error.message : "failed" }); }
    }
    if (body && typeof body === "object" && !Array.isArray(body) && "max" in body) {
      max = Number((body as JsonObject).max);
      if (!Number.isInteger(max) || max < 1 || max > 20) throw new Error("max must be 1-20");
    }
  } catch (error) { return json(400, { error: error instanceof Error ? error.message : "Invalid request" }); }
  let sent = 0, failed = 0, suppressed = 0;
  for (let index = 0; index < max; index++) {
    const { data, error } = await db.rpc("claim_next_ssuite_email_delivery");
    if (error) return json(500, { error: "Unable to claim email", sent, failed, suppressed });
    if (!Array.isArray(data) || !data.length) break;
    const delivery = data[0] as Claimed;
    // Never attempt what cannot arrive. Suppressing is not a failure: the row records
    // that no delivery was possible, which is the honest outcome.
    const unreachable = undeliverableByReservation(delivery.recipient);
    if (unreachable) {
      await db.rpc("suppress_ssuite_email_delivery", { p_outbox_id: delivery.outbox_id, p_reason: unreachable });
      suppressed++;
      continue;
    }
    try { await sendOne(delivery); sent++; }
    catch (error) {
      failed++;
      // No token, recipient, payload, or provider response is logged. The database records a bounded generic error.
      await db.rpc("fail_ssuite_email_delivery", { p_outbox_id: delivery.outbox_id, p_error: (error instanceof Error ? error.message : "relay failure").slice(0, 1000) });
    }
  }
  return json(failed ? 502 : 200, { sent, failed, suppressed });
});
