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
          setStatus(challengeError, "error");
        },
        "expired-callback": () => { needsReset = true; },
        "timeout-callback": () => {
          challengeError = "The security check timed out. Please try again and complete the security check below.";
          needsReset = true;
          setStatus(challengeError, "error");
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
      const response = await fetch(`${apiBase}/functions/v1/ambassador-interest`, {
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
      const payload = await response.json().catch(() => ({}));
      if (response.status === 429) throw new Error("Too many requests from this connection. Please wait a few minutes and try again.");
      if (!response.ok || payload.accepted !== true) throw new Error("We could not record your interest. Please try again shortly, or contact ssuite@salute.community.");
      form.hidden = true;
      success.hidden = false;
      success.focus();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "We could not record your interest. Please try again shortly.", "error");
      needsReset = true;
      submitButton.disabled = false;
    } finally {
      submitting = false;
    }
  }

  const ready = ambassadorCfg.enabled === true && apiBase && text(cfg.turnstileSiteKey);
  if (ready) {
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
