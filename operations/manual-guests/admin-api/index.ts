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

// `ssuite_community_invitation_requests` is deliberately not readable by
// service_role: the 2026-09-09 gate migration exposes it only through
// SECURITY DEFINER functions. A direct .from() read on it therefore fails,
// which is how the first build of this panel locked staff out of the whole
// dashboard -- the overview gates sign-in, so one broken count broke everything.
// Every read below goes through the granted function instead.
const INVITATION_SCAN_LIMIT = 5000;

async function invitationRequestRows(db: ReturnType<typeof client>, status: string | null): Promise<Record<string, unknown>[] | null> {
  const result = await db.rpc("ssuite_admin_list_invitation_requests", { p_status: status, p_limit: INVITATION_SCAN_LIMIT });
  if (result.error || !Array.isArray(result.data)) return null;
  return result.data as Record<string, unknown>[];
}

async function memberCodeRequestRows(db: ReturnType<typeof client>, status: string | null): Promise<Record<string, unknown>[] | null> {
  const result = await db.rpc("ssuite_admin_list_member_code_requests", { p_status: status });
  if (result.error || !Array.isArray(result.data)) return null;
  return result.data as Record<string, unknown>[];
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
  const ambassadors = db.from("ssuite_ambassador_interests").select("id", { count: "exact", head: true }).eq("event_id", id);
  // The invitation-request function uses the database's "new" state. The
  // dashboard calls that state "pending" so staff see the operational meaning.
  const [paidResult, attendeeResult, completedResult, tableResult, emailResult, ambassadorResult, pendingInvitationRows, pendingMemberCodeRows] = await Promise.all([
    paidOrders, attendees, completed, tables, email, ambassadors, invitationRequestRows(db, "new"), memberCodeRequestRows(db, "pending"),
  ]);
  if ([paidResult, attendeeResult, completedResult, tableResult, emailResult, ambassadorResult].some((item) => item.error)) fail("Overview is unavailable", 503);
  if (pendingInvitationRows === null || pendingMemberCodeRows === null) fail("Overview is unavailable", 503);
  const data = result.data as any; const counts = data.counts ?? {};
  const salesOpen = String(data?.event?.sales_status ?? "").toLowerCase() === "open";
  data.environment = "production";
  data.notice = `Live production records for event.ssuite.org. Ticket sales are ${salesOpen ? "open" : "closed"}. Isolated validation transactions are excluded from these figures.`;
  data.counts = { ...counts, paid_orders: paidResult.count ?? 0, attendees: attendeeResult.count ?? 0, completed_attendees: completedResult.count ?? 0, tables: tableResult.count ?? 0, email_queued: emailResult.count ?? 0, invitation_requests_pending: pendingInvitationRows.length, member_code_requests_pending: pendingMemberCodeRows.length, ambassador_responses: ambassadorResult.count ?? 0 };
  return { overview: data };
}

async function listInvitationRequests(body: Json): Promise<Json> {
  const p = page(body);
  const requestedStatus = body.status === undefined ? "all" : body.status;
  if (typeof requestedStatus !== "string" || !["all", "pending", "approved", "declined"].includes(requestedStatus)) {
    fail("Invitation request status is invalid");
  }
  // The existing RPC exposes its pending queue as status="new". Keep that
  // implementation detail server-side and use the staff-facing pending label.
  const databaseStatus = requestedStatus === "all" ? null : requestedStatus === "pending" ? "new" : requestedStatus;
  const db = client();
  // One function call covers both the filtered page and the filter tallies, so
  // the counts beside each filter can never disagree with the rows on screen.
  const all = await invitationRequestRows(db, null);
  if (all === null) fail("Invitation requests are unavailable", 503);
  const tally = (status: string) => all.filter((row) => row.status === status).length;
  const filtered = databaseStatus === null ? all : all.filter((row) => row.status === databaseStatus);
  const rows = filtered.map((row) => ({ ...row, status: row.status === "new" ? "pending" : row.status }));
  return {
    ...paged(rows.slice(p.from, p.to + 1), filtered.length, p),
    counts: { pending: tally("new"), approved: tally("approved"), declined: tally("declined") },
  };
}

