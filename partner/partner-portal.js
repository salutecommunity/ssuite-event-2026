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
    const profile = partner.profile || {};
    const company = profile.organization_name || profile.recognition_name || partner.host_company || "your organization";
    $("headline").textContent = `Welcome, ${company}.`;
    $("intro").textContent = `We’re delighted to welcome ${company} as an S.SUITE ${tier.label}. Your partnership supports SALUTE’s work to expand access, visibility, and connection for South Asian women leaders and allies.`;
    $("coordinator-thanks").textContent = host ? `${partner.host_first_name}, thank you personally for helping bring this partnership to life. This is your team’s space to coordinate recognition, share materials, and manage your table for November 20.` : "Thank you for helping bring this partnership to life. This is your team’s space to coordinate recognition, share materials, and manage your table for November 20.";

    const filled = Number(partner.seats_filled || 0);
    const total = Number(partner.seat_count || 0);
    $("table-headline").textContent = partner.table_name || "Your table";
    $("table-summary").textContent = `${filled} of ${total} seats confirmed. Name your table and invite your guests from your table page, where you can also edit their details until November 13, 2026.`;
    $("table-link").href = `../table-portal.html#token=${token}`;

    const form = $("partner-form");
    form.elements.recognition_name.value = form.elements.recognition_name.value || profile.recognition_name || profile.organization_name || partner.host_company || "";
    for (const name of ["organization_bio", "website_url", "linkedin_url", "contact_name", "contact_email", "contact_phone"]) {
      const field = form.elements[name];
      if (field && !field.value) field.value = profile[name] || "";
    }
    countBioWords();
    if (!form.elements.contact_name.value && host) form.elements.contact_name.value = host;
    if (!form.elements.contact_email.value && partner.host_email) form.elements.contact_email.value = partner.host_email;

    const preference = profile.recognition_preference || "";
    for (const radio of document.querySelectorAll('input[name="recognition_preference"]')) radio.checked = radio.value === preference;
    const approval = profile.posts_approval_required || "";
    for (const radio of document.querySelectorAll('input[name="posts_approval_required"]')) radio.checked = radio.value === approval;
    const approvalFields = $("approval-contact-fields");
    approvalFields.hidden = approval !== "yes";
    for (const name of ["approval_contact_name", "approval_contact_email", "approval_guidelines"]) {
      const field = form.elements[name];
      field.value = approval === "yes" ? (profile[name] || "") : "";
      field.required = approval === "yes" && name !== "approval_guidelines";
    }
    updateDrafts(company, tier.label);
    $("logo-block").hidden = preference === "name";

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
      status(`${e.message} If this link no longer works, write to ssuite@salute.community and we will send a new one.`, "warn");
    }
  }

  function selectedPreference() {
    const chosen = document.querySelector('input[name="recognition_preference"]:checked');
    return chosen ? chosen.value : "";
  }
  function selectedApproval() {
    const chosen = document.querySelector('input[name="posts_approval_required"]:checked');
    return chosen ? chosen.value : "";
  }
  function updateApprovalFields() {
    const approval = selectedApproval();
    const fields = $("approval-contact-fields");
    fields.hidden = approval !== "yes";
    for (const name of ["approval_contact_name", "approval_contact_email", "approval_guidelines"]) {
      const field = $("partner-form").elements[name];
      field.required = approval === "yes" && name !== "approval_guidelines";
      if (approval !== "yes") field.value = "";
    }
  }
  function updateDrafts(company, tierLabel) {
    const safeCompany = company && company !== "your organization" ? company : "[Company]";
    $("draft-invite").textContent = $("draft-invite").textContent.replaceAll("[Company]", safeCompany);
    const tierArticle = tierLabel === "Associate Partner" ? "an" : "a";
    $("draft-social").textContent = $("draft-social").textContent.replaceAll("[Company]", safeCompany).replace(/as an Associate Partner/, `as ${tierArticle} ${tierLabel}`);
  }

  const bio = $("partner-form").elements.organization_bio;
  function countBioWords() {
    const words = bio.value.trim() ? bio.value.trim().split(/\s+/u).length : 0;
    $("bio-word-count").textContent = `${words} / 100 words${words > 100 ? " — please shorten your description" : ""}`;
    bio.setCustomValidity(words > 100 ? "Please limit the company description to 100 words." : "");
    return words;
  }
  bio.addEventListener("input", countBioWords);

  $("partner-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    if (countBioWords() > 100) { bio.reportValidity(); return; }
    if (!selectedPreference()) { notice($("form-status"), "Choose recognition by logo or by name.", "warn"); return; }
    if (!selectedApproval()) { notice($("form-status"), "Please tell us whether your communications team needs approval.", "warn"); return; }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    notice($("form-status"), "Saving…");
    try {
      const body = { action: "save_profile", recognition_preference: selectedPreference(), posts_approval_required: selectedApproval() };
      for (const name of ["recognition_name", "organization_bio", "website_url", "linkedin_url", "contact_name", "contact_email", "contact_phone", "approval_contact_name", "approval_contact_email", "approval_guidelines"]) {
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
  for (const radio of document.querySelectorAll('input[name="posts_approval_required"]')) {
    radio.addEventListener("change", updateApprovalFields);
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

  load();
})();
