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
function recordTypeLabel(value) { return ({ complimentary: "Complimentary", sponsor: "Sponsor", honoree: "Honoree", staff: "Staff", pre_existing_paid: "Existing paid purchase" })[value] || text(value).replaceAll("_", " "); }
function clear(node) { node.replaceChildren(); }
function element(tag, className, value) { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; }

async function initialize() {
  if (!configured()) {
    $("send-link").disabled = true;
    $("request-code").disabled = true;
    $("verify-code").disabled = true;
    authStatus("Private sign-in is unavailable until the deployment supplies the public Supabase URL, anon key, and API base URL.", "error");
    return;
  }
  // Keep the administrator session in memory only; never write auth material to browser storage.
  supabase = createClient(String(config.supabaseUrl), String(config.supabaseAnonKey), { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: true } });
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

async function uploadAttendeePhoto(attendeeId, file) {
  if (!(file instanceof File) || !file.size) return null;
  if (file.size > 5 * 1024 * 1024) throw new Error("Guest photo must be 5 MB or smaller.");
  const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const extension = extensions[file.type];
  if (!extension) throw new Error("Guest photo must be JPG, PNG, or WebP.");
  const path = `${attendeeId}/${crypto.randomUUID()}.${extension}`;
  const upload = await supabase.storage.from("ssuite-attendee-photos").upload(path, file, { contentType: file.type, upsert: false, cacheControl: "3600" });
  if (upload.error) throw new Error("The private guest photo could not be uploaded.");
  try { return await call({ action: "attendee_photo_set", attendee_id: attendeeId, photo_path: path }); }
  catch (error) { await supabase.storage.from("ssuite-attendee-photos").remove([path]); throw error; }
}
function photoField() {
  const label = document.createElement("label"); label.textContent = "Guest photo (optional · JPG, PNG, or WebP · max 5 MB)";
  const input = document.createElement("input"); input.type = "file"; input.name = "guest_photo"; input.accept = "image/jpeg,image/png,image/webp"; label.append(input); return label;
}

async function requestCode() {
  if (!supabase || !configured()) return;
  const button = $("request-code"); setBusy(button, true); authStatus("Requesting a one-time email code…");
  try {
    // Omitting emailRedirectTo requests the numeric OTP rather than a magic link.
    const { error } = await supabase.auth.signInWithOtp({ email: APPROVED_EMAIL });
    if (error) throw error;
    authStatus("If the approved mailbox is available, a one-time code has been sent. It does not grant access until server authorization succeeds.", "success");
    $("admin-otp").focus();
  } catch { authStatus("The one-time email code could not be requested. Check deployment configuration and try again.", "error"); }
  finally { setBusy(button, false); }
}

async function verifyCode(event) {
  event.preventDefault(); if (!supabase || !configured()) return;
  const form = event.currentTarget; if (!form.reportValidity()) return;
  const button = $("verify-code"); setBusy(button, true); authStatus("Verifying the one-time email code…");
  try {
    const { data, error } = await supabase.auth.verifyOtp({ email: APPROVED_EMAIL, token: $("admin-otp").value.trim(), type: "email" });
    if (error) throw error;
    if (!data?.session) throw new Error("The one-time code did not create a session.");
    await openDashboard(data.session);
  } catch { authStatus("The one-time email code could not be verified. Request a fresh code and try again.", "error"); }
  finally { setBusy(button, false); }
}