async function decideInvitationRequest(body: Json, user: User): Promise<Json> {
  const requestId = uuid(body.request_id, "Invalid invitation request");
  if (body.decision !== "approved" && body.decision !== "declined") fail("Invitation request decision is invalid");
  const decision = body.decision;
  let seats: number | null = null;
  if (body.seats !== undefined) {
    if (typeof body.seats !== "number" || !Number.isInteger(body.seats) || body.seats < 1 || body.seats > 10) fail("Seat cap must be a whole number from 1 to 10");
    seats = body.seats;
  }
  const note = editableString(body.note, "Internal note", 2000);
  const db = client();
  // The deployed database function raises for a missing request rather than
  // returning a result value. Check it explicitly so the browser receives a
  // useful 4xx response without receiving database error text.
  const all = await invitationRequestRows(db, null);
  if (all === null) fail("Invitation request decision is unavailable", 503);
  const existing = all.find((row) => row.id === requestId);
  if (!existing) fail("Invitation request not found", 404);
  if (existing.status !== "new") {
    fail(existing.status === "approved" ? "This request was already approved. No new code was created." : "This request was already declined.", 409);
  }

  const result = await db.rpc("ssuite_admin_decide_invitation_request", {
    p_request_id: requestId,
    p_decision: decision === "approved" ? "approve" : "decline",
    p_actor: user.email?.trim() || user.id,
    p_seats: seats,
    p_note: note,
  });
  if (result.error || !Array.isArray(result.data) || result.data.length !== 1) fail("Invitation request decision is unavailable", 503);
  const decided = result.data[0] as Record<string, unknown>;
  const outcome = String(decided.result ?? "");
  if (outcome === "already_approved") fail("This request was already approved. No new code was created.", 409);
  if (!['approved', 'declined'].includes(outcome)) fail("This invitation request cannot be decided", 409);

  const audit = await db.from("ssuite_staff_audit_log").insert({
    event_id: await eventId(), actor_user_id: user.id,
    action: "ssuite_admin_invitation_request_decided", entity_type: "invitation_request", entity_id: requestId,
    metadata: { decision, seats_applied: outcome === "approved" ? decided.seats_approved ?? null : null, code_created: outcome === "approved" },
  });
  if (audit.error) fail("The invitation request decision could not be audited", 503);

  // Approving answers a person who asked to be invited, so the email is offered
  // with the decision rather than left to a second step somebody has to remember.
  // Staff still choose: send_email === false records the decision and sends nothing.
  // A queue failure never fails the decision — the decision is already recorded and
  // the row keeps its Send button.
  let queued: { outbox_id: string | null; send_count: number | null } | null = null;
  let sendError: string | null = null;
  if (outcome === "approved" && body.send_email !== false) {
    try {
      queued = await queueInvitationEmail(db, requestId, user);
    } catch {
      sendError = "The decision is recorded and the code exists, but the email could not be queued. Use Send invitation on the row.";
    }
  }

  return {
    result: outcome, request_id: decided.request_id, email: decided.email, first_name: decided.first_name,
    display_code: outcome === "approved" ? decided.display_code : null,
    seats_approved: outcome === "approved" ? decided.seats_approved : null,
    sent: queued !== null,
    send_count: queued?.send_count ?? null,
    send_error: sendError,
    held_until: queued === null ? null : (await db.from("ssuite_email_compliance_holds").select("hold_until").eq("message_type", "ssuite_invitation_approved").maybeSingle()).data?.hold_until ?? null,
  };
}

/** Queues the approved invitation and audits it. Shared by the decision path and the
 *  per-row Send button so both behave identically. The raw code is never returned to
 *  the browser from here and never written to the audit log. */
async function queueInvitationEmail(db: ReturnType<typeof client>, requestId: string, user: User): Promise<{ outbox_id: string | null; send_count: number | null }> {
  const result = await db.rpc("ssuite_queue_invitation_approval_email", { p_request_id: requestId });
  if (result.error || !Array.isArray(result.data) || result.data.length !== 1) throw new Error("queue unavailable");
  const row = result.data[0] as Record<string, unknown>;
  const outcome = String(row.result ?? "");
  if (outcome !== "queued") throw new Error(outcome);
  const audit = await db.from("ssuite_staff_audit_log").insert({
    event_id: await eventId(), actor_user_id: user.id,
    action: "ssuite_admin_invitation_email_queued", entity_type: "invitation_request", entity_id: requestId,
    metadata: { recipient: row.recipient ?? null, send_count: row.send_count ?? null, outbox_id: row.outbox_id ?? null },
  });
  if (audit.error) throw new Error("audit unavailable");
  return { outbox_id: row.outbox_id ? String(row.outbox_id) : null, send_count: typeof row.send_count === "number" ? row.send_count : null };
}

/** Sends, or re-sends, the invitation for an already-approved request. */
async function sendInvitationEmail(body: Json, user: User): Promise<Json> {
  const requestId = uuid(body.request_id, "Invalid invitation request");
  const db = client();
  const all = await invitationRequestRows(db, null);
  if (all === null) fail("Invitation requests are unavailable", 503);
  const existing = all.find((row) => row.id === requestId);
  if (!existing) fail("Invitation request not found", 404);
  if (existing.status !== "approved") fail("Only an approved request has an invitation to send.", 409);

  let queued: { outbox_id: string | null; send_count: number | null };
  try {
    queued = await queueInvitationEmail(db, requestId, user);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason === "not_eligible") fail("Only an approved request with a code has an invitation to send.", 409);
    if (reason === "unavailable") fail("This invitation code is no longer active, so it cannot be sent.", 409);
    if (reason === "not_found") fail("Invitation request not found", 404);
    if (reason === "audit unavailable") fail("The invitation send could not be audited", 503);
    fail("The invitation could not be queued", 503);
    throw error;
  }
  // A held message type is queued but not delivered. Report the hold so the dashboard
  // says "waiting on review" rather than implying the invitation has landed.
  const hold = await db.from("ssuite_email_compliance_holds").select("hold_until").eq("message_type", "ssuite_invitation_approved").maybeSingle();
  const heldUntil = hold.data?.hold_until ?? null;
  return { result: "queued", request_id: requestId, email: existing.email ?? null, send_count: queued.send_count, held_until: heldUntil };
}

