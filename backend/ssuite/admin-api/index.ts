import { createClient, type User } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { appendFragment, requiredHttpsUrl } from "../email-operations/_shared.ts";

// This is a private read/export API. It intentionally contains no mail sender,
// Stripe action, sales-status mutation, or raw credential/token response.
const APPROVED_ADMIN_EMAIL = "ssuite@salute.community";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PAGE_SIZE = 100;
const MAX_EXPORT_ROWS = 5000;
const TABLE_PORTAL_URL = requiredHttpsUrl(Deno.env.get("SSUITE_TABLE_PORTAL_URL") ?? "");
const TABLE_TOKEN_SECRET = Deno.env.get("SSUITE_TOKEN_DERIVATION_SECRET_V1") ?? "";

type Json = Record<string, unknown>;
type ApiError = Error & { status?: number };

function fail(message: string, status = 400): never {
  const error = new Error(message) as ApiError;
  error.status = status;
  throw error;
}

function parseAllowedOrigins(raw: string): string[] {
  if (!raw.trim()) return [];
  const items = raw.split(",").map((item) => item.trim());
  if (items.some((item) => !item)) return [];
  const origins: string[] = [];
  for (const item of items) {
    let parsed: URL;
    try { parsed = new URL(item); } catch { return []; }
    if (parsed.protocol !== "https:" || parsed.origin !== item || parsed.username || parsed.password || origins.includes(parsed.origin)) return [];
    origins.push(parsed.origin);
  }
  return origins;
}

const ALLOWED_ORIGINS = parseAllowedOrigins(Deno.env.get("SSUITE_ADMIN_ALLOWED_ORIGINS") ?? "https://event.ssuite.org");

function cors(origin: string | null): HeadersInit {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store, private",
    "Pragma": "no-cache",
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(body: Json, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json; charset=utf-8" } });
}

function client() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) fail("Service is unavailable", 503);
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function requestOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) fail("Origin is not authorized", 403);
  return origin;
}

function bearerToken(request: Request): string {
  const match = /^Bearer\s+([A-Za-z0-9._~-]{20,8192})$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) fail("Authentication is required", 401);
  return match[1];
}

async function requireApprovedAdmin(request: Request): Promise<User> {
  // auth.getUser validates the bearer JWT against Supabase Auth; decode-only
  // inspection is never used for authorization.
  const token = bearerToken(request);
  const db = client();
  const { data: authData, error: authError } = await db.auth.getUser(token);
  const user = authData.user;
  if (authError || !user || user.email?.trim().toLowerCase() !== APPROVED_ADMIN_EMAIL) {
    fail("Administrator authorization is required", 403);
  }

  const existing = await db.from("staff_members")
    .select("user_id, role, active")
    .eq("user_id", user.id)
    .maybeSingle();
  if (existing.error) fail("Authorization lookup failed", 503);

  if (!(existing.data?.active && existing.data.role === "admin")) {
    // The RPC repeats the exact auth.users email check and takes an advisory
    // lock, so it can only bootstrap this one approved identity and never
    // races with a second active administrator.
    const bootstrap = await db.rpc("bootstrap_ssuite_sole_admin", { p_user_id: user.id });
    if (bootstrap.error) fail("Administrator authorization is required", 403);
  }

  const verified = await db.from("staff_members")
    .select("user_id, role, active")
    .eq("user_id", user.id).eq("role", "admin").eq("active", true).maybeSingle();
  if (verified.error || !verified.data) fail("Administrator authorization is required", 403);
  return user;
}

async function readJson(request: Request): Promise<Json> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) fail("Request is too large", 413);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) fail("Request is too large", 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { fail("Invalid request"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("Invalid request");
  return body as Json;
}

function text(value: unknown, max = 120): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max).replace(/[^a-zA-Z0-9 .@-]/g, "");
}

function page(body: Json): { page: number; limit: number; from: number; to: number } {
  const number = typeof body.page === "number" && Number.isInteger(body.page) ? body.page : 1;
  const limit = typeof body.limit === "number" && Number.isInteger(body.limit) ? body.limit : 50;
  const safePage = Math.max(1, Math.min(number, 10000));
  const safeLimit = Math.max(1, Math.min(limit, MAX_PAGE_SIZE));
  return { page: safePage, limit: safeLimit, from: (safePage - 1) * safeLimit, to: safePage * safeLimit - 1 };
}

async function eventId(): Promise<string> {
  const result = await client().from("events").select("id").eq("name", "SSuite").order("created_at", { ascending: true }).limit(2);
  const events = result.data ?? [];
  if (result.error || events.length !== 1) fail("The S.Suite event is unavailable", 503);
  return events[0].id;
}

function paged(data: unknown, count: number | null, pagination: ReturnType<typeof page>): Json {
  return { data: data as unknown[], page: pagination.page, limit: pagination.limit, total: count ?? 0, has_more: pagination.to + 1 < (count ?? 0) };
}

