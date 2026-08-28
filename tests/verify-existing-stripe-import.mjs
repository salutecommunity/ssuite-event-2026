#!/usr/bin/env node
/* Deterministic source verification only. No database, Stripe, or email call occurs. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = path.resolve(app, "../../backend/ssuite/20260824220000_ssuite_existing_verified_stripe_table_imports.sql");
const migration = await readFile(migrationPath, "utf8");

assert.match(migration, /begin;[\s\S]*commit;/, "migration must be transactional");
assert.match(migration, /ssuite_existing_stripe_import_write/, "import must require a dedicated staff permission");
assert.match(migration, /private\.require_ssuite_staff_permission\(p_actor_user_id,'ssuite_existing_stripe_import_write'\)/);
assert.match(migration, /source text not null default 'existing_verified_stripe_payment'/);
assert.match(migration, /'commerce_source','existing_verified_stripe_payment'/);
assert.match(migration, /A Stripe PaymentIntent or Checkout Session identifier is required/);
assert.match(migration, /ssuite_existing_stripe_import_payment_intent_uq/);
assert.match(migration, /ssuite_existing_stripe_import_checkout_session_uq/);
assert.match(migration, /pg_advisory_xact_lock/, "concurrent imports must serialize by Stripe identifier");
assert.match(migration, /Stripe identifiers map to different existing imports/);
assert.match(migration, /credential_returned',false/, "replays must not return a raw credential");
assert.match(migration, /null::text,false,v_import\.credential_delivery_status/);
assert.match(migration, /v_credential:=encode\(extensions\.gen_random_bytes\(32\),'hex'\)/);
assert.match(migration, /v_credential_hash:=encode\(extensions\.digest\(v_credential,'sha256'\),'hex'\)/);
assert.match(migration, /token_hash,token_version,status,expires_at/);
assert.match(migration, /The raw credential exists only in this function result/);
assert.doesNotMatch(
  migration.match(/create table if not exists public\.ssuite_existing_stripe_payment_imports[\s\S]*?\n\);/)?.[0] ?? "",
  /credential_plaintext|table_management_credential|raw_credential/i,
  "the import record must never persist plaintext credential material",
);
assert.match(migration, /select p_event_id,v_order,v_item,gs\.seat_index from generate_series\(1,10\) as gs\(seat_index\)/);
assert.match(migration, /values\(p_event_id,v_table,1,v_lead\)/);
assert.match(migration, /generate_series\(2,10\) as gs\(seat_number\)/);
assert.match(migration, /v_paid_used\+v_active_holds\+10>v_event\.paid_capacity/);
assert.match(migration, /credential_delivery_status text not null default 'hold'/);
assert.match(migration, /o\.metadata->>'delivery_status'='hold'/, "legacy table-token email queue must honor held imports");
assert.match(migration, /return null;[\s\S]*Active table access token is required/, "held imports must suppress rather than enqueue delivery");
assert.doesNotMatch(migration, /insert into public\.(?:invitations|communication_deliveries|ssuite_email_outbox)\b/i, "the import may not queue invitations or email");
assert.match(migration, /prevent_ssuite_existing_stripe_import_audit_mutation/);
assert.match(migration, /guard_ssuite_existing_stripe_payment_import/);
assert.match(migration, /correct_ssuite_existing_stripe_payment_import/);
assert.match(migration, /credential_plaintext','table_management_credential','raw_credential'/, "correction metadata must reject credential material");
assert.match(migration, /revoke_ssuite_existing_stripe_payment_import/);
assert.match(migration, /table_management_tokens set status='revoked'/);
assert.doesNotMatch(migration, /\bfetch\s*\(|stripe\.com|payment_intents\.create|checkout\.sessions\.create/i, "the migration must not create or call a Stripe charge flow");

console.log("existing verified Stripe table import source verification passed");