async function listMemberCodeRequests(body: Json): Promise<Json> {
  const p = page(body);
  const requestedStatus = body.status === undefined ? "all" : body.status;
  if (typeof requestedStatus !== "string" || !["all", "pending", "sent", "approved", "declined"].includes(requestedStatus)) {
    fail("Member code request status is invalid");
  }
  const db = client();
  const all = await memberCodeRequestRows(db, null);
  if (all === null) fail("Member code requests are unavailable", 503);
  const tally = (status: string) => all.filter((row) => row.status === status).length;
  const filtered = requestedStatus === "all" ? all : all.filter((row) => row.status === requestedStatus);
  return {
    ...paged(filtered.slice(p.from, p.to + 1), filtered.length, p),
    counts: { pending: tally("pending"), sent: tally("sent"), approved: tally("approved"), declined: tally("declined") },
  };
}

async function decideMemberCodeRequest(body: Json, user: User): Promise<Json> {
  const requestId = uuid(body.request_id, "Invalid member code request");
  if (body.decision !== "approved" && body.decision !== "declined") fail("Member code request decision is invalid");
  const decision = body.decision;
  const note = editableString(body.note, "Internal note", 2000);
  const db = client();
  const all = await memberCodeRequestRows(db, null);
  if (all === null) fail("Member code request decision is unavailable", 503);
  const existing = all.find((row) => row.id === requestId);
  if (!existing) fail("Member code request not found", 404);
  if (existing.status !== "pending") {
    fail(existing.status === "approved" ? "This request was already approved." : "This member code request cannot be decided.", 409);
  }

  const result = await db.rpc("ssuite_admin_decide_member_code_request", {
    p_request_id: requestId,
    p_decision: decision === "approved" ? "approve" : "decline",
    p_actor: user.email?.trim() || user.id,
    p_note: note,
  });
  if (result.error || !Array.isArray(result.data) || result.data.length !== 1) fail("Member code request decision is unavailable", 503);
  const decided = result.data[0] as Record<string, unknown>;
  const outcome = String(decided.result ?? "");
  if (outcome === "already_approved") fail("This request was already approved.", 409);
  if (!['approved', 'declined'].includes(outcome)) fail("This member code request cannot be decided", 409);

  const audit = await db.from("ssuite_staff_audit_log").insert({
    event_id: await eventId(), actor_user_id: user.id,
    action: "ssuite_admin_member_code_request_decided", entity_type: "member_code_request", entity_id: requestId,
    metadata: { decision, code_emailed: outcome === "approved" },
  });
  if (audit.error) fail("The member code request decision could not be audited", 503);
  return { result: outcome, request_id: requestId, email: decided.email, first_name: decided.first_name };
}

async function resendMemberCode(body: Json, user: User): Promise<Json> {
  const requestId = uuid(body.request_id, "Invalid member code request");
  const db = client();
  const result = await db.rpc("ssuite_admin_resend_member_code", {
    p_request_id: requestId,
    p_actor: user.email?.trim() || user.id,
  });
  if (result.error || !Array.isArray(result.data) || result.data.length !== 1) fail("Member code resend is unavailable", 503);
  const resent = result.data[0] as Record<string, unknown>;
  const outcome = String(resent.result ?? "");
  if (outcome === "not_eligible") fail("This member code request is not eligible for resend.", 409);
  if (outcome === "unavailable") fail("This member code is unavailable.", 409);
  if (outcome !== "resent") fail("This member code request cannot be resent.", 409);

  const audit = await db.from("ssuite_staff_audit_log").insert({
    event_id: await eventId(), actor_user_id: user.id,
    action: "ssuite_admin_member_code_resent", entity_type: "member_code_request", entity_id: requestId,
    metadata: { recipient: resent.email },
  });
  if (audit.error) fail("The member code resend could not be audited", 503);
  return { result: outcome, request_id: requestId, email: resent.email };
}

