# Manual guests — disconnected staff-management preview

**Add guest → Complimentary individual** creates a protected staff attendee record. **Add guest → Table host / allocated seats** is now one form and one atomic database operation: reserve five or ten seats including the host, create the host in seat 1, and set table lead. It collects guest facts, reason, approver and non-paid provenance. Host registration remains pending; staff do not claim personal consent. Staff manage the remaining seats from Tables using the existing protected guest/assignment controls.

No new orders, paid revenue, receipts, consent, mail or access credentials are created. Host/seat/lead failures roll back together. The parent request ledger guarantees retries return the original result and rejects changed payloads. Duplicate guest primary/secondary email checks run under the existing event row lock. Existing assignment releases separate reserved allocation so a guest does not count twice.

## Intentional self-service limitation

**Orderless allocated tables are staff-managed only.** Their self-service and completion-email controls are disabled with clear UI text. The preview admin API additionally refuses completion-link preparation for guests on orderless tables. Existing paid-order-only management-token guards remain intact. Historical Priscilla partner half-table handling is not reused to fabricate paid purchases for complimentary allocations.

This chooses the authorized safer staff-entry fallback rather than expanding the credential/portal/registration architecture without full isolated integration tests. Guests on these tables remain pending until a later reviewed consent/completion flow is supported. Staff may still edit factual details and seat assignments.

## Deployment artifacts (all unapplied)

- `migration.sql`: complete single-transaction migration. Includes the new atomic-host RPC and existing RPC/trigger extensions. **Do not apply `atomic-host.sql` separately after this**; it is the isolated wrapper source used by tests and is already included in the migration.
- `admin-api/index.ts`: preview replacement source for the existing `admin-api` Edge Function. Adds the authenticated atomic-host action and reserved-table completion guard. Retains existing custom bearer validation, sole approved account and active-admin checks. Its relative `../email-operations/_shared.ts` dependency is the existing backend dependency and must be included using the current backend deployment package. Do not upload this directory as a new standalone public function.
- `admin/admin.js`: atomic wizard, truthful staff-management notices, and disabled orderless self-service controls.
- `admin/admin-config.js`: intentionally blank configuration. The preview cannot sign in or call production.

Use only an isolated development project to review/apply the migration and Edge Function before release. No chargeable branch was provisioned and no production writes/deployments were made. The existing paid-table-only creation path remains separate; this host wizard excludes paid provenance entirely.

## Tests

From repository root:

```
bun tests/verify-manual-guests.mjs
bun -i tests/verify-atomic-host.mjs
```

Passed source/syntax checks plus **real local PostgreSQL (PGlite) wrapper tests with mocked existing child RPCs**: SQL compilation, atomic rollback after attendee failure, same-request retry, changed-payload refusal, unauthorized actor rejection, five/ten allocations, paid-provenance/order injection rejection, UI request construction, and API/browser syntax. No network database is used.

**Not tested:** full migration against actual Supabase schema; real capacity/duplicate triggers and RLS/grants; existing child RPC runtime; production packaging/dependency resolution; browser end-to-end. Existing source-level security test in this repository references absent historical monorepo paths/stale session policy and is not current runtime assurance. Before any release, isolated tests must verify capacity exhaustion, duplicate identity, reserved capacity versus paid revenue, all authorization layers, no-mail ledgers and rollback across real child RPCs.
