import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const APPROVED_EMAIL = "ssuite@salute.community";
const config = window.SSUITE_ADMIN_CONFIG || {};
const $ = (id) => document.getElementById(id);
let supabase = null;
let session = null;
let activeTab = "overview";
let currentPage = 1;
let lastSearch = "";

function configured() {
  try {
    const url = new URL(String(config.supabaseUrl || ""));
    const api = new URL(String(config.apiBase || config.supabaseUrl || ""));
    return url.protocol === "https:" && api.protocol === "https:" && typeof config.supabaseAnonKey === "string" && config.supabaseAnonKey.length > 30;
  } catch { return false; }
}
function apiBase() { return new URL(String(config.apiBase || config.supabaseUrl)).origin; }
function authStatus(message, kind = "") { const node = $("auth-status"); node.textContent = message; node.className = `notice ${kind}`; }
function status(message, kind = "") { const node = $("dashboard-status"); node.textContent = message; node.className = `notice ${kind}`; }
function cleanAuthUrl() { if (location.hash.includes("access_token") || location.hash.includes("refresh_token") || new URLSearchParams(location.search).has("code")) history.replaceState(null, "", location.pathname); }
function setBusy(button, value) { button.disabled = value; }
function money(cents, currency = "usd") { return new Intl.NumberFormat("en-US", { style: "currency", currency: String(currency).toUpperCase() }).format((Number(cents) || 0) / 100); }
function date(value) { return value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—"; }
function chip(value) { const span = document.createElement("span"); const normalized = String(value || "unknown").toLowerCase().replaceAll(" ", "_"); span.className = `chip ${normalized}`; span.textContent = String(value || "unknown").replaceAll("_", " "); return span; }
function text(value) { return value === null || value === undefined || value === "" ? "—" : String(value); }
function clear(node) { node.replaceChildren(); }
function element(tag, className, value) { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; }

async function initialize() {
  if (!configured()) {
    $("send-link").disabled = true; $("verify-code").disabled = true;
    authStatus("Private sign-in is unavailable until the deployment supplies the public Supabase URL, anon key, and API base URL.", "error");
    return;
  }
  supabase = createClient(String(config.supabaseUrl), String(config.supabaseAnonKey), { auth: { persistSession: true, storage: window.sessionStorage, autoRefreshToken: true, detectSessionInUrl: true } });
  supabase.auth.onAuthStateChange((_event, nextSession) => { if (nextSession) openDashboard(nextSession); });
  const { data } = await supabase.auth.getSession();
  if (data.session) await openDashboard(data.session);
  else authStatus("Use the locked email address to request a private passwordless sign-in.");
}

async function openDashboard(nextSession) {
  if (!nextSession?.access_token) return;
  session = nextSession; cleanAuthUrl();
  try {
    await call({ action: "overview" });
    $("auth-shell").hidden = true; $("workspace").hidden = false; $("sign-out").hidden = false;
    await loadTab("overview");
  } catch (error) {
    session = null;
    authStatus(error.message || "This account is not authorized for S.Suite administration.", "error");
    await supabase?.auth.signOut();
  }
}

async function call(body, expectCsv = false) {
  if (!session?.access_token) throw new Error("Your private session has expired. Sign in again.");
  const response = await fetch(`${apiBase()}/functions/v1/admin-api`, {
    method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  });
  if (expectCsv) {
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || "The export could not be created."); }
    return response.blob();
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "The private dashboard is unavailable.");
  return payload;
}

async function sendLink(event) {
  event.preventDefault(); if (!supabase || !configured()) return;
  const button = $("send-link"); setBusy(button, true); authStatus("Requesting a passwordless sign-in link…");
  try {
    const { error } = await supabase.auth.signInWithOtp({ email: APPROVED_EMAIL, options: { emailRedirectTo: `${location.origin}${location.pathname}` } });
    if (error) throw error;
    authStatus("If the approved mailbox is available, a private sign-in link or code has been sent. It does not grant access until server authorization succeeds.", "success");
  } catch { authStatus("The private sign-in link could not be requested. Check deployment configuration and try again.", "error"); }
  finally { setBusy(button, false); }
}