async function testOrderIds(id: string): Promise<string[]> {
  const result = await client().from("orders").select("id").eq("event_id", id)
    .or("stripe_checkout_session_id.like.cs_test_*,purchaser_email.ilike.*staging*");
  if (result.error) fail("Record classification is unavailable", 503);
  return (result.data ?? []).map((row) => String(row.id));
}

function excludeIds<T>(query: T, column: string, ids: string[]): T {
  if (!ids.length) return query;
  return (query as any).not(column, "in", `(${ids.join(",")})`) as T;
}

async function overview(): Promise<Json> {
  const id = await eventId(); const db = client(); const hiddenOrderIds = await testOrderIds(id);
  const result = await db.rpc("ssuite_admin_dashboard_overview", { p_event_id: id });
  if (result.error || !result.data) fail("Overview is unavailable", 503);
  const paidOrders = excludeIds(db.from("orders").select("id", { count: "exact", head: true }).eq("event_id", id).in("status", ["paid", "partially_refunded"]), "id", hiddenOrderIds);
  const attendees = excludeIds(db.from("attendees").select("id", { count: "exact", head: true }).eq("event_id", id).not("email", "ilike", "*staging*"), "order_id", hiddenOrderIds);
  const completed = excludeIds(db.from("attendees").select("id", { count: "exact", head: true }).eq("event_id", id).eq("registration_status", "complete").not("email", "ilike", "*staging*"), "order_id", hiddenOrderIds);
  const tables = excludeIds(db.from("event_tables").select("id", { count: "exact", head: true }).eq("event_id", id).eq("status", "active"), "order_id", hiddenOrderIds);
  const email = db.from("ssuite_email_outbox").select("id", { count: "exact", head: true }).eq("event_id", id).eq("status", "queued").not("recipient", "ilike", "*staging*");
  const [paidResult, attendeeResult, completedResult, tableResult, emailResult] = await Promise.all([paidOrders, attendees, completed, tables, email]);
  if ([paidResult, attendeeResult, completedResult, tableResult, emailResult].some((item) => item.error)) fail("Overview is unavailable", 503);
  const data = result.data as any; const counts = data.counts ?? {};
  data.environment = "authoritative_review";
  data.notice = "This staging interface reads authoritative event records. Isolated validation transactions are hidden; sales and outbound delivery remain closed.";
  data.counts = { ...counts, paid_orders: paidResult.count ?? 0, attendees: attendeeResult.count ?? 0, completed_attendees: completedResult.count ?? 0, tables: tableResult.count ?? 0, email_queued: emailResult.count ?? 0 };
  return { overview: data };
}

async function listOrders(body: Json): Promise<Json> {
  const id = await eventId(); const p = page(body); const search = text(body.search, 80); const hiddenOrderIds = await testOrderIds(id);
  let query = client().from("orders").select("id,order_type,status,purchaser_first_name,purchaser_last_name,purchaser_email,subtotal_cents,discount_cents,tax_cents,total_cents,currency,paid_at,created_at", { count: "exact" }).eq("event_id", id).not("purchaser_email", "ilike", "*staging*");
  query = excludeIds(query, "id", hiddenOrderIds);
  if (search) query = query.or(`purchaser_first_name.ilike.%${search}%,purchaser_last_name.ilike.%${search}%,purchaser_email.ilike.%${search}%`);
  const result = await query.order("created_at", { ascending: false }).range(p.from, p.to);
  if (result.error) fail("Orders are unavailable", 503);
  return paged(result.data, result.count, p);
}

