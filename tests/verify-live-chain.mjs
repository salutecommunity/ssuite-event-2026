#!/usr/bin/env node
/* Deterministic source-level deployment harness. It makes no network calls. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const read = (name) => readFile(path.join(app, name), "utf8");
const config = await read("config.js");
const index = await read("index.html");
const checkout = await read("../../backend/ssuite/create-checkout/index.ts");
const checkoutMigration = await read("../../backend/ssuite/20260819235900_ssuite_checkout_hardening.sql");
const guestRegistration = await read("../../backend/ssuite/guest-registration/index.ts");
const tablePortal = await read("../../backend/ssuite/table-portal/index.ts");
const scripts = ["live-chain.js", "table-portal.js", "guest-registration.js"];

assert.match(config, /mode:\s*"preview"/, "the committed public config must remain preview-only");
assert.match(index, /data-ticket-code="salute_member"/);
assert.match(index, /data-ticket-code="community"/);
assert.match(index, /data-ticket-code="full_table"/);
assert.match(index, /id="checkout-turnstile"/);
assert.match(index, /data-policy-link="terms"/);
assert.match(index, /window\.SSuiteLive\?\.checkoutEnabled\(\)/, "live checkout must remain an explicit opt-in");
assert.match(checkout, /parseAllowedOrigins/, "checkout must strict-parse the origin allowlist");
assert.match(checkout, /SSUITE_ALLOW_LOCAL_DEVELOPMENT/, "HTTP must be an explicit local-only exception");
assert.match(checkoutMigration, /ssuite_policy_versions/, "checkout must read policy versions from server state");
assert.match(checkoutMigration, /configured_at is not null/, "checkout must fail before policies are configured");
assert.match(checkoutMigration, /is distinct from/, "checkout must compare submitted policy versions with server state");
assert.match(checkoutMigration, /v_policy\.terms_version[\s\S]*v_policy\.privacy_version[\s\S]*v_policy\.media_release_version/, "checkout consent must persist server-derived policy versions");
assert.match(checkoutMigration, /Submitted policy versions do not match current SSuite policies/, "modified client policy versions must fail");
assert.match(checkoutMigration, /Current SSuite policies are not configured/, "checkout must fail before policies are configured");
for (const [name, source] of [["guest-registration", guestRegistration], ["table-portal", tablePortal]]) {
  assert.match(source, /parseAllowedOrigins/, `${name} must strict-parse the origin allowlist`);
  assert.match(source, /SSUITE_ALLOW_LOCAL_DEVELOPMENT/, `${name} must make HTTP local-only`);
  assert.match(source, /parsed\.pathname[\s\S]*parsed\.search[\s\S]*parsed\.hash[\s\S]*parsed\.username[\s\S]*parsed\.password/, `${name} must allow origins only, without URL paths or credentials`);
  assert.match(source, /parsed\.protocol[\s\S]*localhost[\s\S]*127\.0\.0\.1[\s\S]*::1/, `${name} must restrict HTTP exceptions to local hosts`);
  assert.match(source, /MAX_REQUEST_BYTES/, `${name} must bound request bodies`);
  assert.match(source, /body\.getReader\(\)/, `${name} must stream request bodies`);
  assert.match(source, /TextDecoder\("utf-8",\{fatal:true\}\)/, `${name} must reject invalid UTF-8`);
  assert.doesNotMatch(source, /await (?:q|req)\.json\(\)/, `${name} must not use unrestricted req.json()`);
}
for (const script of scripts) {
  const source = await read(script);
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/, `${script} must not persist bearer tokens`);
  if (script !== "live-chain.js") assert.match(source, /history\.replaceState/, `${script} must remove URL fragments`);
  const result = spawnSync(process.execPath, ["--check", path.join(app, script)], { encoding: "utf8" });
  assert.equal(result.status, 0, `${script} syntax failed: ${result.stderr}`);
}
const portal = await read("table-portal.html");
const guest = await read("guest-registration.html");
const guestScript = await read("guest-registration.js");
assert.match(portal, /noindex,nofollow/);
assert.match(guest, /noindex,nofollow/);
assert.match(guestScript, /combined_agreement/);
console.log("live-chain source verification passed");