async function verifyCode(event) {
  event.preventDefault(); if (!supabase) return;
  const token = $("otp-code").value.trim();
  if (!/^[a-zA-Z0-9]{6,12}$/.test(token)) return authStatus("Enter the one-time code from the approved S.Suite sign-in email.", "error");
  const button = $("verify-code"); setBusy(button, true); authStatus("Verifying one-time code…");
  try {
    const { data, error } = await supabase.auth.verifyOtp({ email: APPROVED_EMAIL, token, type: "email" });
    if (error || !data.session) throw error || new Error("No session");
    $("otp-code").value = ""; await openDashboard(data.session);
  } catch { authStatus("That one-time code could not be verified. Request a new private sign-in email.", "error"); }
  finally { setBusy(button, false); }
}

function tabMeta(tab) {
  return ({ overview: ["Private dashboard", "Overview"], orders: ["Commerce records", "Orders"], attendees: ["Guest book", "Attendees"], tables: ["Seating operations", "Tables"], email: ["Delivery ledger", "Email delivery"], auction: ["Submitted items", "Auction"], donations: ["Giving ledger", "Donations"], audit: ["Append-only activity", "Audit"] })[tab];
}
async function loadTab(tab, page = 1, search = "") {
  activeTab = tab; currentPage = page; lastSearch = search;
  for (const button of document.querySelectorAll("#tabs button")) button.classList.toggle("active", button.dataset.tab === tab);
  const [kicker, title] = tabMeta(tab); $("section-kicker").textContent = kicker; $("section-title").textContent = title;
  clear($("dashboard-content")); status("Loading private data…");
  try {
    const body = { action: tab, page, limit: 50, search };
    const payload = await call(body);
    render(tab, payload); status("");
  } catch (error) { status(error.message || "Unable to load this private view.", "error"); }
}

function render(tab, payload) {
  const host = $("dashboard-content"); clear(host);
  if (tab === "overview") return renderOverview(host, payload.overview);
  if (tab === "tables") return renderTables(host, payload);
  if (tab === "audit") return renderAudit(host, payload);
  const searchable = ["orders", "attendees", "email", "auction", "donations"].includes(tab);
  if (searchable) host.append(searchToolbar(tab));
  const configByTab = {
    orders: [["Purchaser", (r) => `${text(r.purchaser_first_name)} ${text(r.purchaser_last_name)}`], ["Email", "purchaser_email"], ["Type", "order_type"], ["Total", (r) => money(r.total_cents, r.currency)], ["Status", "status"], ["Paid", (r) => date(r.paid_at)]],
    attendees: [["Name", (r) => `${text(r.first_name)} ${text(r.last_name)}`], ["Email", "email"], ["Organization", "company"], ["Registration", "registration_status"], ["Source", "source"], ["Completed", (r) => date(r.completed_at)]],
    email: [["Recipient", "recipient"], ["Message", "message_type"], ["Status", "status"], ["Attempts", "attempt_count"], ["Accepted", (r) => date(r.accepted_at)], ["Delivered", (r) => date(r.delivered_at)]],
    auction: [["Donor", "name"], ["Email", "normalized_email"], ["Company", "company"], ["Estimated value", (r) => money(r.estimated_value_cents)], ["Review", "review_status"], ["Received", (r) => date(r.created_at)]],
    donations: [["Donor", "donor_name"], ["Email", "normalized_email"], ["Amount", (r) => money(r.received_amount_cents ?? r.amount_cents, r.currency)], ["Mode", "donation_mode"], ["Status", "status"], ["Received", (r) => date(r.paid_at || r.created_at)]],
  };
  renderDataTable(host, payload, configByTab[tab] || [], tab === "attendees");
  if (["orders", "attendees", "donations"].includes(tab)) host.append(exportButton(tab));
}

