#!/usr/bin/env node
/* Deterministic source checks only. No service, Stripe, or browser calls occur. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = path.resolve(app, "../../backend/ssuite");
const readApp = (file) => readFile(path.join(app, file), "utf8");
const readBackend = (file) => readFile(path.join(backend, file), "utf8");
const visual = await readApp("donation-auction.css");
const [config, page, live, auction, donation, webhook, migration] = await Promise.all([
  readApp("config.js"), readApp("index.html"), readApp("donation-auction-live.js"),
  readBackend("auction-submission/index.ts"), readBackend("donation-create-checkout/index.ts"),
  readBackend("donation-stripe-webhook/index.ts"), readBackend("20260820170000_ssuite_donations_and_auction_review.sql"),
]);
assert.match(config, /mode:\s*"preview"/);
assert.match(config, /donation:\s*Object\.freeze\(\{ enabled: false/);
assert.match(config, /auction:\s*Object\.freeze\(\{ enabled: false/);
assert.match(page, /id="donation-form"/);
assert.match(page, /data-frequency="One-time"/);
assert.match(page, /data-frequency="Monthly"/);
assert.match(page, /id="custom-amount"/);
assert.match(page, /name="donor_name"/);
assert.match(page, /name="email"/);
assert.doesNotMatch(page, /dedication-toggle|dedication_type|honoree_name/);
assert.match(page, /id="employer-match-title"/);
assert.match(page, /SALUTE Foundation is listed in employer matching-gift databases/);
assert.match(page, /EIN 92-2955808/);
assert.match(page, /id="copy-matching-details"/);
assert.match(page, /id="auction-submission-form"/);
assert.match(page, /donation-auction-live\.js/);
assert.match(visual, /\.custom-amount\s*\{[^}]*grid-template-columns/);
assert.match(visual, /\.live-status\[data-kind="error"\]\s*\{[^}]*border-color:#000[^}]*background:#f4f4f4/);
assert.match(visual, /\.live-status\[data-kind="working"\]\s*\{[^}]*border-color:#000[^}]*background:#f4f4f4/);
assert.match(live, /cfg\.mode !== "live"/);
assert.match(live, /d\.enabled !== true/);
assert.match(live, /a\.enabled !== true/);
assert.match(live, /configuredTurnstileAction\(d\)/);
assert.match(live, /configuredTurnstileAction\(a\)/);
assert.match(live, /Idempotency-Key/);
assert.match(live, /checkout\.stripe\.com/);
assert.doesNotMatch(live, /dedication_type|honoree_name|employer_match_requested/);
assert.doesNotMatch(live, /localStorage|sessionStorage|document\.cookie|SUPABASE_SERVICE_ROLE/);
assert.match(donation, /SSUITE_DONATION_IP_HASH_SECRET/);
assert.match(donation, /TURNSTILE_EXPECTED_HOSTNAME/);
assert.match(donation, /SSUITE_DONATION_TURNSTILE_ACTION/);
assert.match(donation, /!EXPECTED_HOSTNAME \|\| !EXPECTED_ACTION/);
assert.match(donation, /payload\.hostname === EXPECTED_HOSTNAME/);
assert.match(donation, /payload\.action === EXPECTED_ACTION/);
assert.match(donation, /create_ssuite_donation_intent/);
assert.match(donation, /Idempotency-Key/);
assert.match(donation, /checkout\.stripe\.com/);
assert.match(donation, /p_dedication_type: "none"/);
assert.match(donation, /p_honoree_name: null/);
assert.match(donation, /p_employer_match_requested: false/);
assert.match(donation, /body\.dedication_type !== undefined/);
assert.match(webhook, /SSUITE_DONATION_STRIPE_WEBHOOK_SECRET/);
assert.match(webhook, /claim_ssuite_donation_webhook_event/);
assert.match(webhook, /invoice\.paid/);
assert.match(webhook, /payment_status !== "paid"/);
assert.match(auction, /TURNSTILE_EXPECTED_HOSTNAME/);
assert.match(auction, /SSUITE_AUCTION_TURNSTILE_ACTION/);
assert.match(auction, /!TURNSTILE_EXPECTED_HOSTNAME/);
assert.match(auction, /!TURNSTILE_EXPECTED_ACTION/);
assert.match(auction, /payload\.hostname === TURNSTILE_EXPECTED_HOSTNAME/);
assert.match(auction, /payload\.action === TURNSTILE_EXPECTED_ACTION/);
assert.match(migration, /create table if not exists public\.ssuite_donations/);
assert.match(migration, /create_ssuite_donation_intent/);
assert.match(migration, /finalize_ssuite_donation/);
assert.match(migration, /queue_ssuite_donation_receipt_after_payment/);
assert.match(migration, /new\.status='paid'/);
assert.match(migration, /auction_submission_review_audit/);
assert.match(migration, /review_ssuite_auction_submission/);
assert.match(migration, /enable row level security/);
for (const file of ["donation-auction-live.js", "config.js"]) {
  const checked = spawnSync(process.execPath, ["--check", path.join(app, file)], { encoding: "utf8" });
  assert.equal(checked.status, 0, `${file} syntax failed: ${checked.stderr}`);
}
console.log("donation and auction source verification passed");
