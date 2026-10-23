# Manual guests — disconnected preview, not release-ready

The Attendees tab now offers **Add guest → Complimentary individual** or **Table host / allocated seats**. Individual creation reuses the protected staff API. Allocated tables reserve five or ten seats including the host, with reason, approver and provenance. Next, staff add the host to seat 1 and use **Set table host** in Tables. This is deliberately a staged flow using existing protected operations, not an atomic host wizard.

The accompanying SQL is unapplied. It extends the existing table RPC and capacity trigger from ten-only to five-or-ten reserved seats, preserving paid-table validation, permissions, audit and idempotency. Attendee creation rejects an existing matching primary/secondary email under the existing event lock. A retry with the same request returns the stored result. No orders, paid revenue, receipt, consent, mail or credentials are created. Existing table assignment releases a separate reserved allocation, avoiding double counting.

## Preview safety

This branch's admin configuration is blank, so the dashboard cannot sign in or call production. Supply only an isolated development project's public configuration after applying and reviewing the migration there. Do not copy production credentials or invoke production writes for testing. No Supabase branch was created because branch costs require explicit approval.

## Remaining release blockers

1. Self-service management of **orderless reserved tables is not supported by current production backend**. `revealTableManagementLink` and `provision_ssuite_table_management_token` require a paid order and complete host. Do not weaken these checks merely to make this UI work. Review and extend all table-portal and registration-completion guards for provenance-backed reserved tables, with integration tests, before release. Historical Priscilla handling used a manually imported partner/half-table record; that must not be represented as new paid revenue for a complimentary allocation.
2. Host allocation is staged (table → attendee → set host), not the final simple all-in-one wizard.
3. Run database tests in an isolated schema: authorized/unauthorized calls; 5/10/invalid size; capacity exhaustion; retry same/changed request; duplicate primary/secondary email; host and guest share one claim; failed attendee insertion rollback; no email/consent/order changes. Existing source-level tests in this repository reference an absent historical monorepo and stale session policy, so cannot be used as current runtime assurance.
4. Guest self-completion currently triggers normal host email flow; no mail is sent by these new creation operations. Review that transition separately.

## Local checks

Run `bun tests/verify-manual-guests.mjs`. This checks JS syntax and source invariants only, not database execution or live browser interaction.
