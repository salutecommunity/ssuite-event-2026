(() => {
  "use strict";
  const cfg = window.SSUITE_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
  // Fragments never leave the browser in an HTTP request, but remove them at
  // once so users cannot accidentally copy, bookmark, or report the token.
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  let tableToken = /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : "";
  let table = null;

  function base() {
    try { const u = new URL(String(cfg.apiBase || "")); return cfg.mode === "live" && u.protocol === "https:" ? u.origin : ""; } catch { return ""; }
  }
  function status(message, kind = "") { const node = $("status"); node.textContent = message; node.className = `notice ${kind}`; node.hidden = !message; }
  function randomKey() { const bytes = new Uint8Array(32); crypto.getRandomValues(bytes); return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""); }
  async function call(body) {
    const response = await fetch(`${base()}/functions/v1/table-portal`, { method: "POST", mode: "cors", credentials: "omit", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, table_token: tableToken }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "The table request could not be completed.");
    return payload;
  }
  function cell(label, value) { const el = document.createElement("div"), a = document.createElement("span"), b = document.createElement("strong"); a.textContent = label; b.textContent = value; el.append(a, b); return el; }
  function openSeats() { return (table?.seats || []).filter((seat) => !seat.locked && !seat.attendee_id && !activeSeat(seat.seat_number)); }
  function activeSeat(n) { return (table?.invitations || []).some((i) => Number(i.seat_number) === Number(n) && ["draft", "queued", "sent", "opened", "started"].includes(i.status)); }
  function render() {
    $("portal").hidden = false;
    $("table-name").textContent = table.table_name || `Table ${table.table_number || ""}`;
    const meta = $("table-meta"); meta.replaceChildren(cell("Table", String(table.table_number || "—")), cell("Seats", String((table.seats || []).length)), cell("Lead", "Secure access"));
    const grid = $("seats"); grid.replaceChildren();
    for (const seat of [...(table.seats || [])].sort((a, b) => a.seat_number - b.seat_number)) {
      const card = document.createElement("article"), title = document.createElement("h3"), detail = document.createElement("p");
      title.textContent = `Seat ${String(seat.seat_number).padStart(2, "0")}`;
      if (seat.locked) detail.textContent = "This seat is locked.";
      else if (seat.attendee_id) detail.textContent = `${[seat.first_name, seat.last_name].filter(Boolean).join(" ") || "Guest"} — ${seat.registration_status === "complete" ? "registered" : "awaiting guest completion"}`;
      else { const invite = (table.invitations || []).find((i) => Number(i.seat_number) === Number(seat.seat_number) && ["draft", "queued", "sent", "opened", "started"].includes(i.status)); detail.textContent = invite ? `Invitation ${invite.status}; awaiting details.` : "Open seat."; }
      card.append(title, detail);
      const invitation = (table.invitations || []).find((i) => Number(i.seat_number) === Number(seat.seat_number) && ["queued", "sent", "opened", "started"].includes(i.status));
      if (invitation) { const actions = document.createElement("div"); actions.className = "actions"; const resend = document.createElement("button"); resend.type = "button"; resend.className = "secondary"; resend.textContent = "Queue resend"; resend.addEventListener("click", () => resendInvitation(invitation.id)); actions.append(resend); card.append(actions); }
      grid.append(card);
    }
    const select = $("invite-form").elements.seat_number; select.replaceChildren();
    for (const seat of openSeats()) { const option = document.createElement("option"); option.value = String(seat.seat_number); option.textContent = `Seat ${String(seat.seat_number).padStart(2, "0")}`; select.append(option); }
    const form = $("invite-form"); form.hidden = openSeats().length === 0;
  }
  async function load(message = "Refreshing secure table data…") {
    status(message); const result = await call({ action: "get" }); table = result.table; if (!table || typeof table !== "object") throw new Error("Table data was unavailable."); render(); status("");
  }
  async function invite(event) {
    event.preventDefault(); const form = event.currentTarget; const recipient = form.elements.recipient_email.value.trim().toLowerCase(), seat = Number(form.elements.seat_number.value), note = form.elements.personal_note.value.trim();
    if (!email.test(recipient) || !Number.isInteger(seat) || seat < 1 || seat > 10 || note.length > 2000) return status("Enter a valid email, open seat, and optional note.", "error");
    const button = form.querySelector("button[type=submit]"); button.disabled = true;
    try { status("Queueing the invitation…"); await call({ action: "create_invitation", recipient_email: recipient, seat_number: seat, personal_note: note, idempotency_key: randomKey() }); form.reset(); await load(""); status("Invitation queued. It has not been represented as sent; the server delivery worker must accept it.", "success"); } catch { status("Unable to queue this invitation. Confirm that this secure link remains active and try again.", "error"); } finally { button.disabled = false; }
  }
  async function resendInvitation(invitationId) {
    try { status("Queueing resend…"); await call({ action: "resend_invitation", invitation_id: invitationId, idempotency_key: randomKey() }); await load(""); status("Resend queued. Delivery still requires server-worker and provider acceptance.", "success"); } catch { status("Unable to queue the resend.", "error"); }
  }
  async function revoke() {
    if (!confirm("Revoke this table access link? This cannot be undone from this browser.")) return;
    try { await call({ action: "revoke_access" }); tableToken = ""; $("portal").hidden = true; status("This access link was revoked.", "success"); } catch { status("The access link could not be revoked.", "error"); }
  }
  $("refresh").addEventListener("click", () => load().catch(() => status("Unable to refresh this private table.", "error")));
  $("invite-form").addEventListener("submit", invite); $("revoke-access").addEventListener("click", revoke);
  if (!tableToken) status("This private table link is missing or invalid. Request a new link from the table lead process.", "error");
  else if (!base()) status("The table portal is not configured for live access.", "error");
  else load().catch(() => status("This private table link is unavailable or has expired.", "error"));
})();
