# S.Suite event experience domains

## Confirmed public production origin

- `https://event.ssuite.org`
- Confirmed by Neha Singh on 2026-08-20 and reconfirmed on 2026-08-26 as the only supported public event hostname.
- Purpose: standalone S.Suite event commerce and participant experience, including Attend, Give, Auction intake, table management, and guest registration.

## Required routes

- Public experience: `https://event.ssuite.org/`
- Table-lead portal: `https://event.ssuite.org/table-portal.html`
- Seat-specific guest registration: `https://event.ssuite.org/guest-registration.html`

## Unsupported aliases

- `events.ssuite.org` is not required, will not be promoted or linked, and its HTTPS state is not a launch gate per Neha Singh's direction on 2026-08-26.
- Do not make speculative DNS or certificate changes for the plural hostname.

## Guardrails

- Do not alter or replace the active `https://ssuite.org/` Showit site, shared canvas, navigation, or published pages.
- DNS work must add only the `event` subdomain record.
- Keep the standalone experience in preview/draft until production launch gates pass.
- Staging may allow localhost solely within the isolated Supabase preview branch; remove local-development allowances and use production Turnstile credentials before launch.
- Do not publish legal acceptance, sales, live email delivery, SMS, auction bidding, or start time until their respective approvals and end-to-end tests pass.