async function listAttendees(body: Json): Promise<Json> {
  const id = await eventId(); const p = page(body); const search = text(body.search, 80); const hiddenOrderIds = await testOrderIds(id);
  let query = client().from("attendees").select("id,first_name,last_name,email,phone,company,job_title,registration_status,source,is_purchaser,is_table_lead,completed_at,created_at", { count: "exact" }).eq("event_id", id).not("email", "ilike", "*staging*");
  query = excludeIds(query, "order_id", hiddenOrderIds);
  if (search) query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,company.ilike.%${search}%`);
  const result = await query.order("created_at", { ascending: false }).range(p.from, p.to);
  if (result.error) fail("Attendees are unavailable", 503);
  return paged(result.data, result.count, p);
}

async function attendeeDetail(body: Json): Promise<Json> {
  const id = typeof body.attendee_id === "string" && /^[0-9a-f-]{36}$/i.test(body.attendee_id) ? body.attendee_id : fail("Invalid attendee");
  const db = client();
  const event = await eventId(); const hiddenOrderIds = await testOrderIds(event);
  const attendee = await db.from("attendees").select("id,event_id,order_id,ticket_type_id,table_id,first_name,last_name,email,secondary_email,phone,job_title,company,pronunciation,bio,relationship_notes,linkedin_url,staff_photo_path,registration_status,source,is_purchaser,is_table_lead,completed_at,created_at").eq("id", id).eq("event_id", event).not("email", "ilike", "*staging*").maybeSingle();
  if (attendee.error || !attendee.data || (attendee.data.order_id && hiddenOrderIds.includes(String(attendee.data.order_id)))) fail("Attendee not found", 404);
  const [needs, consents, table, ticket, order] = await Promise.all([
    db.from("attendee_needs").select("meal_preference,has_dietary_or_allergy_needs,dietary_or_allergy_details,has_accessibility_needs,accessibility_details,updated_at").eq("attendee_id", id).maybeSingle(),
    db.from("consents").select("scope,terms_version,privacy_version,media_release_version,accepted_at,source").eq("attendee_id", id).order("accepted_at", { ascending: false }).limit(20),
    attendee.data.table_id ? db.from("event_tables").select("table_number,name").eq("id", attendee.data.table_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    attendee.data.ticket_type_id ? db.from("ticket_types").select("name,code").eq("id", attendee.data.ticket_type_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    attendee.data.order_id ? db.from("orders").select("id,status,order_type,total_cents,currency,paid_at").eq("id", attendee.data.order_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  if (needs.error || consents.error || table.error || ticket.error || order.error) fail("Attendee detail is unavailable", 503);
  let photoSignedUrl: string | null = null;
  if (attendee.data.staff_photo_path) {
    const signed = await db.storage.from("ssuite-attendee-photos").createSignedUrl(String(attendee.data.staff_photo_path), 600);
    if (!signed.error) photoSignedUrl = signed.data.signedUrl;
  }
  return { attendee: { ...attendee.data, photo_signed_url: photoSignedUrl, event_tables: table.data, ticket_types: ticket.data, orders: order.data }, needs: needs.data, consents: consents.data ?? [] };
}

function editableString(value: unknown, name: string, max: number, required = false): string | null {
  if (value === null || value === undefined || value === "") {
    if (required) fail(`${name} is required`);
    return null;
  }
  if (typeof value !== "string") fail(`${name} is invalid`);
  const clean = value.trim();
  if ((!clean && required) || clean.length > max || /[\u0000-\u001f\u007f]/.test(clean)) fail(`${name} is invalid`);
  return clean || null;
}

function editableEmail(value: unknown, name: string, required = false): string | null {
  const email = editableString(value, name, 320, required)?.toLowerCase() ?? null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`${name} is invalid`);
  return email;
}

async function updateAttendee(body: Json, user: User): Promise<Json> {
  const attendeeId = typeof body.attendee_id === "string" && /^[0-9a-f-]{36}$/i.test(body.attendee_id) ? body.attendee_id : fail("Invalid attendee");
  if (!body.record || typeof body.record !== "object" || Array.isArray(body.record)) fail("Invalid attendee edit");
  const input = body.record as Json;
  const allowed = new Set(["first_name","last_name","email","secondary_email","phone","job_title","company","meal_preference","has_dietary_or_allergy_needs","dietary_or_allergy_details","has_accessibility_needs","accessibility_details","pronunciation","bio","relationship_notes","linkedin_url","change_reason"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) fail("Invalid attendee edit fields");
  if (typeof input.has_dietary_or_allergy_needs !== "boolean" || typeof input.has_accessibility_needs !== "boolean") fail("Need selections are required");
  const record: Json = {
    first_name: editableString(input.first_name, "First name", 200, true),
    last_name: editableString(input.last_name, "Last name", 200, true),
    email: editableEmail(input.email, "Email", true),
    secondary_email: editableEmail(input.secondary_email, "Secondary email"),
    phone: editableString(input.phone, "Phone", 100),
    job_title: editableString(input.job_title, "Job title", 300, true),
    company: editableString(input.company, "Company", 300, true),
    pronunciation: editableString(input.pronunciation, "Pronunciation", 300),
    bio: editableString(input.bio, "Bio", 5000),
    relationship_notes: editableString(input.relationship_notes, "Relationship notes", 2000),
    linkedin_url: editableString(input.linkedin_url, "LinkedIn profile", 500),
    meal_preference: editableString(input.meal_preference, "Meal preference", 200, true),
    has_dietary_or_allergy_needs: input.has_dietary_or_allergy_needs,
    dietary_or_allergy_details: editableString(input.dietary_or_allergy_details, "Dietary or allergy details", 2000, Boolean(input.has_dietary_or_allergy_needs)),
    has_accessibility_needs: input.has_accessibility_needs,
    accessibility_details: editableString(input.accessibility_details, "Accessibility details", 2000, Boolean(input.has_accessibility_needs)),
    change_reason: editableString(input.change_reason, "Change note", 500, true),
  };
  if (record.linkedin_url && !/^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\//i.test(String(record.linkedin_url))) fail("LinkedIn profile must be a full linkedin.com URL");
  if (record.secondary_email && record.secondary_email === record.email) fail("Secondary email must differ from the primary email");

  const event = await eventId(); const db = client(); const hiddenOrderIds = await testOrderIds(event);
  const existing = await db.from("attendees").select("id,order_id,email").eq("id", attendeeId).eq("event_id", event).not("email", "ilike", "*staging*").maybeSingle();
  if (existing.error || !existing.data || (existing.data.order_id && hiddenOrderIds.includes(String(existing.data.order_id)))) fail("Attendee not found", 404);
  const result = await db.rpc("update_ssuite_admin_attendee", { p_actor_user_id: user.id, p_event_id: event, p_attendee_id: attendeeId, p_record: record });
  if (result.error) fail("The attendee update could not be saved", 503);
  return await attendeeDetail({ attendee_id: attendeeId });
}

async function setAttendeePhoto(body: Json, user: User): Promise<Json> {
  const attendeeId = uuid(body.attendee_id, "Invalid attendee");
  const photoPath = editableString(body.photo_path, "Photo", 500, true);
  const expectedPrefix = `${attendeeId}/`;
  if (!photoPath || !photoPath.startsWith(expectedPrefix) || !/\.(?:jpe?g|png|webp)$/i.test(photoPath)) fail("Invalid attendee photo");
  const db = client(); const event = await eventId();
  const existing = await db.from("attendees").select("id,staff_photo_path").eq("id", attendeeId).eq("event_id", event).maybeSingle();
  if (existing.error || !existing.data) fail("Attendee not found", 404);
  const folder = attendeeId;
  const objects = await db.storage.from("ssuite-attendee-photos").list(folder, { search: photoPath.split("/").pop() ?? "" });
  if (objects.error || !objects.data.some((item) => `${folder}/${item.name}` === photoPath)) fail("Uploaded photo was not found", 400);
  const update = await db.from("attendees").update({ staff_photo_path: photoPath }).eq("id", attendeeId).eq("event_id", event);
  if (update.error) fail("The attendee photo could not be saved", 503);
  // The audit action must match the ssuite_ prefix enforced by the staff audit
  // log CHECK constraint, and a failed audit write must never pass silently:
  // an unaudited private-photo change is not an acceptable outcome.
  const audited = await db.from("ssuite_staff_audit_log").insert({ event_id: event, actor_user_id: user.id, action: "ssuite_attendee_photo_updated", entity_type: "attendee", entity_id: attendeeId, metadata: { private_staff_photo: true } });
  if (audited.error) fail("The attendee photo change could not be audited", 503);
  const oldPath = String(existing.data.staff_photo_path ?? "");
  if (oldPath && oldPath !== photoPath) await db.storage.from("ssuite-attendee-photos").remove([oldPath]);
  return await attendeeDetail({ attendee_id: attendeeId });
}

function uuid(value: unknown, message = "Invalid identifier"): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail(message);
  return value;
}

function operationRecord(body: Json): Json {
  if (!body.record || typeof body.record !== "object" || Array.isArray(body.record)) fail("Invalid operation request");
  return body.record as Json;
}

async function eligiblePaidTableOrders(user: User): Promise<Json> {
  const result = await client().rpc("list_ssuite_admin_eligible_paid_table_orders", { p_actor_user_id: user.id, p_event_id: await eventId() });
  if (result.error) fail("Eligible paid table orders are unavailable", 503);
  return { data: result.data ?? [] };
}

async function unseatedAdminAttendees(user: User): Promise<Json> {
  const result = await client().rpc("list_ssuite_admin_unseated_attendees", { p_actor_user_id: user.id, p_event_id: await eventId() });
  if (result.error) fail("Eligible pending attendees are unavailable", 503);
  return { data: result.data ?? [] };
}

async function createAdminTable(body: Json, user: User): Promise<Json> {
  const result = await client().rpc("create_ssuite_admin_table", {
    p_actor_user_id: user.id, p_event_id: await eventId(), p_request_id: uuid(body.request_id, "A browser request ID is required"), p_record: operationRecord(body),
  });
  if (result.error || !result.data) fail("The table could not be created. Check the selected order, capacity, and table details.", 400);
  return { result: result.data };
}

async function createAdminAttendee(body: Json, user: User): Promise<Json> {
  const result = await client().rpc("create_ssuite_admin_attendee", {
    p_actor_user_id: user.id, p_event_id: await eventId(), p_request_id: uuid(body.request_id, "A browser request ID is required"), p_record: operationRecord(body),
  });
  if (result.error || !result.data) fail("The attendee could not be created. Check provenance, capacity, and the selected seat.", 400);
  return { result: result.data };
}

async function updateAdminTable(body: Json, user: User): Promise<Json> {
  const result = await client().rpc("update_ssuite_admin_table", {
    p_actor_user_id: user.id, p_event_id: await eventId(), p_table_id: uuid(body.table_id, "Invalid table"), p_record: operationRecord(body),
  });
  if (result.error || !result.data) fail("The table could not be updated. Check the table details and status.", 400);
  return { result: result.data };
}

async function setAdminSeat(body: Json, user: User): Promise<Json> {
  const seatNumber = body.seat_number;
  if (typeof seatNumber !== "number" || !Number.isInteger(seatNumber) || seatNumber < 1 || seatNumber > 10) fail("Invalid seat");
  const attendeeId = body.attendee_id === null || body.attendee_id === undefined ? null : uuid(body.attendee_id, "Invalid attendee");
  const result = await client().rpc("set_ssuite_admin_table_seat", {
    p_actor_user_id: user.id, p_event_id: await eventId(), p_table_id: uuid(body.table_id, "Invalid table"), p_seat_number: seatNumber, p_attendee_id: attendeeId,
  });
  if (result.error || !result.data) fail("The seat could not be changed. Pending guests, table provenance, and active invitations are protected.", 400);
  return { result: result.data };
}

async function setAdminLead(body: Json, user: User): Promise<Json> {
  const attendeeId = body.attendee_id === null || body.attendee_id === undefined ? null : uuid(body.attendee_id, "Invalid attendee");
  const result = await client().rpc("set_ssuite_admin_table_lead", {
    p_actor_user_id: user.id, p_event_id: await eventId(), p_table_id: uuid(body.table_id, "Invalid table"), p_attendee_id: attendeeId,
  });
  if (result.error || !result.data) fail("The table lead could not be changed. Active management credentials are protected.", 400);
  return { result: result.data };
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function tableToken(tokenId: string): Promise<string> {
  if (!TABLE_TOKEN_SECRET) fail("Private table links are not configured", 503);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(TABLE_TOKEN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`SSUITE/TABLE-MANAGEMENT/V1:${tokenId}`));
  return [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function revealTableManagementLink(body: Json, user: User): Promise<Json> {
  const tableId = uuid(body.table_id, "Invalid table");
  if (!TABLE_PORTAL_URL || new URL(TABLE_PORTAL_URL).hash) fail("Private table links are not configured", 503);

  const db = client(); const event = await eventId();
  const tableResult = await db.from("event_tables").select("id,event_id,order_id,lead_attendee_id,status").eq("id", tableId).eq("event_id", event).maybeSingle();
  if (tableResult.error || !tableResult.data || tableResult.data.status !== "active" || !tableResult.data.lead_attendee_id) fail("An active table lead is required");
  const leadId = String(tableResult.data.lead_attendee_id);
  const [orderResult, leadResult, tokenResult] = await Promise.all([
    db.from("orders").select("id,status").eq("id", tableResult.data.order_id).eq("event_id", event).maybeSingle(),
    db.from("attendees").select("id,table_id,registration_status,email").eq("id", leadId).eq("event_id", event).maybeSingle(),
    db.from("table_management_tokens").select("id,token_hash,status,expires_at,last_used_at").eq("table_id", tableId).eq("status", "active").maybeSingle(),
  ]);
  if (orderResult.error || !orderResult.data || !["paid", "partially_refunded"].includes(orderResult.data.status)) fail("A verified paid table is required");
  if (leadResult.error || !leadResult.data || leadResult.data.table_id !== tableId || leadResult.data.registration_status !== "complete") fail("A completed table lead is required");
  if (tokenResult.error) fail("Table access is unavailable", 503);

  let tokenId = tokenResult.data?.id ? String(tokenResult.data.id) : crypto.randomUUID();
  let raw = await tableToken(tokenId); let digest = await sha256(raw); let rotated = false; let created = false;
  if (!tokenResult.data) {
    const provisioned = await db.rpc("provision_ssuite_table_management_token", { p_table_id: tableId, p_lead_attendee_id: leadId, p_token_id: tokenId, p_token_hash: digest, p_token_version: 1, p_expires_at: new Date(Date.now() + 365 * 86400000).toISOString() });
    if (provisioned.error || !Array.isArray(provisioned.data) || provisioned.data.length !== 1) fail("Table access could not be prepared", 503);
    tokenId = String(provisioned.data[0].token_id); raw = await tableToken(tokenId); digest = await sha256(raw); created = Boolean(provisioned.data[0].created);
  } else if (String(tokenResult.data.token_hash) !== digest) {
    if (tokenResult.data.last_used_at) fail("This existing access link cannot be reconstructed. Revoke it before issuing a replacement.", 409);
    const updated = await db.from("table_management_tokens").update({ token_hash: digest, updated_at: new Date().toISOString() }).eq("id", tokenId).eq("status", "active").is("last_used_at", null).select("id").maybeSingle();
    if (updated.error || !updated.data) fail("Table access could not be prepared", 503);
    rotated = true;
  }

  const audit = await db.from("ssuite_staff_audit_log").insert({ event_id: event, actor_user_id: user.id, action: "ssuite_admin_table_management_link_revealed", entity_type: "event_table", entity_id: tableId, metadata: { lead_attendee_id: leadId, recipient: leadResult.data.email, delivery_method: "manual_copy", nothing_sent: true, credential_created: created, undelivered_credential_reconstructed: rotated } });
  if (audit.error) fail("The access-link audit record could not be saved", 503);
  return { table_id: tableId, lead_attendee_id: leadId, recipient: leadResult.data.email, table_management_url: appendFragment(TABLE_PORTAL_URL, raw), nothing_sent: true };
}

async function listTables(body: Json): Promise<Json> {
  const id = await eventId(); const p = page(body); const hiddenOrderIds = await testOrderIds(id); const db = client();
  let query = db.from("event_tables").select("id,order_id,table_number,name,status,seat_count,lead_attendee_id,created_at", { count: "exact" }).eq("event_id", id);
  query = excludeIds(query, "order_id", hiddenOrderIds);
  const tableResult = await query.order("table_number", { ascending: true, nullsFirst: false }).range(p.from, p.to);
  if (tableResult.error) fail("Tables are unavailable", 503);
  const tables = tableResult.data ?? [];
  if (!tables.length) return paged([], tableResult.count, p);

  const tableIds = tables.map((table) => String(table.id));
  const orderIds = tables.map((table) => String(table.order_id ?? "")).filter(Boolean);
  const [seatResult, attendeeResult, invitationResult, credentialResult, orderResult] = await Promise.all([
    db.from("table_seats").select("id,table_id,seat_number,locked,attendee_id,updated_at").in("table_id", tableIds).order("seat_number", { ascending: true }),
    db.from("attendees").select("id,table_id,first_name,last_name,email,company,job_title,registration_status,is_purchaser,is_table_lead,completed_at").in("table_id", tableIds).not("email", "ilike", "*staging*"),
    db.from("invitations").select("id,table_id,seat_id,attendee_id,recipient_email,status,send_count,first_sent_at,last_sent_at,expires_at,revoked_at,created_at").in("table_id", tableIds).order("created_at", { ascending: false }),
    db.from("table_management_tokens").select("id,table_id,lead_attendee_id,status,expires_at,last_used_at,revoked_at,created_at").in("table_id", tableIds).order("created_at", { ascending: false }),
    orderIds.length ? db.from("orders").select("id,purchaser_first_name,purchaser_last_name,purchaser_email,status,total_cents,currency,paid_at").in("id", orderIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (seatResult.error || attendeeResult.error || invitationResult.error || credentialResult.error || orderResult.error) fail("Table roster is unavailable", 503);

  const invitationIds = (invitationResult.data ?? []).map((row) => String(row.id));
  const credentialIds = (credentialResult.data ?? []).map((row) => String(row.id));
  const leadIds = tables.map((row) => String(row.lead_attendee_id ?? "")).filter(Boolean);
  const deliveryEntityIds = [...new Set([...tableIds, ...leadIds, ...invitationIds, ...credentialIds])];
  const deliveryResult = await db.from("ssuite_email_outbox").select("id,message_type,recipient,entity_type,entity_id,status,attempt_count,accepted_at,delivered_at,bounced_at,suppressed_at,failure_detail,created_at").eq("event_id", id).in("entity_id", deliveryEntityIds).order("created_at", { ascending: false });
  if (deliveryResult.error) fail("Invitation delivery data is unavailable", 503);

  const attendees = new Map((attendeeResult.data ?? []).map((row) => [String(row.id), row]));
  const orders = new Map((orderResult.data ?? []).map((row) => [String(row.id), row]));
  const latestInvitationBySeat = new Map<string, any>();
  for (const invitation of invitationResult.data ?? []) {
    const key = String(invitation.seat_id ?? invitation.attendee_id ?? "");
    if (key && !latestInvitationBySeat.has(key)) latestInvitationBySeat.set(key, invitation);
  }
  const latestMailByEntity = new Map<string, any>();
  for (const mail of deliveryResult.data ?? []) {
    const key = String(mail.entity_id ?? "");
    if (key && !latestMailByEntity.has(key)) latestMailByEntity.set(key, mail);
  }
  const latestCredentialByTable = new Map<string, any>();
  for (const credential of credentialResult.data ?? []) {
    const key = String(credential.table_id);
    if (!latestCredentialByTable.has(key)) latestCredentialByTable.set(key, credential);
  }
  const seatsByTable = new Map<string, any[]>();
  for (const seat of seatResult.data ?? []) {
    const attendee = seat.attendee_id ? attendees.get(String(seat.attendee_id)) ?? null : null;
    const invitation = latestInvitationBySeat.get(String(seat.id)) ?? (seat.attendee_id ? latestInvitationBySeat.get(String(seat.attendee_id)) : null) ?? null;
    const delivery = invitation ? latestMailByEntity.get(String(invitation.id)) ?? null : null;
    const record = { ...seat, attendee, invitation: invitation ? { ...invitation, delivery } : null };
    const key = String(seat.table_id); const rows = seatsByTable.get(key) ?? []; rows.push(record); seatsByTable.set(key, rows);
  }
  const data = tables.map((table) => {
    const tableId = String(table.id); const leadCredential = latestCredentialByTable.get(tableId) ?? null;
    const leadDelivery = leadCredential ? latestMailByEntity.get(String(leadCredential.id)) ?? latestMailByEntity.get(String(leadCredential.lead_attendee_id)) ?? latestMailByEntity.get(tableId) ?? null : null;
    return { ...table, purchaser: table.order_id ? orders.get(String(table.order_id)) ?? null : null, table_seats: seatsByTable.get(tableId) ?? [], lead_access: leadCredential ? { ...leadCredential, delivery: leadDelivery } : null };
  });
  return paged(data, tableResult.count, p);
}

async function listEmail(body: Json): Promise<Json> {
  const id = await eventId(); const p = page(body); const search = text(body.search, 80);
  let query = client().from("ssuite_email_outbox").select("id,message_type,recipient,entity_type,entity_id,status,attempt_count,accepted_at,delivered_at,bounced_at,suppressed_at,failure_detail,created_at", { count: "exact" }).eq("event_id", id).not("recipient", "ilike", "*staging*");
  if (search) query = query.or(`recipient.ilike.%${search}%,message_type.ilike.%${search}%`);
  const result = await query.order("created_at", { ascending: false }).range(p.from, p.to);
  if (result.error) fail("Email delivery data is unavailable", 503);
  return paged(result.data, result.count, p);
}

async function listAuction(body: Json): Promise<Json> {
  const p = page(body); const search = text(body.search, 80);
  let query = client().from("auction_item_submissions").select("id,name,normalized_email,job_title,company,item_description,estimated_value_cents,review_status,review_status_changed_at,created_at", { count: "exact" });
  if (search) query = query.or(`name.ilike.%${search}%,normalized_email.ilike.%${search}%,company.ilike.%${search}%`);
  const result = await query.order("created_at", { ascending: false }).range(p.from, p.to);
  if (result.error) fail("Auction submissions are unavailable", 503);
  return paged(result.data, result.count, p);
}

async function listDonations(body: Json): Promise<Json> {
  const id = await eventId(); const p = page(body); const search = text(body.search, 80);
  let query = client().from("ssuite_donations").select("id,donation_mode,amount_cents,received_amount_cents,currency,donor_name,normalized_email,dedication_type,honoree_name,employer_match_status,status,paid_at,receipt_number,receipt_status,created_at", { count: "exact" }).eq("event_id", id);
  if (search) query = query.or(`donor_name.ilike.%${search}%,normalized_email.ilike.%${search}%`);
  const result = await query.order("created_at", { ascending: false }).range(p.from, p.to);
  if (result.error) fail("Donations are unavailable", 503);
  return paged(result.data, result.count, p);
}

async function listAudit(): Promise<Json> {
  const id = await eventId(); const db = client(); const hiddenOrders = await testOrderIds(id);
  const [staff, base, hiddenAttendees, hiddenTables] = await Promise.all([
    db.from("ssuite_staff_audit_log").select("id,actor_user_id,action,entity_type,entity_id,metadata,occurred_at").eq("event_id", id).order("occurred_at", { ascending: false }).limit(100),
    db.from("audit_log").select("id,actor_user_id,actor_type,action,entity_type,entity_id,metadata,occurred_at").eq("event_id", id).order("occurred_at", { ascending: false }).limit(100),
    db.from("attendees").select("id").eq("event_id", id).ilike("email", "*staging*"),
    hiddenOrders.length ? db.from("event_tables").select("id").eq("event_id", id).in("order_id", hiddenOrders) : Promise.resolve({ data: [], error: null }),
  ]);
  if (staff.error || base.error || hiddenAttendees.error || hiddenTables.error) fail("Audit data is unavailable", 503);
  const hiddenIds = new Set([...hiddenOrders, ...(hiddenAttendees.data ?? []).map((row) => String(row.id)), ...(hiddenTables.data ?? []).map((row) => String(row.id))]);
  const entries = [...(staff.data ?? []).map((row) => ({ ...row, log: "staff" })), ...(base.data ?? []).map((row) => ({ ...row, log: "system" }))]
    .filter((row) => !hiddenIds.has(String(row.entity_id ?? "")) && !/cs_test_|staging/i.test(JSON.stringify(row.metadata ?? {})))
    .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))).slice(0, 100);
  return { data: entries, limit: 100, note: "Latest 100 operational audit entries. Isolated validation activity is hidden." };
}

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  // Spreadsheet applications can execute cells beginning with formula sigils,
  // including after leading spaces or control characters. Preserve the value
  // while forcing literal-text interpretation before applying CSV quoting.
  const neutralizeFormula = /^[\t\r\n]|^ *[=+\-@]/.test(raw);
  const safe = `${neutralizeFormula ? "'" : ""}${raw.replace(/[\r\n]/g, " ")}`;
  return `"${safe.replaceAll('"', '""')}"`;
}

