(() => {
  "use strict";
  const cfg = window.SSUITE_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
  const TOKEN_STORE = "ssuite.partner.portal";

  /* The token arrives in the URL fragment. Fragments never leave the browser in
     an HTTP request, and it is taken out of the address bar at once so it cannot
     be copied, bookmarked or screenshotted by accident. It is kept for this tab
     only, so a refresh still opens the portal. */
  function readToken() {
    const fromLink = new URLSearchParams(location.hash.slice(1)).get("token") || "";
    if (TOKEN_PATTERN.test(fromLink)) {
      try { sessionStorage.setItem(TOKEN_STORE, fromLink.toLowerCase()); } catch { /* storage unavailable */ }
      return fromLink.toLowerCase();
    }
    try {
      const stored = sessionStorage.getItem(TOKEN_STORE) || "";
      if (TOKEN_PATTERN.test(stored)) return stored.toLowerCase();
    } catch { /* storage unavailable */ }
    return "";
  }

  const token = readToken();
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  let partner = null;

  function base() {
    try {
      const u = new URL(String(cfg.apiBase || ""));
      return cfg.mode === "live" && u.protocol === "https:" ? u.origin : "";
    } catch { return ""; }
  }

  function notice(node, message, kind = "") {
    if (!node) return;
    node.textContent = message;
    node.className = `notice form-notice${kind ? ` ${kind}` : ""}`;
    node.hidden = !message;
  }
  function status(message, kind = "") {
    const node = $("status");
    node.textContent = message;
    node.className = `notice ${kind}`;
    node.hidden = !message;
  }

  async function call(body) {
    const response = await fetch(`${base()}/functions/v1/partner-portal`, {
      method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, table_token: token }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "That could not be completed.");
    return payload;
  }

  const TIERS = {
    associate: { label: "Associate Partner", seats: "ten" },
    supporting: { label: "Supporting Partner", seats: "five" },
    partner: { label: "Partner", seats: "" },
  };

  function render(payload) {
    partner = payload.partner || null;
    if (!partner) return;
    const tier = TIERS[partner.tier] || TIERS.partner;
    const host = [partner.host_first_name, partner.host_last_name].filter(Boolean).join(" ");

    $("tier-eyebrow").textContent = tier.label;
    $("headline").textContent = host ? `Thank you, ${partner.host_first_name}.` : "Your partnership.";
    $("intro").textContent = `You are recognized as an S.SUITE ${tier.label} for the evening of Friday, November 20, 2026. Everything below is yours to complete whenever you are ready — your details save as you go.`;

    const filled = Number(partner.seats_filled || 0);
    const total = Number(partner.seat_count || 0);
    $("table-headline").textContent = partner.table_name || "Your table";
    $("table-summary").textContent = `${filled} of ${total} seats confirmed. Name your table and invite your guests from your table page. Each guest completes their own registration and preferences.`;
    $("table-link").href = `../table-portal.html#token=${token}`;

    const profile = partner.profile || {};
    const form = $("partner-form");
    for (const name of ["recognition_name", "organization_bio", "website_url", "linkedin_url", "contact_name", "contact_email", "contact_phone", "posts_approval_required", "approval_contact_name", "approval_contact_email", "approval_guidelines"]) {
      const field = form.elements[name];
      if (field && !field.value) field.value = profile[name] || "";
    }
    if (!form.elements.contact_name.value && host) form.elements.contact_name.value = host;
    if (!form.elements.contact_email.value && partner.host_email) form.elements.contact_email.value = partner.host_email;

    const preference = ["name", "logo"].includes(profile.recognition_preference) ? profile.recognition_preference : "name";
    for (const radio of document.querySelectorAll('input[name="recognition_preference"]')) radio.checked = radio.value === preference;

    $("logo-block").hidden = preference === "name";
    updateApproval();
    const hasLogo = !!profile.has_logo;
    $("logo-current").hidden = !hasLogo;
    if (hasLogo) {
      $("logo-current-name").textContent = profile.logo_filename || "Your logo";
      const preview = $("logo-preview");
      if (payload.logo_url && /\.(png|jpe?g|svg)$/i.test(profile.logo_filename || "")) {
        preview.src = payload.logo_url;
        preview.hidden = false;
      } else {
        // A PDF, EPS or AI file cannot be shown in the page. Saying so is better
        // than a broken image frame.
        preview.hidden = true;
      }
    }
  }

  async function load() {
    if (!token) {
      status("Open this page from the private link in your table email. Keep that email — it is how you get back here.", "warn");
      return;
    }
    try {
      const payload = await call({ action: "get" });
      render(payload);
      status("");
      $("portal").hidden = false;
    } catch (e) {
      status(`${e.message} If this link no longer works, write to shama@salute.community and we will send a new one.`, "warn");
    }
  }

  function selectedPreference() {
    const chosen = document.querySelector('input[name="recognition_preference"]:checked');
    return chosen ? chosen.value : "name";
  }

  $("partner-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    notice($("form-status"), "Saving…");
    try {
      const body = { action: "save_profile", recognition_preference: selectedPreference() };
      for (const name of ["recognition_name", "organization_bio", "website_url", "linkedin_url", "contact_name", "contact_email", "contact_phone", "posts_approval_required", "approval_contact_name", "approval_contact_email", "approval_guidelines"]) {
        body[name] = form.elements[name].value.trim();
      }
      const payload = await call(body);
      render(payload);
      notice($("form-status"), "Saved. Thank you.", "ok");
    } catch (e) {
      notice($("form-status"), e.message, "warn");
    } finally {
      button.disabled = false;
    }
  });

  for (const radio of document.querySelectorAll('input[name="recognition_preference"]')) {
    radio.addEventListener("change", () => { $("logo-block").hidden = selectedPreference() === "name"; });
  }

  $("logo-file").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const input = event.target;
    notice($("logo-status"), "Uploading…");
    try {
      const prepared = await call({ action: "logo_upload_url", filename: file.name, size_bytes: file.size });
      const put = await fetch(prepared.upload_url, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      if (!put.ok) throw new Error("The file did not finish uploading. Please try again.");
      const payload = await call({
        action: "logo_recorded", object_path: prepared.object_path,
        filename: file.name, content_type: file.type || "", size_bytes: file.size,
      });
      render(payload);
      document.querySelector('input[name="recognition_preference"][value="logo"]').checked = true;
      $("logo-block").hidden = false;
      $("logo-filename").textContent = file.name;
      notice($("logo-status"), "Received. Thank you.", "ok");
    } catch (e) {
      notice($("logo-status"), e.message, "warn");
    } finally {
      input.value = "";
    }
  });

  $("logo-remove").addEventListener("click", async () => {
    notice($("logo-status"), "Removing…");
    try {
      const payload = await call({ action: "remove_logo" });
      render(payload);
      $("logo-filename").textContent = "PNG, JPG, SVG, PDF, EPS, or AI · up to 10 MB";
      notice($("logo-status"), "Removed.", "ok");
    } catch (e) {
      notice($("logo-status"), e.message, "warn");
    }
  });

  for (const button of document.querySelectorAll(".copy")) {
    button.addEventListener("click", async () => {
      const source = $(button.dataset.copy);
      if (!source) return;
      try {
        await navigator.clipboard.writeText(source.textContent.trim());
        const original = button.textContent;
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = original; }, 1600);
      } catch {
        // Clipboard access can be refused. Selecting the text is the honest
        // fallback: the words are still right there to copy by hand.
        const range = document.createRange();
        range.selectNodeContents(source);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });
  }

  function updateApproval() {
    const form = $("partner-form"); const yes = form.elements.posts_approval_required.value === "yes";
    $("approval-fields").hidden = !yes;
    form.elements.approval_contact_name.required = yes;
    form.elements.approval_contact_email.required = yes;
  }
  $("partner-form").elements.posts_approval_required.addEventListener("change", updateApproval);
  let documentId = null;
  async function loadDocuments() {
    try {
      const r = await fetch(base()+"/functions/v1/partner-documents",{method:"POST",headers:{"Content-Type":"application/json"},cache:"no-store",credentials:"omit",body:JSON.stringify({action:"list",table_token:token})});
      const d = await r.json(); if (!r.ok) throw Error(d.error || "Payment documents could not be loaded.");
      const dl = $("payment-details"); dl.replaceChildren();
      for (const [label,value] of [["Payment status",d.payment.status],["Total paid",d.payment.amount],["Balance due",d.payment.balance],["Date paid",d.payment.date]]) {
        if(!value) continue; const row=document.createElement("div"),dt=document.createElement("dt"),dd=document.createElement("dd");dt.textContent=label;dd.textContent=value;row.append(dt,dd);dl.append(row);
      }
      documentId=d.documents?.[0]?.id || null;$("document-actions").hidden=!documentId;
      notice($("documents-status"),documentId?"The receipt includes SALUTE’s EIN and the original payment receipt link.":d.message || "No receipt has been added yet. Please contact Shama for documentation.");
    } catch(e) {notice($("documents-status"),e.message,"warn");}
  }
  async function openReceipt(download) {
    if(!documentId)return;
    const tab=download?null:window.open("about:blank","_blank");
    $("receipt-view").disabled=$("receipt-download").disabled=true;
    try {
      const r=await fetch(base()+"/functions/v1/partner-documents",{method:"POST",headers:{"Content-Type":"application/json"},cache:"no-store",credentials:"omit",body:JSON.stringify({action:"download",table_token:token,document_id:documentId})});
      if(!r.ok){const d=await r.json();throw Error(d.error || "Unable to open receipt.");}
      const blob=await r.blob();if(blob.size<100 || blob.type!=="application/pdf")throw Error("The receipt file could not be loaded.");
      const url=URL.createObjectURL(blob);
      if(tab){tab.location.replace(url);}else{const a=document.createElement("a");a.href=url;a.download="SALUTE-Paid-Receipt.pdf";document.body.append(a);a.click();a.remove();}
      setTimeout(()=>URL.revokeObjectURL(url),300000);
    }catch(e){if(tab)tab.close();notice($("documents-status"),e.message,"warn");}
    finally{$("receipt-view").disabled=$("receipt-download").disabled=false;}
  }
  $("receipt-view").addEventListener("click",()=>openReceipt(false));
  $("receipt-download").addEventListener("click",()=>openReceipt(true));
  load().then(()=>{if(partner)loadDocuments();});
})();
