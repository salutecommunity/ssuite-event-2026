# Quarantined email templates — do not deploy

These files were removed from the active template set on 2026-08-26. None of them
has a Klaviyo template ID in `../klaviyo-template-ids.json`, and none appears in
the relay allowlist (`SSUITE_KLAVIYO_ALLOWED_METRICS_JSON`), so none can be sent
today. They are kept here rather than deleted so the reasoning survives.

The approved set is exactly nine branded templates, `01-` through `09-`, plus
`10-admin-sign-in.html`, which is a Supabase Auth template and is not sent
through Klaviyo.

## `11-wallet-pass-update.html` — untruthful, must not ship as written

Asserts "Your S.Suite wallet pass information has been updated" and "Please use
the current pass issued to you for event access."

No wallet-pass provider has been selected, no passes have been issued, and
check-in operations are unchosen. The message states as fact something that does
not exist. It violates the standing rule against claiming an action the system
did not perform.

If wallet passes are adopted later, rewrite from scratch against the real
provider's behaviour. Do not reuse this copy.

## `10-auction-status-notification.html` — accurate, but premature

Copy is careful and makes no promise about publication, acceptance, valuation,
or tax treatment. The problem is operational, not editorial: there is no
approved auction review workflow, no approved lots, and no reveal date. Sending
status updates implies a review process that has not been defined.

Hold until auction operations are approved. The copy is a reasonable starting
point at that time.

## `paid-order-confirmation.html` + `paid-order-confirmation-assets.zip` — superseded duplicate

Legacy draft of what is now `01-paid-order-confirmation.html`. Two defects:

1. Carries a marketing **Unsubscribe** link in a payment receipt. A receipt is
   transactional; offering to unsubscribe from it is wrong, and Klaviyo
   transactional messages should not carry marketing unsubscribe footers.
2. Uses relative asset paths. Email clients cannot resolve them, so the logos
   would have broken. The active templates use externally hosted absolute URLs.

Superseded. Do not revive.