function renderOverview(host, overview) {
  const event = overview.event || {}; const counts = overview.counts || {};
  if (overview.notice) host.append(element("p", "notice", overview.notice));
  const eventCard = element("article", "event-card"); eventCard.append(element("span", "record-label", "Launch status"), element("h2", "", text(event.name)), element("p", "", `${text(event.display_date)} · ${text(event.venue_name)}, ${text(event.city)}`), chip(event.sales_status)); host.append(eventCard);
  const fields = [["Operational paid orders", counts.paid_orders], ["Registered guests", counts.attendees], ["Completed profiles", counts.completed_attendees], ["Checked in", counts.checked_in], ["Active tables", counts.tables], ["Email queued", counts.email_queued], ["Auction pending", counts.auction_pending], ["Donations received", money(counts.donations_paid_cents)]];
  const grid = element("div", "summary"); for (const [label, value] of fields) { const card = element("article", "metric"); card.append(element("span", "", label), element("strong", "", String(value ?? 0))); grid.append(card); } host.append(grid);
  const note = element("p", "fineprint", "Sales status is shown for visibility only. This dashboard intentionally provides no control to open sales, release holds, send communications, or process money."); host.append(note);
}

function searchToolbar(tab) {
  const form = element("form", "toolbar"); const input = document.createElement("input"); input.type = "search"; input.placeholder = `Search ${tab}…`; input.value = lastSearch; input.maxLength = 80; input.setAttribute("aria-label", `Search ${tab}`);
  const submit = element("button", "button dark", "Search"); submit.type = "submit"; const reset = element("button", "button outline", "Clear"); reset.type = "button";
  form.append(input, submit, reset); form.addEventListener("submit", (event) => { event.preventDefault(); loadTab(tab, 1, input.value.trim()); }); reset.addEventListener("click", () => loadTab(tab)); return form;
}

function renderDataTable(host, payload, columns, attendeeRows) {
  if (!payload.data?.length) { host.append(element("p", "empty", "No records match this bounded private view.")); return; }
  const wrap = element("div", "table-wrap"); const table = document.createElement("table"); const thead = document.createElement("thead"); const headRow = document.createElement("tr");
  for (const [label] of columns) headRow.append(element("th", "", label)); thead.append(headRow); table.append(thead); const body = document.createElement("tbody");
  for (const row of payload.data) { const tr = document.createElement("tr"); if (attendeeRows) { tr.dataset.attendeeId = row.id; tr.tabIndex = 0; tr.addEventListener("click", () => showAttendee(row.id)); tr.addEventListener("keydown", (event) => { if (event.key === "Enter") showAttendee(row.id); }); }
    for (const [, getter] of columns) { const td = document.createElement("td"); const value = typeof getter === "function" ? getter(row) : row[getter]; if (["status", "registration_status", "review_status"].includes(getter)) td.append(chip(value)); else td.textContent = text(value); tr.append(td); } body.append(tr); }
  table.append(body); wrap.append(table); host.append(wrap); host.append(pagination(payload));
}

function pagination(payload) { const row = element("div", "pagination"); row.append(element("span", "", `Showing page ${payload.page} of ${Math.max(1, Math.ceil(payload.total / payload.limit))} · ${payload.total} records`)); const controls = element("div", "pager-controls"); const previous = element("button", "quiet", "Previous"); previous.disabled = payload.page <= 1; previous.addEventListener("click", () => loadTab(activeTab, payload.page - 1, lastSearch)); const next = element("button", "quiet", "Next"); next.disabled = !payload.has_more; next.addEventListener("click", () => loadTab(activeTab, payload.page + 1, lastSearch)); controls.append(previous, next); row.append(controls); return row; }