async function listOrders(body: Json): Promise<Json> {
  const id = await eventId(); const p = page(body); const search = text(body.search, 80); const hiddenOrderIds = await testOrderIds(id);
  let query = client().from("orders").select("id,order_type,status,purchaser_first_name,purchaser_last_name,purchaser_email,subtotal_cents,discount_cents,tax_cents,total_cents,currency,paid_at,created_at,member_verification_status,membership_email", { count: "exact" }).eq("event_id", id).not("purchaser_email", "ilike", "*staging*");
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
  const [needs, consents, table, ticket, order, orderConsents] = await Promise.all([
    db.from("attendee_needs").select("meal_preference,has_dietary_or_allergy_needs,dietary_or_allergy_details,has_accessibility_needs,accessibility_details,updated_at").eq("attendee_id", id).maybeSingle(),
    db.from("consents").select("scope,terms_version,privacy_version,media_release_version,accepted_at,source").eq("attendee_id", id).order("accepted_at", { ascending: false }).limit(20),
    attendee.data.table_id ? db.from("event_tables").select("table_number,name").eq("id", attendee.data.table_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    attendee.data.ticket_type_id ? db.from("ticket_types").select("name,code").eq("id", attendee.data.ticket_type_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    attendee.data.order_id ? db.from("orders").select("id,status,order_type,total_cents,currency,paid_at,purchaser_first_name,purchaser_last_name,purchaser_email").eq("id", attendee.data.order_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    // The agreement is accepted once, at checkout, by the person paying -- for
    // herself and for the guests on her registration -- and is stored against
    // the order. Reading only this attendee's own rows therefore reported "no
    // record" for people who had in fact agreed. Nothing is written per guest:
    // a row in a guest's name would claim she accepted a box she never saw.
    attendee.data.order_id ? db.from("consents").select("scope,terms_version,privacy_version,media_release_version,accepted_at,source").is("attendee_id", null).eq("order_id", attendee.data.order_id).order("accepted_at", { ascending: false }).limit(5) : Promise.resolve({ data: [], error: null }),
  ]);
  if (needs.error || consents.error || table.error || ticket.error || order.error || orderConsents.error) fail("Attendee detail is unavailable", 503);
  let photoSignedUrl: string | null = null;
  if (attendee.data.staff_photo_path) {
    const signed = await db.storage.from("ssuite-attendee-photos").createSignedUrl(String(attendee.data.staff_photo_path), 600);
    if (!signed.error) photoSignedUrl = signed.data.signedUrl;
  }
  return { attendee: { ...attendee.data, photo_signed_url: photoSignedUrl, event_tables: table.data, ticket_types: ticket.data, orders: order.data }, needs: needs.data, consents: consents.data ?? [], order_consents: orderConsents.data ?? [] };
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

async function createAdminAllocatedHost(body: Json, user: User): Promise<Json> {
  const result = await client().rpc("create_ssuite_admin_allocated_host", {
    p_actor_user_id: user.id, p_event_id: await eventId(), p_request_id: uuid(body.request_id, "A browser request ID is required"), p_record: operationRecord(body),
  });
  if (result.error || !result.data) fail("The host and seats could not be added. Nothing was saved. Check duplicate email, capacity, table number and required details.", 400);
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
  if (result.error || !result.data) fail("The table host could not be changed. Active management credentials are protected.", 400);
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
  if (tableResult.error || !tableResult.data || tableResult.data.status !== "active" || !tableResult.data.lead_attendee_id) fail("An active table host is required");
  const leadId = String(tableResult.data.lead_attendee_id);
  const [orderResult, leadResult, tokenResult] = await Promise.all([
    db.from("orders").select("id,status").eq("id", tableResult.data.order_id).eq("event_id", event).maybeSingle(),
    db.from("attendees").select("id,table_id,registration_status,email").eq("id", leadId).eq("event_id", event).maybeSingle(),
    db.from("table_management_tokens").select("id,token_hash,status,expires_at,last_used_at").eq("table_id", tableId).eq("status", "active").maybeSingle(),
  ]);
  if (orderResult.error || !orderResult.data || !["paid", "partially_refunded"].includes(orderResult.data.status)) fail("A verified paid table is required");
  if (leadResult.error || !leadResult.data || leadResult.data.table_id !== tableId || leadResult.data.registration_status !== "complete") fail("A completed table host is required");
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

async function listAmbassadors(body: Json): Promise<Json> {
  const id = await eventId(); const p = page(body); const search = text(body.search, 80);
  let query = client().from("ssuite_ambassador_interests").select("id,first_name,last_name,email,job_title,company,salute_relationship,motivations,status,submission_count,confirmation_status,confirmation_triggered_at,admin_notification_status,admin_notification_triggered_at,created_at,updated_at", { count: "exact" }).eq("event_id", id);
  if (search) query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,company.ilike.%${search}%`);
  const result = await query.order("created_at", { ascending: false }).range(p.from, p.to);
  if (result.error) fail("Ambassador responses are unavailable", 503);
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
  if (kind === "honorees" || kind === "honoree_contacts") return await exportHonorees(kind, origin);
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
  } else if (kind === "ambassadors") {
    columns = ["id", "first_name", "last_name", "email", "job_title", "company", "salute_relationship", "motivations", "status", "submission_count", "confirmation_status", "confirmation_triggered_at", "admin_notification_status", "admin_notification_triggered_at", "created_at", "updated_at"];
    const result = await db.from("ssuite_ambassador_interests").select(columns.join(",")).eq("event_id", id).order("created_at", { ascending: false }).limit(MAX_EXPORT_ROWS);
    if (result.error) fail("Export is unavailable", 503); rows = result.data as Record<string, unknown>[];
  } else fail("Export type is unavailable");
  const csv = [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n");
  return new Response(csv, { headers: { ...cors(origin), "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="ssuite-${kind}-export.csv"`, "X-Content-Type-Options": "nosniff" } });
}

/** The completion page lives beside the table portal on the same private surface. */
function completionPageUrl(): string {
  const url = new URL(TABLE_PORTAL_URL);
  url.hash = "";
  url.pathname = url.pathname.replace(/[^/]*$/, "complete-registration.html");
  return url.toString();
}

async function completionToken(invitationId: string): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(invitationId) || !TABLE_TOKEN_SECRET) fail("Completion link material is unavailable", 503);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(TABLE_TOKEN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`SSUITE/REGISTRATION-COMPLETION/V1:${invitationId}`)));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