async function sendLink(event) {
  event.preventDefault(); if (!supabase || !configured()) return;
  const button = $("send-link"); setBusy(button, true); authStatus("Requesting a passwordless sign-in link…");
  try {
    const { error } = await supabase.auth.signInWithOtp({ email: APPROVED_EMAIL, options: { emailRedirectTo: `${location.origin}${location.pathname}` } });
    if (error) throw error;
    authStatus("If the approved mailbox is available, a private sign-in link has been sent. It does not grant access until server authorization succeeds.", "success");
  } catch { authStatus("The private sign-in link could not be requested. Check deployment configuration and try again.", "error"); }
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
  if (tab === "attendees") host.append(adminAttendeeButton());
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
  const create = element("button", "button dark admin-action", "Add ten-seat table"); create.type = "button"; create.addEventListener("click", tableCreateForm); host.append(create, element("p", "fineprint", "Staff-created records stay incomplete until the guest finishes registration. Nothing is emailed or sent, and no payment, consent, access, or secure link is created."));
  if (!payload.data?.length) { host.append(element("p", "empty", "No authoritative operational table records are available.")); return; }
  const list = element("div", "table-list");
  for (const table of payload.data || []) {
    const card = element("details", "table-card roster-card");
    const heading = element("summary", "table-heading");
    const title = element("div");
    title.append(element("span", "record-label", table.table_number ? `Table ${table.table_number}` : "Table number not assigned"), element("h3", "", text(table.name || "Unassigned table")));
    const occupied = (table.table_seats || []).filter((seat) => seat.attendee_id).length;
    const meta = element("div", "table-meta"); meta.append(chip(table.status), element("strong", "", `${occupied} of ${table.seat_count || table.table_seats?.length || 0} seats named`));
    heading.append(title, meta); card.append(heading);
    const controls = element("div", "table-controls"); const add = element("button", "quiet compact", "Add guest record"); add.type = "button"; add.addEventListener("click", () => { const open = (table.table_seats || []).find((seat) => !seat.attendee_id && !seat.locked); if (!open) return status("There is no open seat on this table.", "error"); attendeeCreateForm(table, open.seat_number); }); const editTable = element("button", "quiet compact", table.table_number ? "Change table number / name" : "Assign table number"); editTable.type = "button"; editTable.addEventListener("click", () => tableEditForm(table)); const leadButton = element("button", "quiet compact", "Set table lead"); leadButton.type = "button"; leadButton.addEventListener("click", () => setLeadForm(table)); controls.append(editTable, add, leadButton); card.append(controls);

    const lead = (table.table_seats || []).find((seat) => seat.attendee?.is_table_lead)?.attendee;
    const access = table.lead_access; const accessDelivery = access?.delivery;
    let accessLabel = "No management credential";
    if (access) accessLabel = access.revoked_at || access.status === "revoked" ? "Management access revoked" : accessDelivery?.delivered_at ? "Management access delivered" : accessDelivery?.accepted_at ? "Management access accepted by provider" : "Management access held — not sent";
    const buyer = table.purchaser;
    const buyerLine = element("p", "buyer-line", buyer ? `Table purchaser: ${text(buyer.purchaser_first_name)} ${text(buyer.purchaser_last_name)} · ${text(buyer.purchaser_email)} · ${money(buyer.total_cents, buyer.currency)} paid ${date(buyer.paid_at)}` : "Table purchaser: No linked purchase — staff-reserved table");
    const leadLine = element("p", "lead-line", `Table lead: ${lead ? `${text(lead.first_name)} ${text(lead.last_name)} · ${text(lead.email)}` : "Not assigned"} · ${accessLabel}`);
    card.append(buyerLine, leadLine);
    if (lead) {
      const reveal = element("button", "quiet compact", "Show / copy management link"); reveal.type = "button";
      const linkBox = element("div", "management-link-box"); linkBox.hidden = true;
      reveal.addEventListener("click", async () => {
        if (!confirm(`Reveal the private management link for ${text(lead.first_name)} ${text(lead.last_name)}? This grants full control of this table. No email will be sent.`)) return;
        setBusy(reveal, true);
        try {
          const result = await call({ action: "table_management_link_reveal", table_id: table.id });
          const input = document.createElement("input"); input.type = "text"; input.readOnly = true; input.value = result.table_management_url; input.setAttribute("aria-label", "Private table management link");
          const copy = element("button", "button dark compact", "Copy link"); copy.type = "button";
          copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(input.value); status("Private management link copied. Nothing was emailed.", "success"); } catch { input.focus(); input.select(); status("Select and copy the highlighted private link. Nothing was emailed."); } });
          linkBox.replaceChildren(element("p", "fineprint", `Private management access for ${text(result.recipient)}. Share only with the named table lead. Nothing was emailed.`), input, copy); linkBox.hidden = false; input.focus(); input.select();
          status("Private management link revealed and recorded in the audit log. Nothing was emailed.", "success");
        } catch (error) { status(error.message || "The private management link could not be prepared.", "error"); }
        finally { setBusy(reveal, false); }
      });
      card.append(reveal, linkBox);
    }
    card.append(element("h4", "roster-title", "Guest order · numbered seats 1–10"));

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
      const values = [`Seat ${seat.seat_number}`, guestName, recipient, organization, registration, inviteStatus, activity ? date(activity) : "—"];
      values.forEach((value, index) => { const td = document.createElement("td"); if (index === 4 || index === 5) td.append(chip(value)); else td.textContent = text(value); tr.append(td); });
      const action = document.createElement("td");
      if (attendee) { const edit = element("button", "quiet compact", "Edit attendee"); edit.type = "button"; edit.addEventListener("click", () => showAttendee(attendee.id)); const move = element("button", "quiet compact", "Move"); move.type = "button"; move.addEventListener("click", () => seatMoveForm(table, seat, payload.data)); const clearSeat = element("button", "quiet compact", "Clear"); clearSeat.type = "button"; clearSeat.addEventListener("click", async () => { if (!confirm("Clear this seat assignment? Nothing will be sent and no attendee record will be deleted.")) return; try { await call({ action: "admin_seat_set", table_id: table.id, seat_number: seat.seat_number, attendee_id: null }); status("Seat cleared. Nothing was sent.", "success"); await loadTab("tables", currentPage, lastSearch); } catch (error) { status(error.message || "The seat could not be cleared.", "error"); } }); action.append(edit, move, clearSeat); }
      else { const add = element("button", "quiet compact", "Add attendee"); add.type = "button"; add.disabled = Boolean(seat.locked); add.addEventListener("click", () => attendeeCreateForm(table, seat.seat_number)); const assign = element("button", "quiet compact", "Assign existing guest"); assign.type = "button"; assign.disabled = Boolean(seat.locked); assign.addEventListener("click", () => seatAssignForm(table, seat)); action.append(add, assign); }
      tr.append(action); tbody.append(tr);
    }
    roster.append(tbody); wrap.append(roster); card.append(wrap, element("p", "fineprint", "Invitation and delivery statuses are read from the private invitation and email ledgers. A management link is displayed only after the sole administrator explicitly reveals it; the raw link is never stored in the dashboard or audit log.")); list.append(card);
  }
  host.append(list); host.append(pagination(payload));
}
function selectField(labelText, name, values, value = "", required = true) {
  const label = document.createElement("label"); label.textContent = labelText; const select = document.createElement("select"); select.name = name; select.required = required;
  for (const item of values) { const option = document.createElement("option"); option.value = item.value; option.textContent = item.label; option.selected = item.value === value; select.append(option); }
  label.append(select); return label;
}
function mealField(value = "") {
  return selectField("Meal preference", "meal_preference", [{ value: "", label: "Select one" }, { value: "Vegetarian", label: "Vegetarian" }, { value: "Non-vegetarian", label: "Non-vegetarian" }], value, true);
}
function attendeeNeedsFields(form, values = {}) {
  form.append(mealField(values.meal_preference || ""));
  function need(labelText, checkboxName, checked, detailName, detailValue, detailLabel) {
    const section = element("fieldset", "need-field"); const label = document.createElement("label"); const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.name = checkboxName; checkbox.checked = Boolean(checked); label.append(checkbox, document.createTextNode(labelText)); const detail = formField(detailLabel, detailName, detailValue || "", { multiline: true, max: 2000 }); detail.hidden = !checkbox.checked; detail.querySelector("textarea").required = checkbox.checked; checkbox.addEventListener("change", () => { detail.hidden = !checkbox.checked; detail.querySelector("textarea").required = checkbox.checked; if (!checkbox.checked) detail.querySelector("textarea").value = ""; }); section.append(label, detail); return section;
  }
  form.append(need("This attendee has allergies or additional dietary needs", "has_dietary_or_allergy_needs", values.has_dietary_or_allergy_needs, "dietary_or_allergy_details", values.dietary_or_allergy_details, "Allergies / dietary needs"));
  form.append(need("This attendee has accessibility needs", "has_accessibility_needs", values.has_accessibility_needs, "accessibility_details", values.accessibility_details, "Accessibility needs"));
}
function openOperation(title, intro, build) {
  const host = $("attendee-detail"); clear(host); host.append(element("p", "eyebrow", "Protected staging operation"), element("h2", "", title), element("p", "fineprint", intro));
  const form = build(); host.append(form); if (!$("attendee-dialog").open) $("attendee-dialog").showModal();
}
function operationActions(form, submitLabel, handler) {
  const note = element("p", "notice", "Nothing will be sent and no consent, payment, Stripe record, credential, or secure link will be created."); note.setAttribute("role", "status");
  const actions = element("div", "dialog-actions"); const cancel = element("button", "button outline", "Cancel"); cancel.type = "button"; cancel.addEventListener("click", () => $("attendee-dialog").close()); const save = element("button", "button dark", submitLabel); save.type = "submit"; actions.append(cancel, save); form.append(note, actions);
  form.addEventListener("submit", async (event) => { event.preventDefault(); if (!form.reportValidity()) return; if (!confirm("Confirm this protected staging change. Nothing will be sent and no payment, consent, access credential, or secure link will be created.")) return; setBusy(save, true); note.textContent = "Saving protected staging operation…"; note.className = "notice"; try { await handler(new FormData(form)); note.textContent = "Saved. Nothing was sent."; note.className = "notice success"; await loadTab(activeTab, currentPage, lastSearch); } catch (error) { note.textContent = error.message || "The operation could not be saved."; note.className = "notice error"; } finally { setBusy(save, false); } });
  return form;
}
function recordTypeFields(form, locked = "") {
  const labels = { complimentary: "Complimentary", sponsor: "Sponsor", honoree: "Honoree", staff: "Staff", pre_existing_paid: "Existing paid purchase" }; const options = locked ? [{ value: locked, label: labels[locked] || locked }] : Object.entries(labels).map(([value, label]) => ({ value, label }));
  form.append(selectField("Record type", "provenance", options, locked || "complimentary"), formField("Reason for staff-added record", "reason", "", { required: !locked || locked !== "pre_existing_paid", multiline: true, max: 2000 }), formField("Approved by", "approver", "", { required: !locked || locked !== "pre_existing_paid", max: 300 }));
}
function adminAttendeeButton() { const button = element("button", "button dark admin-action", "Add attendee"); button.type = "button"; button.addEventListener("click", () => attendeeCreateForm()); return button; }
function attendeeCreateForm(table = null, seatNumber = null) {
  const requestId = crypto.randomUUID(); const paid = Boolean(table?.order_id); const form = element("form", "attendee-edit"); const grid = element("div", "edit-grid");
  grid.append(formField("First name", "first_name", "", { required: true, max: 200 }), formField("Last name", "last_name", "", { required: true, max: 200 }), formField("Email", "email", "", { required: true, type: "email", max: 320 }), formField("Secondary email (optional)", "secondary_email", "", { type: "email", max: 320 }), formField("Phone (optional)", "phone", "", { type: "tel", max: 100 }), formField("Job title", "job_title", "", { required: true, max: 300 }), formField("Company", "company", "", { required: true, max: 300 }), formField("Pronunciation (optional)", "pronunciation", "", { max: 300 }), formField("LinkedIn profile (optional)", "linkedin_url", "", { type: "url", max: 500 })); form.append(grid);
  form.append(photoField(), formField("Bio (optional)", "bio", "", { multiline: true, max: 5000 }), formField("Relationship notes (optional)", "relationship_notes", "", { multiline: true, max: 2000 }));
  if (table) { const details = element("p", "fineprint", `This guest will be added to Table ${table.table_number || "number not assigned"}, seat ${seatNumber}.`); form.append(details); }
  attendeeNeedsFields(form);
  recordTypeFields(form, paid ? "pre_existing_paid" : "");
  operationActions(form, "Create guest record", async (data) => { const photo = data.get("guest_photo"); const record = Object.fromEntries(data.entries()); delete record.guest_photo; record.needs = { meal_preference: data.get("meal_preference"), has_dietary_or_allergy_needs: data.has("has_dietary_or_allergy_needs"), dietary_or_allergy_details: data.has("has_dietary_or_allergy_needs") ? data.get("dietary_or_allergy_details") : null, has_accessibility_needs: data.has("has_accessibility_needs"), accessibility_details: data.has("has_accessibility_needs") ? data.get("accessibility_details") : null }; for (const key of ["meal_preference","has_dietary_or_allergy_needs","dietary_or_allergy_details","has_accessibility_needs","accessibility_details"]) delete record[key]; if (table) { record.table_id = table.id; record.seat_number = String(seatNumber); } const payload = await call({ action: "admin_attendee_create", request_id: requestId, record }); const attendeeId = payload?.result?.attendee_id; if (attendeeId && photo instanceof File && photo.size) await uploadAttendeePhoto(attendeeId, photo); if (attendeeId) status("Guest record created. Registration is not complete and nothing was sent.", "success"); });
  openOperation("Add guest record", "This creates a staff-added guest record only. Registration and personal consent remain incomplete until the guest completes them.", () => form);
}
function tableCreateForm() {
  const requestId = crypto.randomUUID(); const form = element("form", "attendee-edit"); const grid = element("div", "edit-grid"); grid.append(formField("Table number", "table_number", "", { required: true, type: "number", max: 4 }), formField("Table name", "name", "", { required: true, max: 300 })); form.append(grid); recordTypeFields(form);
  const paidOrder = selectField("Existing paid table order (pre-existing paid only)", "order_id", [{ value: "", label: "None — manually reserved table" }], "", false); form.append(paidOrder);
  call({ action: "eligible_paid_table_orders" }).then((payload) => { for (const order of payload.data || []) { const option = document.createElement("option"); option.value = order.order_id; option.textContent = `${text(order.purchaser_first_name)} ${text(order.purchaser_last_name)} · ${text(order.purchaser_email)} · ${order.unassigned_entitlements} unassigned`; paidOrder.querySelector("select").append(option); } }).catch(() => {});
  operationActions(form, "Create ten-seat table", async (data) => { const record = Object.fromEntries(data.entries()); if (record.provenance === "pre_existing_paid" && !record.order_id) throw new Error("Select an eligible existing paid table order."); if (record.provenance !== "pre_existing_paid") record.order_id = ""; await call({ action: "admin_table_create", request_id: requestId, record }); status("Ten-seat table created. Nothing was sent.", "success"); });
  openOperation("Add ten-seat table", "Manual tables reserve ten seats once. A paid table only links an existing same-event paid table order; it never creates or changes an order or Stripe ID.", () => form);
}
function tableEditForm(table) {
  const form = element("form", "attendee-edit"); const grid = element("div", "edit-grid"); grid.append(formField("Table number", "table_number", table.table_number, { required: true, type: "number", max: 4 }), formField("Table name", "name", table.name, { required: true, max: 300 }), selectField("Status", "status", ["active","locked","cancelled"].map((value) => ({ value, label: value })), table.status)); form.append(grid);
  operationActions(form, "Save table", async (data) => { await call({ action: "admin_table_update", table_id: table.id, record: Object.fromEntries(data.entries()) }); status("Table updated. Nothing was sent.", "success"); }); openOperation("Edit table", "Cancelling is blocked when guests, active invitations, or a manual reserved-capacity claim exist.", () => form);
}
function seatAssignForm(table, seat) {
  const form = element("form", "attendee-edit"); const pending = selectField("Unseated guest record", "attendee_id", [{ value: "", label: "Loading eligible attendees…" }], "", true); form.append(pending);
  const select = pending.querySelector("select"); select.disabled = true;
  call({ action: "admin_unseated_attendees" }).then((payload) => { clear(select); const empty = document.createElement("option"); empty.value = ""; empty.textContent = "Choose a compatible unseated guest"; select.append(empty); for (const attendee of payload.data || []) { const option = document.createElement("option"); option.value = attendee.attendee_id; option.textContent = `${text(attendee.first_name)} ${text(attendee.last_name)} · ${text(attendee.email)} · ${recordTypeLabel(attendee.provenance)}`; select.append(option); } select.disabled = false; }).catch(() => { select.options[0].textContent = "Eligible attendees unavailable"; });
  operationActions(form, "Assign guest to seat", async (data) => { const attendeeId = data.get("attendee_id"); if (!attendeeId) throw new Error("Choose an eligible unseated guest."); await call({ action: "admin_seat_set", table_id: table.id, seat_number: seat.seat_number, attendee_id: attendeeId }); status("Seat assignment saved. Nothing was sent.", "success"); }); openOperation("Assign existing guest record", "Only a compatible staff-added guest can be assigned to this table. Any separate reserved seat is released so capacity is not counted twice.", () => form);
}
function seatMoveForm(table, seat, tables) {
  const form = element("form", "attendee-edit"); const options = (tables || []).filter((candidate) => candidate.status === "active").map((candidate) => ({ value: candidate.id, label: `Table ${candidate.table_number} · ${text(candidate.name)}` })); form.append(selectField("Destination table", "table_id", options, table.id), formField("Destination seat number", "seat_number", "", { required: true, type: "number", max: 2 }));
  operationActions(form, "Move guest", async (data) => { const destination = Object.fromEntries(data.entries()); const n = Number(destination.seat_number); if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error("Choose a seat number from 1 to 10."); await call({ action: "admin_seat_set", table_id: destination.table_id, seat_number: n, attendee_id: seat.attendee_id }); status("Seat assignment saved. Nothing was sent.", "success"); }); openOperation("Move guest", "The move is saved as one protected change. Paid and staff-reserved seats cannot be mixed, and active invitations remain protected.", () => form);
}
function setLeadForm(table) {
  const seated = (table.table_seats || []).filter((seat) => seat.attendee).map((seat) => ({ value: seat.attendee.id, label: `${text(seat.attendee.first_name)} ${text(seat.attendee.last_name)} · seat ${seat.seat_number}` })); const form = element("form", "attendee-edit"); form.append(selectField("Table lead", "attendee_id", [{ value: "", label: "Clear table lead" }, ...seated], table.lead_attendee_id || "", false)); operationActions(form, "Save table lead", async (data) => { const value = data.get("attendee_id"); await call({ action: "admin_table_lead_set", table_id: table.id, attendee_id: value || null }); status("Table lead updated. Nothing was sent.", "success"); }); openOperation("Set or clear table lead", "The selected lead must occupy a seat. The operation is blocked while an active table-management credential exists; no credential is created, changed, revoked, or sent.", () => form);
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
  const profile = element("section", "detail-section profile-details"); profile.append(element("h3", "", "Guest profile"));
  if (a.photo_signed_url) { const image = document.createElement("img"); image.className = "guest-photo"; image.src = a.photo_signed_url; image.alt = `${text(a.first_name)} ${text(a.last_name)}`; profile.append(image); }
  if (a.linkedin_url) { const link = document.createElement("a"); link.href = a.linkedin_url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "View LinkedIn profile"; profile.append(link); }
  profile.append(element("p", "", a.bio ? `Bio: ${a.bio}` : "No bio added."), element("p", "", a.pronunciation ? `Pronunciation: ${a.pronunciation}` : ""), element("p", "", a.relationship_notes ? `Relationship notes: ${a.relationship_notes}` : "")); host.append(profile);
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
    formField("Pronunciation (optional)", "pronunciation", a.pronunciation, { max: 300 }),
    formField("LinkedIn profile (optional)", "linkedin_url", a.linkedin_url, { type: "url", max: 500 })
  ); form.append(fields);
  form.append(photoField(), formField("Bio (optional)", "bio", a.bio, { multiline: true, max: 5000 }), formField("Relationship notes (optional)", "relationship_notes", a.relationship_notes, { multiline: true, max: 2000 }));
  attendeeNeedsFields(form, n);
  form.append(formField("Internal change note", "change_reason", "", { required: true, max: 500, multiline: true }));
  const formStatus = element("p", "notice"); formStatus.setAttribute("role", "status"); form.append(formStatus);
  const actions = element("div", "dialog-actions"); const cancel = element("button", "button outline", "Cancel"); cancel.type = "button"; cancel.addEventListener("click", () => renderAttendeeDetail(payload)); const save = element("button", "button dark", "Save audited changes"); save.type = "submit"; actions.append(cancel, save); form.append(actions);
  form.addEventListener("submit", async (event) => { event.preventDefault(); if (!form.reportValidity()) return; setBusy(save, true); formStatus.textContent = "Saving protected attendee information…"; formStatus.className = "notice"; const data = new FormData(form); const photo = data.get("guest_photo"); const record = Object.fromEntries(data.entries()); delete record.guest_photo; record.has_dietary_or_allergy_needs = data.has("has_dietary_or_allergy_needs"); record.has_accessibility_needs = data.has("has_accessibility_needs"); try { let updated = await call({ action: "attendee_update", attendee_id: a.id, record }); if (photo instanceof File && photo.size) updated = await uploadAttendeePhoto(a.id, photo); renderAttendeeDetail(updated, "Attendee information saved. No email or access link was sent."); if (["attendees", "tables"].includes(activeTab)) loadTab(activeTab, currentPage, lastSearch); } catch (error) { formStatus.textContent = error.message || "The attendee update could not be saved."; formStatus.className = "notice error"; } finally { setBusy(save, false); } });
  host.append(form);
}

async function showAttendee(id) { status("Loading attendee detail…"); try { const payload = await call({ action: "attendee_detail", attendee_id: id }); renderAttendeeDetail(payload); if (!$("attendee-dialog").open) $("attendee-dialog").showModal(); status(""); } catch (error) { status(error.message || "Attendee detail is unavailable.", "error"); } }

$("magic-form").addEventListener("submit", sendLink); $("otp-form").addEventListener("submit", verifyCode); $("request-code").addEventListener("click", requestCode); $("refresh").addEventListener("click", () => loadTab(activeTab, currentPage, lastSearch)); $("tabs").addEventListener("click", (event) => { const button = event.target.closest("button[data-tab]"); if (button) loadTab(button.dataset.tab); }); $("sign-out").addEventListener("click", async () => { await supabase?.auth.signOut(); session = null; $("workspace").hidden = true; $("auth-shell").hidden = false; $("sign-out").hidden = true; authStatus("Signed out of private administration."); }); $("attendee-dialog").querySelector(".close").addEventListener("click", () => $("attendee-dialog").close());
initialize().catch(() => authStatus("Private sign-in is unavailable. Check deployment configuration.", "error"));