function invitationLabel(seat) {
  const invite = seat.invitation; const delivery = invite?.delivery;
  if (!invite) return "Not invited";
  if (invite.revoked_at || invite.status === "revoked") return "Revoked";
  if (delivery?.bounced_at || delivery?.status === "bounced") return "Bounced";
  if (delivery?.suppressed_at || delivery?.status === "suppressed") return "Suppressed";
  if (delivery?.delivered_at || delivery?.status === "delivered") return "Delivered";
  if (delivery?.accepted_at || delivery?.status === "accepted") return "Accepted by provider";
  if (invite.first_sent_at || Number(invite.send_count) > 0) return "Sent";
  return "Prepared — not sent";
}
function renderTables(host, payload) {
  if (!payload.data?.length) { host.append(element("p", "empty", "No authoritative operational table records are available.")); return; }
  const list = element("div", "table-list");
  for (const table of payload.data || []) {
    const card = element("article", "table-card roster-card");
    const heading = element("div", "table-heading");
    const title = element("div");
    title.append(element("span", "record-label", table.table_number ? `Table ${table.table_number}` : "Table number not assigned"), element("h3", "", text(table.name || "Unassigned table")));
    const occupied = (table.table_seats || []).filter((seat) => seat.attendee_id).length;
    const meta = element("div", "table-meta"); meta.append(chip(table.status), element("strong", "", `${occupied} of ${table.seat_count || table.table_seats?.length || 0} seats named`));
    heading.append(title, meta); card.append(heading);

    const lead = (table.table_seats || []).find((seat) => seat.attendee?.is_table_lead)?.attendee;
    const access = table.lead_access; const accessDelivery = access?.delivery;
    let accessLabel = "No management credential";
    if (access) accessLabel = access.revoked_at || access.status === "revoked" ? "Management access revoked" : accessDelivery?.delivered_at ? "Management access delivered" : accessDelivery?.accepted_at ? "Management access accepted by provider" : "Management access held — not sent";
    const leadLine = element("p", "lead-line", `Table lead: ${lead ? `${text(lead.first_name)} ${text(lead.last_name)} · ${text(lead.email)}` : "Not assigned"} · ${accessLabel}`);
    card.append(leadLine);

    const wrap = element("div", "table-wrap roster-wrap"); const roster = document.createElement("table");
    const thead = document.createElement("thead"); const hr = document.createElement("tr");
    for (const label of ["Seat", "Guest", "Email", "Organization / title", "Registration", "Invitation", "Last activity", "Action"]) hr.append(element("th", "", label));
    thead.append(hr); roster.append(thead); const tbody = document.createElement("tbody");
    for (const seat of table.table_seats || []) {
      const tr = document.createElement("tr"); const attendee = seat.attendee; const invite = seat.invitation; const delivery = invite?.delivery;
      const guestName = attendee ? `${text(attendee.first_name)} ${text(attendee.last_name)}${attendee.is_table_lead ? " · Lead" : ""}` : seat.locked ? "Locked" : "Open";
      const recipient = attendee?.email || invite?.recipient_email || "—";
      const organization = attendee ? [attendee.company, attendee.job_title].filter(Boolean).join(" · ") || "—" : "—";
      const registration = attendee?.registration_status || (invite ? "Invited — not registered" : "Open");
      const inviteStatus = invitationLabel(seat);
      const activity = delivery?.delivered_at || delivery?.accepted_at || invite?.last_sent_at || invite?.first_sent_at || attendee?.completed_at || "";
      const values = [seat.seat_number, guestName, recipient, organization, registration, inviteStatus, activity ? date(activity) : "—"];
      values.forEach((value, index) => { const td = document.createElement("td"); if (index === 4 || index === 5) td.append(chip(value)); else td.textContent = text(value); tr.append(td); });
      const action = document.createElement("td");
      if (attendee) { const edit = element("button", "quiet compact", "View / edit"); edit.type = "button"; edit.addEventListener("click", () => showAttendee(attendee.id)); action.append(edit); }
      else action.textContent = "—";
      tr.append(action); tbody.append(tr);
    }
    roster.append(tbody); wrap.append(roster); card.append(wrap, element("p", "fineprint", "Invitation and delivery statuses are read from the private invitation and email ledgers. Secure links and token values are never displayed.")); list.append(card);
  }
  host.append(list); host.append(pagination(payload));
}
function renderAudit(host, payload) { host.append(element("p", "fineprint", payload.note || "Bounded audit view.")); for (const item of payload.data || []) { const row = element("article", "audit-item"); row.append(element("strong", "", `${text(item.action)} · ${text(item.entity_type)}`), element("span", "", `${date(item.occurred_at)} · ${text(item.log)} log · ${text(item.actor_type || item.actor_user_id)}`)); host.append(row); } if (!payload.data?.length) host.append(element("p", "empty", "No audit records are available.")); }
function exportButton(kind) { const button = element("button", "button outline", `Download ${kind} CSV (max 5,000)`); button.type = "button"; button.addEventListener("click", async () => { setBusy(button, true); status("Preparing secure CSV export…"); try { const blob = await call({ action: "export", kind }, true); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `ssuite-${kind}-export.csv`; link.click(); URL.revokeObjectURL(link.href); status("CSV export downloaded.", "success"); } catch (error) { status(error.message || "Export failed.", "error"); } finally { setBusy(button, false); } }); return button; }