type PreparedCompletion = { invitationId: string; raw: string; created: boolean; email: string; isTableHost: boolean };

/** Issues, or faithfully rebuilds, one person's private finish-registration link, and proves it
 *  opens the record it claims to before anyone is handed it or sent it. */
async function prepareCompletionLink(db: ReturnType<typeof client>, event: string, attendeeId: string): Promise<PreparedCompletion> {
  if (!TABLE_PORTAL_URL || new URL(TABLE_PORTAL_URL).hash) fail("Private links are not configured", 503);

  const attendee = await db.from("attendees").select("id,email,first_name,last_name,registration_status,is_table_lead,table_id")
    .eq("id", attendeeId).eq("event_id", event).maybeSingle();
  if (attendee.error || !attendee.data) fail("That person is not on the guest list");
  if (attendee.data.registration_status === "complete") fail("That person has already completed their registration", 409);
  if (!attendee.data.email) fail("That person has no email address on file");

  const invitationId = crypto.randomUUID();
  const raw = await completionToken(invitationId);
  const issued = await db.rpc("issue_ssuite_registration_completion_link", {
    p_attendee_id: attendeeId, p_invitation_id: invitationId,
    p_token_hash: await sha256(raw), p_token_version: 1, p_expires_at: null,
  });
  if (issued.error || !Array.isArray(issued.data) || issued.data.length !== 1) fail("The completion link could not be prepared", 503);

  const returnedId = String(issued.data[0].invitation_id);
  const created = Boolean(issued.data[0].created);
  const finalRaw = returnedId === invitationId ? raw : await completionToken(returnedId);

  // Prove the link we are about to hand over actually opens the record it claims to.
  const stored = await db.from("invitations").select("token_hash").eq("id", returnedId).maybeSingle();
  if (stored.error || !stored.data || String(stored.data.token_hash) !== (await sha256(finalRaw))) {
    fail("This existing completion link cannot be reconstructed. Revoke it before issuing a replacement.", 409);
  }
  return {
    invitationId: returnedId, raw: finalRaw, created,
    email: String(attendee.data.email), isTableHost: attendee.data.is_table_lead === true,
  };
}

/** Hands staff the private link that lets one person finish their own registration.
 *  Issuing a link sends nothing: delivery stays a separate, deliberate act. */
async function revealRegistrationCompletionLink(body: Json, user: User): Promise<Json> {
  const attendeeId = uuid(body.attendee_id, "Invalid attendee");
  const db = client(); const event = await eventId();
  const prepared = await prepareCompletionLink(db, event, attendeeId);

  const audit = await db.from("ssuite_staff_audit_log").insert({
    event_id: event, actor_user_id: user.id, action: "ssuite_admin_registration_completion_link_revealed",
    entity_type: "attendee", entity_id: attendeeId, metadata: { created: prepared.created, invitation_id: prepared.invitationId, nothing_sent: true },
  });
  if (audit.error) fail("The completion-link audit record could not be saved", 503);

  const url = new URL(completionPageUrl());
  url.hash = `token=${prepared.raw}`;
  return {
    attendee_id: attendeeId, recipient: prepared.email, created: prepared.created,
    is_table_host: prepared.isTableHost,
    completion_url: url.toString(), nothing_sent: true,
  };
}

/** Sends that same link as the S.Suite-branded "Finish your registration" email, through the
 *  ordinary audited outbox. Deliberately a separate action from revealing the link: adding
 *  someone still sends nothing, and staff decide per person whether to email, copy, or do
 *  nothing. The queued row carries identifiers only; the link is rebuilt at send time. */
async function manualGuestEmail(body: Json, user: User, send = false): Promise<Json> {
  const attendeeId = uuid(body.attendee_id, "Invalid attendee");
  const db = client(); const event = await eventId();
  const inspect = await db.rpc("ssuite_admin_manual_guest_email", { p_actor_user_id: user.id, p_event_id: event, p_attendee_id: attendeeId, p_send: false });
  if (inspect.error || !inspect.data) fail("This guest is not eligible for manual registration email or confirmation. Check active allocation and staff provenance.", 400);
  if (!send) return { result: inspect.data };
  if (inspect.data.registration_status === "pending") await prepareCompletionLink(db, event, attendeeId);
  const queued = await db.rpc("ssuite_admin_manual_guest_email", { p_actor_user_id: user.id, p_event_id: event, p_attendee_id: attendeeId, p_send: true });
  if (queued.error || !queued.data) fail("The email could not be queued. Refresh its status before trying again.", 400);
  return { result: queued.data };
}

