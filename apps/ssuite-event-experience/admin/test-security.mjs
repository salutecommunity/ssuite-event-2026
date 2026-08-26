#!/usr/bin/env node
/* Deterministic source-level checks: no network, deployment, mail, or database access. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const html = read("apps/ssuite-event-experience/admin/index.html");
const browser = read("apps/ssuite-event-experience/admin/admin.js");
const publicConfig = read("apps/ssuite-event-experience/admin/admin-config.js");
const api = read("backend/ssuite/admin-api/index.ts");
const migration = read("backend/ssuite/20260825010000_ssuite_admin_dashboard.sql");

assert(html.includes('value="ssuite@salute.community" readonly'), "admin email must be exact and readonly");
assert(browser.includes('const APPROVED_EMAIL = "ssuite@salute.community"'), "browser must use the exact approved email");
assert(browser.includes("signInWithOtp"), "browser must use passwordless OTP");
assert(browser.includes("verifyOtp"), "browser must support OTP verification");
assert(browser.includes("persistSession: false"), "browser session must not persist to local storage");
assert(!browser.includes("SERVICE_ROLE") && !html.includes("SERVICE_ROLE") && !publicConfig.includes("SUPABASE_SERVICE_ROLE_KEY"), "browser source must not contain service-role material");
assert(api.includes("db.auth.getUser(token)"), "API must custom-verify the bearer token with auth.getUser");
assert(api.includes("APPROVED_ADMIN_EMAIL") && api.includes("ssuite@salute.community"), "API must lock authorization to the approved email");
assert(api.includes("bootstrap_ssuite_sole_admin"), "API must use the guarded bootstrap RPC");
assert(api.includes('eq("role", "admin").eq("active", true)'), "API must require active admin staff membership");
assert(api.includes("MAX_EXPORT_ROWS = 5000"), "CSV exports must be bounded");
assert(api.includes("neutralizeFormula") && api.includes("^ *[=+\\-@]"), "CSV exports must neutralize spreadsheet formulas, including after leading spaces");
assert(api.includes("SUPABASE_SERVICE_ROLE_KEY") && !browser.includes("SUPABASE_SERVICE_ROLE_KEY"), "service-role use must remain server-side");
assert(migration.includes("insert into public.ssuite_staff_role_permissions(role, permission_code)"), "migration must grant admin existing permissions");
assert(migration.includes("bootstrap_ssuite_sole_admin") && migration.includes("pg_advisory_xact_lock"), "bootstrap must be race-safe");
assert(migration.includes("revoke all on function public.ssuite_admin_dashboard_overview") && migration.includes("to service_role"), "dashboard RPC must be service-role-only");
assert(!/sales_status\s*=\s*'open'/i.test(migration), "migration must not open sales");

// Parse sources without resolving remote imports or executing browser/server code.
const stripStaticImports = (source) => source.replace(/^import[^\n]+\n/gm, "");
const parsedBrowser = stripStaticImports(browser);
new Function(parsedBrowser);
const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
new Function(stripStaticImports(transpiler.transformSync(api)));
console.log("admin security source checks and syntax parsing passed");