function formField(labelText, name, value = "", options = {}) {
  const label = document.createElement("label"); label.textContent = labelText;
  const control = options.multiline ? document.createElement("textarea") : document.createElement("input");
  control.name = name; control.value = value ?? ""; control.maxLength = options.max || (options.multiline ? 2000 : 320);
  if (!options.multiline) control.type = options.type || "text";
  if (options.required) control.required = true;
  if (options.autocomplete) control.autocomplete = options.autocomplete;
  label.append(control); return label;
}

function renderAttendeeDetail(payload, message = "") {
  const a = payload.attendee; const n = payload.needs; const host = $("attendee-detail"); clear(host);
  host.append(element("p", "eyebrow", "Restricted attendee record"));
  const title = element("h2", "", `${text(a.first_name)} ${text(a.last_name)}`); title.id = "attendee-title"; host.append(title);
  if (message) host.append(element("p", "notice success", message));
  const grid = element("div", "detail-grid");
  for (const [label, value] of [["Email", a.email], ["Phone", a.phone], ["Organization", a.company], ["Title", a.job_title], ["Registration", a.registration_status], ["Table", a.event_tables?.table_number]]) { const cell = document.createElement("div"); cell.append(element("span", "record-label", label), element("b", "", text(value))); grid.append(cell); }
  host.append(grid);
  const needs = element("section", "detail-section sensitive"); needs.append(element("h3", "", "Meal & access needs"), element("small", "", "Sensitive operational information — visible only after approved-admin server authorization."), element("p", "", n ? `Meal: ${text(n.meal_preference)}\nDietary/allergy: ${n.has_dietary_or_allergy_needs ? text(n.dietary_or_allergy_details) : "None reported"}\nAccessibility: ${n.has_accessibility_needs ? text(n.accessibility_details) : "None reported"}` : "No needs record.")); host.append(needs);
  const consent = element("section", "detail-section"); consent.append(element("h3", "", "Recorded consent"), element("p", "", payload.consents?.length ? payload.consents.map((c) => `${text(c.scope)} · accepted ${date(c.accepted_at)} · terms ${text(c.terms_version)}`).join("\n") : "No attendee-specific consent record.")); host.append(consent);
  const edit = element("button", "button dark", "Edit attendee information"); edit.type = "button"; edit.addEventListener("click", () => renderAttendeeEdit(payload)); host.append(edit);
}