async function sendRegistrationCompletionEmail(body: Json, user: User): Promise<Json> {
  const attendeeId = uuid(body.attendee_id, "Invalid attendee");
  const db = client(); const event = await eventId();
  const manual = await db.from("attendees").select("order_id,source").eq("id", attendeeId).eq("event_id", event).maybeSingle();
  if (!manual.error && manual.data && !manual.data.order_id && ["complimentary", "staff"].includes(manual.data.source)) return await manualGuestEmail(body, user, true);
  const prepared = await prepareCompletionLink(db, event, attendeeId);

  const queued = await db.rpc("queue_ssuite_email", {
    p_event_id: event,
    p_message_type: "ssuite_finish_registration",
    p_recipient: prepared.email.trim().toLowerCase(),
    p_entity_type: "attendee",
    p_entity_id: attendeeId,
    // Minute granularity: an accidental double click is one email, a deliberate resend later is not.
    p_idempotency_key: `completion:${prepared.invitationId}:${Math.floor(Date.now() / 60000)}`,
    p_payload: { attendee_id: attendeeId, invitation_id: prepared.invitationId },
  });
  if (queued.error) fail("The email could not be queued", 503);

  const audit = await db.from("ssuite_staff_audit_log").insert({
    event_id: event, actor_user_id: user.id, action: "ssuite_admin_registration_completion_email_queued",
    entity_type: "attendee", entity_id: attendeeId,
    metadata: { invitation_id: prepared.invitationId, link_created: prepared.created, recipient: prepared.email },
  });
  if (audit.error) fail("The completion-email audit record could not be saved", 503);

  // Tell staff the truth about when it will actually leave, rather than implying it already has.
  const hold = await db.from("ssuite_email_compliance_holds").select("hold_until").eq("message_type", "ssuite_finish_registration").maybeSingle();
  const heldUntil = hold.data?.hold_until ?? null;

  return {
    attendee_id: attendeeId, recipient: prepared.email, queued: true,
    link_created: prepared.created, held_until: heldUntil,
  };
}

async function revokeRegistrationCompletionLink(body: Json, user: User): Promise<Json> {
  const attendeeId = uuid(body.attendee_id, "Invalid attendee");
  const db = client(); const event = await eventId();
  const attendee = await db.from("attendees").select("id").eq("id", attendeeId).eq("event_id", event).maybeSingle();
  if (attendee.error || !attendee.data) fail("That person is not on the guest list");

  const revoked = await db.rpc("revoke_ssuite_registration_completion_link", { p_attendee_id: attendeeId });
  if (revoked.error) fail("The completion link could not be revoked", 503);

  const audit = await db.from("ssuite_staff_audit_log").insert({
    event_id: event, actor_user_id: user.id, action: "ssuite_admin_registration_completion_link_revoked",
    entity_type: "attendee", entity_id: attendeeId, metadata: { revoked_count: Number(revoked.data ?? 0) },
  });
  if (audit.error) fail("The completion-link audit record could not be saved", 503);
  return { attendee_id: attendeeId, revoked: Number(revoked.data ?? 0) };
}


/* ── Honoree portal responses (read-only) ───────────────────────────────────
   Everything an honoree enters in her private portal lives on ssuite_honorees.
   These views only read it. Headshots are served by short-lived signed links. */
const HONOREE_BUCKET = "ssuite-honoree-headshots";
const HONOREE_COLUMNS = "id,slug,full_name,first_name,honor,headline_title,status,response,headshot_path,headshot_meta,guest_page_url,guest_code,response_deadline,first_opened_at,last_opened_at,open_count,last_saved_at,submitted_at,submission_count,access_revoked_at,created_at,updated_at";
type Contact = { name?: string; email?: string };

async function honoreeRows(includeTests: boolean): Promise<Record<string, any>[]> {
  let query = client().from("ssuite_honorees").select(HONOREE_COLUMNS).order("created_at", { ascending: true }).limit(500);
  if (!includeTests) query = query.not("slug", "like", "test-%");
  const result = await query;
  if (result.error) fail("Honoree responses are unavailable", 503);
  return (result.data ?? []) as Record<string, any>[];
}

