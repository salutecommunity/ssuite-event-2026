(() => {
  "use strict";
  const cfg = window.SSUITE_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const tableNameLimit = 200;
  const invalidTableNameCharacters = /[\u0000-\u001f\u007f]/;
  const TOKEN_PATTERN = /^[0-9a-f]{64}$/i, TOKEN_STORE = "ssuite.table.portal";
  /* The token arrives in the URL fragment. Fragments never leave the browser in an
     HTTP request, but it is taken out of the address bar at once so it cannot be
     copied, bookmarked or screenshotted by accident. It is then kept for this tab
     only, so a refresh or a back navigation still opens the table. */
  function readToken() {
    const fromLink = new URLSearchParams(location.hash.slice(1)).get("token") || "";
    if (TOKEN_PATTERN.test(fromLink)) { try { sessionStorage.setItem(TOKEN_STORE, fromLink.toLowerCase()); } catch { /* storage unavailable */ } return fromLink.toLowerCase(); }
    try { const stored = sessionStorage.getItem(TOKEN_STORE) || ""; if (TOKEN_PATTERN.test(stored)) return stored.toLowerCase(); } catch { /* storage unavailable */ }
    return "";
  }
  let tableToken = readToken();
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  let table = null;
  /* Partners reach their partnership page with the same link they already have,
     so there is no second credential to keep. The link only appears once the
     table has actually loaded, which means the token is known to be good. */
  function showPartnerLink() {
    const link = document.getElementById("partner-link");
    if (!link || !tableToken) return;
    link.href = `./partner/#token=${tableToken}`;
    link.hidden = false;
  }

  let editingTableName = false;

  function base() {
    try { const u = new URL(String(cfg.apiBase || "")); return cfg.mode === "live" && u.protocol === "https:" ? u.origin : ""; } catch { return ""; }
  }
  /* A message about something a host just did has to be somewhere they can see. This page runs long
     — ten seat cards sit between the top notice and the invite form — so any notice that lands off
     screen is brought into view rather than being announced into empty space. */
  function reveal(node) { const box = node.getBoundingClientRect(); if (box.top < 0 || box.bottom > window.innerHeight) node.scrollIntoView({ block: "center", behavior: "smooth" }); }
  function status(message, kind = "") { const node = $("status"); node.textContent = message; node.className = `notice ${kind}`; node.hidden = !message; if (message) reveal(node); }
  /* Invitation feedback belongs directly above the Send invitation button that produced it. */
  function inviteStatus(message, kind = "") { const node = $("invite-status"); if (!node) { status(message, kind); return; } node.textContent = message; node.className = `notice form-notice${kind ? ` ${kind}` : ""}`; node.hidden = !message; if (message) reveal(node); }
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
  // The server is the authority on both deadlines; these only decide what the
  // page offers, so a closed window never shows a control that would be refused.
  function windowOf(key) { const w = table && table[key]; return w && typeof w === "object" ? w : null; }
  function changesOpen() { const w = windowOf("details_window"); return !w || w.open !== false; }
  function changesCutoff() { const w = windowOf("details_window"); return w && typeof w.cutoff_display === "string" ? w.cutoff_display : ""; }
  function guestCutoff() { const w = windowOf("guest_details_window"); return w && typeof w.cutoff_display === "string" ? w.cutoff_display : ""; }
  function renderChangeWindow() {
    const node = $("changes-window"), mine = changesCutoff(), theirs = guestCutoff();
    const parts = [];
    if (changesOpen()) {
      if (mine) parts.push(`You can add guests, edit their details, send invitations, and rename this table until ${mine}.`);
      if (theirs) parts.push(`Your guests can change their own details until ${theirs}.`);
      if (mine) parts.push("After that, email ssuite@salute.community and the S.Suite team can still make changes.");
    } else {
      parts.push(mine ? `Table changes closed on ${mine}.` : "Table changes are closed.");
      parts.push("You can still resend an invitation to a guest. For any other change, email ssuite@salute.community and the S.Suite team can help.");
    }
    node.textContent = parts.join(" ");
    node.className = changesOpen() ? "notice" : "notice error";
    node.hidden = parts.length === 0;
  }
  function render() {
    $("portal").hidden = false;
    showPartnerLink();
    const currentTableName = typeof table.table_name === "string" ? table.table_name.trim() : "";
    $("table-name").textContent = currentTableName || (table.table_number ? `Table ${table.table_number}` : "Your table");
    if (!editingTableName) $("table-name-input").value = currentTableName;
    const meta = $("table-meta"); meta.replaceChildren(cell("Table", String(table.table_number || "—")), cell("Seats", String((table.seats || []).length)), cell("Host", "Secure access"));
    const grid = $("seats"); grid.replaceChildren();
    for (const seat of [...(table.seats || [])].sort((a, b) => a.seat_number - b.seat_number)) {
      const card = document.createElement("article"), title = document.createElement("h3"), detail = document.createElement("p");
      title.textContent = `Seat ${String(seat.seat_number).padStart(2, "0")}`;
      if (seat.locked) detail.textContent = "This seat is not available to invite.";
      else if (seat.attendee_id) detail.textContent = `${[seat.first_name, seat.last_name].filter(Boolean).join(" ") || "Guest"} — ${seat.registration_status === "complete" ? "registered" : "waiting on their details"}`;
      else { const invite = (table.invitations || []).find((i) => Number(i.seat_number) === Number(seat.seat_number) && ["draft", "queued", "sent", "opened", "started"].includes(i.status)); detail.textContent = invite ? ({ draft: "Invitation not sent yet.", queued: "Invitation sending now.", sent: "Invitation sent — waiting on their details.", opened: "Invitation opened — waiting on their details.", started: "They have started — waiting on their details." }[invite.status] || "Invitation sent — waiting on their details.") : "Open seat."; }
      card.append(title, detail);
      const activeInvite = (table.invitations || []).find(i => Number(i.seat_number) === Number(seat.seat_number) && ["draft","queued","sent","opened","started"].includes(i.status));
      const guestEmail = seat.email || activeInvite?.recipient_email;
      if (guestEmail) { const line = document.createElement("p"); line.textContent = guestEmail; line.style.overflowWrap = "anywhere"; card.append(line); }
      if (seat.company || seat.job_title) { const line = document.createElement("p"); line.textContent = [seat.job_title,seat.company].filter(Boolean).join(" · "); card.append(line); }
      if (!seat.locked && changesOpen()) {
        const edit = document.createElement("button"); edit.type="button"; edit.className="secondary"; edit.textContent=seat.attendee_id?"Edit guest":"Add guest details";
        edit.addEventListener("click",()=>openGuestEditor(seat,activeInvite,card)); card.append(edit);
      }

      const invitation = (table.invitations || []).find((i) => Number(i.seat_number) === Number(seat.seat_number) && ["queued", "sent", "opened", "started"].includes(i.status));
      if (invitation) { const actions = document.createElement("div"); actions.className = "actions"; const resend = document.createElement("button"); resend.type = "button"; resend.className = "secondary"; resend.textContent = "Resend invitation"; resend.addEventListener("click", () => resendInvitation(invitation.id)); actions.append(resend); card.append(actions); }
      grid.append(card);
    }
    const select = $("invite-form").elements.seat_number; select.replaceChildren();
    for (const seat of openSeats()) { const option = document.createElement("option"); option.value = String(seat.seat_number); option.textContent = `Seat ${String(seat.seat_number).padStart(2, "0")}`; select.append(option); }
    const form = $("invite-form"); form.hidden = openSeats().length === 0 || !changesOpen();
    if (!changesOpen() && editingTableName) setNameEditor(false);
    $("edit-table-name").hidden = editingTableName || !changesOpen();
    renderChangeWindow();
  }

  function openGuestEditor(seat, invitation, card) {
    document.querySelectorAll(".host-guest-editor").forEach(node=>{node.parentElement.style.gridColumn="";node.remove();});
    card.style.gridColumn="1 / -1";
    const form=document.createElement("form"); form.className="host-guest-editor invite-form";
    const heading=document.createElement("h3"); heading.textContent=seat.attendee_id?"Edit guest details":"Add guest details"; form.append(heading);
    const help=document.createElement("p"); help.textContent="Save the details you know. Guests still confirm their own agreement and personal requirements before registration is complete. Saving alone does not send an email.";form.append(help);
    const fields=document.createElement("div");fields.className="fields";
    const values={first_name:seat.first_name||"",last_name:seat.last_name||"",email:seat.email||invitation?.recipient_email||"",company:seat.company||"",job_title:seat.job_title||""};
    for(const [name,label] of [["first_name","FIRST NAME"],["last_name","LAST NAME"],["email","EMAIL"],["company","COMPANY (optional until registration)"],["job_title","TITLE (optional until registration)"]]) {
      const field=document.createElement("label");field.className="field";const caption=document.createElement("span");caption.textContent=label;
      const input=document.createElement("input");input.name=name;input.type=name==="email"?"email":"text";input.value=values[name];input.maxLength=name==="email"?320:["first_name","last_name"].includes(name)?100:200;
      input.required=["first_name","last_name","email"].includes(name)||seat.registration_status==="complete";
      if(name==="email"&&(seat.registration_status==="complete"||seat.attendee_id===table.lead_attendee_id)) {input.readOnly=true;const note=document.createElement("small");note.textContent="Contact ssuite@salute.community to change this email.";field.append(note);}
      field.append(caption,input);fields.append(field);
    }
    form.append(fields);
    if(seat.registration_status!=="complete") {
      const label=document.createElement("label"),checkbox=document.createElement("input");checkbox.type="checkbox";checkbox.name="send_email";checkbox.style.width="auto";checkbox.style.marginRight="0.6em";label.append(checkbox,document.createTextNode(" Send this guest an email link to finish registration"));form.append(label);
    }
    const feedback=document.createElement("p");feedback.className="notice";feedback.role="status";feedback.hidden=true;form.append(feedback);
    const actions=document.createElement("div");actions.className="actions";const save=document.createElement("button"),cancel=document.createElement("button");save.type="submit";save.textContent="Save guest details";cancel.type="button";cancel.className="secondary";cancel.textContent="Cancel";cancel.addEventListener("click",()=>{form.remove();card.style.gridColumn="";});actions.append(save,cancel);form.append(actions);
    form.addEventListener("submit",async event=>{
      event.preventDefault();if(!form.reportValidity())return;
      const attendee={};for(const name of Object.keys(values))attendee[name]=form.elements[name].value.trim();
      const send=!!form.elements.send_email?.checked;
      const signature=JSON.stringify({attendee,send});if(form.dataset.signature!==signature){form.dataset.signature=signature;form.dataset.key=randomKey();}
      save.disabled=true;cancel.disabled=true;feedback.hidden=false;feedback.textContent="Saving guest details…";
      try {
        await call({action:"save_guest",seat_number:Number(seat.seat_number),expected_attendee_id:seat.attendee_id||null,attendee,send_email:send,idempotency_key:form.dataset.key});
        await load("");status(send?"Guest details saved. Their registration email is queued.":"Guest details saved. No email was sent.","success");
      } catch(e) {feedback.textContent=e.message||"Could not save. Please try again.";feedback.className="notice error";reveal(feedback);}
      finally{save.disabled=false;cancel.disabled=false;}
    });
    card.append(form);form.querySelector("input").focus();reveal(form);
  }

  function setNameEditor(requested) {
    const open = requested && changesOpen();
    editingTableName = open;
    $("table-name-form").hidden = !open;
    $("edit-table-name").hidden = open || !changesOpen();
    if (open) {
      const input = $("table-name-input");
      input.value = typeof table?.table_name === "string" ? table.table_name.trim() : "";
      requestAnimationFrame(() => { input.focus(); input.select(); });
    }
  }
  async function renameTable(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.table_name.value.trim();
    if (!changesOpen()) { setNameEditor(false); render(); return status(changesCutoff() ? `Table changes closed on ${changesCutoff()}. Email ssuite@salute.community for a late change.` : "Table changes are closed.", "error"); }
    if (!name || name.length > tableNameLimit || invalidTableNameCharacters.test(name)) {
      return status("Enter a table name between 1 and 200 characters.", "error");
    }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      status("Saving table name…");
      const result = await call({ action: "rename_table", table_name: name });
      if (!result || typeof result.table_name !== "string") throw new Error("The table name could not be updated. Your current name is unchanged.");
      table = { ...table, table_name: result.table_name };
      setNameEditor(false);
      render();
      status("Table name updated.", "success");
    } catch {
      status("The table name could not be updated. Your current name is unchanged.", "error");
    } finally {
      button.disabled = false;
    }
  }
  async function load(message = "Updating your table…") {
    status(message); const result = await call({ action: "get" }); table = result.table; if (!table || typeof table !== "object") throw new Error("We could not load your table just now."); render(); status("");
  }
  async function invite(event) {
    event.preventDefault(); const form = event.currentTarget; const recipient = form.elements.recipient_email.value.trim().toLowerCase(), seat = Number(form.elements.seat_number.value), note = form.elements.personal_note.value.trim();
    if (!changesOpen()) { render(); return inviteStatus(changesCutoff() ? `Table changes closed on ${changesCutoff()}. Email ssuite@salute.community to add a guest.` : "Table changes are closed.", "error"); }
    if (!email.test(recipient) || !Number.isInteger(seat) || seat < 1 || seat > 10 || note.length > 2000) return inviteStatus("Enter your guest's email address and choose an open seat.", "error");
    const button = form.querySelector("button[type=submit]"); button.disabled = true;
    try { inviteStatus("Sending the invitation…"); await call({ action: "create_invitation", recipient_email: recipient, seat_number: seat, personal_note: note, idempotency_key: randomKey() }); form.reset(); await load(""); inviteStatus("Invitation is on its way. It sends within about a minute — this page will show it as sent once it has gone out.", "success"); } catch { inviteStatus("This invitation could not be queued. Please check your connection and try again, or write to ssuite@salute.community.", "error"); } finally { button.disabled = false; }
  }
  async function resendInvitation(invitationId) {
    try { status("Resending…"); await call({ action: "resend_invitation", invitation_id: invitationId, idempotency_key: randomKey() }); await load(""); status("Resend is on its way. Your guest keeps the same link, and it sends again within about a minute.", "success"); } catch { status("This resend could not be queued. Please try again, or write to ssuite@salute.community.", "error"); }
  }
  async function revoke() {
    if (!confirm("Turn off this link? Your table page will stop opening from the link in your email, and you will need to ask us for a new one.")) return;
    try { await call({ action: "revoke_access" }); tableToken = ""; $("portal").hidden = true; status("This link is now turned off.", "success"); } catch { status("We could not turn off this link just now.", "error"); }
  }
  $("refresh").addEventListener("click", () => load().catch(() => status("We could not update your table just now.", "error")));
  $("edit-table-name").addEventListener("click", () => setNameEditor(true));
  $("cancel-table-name").addEventListener("click", () => setNameEditor(false));
  $("table-name-form").addEventListener("submit", renameTable);
  $("invite-form").addEventListener("submit", invite); $("revoke-access").addEventListener("click", revoke);
  if (!tableToken) status("This link is missing or incomplete. Please open the private link from your table email, or write to ssuite@salute.community and we will send you a new one.", "error");
  else if (!base()) status("Your table page is temporarily unavailable. Please try again shortly, or write to ssuite@salute.community.", "error");
  else load().catch(() => status("This private table link is unavailable or has expired.", "error"));
})();
