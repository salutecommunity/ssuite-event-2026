(() => {
  "use strict";
  const cfg = window.SSUITE_CONFIG || {};
  const ambassadorCfg = cfg.ambassador && typeof cfg.ambassador === "object" ? cfg.ambassador : {};
  const form = document.getElementById("ambassador-form");
  const statusEl = document.getElementById("ambassador-status");
  const submitButton = document.getElementById("ambassador-submit");
  const success = document.getElementById("ambassador-success");
  const slot = document.getElementById("ambassador-turnstile");
  if (!form || !statusEl || !submitButton || !success || !slot) return;

  const text = (value) => typeof value === "string" ? value.trim() : "";
  const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const apiBase = (() => {
    try {
      const url = new URL(text(cfg.apiBase));
      return url.protocol === "https:" && !url.username && !url.password ? url.origin : "";
    } catch { return ""; }
  })();

  function setStatus(message, kind = "") {
    statusEl.textContent = message;
    statusEl.dataset.kind = kind;
    statusEl.hidden = !message;
    if (kind !== "error") hideFallback();
  }

  // ---- Draft preservation: a failed attempt or reload never loses what someone typed. ----
  // sessionStorage stays in this browser tab only and is cleared on success.
  const DRAFT_KEY = "ssuite-ambassador-draft-v1";
  function saveDraft() {
    try {
      const data = {};
      for (const name of ["first_name", "last_name", "email", "job_title", "company", "salute_relationship"]) data[name] = value(name);
      data.motivations = selectedMotivations();
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(data));
    } catch { /* storage unavailable: nothing to preserve */ }
  }
  function restoreDraft() {
    try {
      const data = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null");
      if (!data || typeof data !== "object") return;
      for (const [name, v] of Object.entries(data)) {
        if (name === "motivations" || typeof v !== "string") continue;
        const field = form.elements.namedItem(name);
        if (field && !field.value) field.value = v;
      }
      if (Array.isArray(data.motivations)) {
        form.querySelectorAll('input[name="motivations"]').forEach((box) => { if (data.motivations.includes(box.value)) box.checked = true; });
      }
    } catch { /* ignore a malformed draft */ }
  }
  function clearDraft() { try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } }

  // ---- Fallback: if the form cannot submit, interest can still reach the team by email. ----
  const fallback = document.createElement("p");
  fallback.className = "fineprint";
  fallback.hidden = true;
  statusEl.insertAdjacentElement("afterend", fallback);
  function hideFallback() { fallback.hidden = true; }
  function showFallback() {
    const lines = [
      "I'd like to express my interest in serving as an S.Suite Ambassador.",
      "",
      `Name: ${value("first_name")} ${value("last_name")}`.trim(),
      `Email: ${value("email")}`,
      `Title: ${value("job_title")}`,
      `Company: ${value("company")}`,
      `Connection to SALUTE: ${form.elements.namedItem("salute_relationship")?.selectedOptions?.[0]?.textContent || ""}`
    ];
    const href = `mailto:ssuite@salute.community?subject=${encodeURIComponent("S.Suite Ambassador Interest")}&body=${encodeURIComponent(lines.join("\n"))}`;
    fallback.textContent = "";
    fallback.append("Still having trouble? ");
    const link = document.createElement("a");
    link.href = href;
    link.textContent = "Email your interest to ssuite@salute.community";
    fallback.append(link, " and we will follow up.");
    fallback.hidden = false;
  }
  function fail(message) {
    setStatus(message, "error");
    showFallback();
  }

  let turnstileLoad;
  let widgetId;
  let challengeError = "";
  let needsReset = false;
  let submitting = false;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (turnstileLoad) return turnstileLoad;
    turnstileLoad = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      const fail = () => {
        clearTimeout(timer);
        script.remove();
        reject(new Error("The security check could not load. Check your connection or content blocker, then try again."));
      };
      const timer = setTimeout(fail, 20000);
      script.onload = () => {
        clearTimeout(timer);
        if (window.turnstile) resolve(window.turnstile);
        else fail();
      };
      script.onerror = fail;
      document.head.appendChild(script);
    }).catch((error) => { turnstileLoad = undefined; throw error; });
    return turnstileLoad;
  }

  async function warmTurnstile() {
    if (widgetId !== undefined) return widgetId;
    const api = await loadTurnstile();
    if (widgetId === undefined) {
      widgetId = api.render(slot, {
        sitekey: text(cfg.turnstileSiteKey),
        action: text(ambassadorCfg.turnstileAction) || "ambassador-interest",
        callback: () => { challengeError = ""; needsReset = false; },
        "error-callback": () => {
          challengeError = "The security check failed. Please try again, and allow challenges.cloudflare.com if you use a content blocker.";
          needsReset = true;
          fail(challengeError);
        },
        "expired-callback": () => { needsReset = true; },
        "timeout-callback": () => {
          challengeError = "The security check timed out. Please try again and complete the security check below.";
          needsReset = true;
          fail(challengeError);
        }
      });
    }
    return widgetId;
  }

  async function turnstileToken() {
    const api = await loadTurnstile();
    const id = await warmTurnstile();
    if (needsReset) {
      challengeError = "";
      needsReset = false;
      api.reset(id);
    }
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (challengeError) throw new Error(challengeError);
      const value = api.getResponse(id);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    needsReset = true;
    throw new Error("The security check has not cleared. Please try again and complete the security check below, or contact ssuite@salute.community.");
  }

  function value(name) {
    const field = form.elements.namedItem(name);
    return field ? text(field.value) : "";
  }

  function selectedMotivations() {
    return [...form.querySelectorAll('input[name="motivations"]:checked')].map((field) => field.value);
  }

  async function submit() {
    if (submitting) return;
    setStatus("", "");
    if (!form.reportValidity()) return;
    const email = value("email").toLowerCase();
    if (!emailPattern.test(email)) {
      setStatus("Please enter a valid email address.", "error");
      return;
    }
    const motivations = selectedMotivations();
    if (!motivations.length) {
      setStatus("Please select at least one reason you are interested in serving.", "error");
      form.querySelector('input[name="motivations"]')?.focus();
      return;
    }

    submitting = true;
    submitButton.disabled = true;
    setStatus("Completing the security check… Please complete any challenge shown below.", "working");
    try {
      const token = await turnstileToken();
      setStatus("Submitting your interest…", "working");
      let response;
      try {
        response = await fetch(`${apiBase}/functions/v1/ambassador-interest`, {
          method: "POST",
          mode: "cors",
          credentials: "omit",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          first_name: value("first_name"),
          last_name: value("last_name"),
          email,
          job_title: value("job_title"),
          company: value("company"),
          salute_relationship: value("salute_relationship"),
          motivations,
          consent_accepted: form.elements.namedItem("consent")?.checked === true,
          privacy_version: text(ambassadorCfg.privacyUrl) || cfg.policy?.privacyVersion || "",
          turnstile_token: token
          })
        });
      } catch {
        throw new Error("We couldn't reach our server. Please check your connection and submit again — your answers are saved on this page.");
      }
      const payload = await response.json().catch(() => ({}));
      if (response.status === 429) throw new Error("Too many requests from this connection. Please wait a few minutes and try again.");
      if (payload.reason === "security_check") throw new Error("The security check expired before we could confirm it. Please complete the check below again, then submit — your answers are saved.");
      if (payload.reason === "invalid") throw new Error("Please review your answers and try again.");
      if (!response.ok || payload.accepted !== true) throw new Error("We could not record your interest. Please try again shortly — your answers are saved on this page.");
      clearDraft();
      setStatus("", "");
      form.hidden = true;
      form.style.display = "none";
      success.hidden = false;
      success.focus();
    } catch (error) {
      fail(error instanceof Error ? error.message : "We could not record your interest. Please try again shortly.");
      needsReset = true;
      submitButton.disabled = false;
    } finally {
      submitting = false;
    }
  }

  const ready = ambassadorCfg.enabled === true && apiBase && text(cfg.turnstileSiteKey);
  if (ready) {
    restoreDraft();
    form.addEventListener("input", saveDraft);
    form.addEventListener("change", saveDraft);
    submitButton.textContent = "Submit My Interest";
    submitButton.disabled = false;
    submitButton.removeAttribute("aria-disabled");
    const prepare = () => warmTurnstile().catch((error) => setStatus(error.message, "error"));
    form.addEventListener("focusin", prepare);
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          prepare();
        }
      }, { rootMargin: "200px" });
      observer.observe(form);
    }
  } else {
    submitButton.textContent = "Interest form unavailable";
    setStatus("The interest form is unavailable right now. Please contact ssuite@salute.community.", "error");
    form.querySelectorAll("input, select, textarea").forEach((field) => { field.disabled = true; });
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit().catch(() => {});
  });
})();