function honoreeFlat(h: Record<string, any>): Record<string, unknown> {
  const r = (h.response ?? {}) as Record<string, any>;
  const s = (k: string) => (typeof r[k] === "string" ? r[k] : "");
  const inv = (Array.isArray(r.invitees) ? r.invitees : []) as Contact[];
  const sup = (Array.isArray(r.supporters) ? r.supporters : []) as Contact[];
  const supportPref = (v: string) => v === "mention" ? "SALUTE may reach out directly" : v === "cc" || v === "check" ? "Copy her when reaching out" : "";
  return {
    honoree: h.full_name, honor: h.honor, slug: h.slug,
    portal_status: h.status, response: s("response") === "accept" ? "Accepted" : s("response") === "decline" ? "Declined" : "",
    response_deadline: h.response_deadline, first_opened_at: h.first_opened_at, last_opened_at: h.last_opened_at, open_count: h.open_count,
    last_saved_at: h.last_saved_at, submitted_at: h.submitted_at, submission_count: h.submission_count,
    public_name: s("pubName"), public_title: s("pubTitle"), public_organization: s("pubOrg"),
    bio: s("bio"), bio_words: s("bio") ? s("bio").split(/\s+/).length : 0, pronunciation: s("pron"), social: s("social"),
    team_contact_name: s("teamName"), team_contact_email: s("teamEmail"),
    headshot_on_file: h.headshot_path ? "Yes" : "No",
    meal: s("diet"), allergies_or_dietary_needs: s("access"),
    complimentary_guest: r.guest === true ? "Yes" : "No",
    guest_first_name: s("gFirst"), guest_last_name: s("gLast"), guest_email: s("gEmail"), guest_title: s("gTitle"), guest_organization: s("gOrg"),
    guest_meal: s("gMeal"), guest_allergies_or_dietary_needs: s("gAccess"),
    guest_details_sent_by: s("gMode") === "salute" ? "SALUTE (copy her)" : s("gMode") === "self" ? "Honoree" : "",
    additional_guests_count: inv.length,
    additional_guests_invited_by: s("inviteMode") === "salute" ? "SALUTE on her behalf (copy her)" : s("inviteMode") === "self" ? "Honoree" : "",
    potential_supporters_count: sup.length, supporter_outreach: supportPref(s("supportMode")),
    table_status: s("tableStatus"), table_order: s("tableRef"),
    table_contact: [[s("tFirst"), s("tLast")].join(" ").trim(), s("tEmail"), s("tPhone")].filter(Boolean).join(" · "),
    decline_note: s("declineNote"),
    handed_to: r.handoff === true ? [s("hoName"), s("hoEmail")].filter(Boolean).join(" · ") : "",
    personal_invitation_page: h.guest_page_url, guest_code: h.guest_code,
  };
}

async function listHonorees(body: Json): Promise<Json> {
  const rows = await honoreeRows(body.include_tests === true);
  const db = client();
  const ids = rows.map((h) => h.id);
  const activity = ids.length
    ? await db.from("ssuite_honoree_activity").select("honoree_id,action,created_at").in("honoree_id", ids).order("created_at", { ascending: false }).limit(1000)
    : { data: [], error: null };
  if (activity.error) fail("Honoree activity is unavailable", 503);
  const data = [];
  for (const h of rows) {
    let headshot: Json | null = null;
    if (h.headshot_path) {
      const ext = String(h.headshot_path).split(".").pop() || "jpg";
      const [view, download] = await Promise.all([
        db.storage.from(HONOREE_BUCKET).createSignedUrl(h.headshot_path, 3600),
        db.storage.from(HONOREE_BUCKET).createSignedUrl(h.headshot_path, 3600, { download: `${h.slug}-headshot.${ext}` }),
      ]);
      headshot = { view_url: view.data?.signedUrl ?? null, download_url: download.data?.signedUrl ?? null, meta: h.headshot_meta ?? null };
    }
    const r = (h.response ?? {}) as Record<string, any>;
    data.push({
      ...honoreeFlat(h),
      id: h.id,
      invitees: Array.isArray(r.invitees) ? r.invitees : [],
      supporters: Array.isArray(r.supporters) ? r.supporters : [],
      headshot,
      activity: (activity.data ?? []).filter((a: any) => a.honoree_id === h.id).slice(0, 25).map((a: any) => ({ action: a.action, at: a.created_at })),
    });
  }
  return { data, total: data.length };
}

