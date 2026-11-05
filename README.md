# RØGUE Autonomous Commerce OS

A modular foundation for opportunity discovery, lead intelligence, digital commerce, creative services and safe workflow orchestration.

> **Status: Foundation + guarded commerce APIs.** The dashboard is connected to a Cloudflare Worker and D1 database. It supports protected source registration, manual opportunity review, product drafts, creative briefs, a public published-product catalog, server-priced pending orders, signed payment-event intake and scheduled RSS candidate intake. It is **not yet a live payment-enabled store or fully autonomous agent**.

## Stack

- Vite static frontend
- Cloudflare Workers with Static Assets
- Cloudflare D1 for source, opportunity, product, order, payment-event, download-grant and audit records
- GitHub Actions for validation and optional guarded deployment

## Live foundation deployment

- Worker: https://rogue-autonomous-os.rogueomegaos.workers.dev
- Health endpoint: https://rogue-autonomous-os.rogueomegaos.workers.dev/api/health
- Public product catalog endpoint: https://rogue-autonomous-os.rogueomegaos.workers.dev/api/catalog
- D1 database: `rogue-autonomous-os` (APAC)

## Required account configuration

The Worker `ROGUE_ADMIN_TOKEN` secret binding is present, and the dashboard Settings page has reported `Source API authentication succeeded` after a token was entered. This confirms the dashboard's connection test, but does not independently prove every protected route or invalid-token rejection. Never commit the token to GitHub or source files. Because a token was previously exposed in conversation, rotate it to a fresh random value in Cloudflare and update the dashboard session value before public launch.

Additional configuration before commerce can go live:

- Stripe checkout requires Worker secrets `STRIPE_SECRET_KEY` (use `sk_test_...` first), `STRIPE_WEBHOOK_SECRET` (Stripe test endpoint signing secret), and `PUBLIC_APP_URL=https://roguehub.freebuff.app`. These credentials are not present in the inspected Worker bindings yet; checkout/webhook must fail closed until configured.
- A private R2 bucket `rogue-product-files` is now present and bound as `PRODUCT_FILES`. File upload, product asset mapping, and paid/unpaid download denial still require an end-to-end test.
- GitHub Actions uses repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Verify the latest run's deploy job; the historical 30 Oct 2026 run failed during D1 migration with Cloudflare error 7403. A green validation job is not proof that the latest code is deployed.
- D1 currently contains the payment-event and download-grant tables. The live Worker version must be checked after each deployment, and migrations must remain additive and reproducible.

## API status

- `GET /api/health`: public runtime/database health.
- `GET /api/catalog`: public published product metadata only.
- `POST /api/checkout`: creates a pending order from server-side MYR prices and requests a Stripe-hosted Checkout Session. It returns 503 until Stripe test credentials are configured.
- `POST /api/webhooks/stripe`: validates Stripe's signature over the exact raw body, rejects stale signatures, checks order amount/currency, and deduplicates event IDs.
- `GET /api/orders/download-link?session_id=...`: retrieves the Checkout Session from Stripe and requires a paid session plus a paid D1 order before issuing an expiring download grant.
- `GET /api/download?grant=<grant>`: requires a valid, unexpired grant, a paid order, a private `PRODUCT_FILES` binding, and a product asset attached in D1.
- `POST /api/products/<uuid>/publish`: protected admin endpoint to publish a draft product.
- Protected `/api/sources`, `/api/opportunities`, `/api/products`, `/api/creative-jobs`, and `/api/audit` endpoints require the admin token.

## Scheduled opportunity intake

The Worker checks registered RSS sources every six hours. It limits source count, response size and request time, blocks redirects, and records candidates as `pending_review`; it does not automatically mark opportunities legitimate or perform paid/external actions. Only public HTTPS feed URLs should be registered. The Cloudflare Worker schedule is configured, but the latest Worker deployment and a successful scheduled execution still need verification. Discovery currently supports RSS feeds only; registering Upwork or Freelancer website URLs does not make their pages machine-readable. Use official APIs or authorized feeds where available.

## Local development

Requires a current Node.js LTS release.

```bash
npm install
npm run dev
npm test
npm run build
```

## Cloudflare setup

```bash
npx wrangler d1 migrations apply rogue-autonomous-os --remote
npm run build
npm run cf:deploy
```

GitHub Actions validates tests and the production build on pushes and pull requests. On pushes to `main`, it applies D1 migrations and deploys only when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are configured as repository Actions secrets. Check the deploy job logs for `Deployment skipped`; job success alone does not mean deployment occurred.

## Security and launch limits

- External content is untrusted and must remain subject to review.
- No product is paid until a provider event is authenticated and amount/currency match.
- The webhook is a generic signed contract, not a ready-made Stripe, ToyyibPay or Billplz adapter.
- Private file delivery is blocked until the R2 binding and asset keys are configured.
- Autonomous actions should remain paused until payment, monitoring, budget limits, retries and an emergency stop are verified.
- Free-tier quotas and provider pricing can change; domain, payment, AI, email, storage and high-volume usage may incur costs.
