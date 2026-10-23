# Manual guests — disconnected preview

Draft PR #2 adds **Add guest → Complimentary individual** and **Add guest → Table host / allocated seats**. The host form atomically reserves five/ten seats including the host, creates the host in seat 1 and assigns table lead. It records provenance, reason and approver. Failures roll back together; identical request retries return the original result and changed retries fail. Existing capacity and duplicate checks remain in place.

Saving creates no paid order, revenue, receipt, consent, automatic email or management credential. Staff manage the remaining seats using Tables. Personal registration remains pending until the guest completes it themselves.

## Optional normal guest email

Save never queues an email. A separate control shows the recipient/outbox status and asks staff to confirm the send. Pending guests receive the existing `ssuite_finish_registration`; completed guests receive `ssuite_guest_registration_confirmation` through the existing audited outbox/dispatcher. Stable idempotency keys reuse the same email on retries. Queued/accepted is not delivered. Failed/suppressed messages require staff review, not blind resend.

The protected RPC requires staff permission, non-paid provenance and an active allocation. The completed personal-link dispatcher validates recipient, completion, expiry, revocation and reconstructed token hash. No paid receipt template is selected. The paid-table-access completion trigger requires a real paid order; reserved hosts do not automatically receive that template.

**Allocated tables remain staff-managed.** Personal registration/confirmation emails do not grant table-management access. Existing paid-order-only management-token guards remain intact. Historical partner table imports are not used to fabricate paid purchases.

The remote provider templates' wording/rendering has not been verified by these local tests. Review both actual templates before release. The separate TEST HTML is a design/content preview, not an exact live template rendering or end-to-end delivery test. No actual provider send was performed.

## Unapplied deployment artifacts

- `migration.sql`: complete single-transaction migration including `atomic-host.sql` and `optional-confirmation.sql`. Do not apply those isolated sources separately afterward.
- `admin-api/index.ts`: preview replacement for the existing authenticated admin Edge Function. Retains existing bearer, approved-account and active-admin checks. Package its existing `../email-operations/_shared.ts` dependency with the backend; this directory is not a standalone public function.
- `email-operations-dispatch/index.ts`: existing dispatcher extended to support completed personal registration links; package existing shared dependencies.
- `admin/admin.js`: atomic wizard and optional email controls.
- `complete-registration.js`: truthful personal completion language, no implication of orderless table portal access.
- `admin/admin-config.js`: deliberately blank/disconnected from production.

No migration, deployment, live guest/outbox write or chargeable branch was performed. Apply only after isolated integration review.

## Local tests

From repository root:

```
bun tests/verify-manual-guests.mjs
bun -i tests/verify-atomic-host.mjs
bun -i tests/verify-optional-confirmation.mjs
```

Passed syntax/source checks and PGlite PostgreSQL tests with mocked existing child RPCs/queue: atomic rollback, retry deduplication, changed-payload refusal, authorization, five/ten seats, paid-provenance/order injection refusal, optional pending/completed templates, audit once and delivery-status reporting. Mocked dispatcher tests exercise both link derivations and wrong-recipient/revoked/expired/pending rejection.

**Not tested:** full Supabase migration, actual child RPCs, capacity/duplicate triggers, RLS/grants, real outbox/idempotency/compliance holds, provider delivery/templates, Edge Function packaging, personal-registration and browser end-to-end. Existing repository security tests reference absent historical monorepo paths/stale session policy. This draft is not release-ready until isolated integration and template review pass.