async function exportHonorees(kind: string, origin: string | null): Promise<Response> {
  const rows = await honoreeRows(false);
  let columns: string[] = []; let out: Record<string, unknown>[] = [];
  if (kind === "honorees") {
    out = rows.map(honoreeFlat);
    columns = out.length ? Object.keys(out[0]) : Object.keys(honoreeFlat({ response: {} }));
  } else {
    columns = ["honoree", "honor", "list", "name", "email", "contact_preference"];
    for (const h of rows) {
      const f = honoreeFlat(h); const r = (h.response ?? {}) as Record<string, any>;
      if (r.guest === true && r.gEmail) out.push({ honoree: h.full_name, honor: h.honor, list: "Complimentary guest", name: [r.gFirst, r.gLast].filter(Boolean).join(" "), email: r.gEmail, contact_preference: f.guest_details_sent_by });
      for (const c of (Array.isArray(r.invitees) ? r.invitees : []) as Contact[]) out.push({ honoree: h.full_name, honor: h.honor, list: "Additional guest ($300)", name: c.name ?? "", email: c.email ?? "", contact_preference: f.additional_guests_invited_by });
      for (const c of (Array.isArray(r.supporters) ? r.supporters : []) as Contact[]) out.push({ honoree: h.full_name, honor: h.honor, list: "Potential supporter", name: c.name ?? "", email: c.email ?? "", contact_preference: f.supporter_outreach });
    }
  }
  const csv = [columns.map(csvCell).join(","), ...out.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n");
  return new Response("\ufeff" + csv, { headers: { ...cors(origin), "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="ssuite-${kind.replace("_", "-")}.csv"`, "X-Content-Type-Options": "nosniff" } });
}

async function listPartners(): Promise<Json> {
  const event = await eventId();
  const result = await client().rpc("ssuite_admin_list_partner_profiles", { p_event_id: event });
  if (result.error || !Array.isArray(result.data)) fail("Partner records are unavailable", 503);
  return { data: result.data, total: result.data.length, page: 1, limit: result.data.length, has_more: false };
}

async function partnerLogo(body: Json): Promise<Json> {
  const profileId = typeof body.profile_id === "string" ? body.profile_id.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileId)) fail("A valid partner profile is required");
  const event = await eventId();
  const db = client();
  const pathResult = await db.rpc("ssuite_admin_partner_logo_path", { p_event_id: event, p_profile_id: profileId });
  if (pathResult.error) fail("Private logo is unavailable", 503);
  if (typeof pathResult.data !== "string" || !pathResult.data) fail("No private logo is recorded for this partner", 404);
  const signed = await db.storage.from("ssuite-partner-logos").createSignedUrl(pathResult.data, 600);
  if (signed.error || !signed.data?.signedUrl) fail("Private logo link could not be prepared", 503);
  return { signed_url: signed.data.signedUrl, expires_in_seconds: 600 };
}

async function route(body: Json, origin: string | null, user: User): Promise<Response> {
  const action = typeof body.action === "string" ? body.action : "";
  if (action === "overview") return json(await overview(), 200, origin);
  if (action === "orders") return json(await listOrders(body), 200, origin);
  if (action === "attendees") return json(await listAttendees(body), 200, origin);
  if (action === "invitation_requests") return json(await listInvitationRequests(body), 200, origin);
  if (action === "invitation_request_decide") return json(await decideInvitationRequest(body, user), 200, origin);
  if (action === "invitation_send") return json(await sendInvitationEmail(body, user), 200, origin);
  if (action === "member_code_requests") return json(await listMemberCodeRequests(body), 200, origin);
  if (action === "member_code_request_decide") return json(await decideMemberCodeRequest(body, user), 200, origin);
  if (action === "member_code_resend") return json(await resendMemberCode(body, user), 200, origin);
  if (action === "attendee_detail") return json(await attendeeDetail(body), 200, origin);
  if (action === "attendee_update") return json(await updateAttendee(body, user), 200, origin);
  if (action === "attendee_photo_set") return json(await setAttendeePhoto(body, user), 200, origin);
  if (action === "eligible_paid_table_orders") return json(await eligiblePaidTableOrders(user), 200, origin);
  if (action === "admin_unseated_attendees") return json(await unseatedAdminAttendees(user), 200, origin);
  if (action === "manual_guest_email_status") return json(await manualGuestEmail(body, user), 200, origin);
  if (action === "manual_guest_email_send") return json(await manualGuestEmail(body, user, true), 200, origin);
  if (action === "admin_allocated_host_create") return json(await createAdminAllocatedHost(body, user), 200, origin);
  if (action === "admin_table_create") return json(await createAdminTable(body, user), 200, origin);
  if (action === "admin_attendee_create") return json(await createAdminAttendee(body, user), 200, origin);
  if (action === "admin_table_update") return json(await updateAdminTable(body, user), 200, origin);
  if (action === "admin_seat_set") return json(await setAdminSeat(body, user), 200, origin);
  if (action === "admin_table_lead_set") return json(await setAdminLead(body, user), 200, origin);
  if (action === "table_management_link_reveal") return json(await revealTableManagementLink(body, user), 200, origin);
  if (action === "registration_completion_link_reveal") return json(await revealRegistrationCompletionLink(body, user), 200, origin);
  if (action === "registration_completion_link_revoke") return json(await revokeRegistrationCompletionLink(body, user), 200, origin);
  if (action === "registration_completion_send") return json(await sendRegistrationCompletionEmail(body, user), 200, origin);
  if (action === "tables") return json(await listTables(body), 200, origin);
  if (action === "partners") return json(await listPartners(), 200, origin);
  if (action === "partner_logo") return json(await partnerLogo(body), 200, origin);
  if (action === "email") return json(await listEmail(body), 200, origin);
  if (action === "auction") return json(await listAuction(body), 200, origin);
  if (action === "donations") return json(await listDonations(body), 200, origin);
  if (action === "ambassadors") return json(await listAmbassadors(body), 200, origin);
  if (action === "audit") return json(await listAudit(), 200, origin);
  if (action === "honorees") return json(await listHonorees(body), 200, origin);
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
