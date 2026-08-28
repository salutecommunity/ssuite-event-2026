#!/usr/bin/env node
/* Deterministic source checks for the isolated browser-valid Turnstile path. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const backend = path.resolve(app, "../../backend/ssuite");
const readApp = (name) => readFile(path.join(app, name), "utf8");
const readBackend = (name) => readFile(path.join(backend, name), "utf8");

const [productionConfig, stagingConfig, productionPage, stagingPage, guestBrowser, guestFunction, runbook, ignore] = await Promise.all([
  readApp("config.js"),
  readApp("config.isolated-staging.example.js"),
  readApp("guest-registration.html"),
  readApp("guest-registration-isolated-staging.html"),
  readApp("guest-registration.js"),
  readBackend("guest-registration/index.ts"),
  readBackend("TURNSTILE_ISOLATED_STAGING.md"),
  readApp(".gitignore"),
]);

assert.match(productionConfig, /mode:\s*"preview"/);
assert.doesNotMatch(productionPage, /config\.isolated-staging/);
assert.match(stagingConfig, /mode:\s*"isolated-staging"/);
assert.match(stagingConfig, /1x00000000000000000000AA/);
assert.match(stagingConfig, /turnstileAction:\s*"guest-registration"/);
assert.doesNotMatch(stagingConfig, /TURNSTILE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|invitation_token|#token=/i);
assert.match(ignore, /^config\.isolated-staging\.js$/m);
assert.match(stagingPage, /config\.isolated-staging\.js/);
assert.match(stagingPage, /Isolated staging only/);
assert.match(stagingPage, /noindex,nofollow,noarchive/);

assert.match(guestBrowser, /cfg\.mode === "live" \|\| cfg\.mode === "isolated-staging"/);
assert.match(guestBrowser, /u\.protocol === "https:"/);
assert.match(guestBrowser, /turnstileAction\(\)/);
assert.match(guestBrowser, /action,.*error-callback/);
assert.match(guestBrowser, /history\.replaceState/);
assert.doesNotMatch(guestBrowser, /localStorage|sessionStorage|document\.cookie/);

assert.match(guestFunction, /TURNSTILE_EXPECTED_HOSTNAME/);
assert.match(guestFunction, /SSUITE_TURNSTILE_ACTION/);
assert.match(guestFunction, /TURNSTILE_VERIFY_TIMEOUT_MS=5000/);
assert.match(guestFunction, /AbortController/);
assert.match(guestFunction, /signal:controller\.signal/);
assert.match(guestFunction, /p\.hostname\.toLowerCase\(\)===EXPECTED_HOST/);
assert.match(guestFunction, /p\.action===EXPECTED_ACTION/);

// Configuration must fail closed when either exact Turnstile binding is absent.
assert.match(guestFunction, /!TURN\|\|!EXPECTED_HOST\|\|!EXPECTED_ACTION\|\|!originConfiguration\.valid/);
const verifyPosition = guestFunction.indexOf("await turn(req(x.turnstile_token");
const rpcPosition = guestFunction.indexOf('db.rpc("register_ssuite_invited_table_guest"');
assert.ok(verifyPosition >= 0 && rpcPosition > verifyPosition, "Turnstile must be verified before the registration RPC");
assert.match(runbook, /1x0000000000000000000000000000000AA/);
assert.match(runbook, /TURNSTILE_EXPECTED_HOSTNAME=localhost/);
assert.match(runbook, /SSUITE_TURNSTILE_ACTION=guest-registration/);
assert.match(runbook, /SSUITE_ALLOW_LOCAL_DEVELOPMENT=true/);
assert.match(runbook, /never.*production|production.*never/is);

console.log("isolated guest-registration Turnstile source verification passed");