function renderAttendeeEdit(payload) {
  const a = payload.attendee; const n = payload.needs || {}; const host = $("attendee-detail"); clear(host);
  host.append(element("p", "eyebrow", "Protected staff edit")); const title = element("h2", "", `Edit ${text(a.first_name)} ${text(a.last_name)}`); title.id = "attendee-title"; host.append(title);
  host.append(element("p", "fineprint", "Saving updates the authoritative attendee record and writes an audit entry. It does not change payment, consent, registration status, table access, or send an email."));
  const form = element("form", "attendee-edit");
  const fields = element("div", "edit-grid");
  fields.append(
    formField("First name", "first_name", a.first_name, { required: true, max: 200, autocomplete: "given-name" }),
    formField("Last name", "last_name", a.last_name, { required: true, max: 200, autocomplete: "family-name" }),
    formField("Primary email", "email", a.email, { required: true, type: "email", autocomplete: "email" }),
    formField("Secondary email (optional)", "secondary_email", a.secondary_email, { type: "email" }),
    formField("Phone (optional)", "phone", a.phone, { type: "tel", max: 100, autocomplete: "tel" }),
    formField("Job title", "job_title", a.job_title, { required: true, max: 300 }),
    formField("Company", "company", a.company, { required: true, max: 300 }),
    formField("Meal preference", "meal_preference", n.meal_preference, { required: true, max: 200 })
  ); form.append(fields);
  function needsField(labelText, checkboxName, checked, detailName, detailValue, detailLabel) {
    const section = element("fieldset", "need-field"); const label = document.createElement("label"); const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.name = checkboxName; checkbox.checked = Boolean(checked); label.append(checkbox, document.createTextNode(labelText)); const detail = formField(detailLabel, detailName, detailValue, { multiline: true, max: 2000 }); detail.hidden = !checkbox.checked; detail.querySelector("textarea").required = checkbox.checked; checkbox.addEventListener("change", () => { detail.hidden = !checkbox.checked; detail.querySelector("textarea").required = checkbox.checked; if (!checkbox.checked) detail.querySelector("textarea").value = ""; }); section.append(label, detail); return section;
  }
  form.append(needsField("Dietary or allergy needs", "has_dietary_or_allergy_needs", n.has_dietary_or_allergy_needs, "dietary_or_allergy_details", n.dietary_or_allergy_details, "Required details"));
  form.append(needsField("Accessibility needs", "has_accessibility_needs", n.has_accessibility_needs, "accessibility_details", n.accessibility_details, "Required details"));
  form.append(formField("Internal change note", "change_reason", "", { required: true, max: 500, multiline: true }));
  const formStatus = element("p", "notice"); formStatus.setAttribute("role", "status"); form.append(formStatus);
  const actions = element("div", "dialog-actions"); const cancel = element("button", "button outline", "Cancel"); cancel.type = "button"; cancel.addEventListener("click", () => renderAttendeeDetail(payload)); const save = element("button", "button dark", "Save audited changes"); save.type = "submit"; actions.append(cancel, save); form.append(actions);
  form.addEventListener("submit", async (event) => { event.preventDefault(); if (!form.reportValidity()) return; setBusy(save, true); formStatus.textContent = "Saving protected attendee information…"; formStatus.className = "notice"; const data = new FormData(form); const record = Object.fromEntries(data.entries()); record.has_dietary_or_allergy_needs = data.has("has_dietary_or_allergy_needs"); record.has_accessibility_needs = data.has("has_accessibility_needs"); try { const updated = await call({ action: "attendee_update", attendee_id: a.id, record }); renderAttendeeDetail(updated, "Attendee information saved. No email or access link was sent."); if (["attendees", "tables"].includes(activeTab)) loadTab(activeTab, currentPage, lastSearch); } catch (error) { formStatus.textContent = error.message || "The attendee update could not be saved."; formStatus.className = "notice error"; } finally { setBusy(save, false); } });
  host.append(form);
}

async function showAttendee(id) { status("Loading attendee detail…"); try { const payload = await call({ action: "attendee_detail", attendee_id: id }); renderAttendeeDetail(payload); if (!$("attendee-dialog").open) $("attendee-dialog").showModal(); status(""); } catch (error) { status(error.message || "Attendee detail is unavailable.", "error"); } }

$("magic-form").addEventListener("submit", sendLink); $("otp-form").addEventListener("submit", verifyCode); $("refresh").addEventListener("click", () => loadTab(activeTab, currentPage, lastSearch)); $("tabs").addEventListener("click", (event) => { const button = event.target.closest("button[data-tab]"); if (button) loadTab(button.dataset.tab); }); $("sign-out").addEventListener("click", async () => { await supabase?.auth.signOut(); session = null; $("workspace").hidden = true; $("auth-shell").hidden = false; $("sign-out").hidden = true; authStatus("Signed out of private administration."); }); $("attendee-dialog").querySelector(".close").addEventListener("click", () => $("attendee-dialog").close());
initialize().catch(() => authStatus("Private sign-in is unavailable. Check deployment configuration.", "error"));