async function exportCsv(body: Json, origin: string | null): Promise<Response> {
  const kind = typeof body.kind === "string" ? body.kind : "";
  const id = await eventId(); const db = client();
  let rows: Record<string, unknown>[] = []; let columns: string[] = [];
  if (kind === "attendees") {
    columns = ["first_name", "last_name", "email", "phone", "company", "job_title", "registration_status", "source", "completed_at"];
    const hiddenOrderIds = await testOrderIds(id);
    let query = db.from("attendees").select(columns.join(",")).eq("event_id", id).not("email", "ilike", "*staging*");
    query = excludeIds(query, "order_id", hiddenOrderIds);
    const result = await query.order("last_name", { ascending: true }).limit(MAX_EXPORT_ROWS);
    if (result.error) fail("Export is unavailable", 503); rows = result.data as Record<string, unknown>[];
  } else if (kind === "orders") {
    columns = ["id", "order_type", "status", "purchaser_first_name", "purchaser_last_name", "purchaser_email", "total_cents", "currency", "paid_at", "created_at"];
    const hiddenOrderIds = await testOrderIds(id);
    let query = db.from("orders").select(columns.join(",")).eq("event_id", id).not("purchaser_email", "ilike", "*staging*");
    query = excludeIds(query, "id", hiddenOrderIds);
    const result = await query.order("created_at", { ascending: false }).limit(MAX_EXPORT_ROWS);
    if (result.error) fail("Export is unavailable", 503); rows = result.data as Record<string, unknown>[];
  } else if (kind === "donations") {
    columns = ["id", "donor_name", "normalized_email", "amount_cents", "received_amount_cents", "currency", "status", "paid_at", "receipt_status", "created_at"];
    const result = await db.from("ssuite_donations").select(columns.join(",")).eq("event_id", id).order("created_at", { ascending: false }).limit(MAX_EXPORT_ROWS);
    if (result.error) fail("Export is unavailable", 503); rows = result.data as Record<string, unknown>[];
  } else fail("Export type is unavailable");
  const csv = [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n");
  return new Response(csv, { headers: { ...cors(origin), "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="ssuite-${kind}-export.csv"`, "X-Content-Type-Options": "nosniff" } });
}

async function route(body: Json, origin: string | null, user: User): Promise<Response> {
  const action = typeof body.action === "string" ? body.action : "";
  if (action === "overview") return json(await overview(), 200, origin);
  if (action === "orders") return json(await listOrders(body), 200, origin);
  if (action === "attendees") return json(await listAttendees(body), 200, origin);
  if (action === "attendee_detail") return json(await attendeeDetail(body), 200, origin);
  if (action === "attendee_update") return json(await updateAttendee(body, user), 200, origin);
  if (action === "attendee_photo_set") return json(await setAttendeePhoto(body, user), 200, origin);
  if (action === "eligible_paid_table_orders") return json(await eligiblePaidTableOrders(user), 200, origin);
  if (action === "admin_unseated_attendees") return json(await unseatedAdminAttendees(user), 200, origin);
  if (action === "admin_table_create") return json(await createAdminTable(body, user), 200, origin);
  if (action === "admin_attendee_create") return json(await createAdminAttendee(body, user), 200, origin);
  if (action === "admin_table_update") return json(await updateAdminTable(body, user), 200, origin);
  if (action === "admin_seat_set") return json(await setAdminSeat(body, user), 200, origin);
  if (action === "admin_table_lead_set") return json(await setAdminLead(body, user), 200, origin);
  if (action === "table_management_link_reveal") return json(await revealTableManagementLink(body, user), 200, origin);
  if (action === "tables") return json(await listTables(body), 200, origin);
  if (action === "email") return json(await listEmail(body), 200, origin);
  if (action === "auction") return json(await listAuction(body), 200, origin);
  if (action === "donations") return json(await listDonations(body), 200, origin);
  if (action === "audit") return json(await listAudit(), 200, origin);
  if (action === "export") return await exportCsv(body, origin);
  fail("Action is unavailable", 404);
}

Deno.serve(async (request) => {
  let origin: string | null = null;
  try {
    origin = requestOrigin(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST") return json({ error: "Method is unavailable" }, 405, origin);
    const user = await requireApprovedAdmin(request); // performed for every non-preflight request
    return await route(await readJson(request), origin, user);
  } catch (error) {
    const appError = error as ApiError;
    const status = appError.status ?? 500;
    // Do not leak database, authentication, or provider details to the browser.
    return json({ error: status >= 500 ? "The private dashboard is temporarily unavailable" : appError.message }, status, origin);
  }
});
