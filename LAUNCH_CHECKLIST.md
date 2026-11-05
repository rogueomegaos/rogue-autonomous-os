# RØGUE OS Production Launch Checklist

Last reviewed: 2026-11-05

## Verified
- [x] Main branch has a Vite frontend, Cloudflare Worker API, D1 migrations, and Node test suite.
- [x] Latest inspected validation job (commit `836e072`, 2026-10-30) passed `npm test` and `npm run build`.
- [x] Dashboard Settings reports `Source API authentication succeeded` for the token entered in that browser session.
- [x] Worker source includes a public health route, protected admin routes, RSS candidate intake, pending checkout orders, HMAC-signed generic payment-event intake, and paid-order gated download grants.
- [x] Cloudflare D1 was inspected directly. The initial schema tables existed, while payment/download-grant tables and migration ledger were missing; the missing tables and migration records were applied additively and then verified.
- [x] Registered Remote OK's public RSS feed in D1 with attribution guidance. Its entries remain candidates, not verified offers.
- [x] Merged Stripe Checkout Session creation, official Stripe signature verification, payment-event idempotency, server-side amount/currency checks, and paid-order download-grant issuance. This is code-level progress only, not a verified live payment flow.
- [x] Added automated tests for the Freebuff app CORS origin and fail-closed/forged-signature Stripe behavior.

## Blocking public launch
- [ ] Rotate the previously exposed admin token to a fresh random secret; verify valid token succeeds and missing/incorrect tokens return 401/403 on protected routes.
- [ ] Confirm the latest GitHub Actions run completes both validation and deployment. Earlier runs had Cloudflare D1 authorization errors; do not treat a green validation job as deployment success.
- [ ] Verify the live Worker health route reports `database: connected` after the additive D1 repair; ensure future Wrangler migration runs reconcile with the recorded migration ledger.
- [x] Confirm private R2 bucket `rogue-product-files` exists and is bound to the Worker as `PRODUCT_FILES`.
- [ ] Upload a harmless test asset, attach its key to a test product, and verify unauthorized/unpaid grants cannot download it; confirm the response is a private attachment.
- [ ] Configure Worker secrets `STRIPE_SECRET_KEY` (test-mode `sk_test_...`), `STRIPE_WEBHOOK_SECRET` (Stripe test endpoint signing secret), and `PUBLIC_APP_URL=https://roguehub.freebuff.app`. These were absent from the inspected Worker bindings. Never use a live key until sandbox tests pass.
- [ ] Register `POST /api/webhooks/stripe` in Stripe test mode and subscribe to `checkout.session.completed` and `checkout.session.async_payment_succeeded`; store the endpoint signing secret as `STRIPE_WEBHOOK_SECRET`.
- [ ] Test valid Stripe signature, invalid signature, timestamp replay outside 5-minute tolerance, duplicate event, amount/currency mismatch, and non-paid/async payment states in test mode.
- [ ] Test checkout -> Stripe test payment -> signed webhook -> paid order -> `/api/orders/download-link?session_id=...` -> R2 file download end-to-end. Verify an unpaid order cannot mint a grant or download.
- [ ] Configure a Stripe live endpoint and live secrets only after the test-mode checklist passes. No live charges or live payment objects were created by this change.
- [ ] Add monitoring/alerts, rate limits, idempotent retries, and a verified emergency stop before enabling scheduled or external side effects.

## Safety defaults
- Keep autonomous financial actions paused until all launch blockers above pass.
- RSS discovery must create candidates as `pending_review`; external source content is untrusted and must not trigger purchases or publish content automatically.
- Never store secrets in Git, browser local storage, logs, product assets, or public client code. The admin UI uses session storage, so rotate the token if the session or device is shared.
- Do not claim the service generates income until a real customer payment has settled and the funds are verified in the provider account.

## Known limitations
- A green GitHub validation job proves tests/build only. A successful deployment must be confirmed from the deploy logs and the live Worker version.
- Domain, payment-provider, email, AI inference, storage, and higher-volume usage may have fees or provider eligibility requirements; do not assume zero cost for all production traffic.
