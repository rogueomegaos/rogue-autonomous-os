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

The live Worker currently has **no Worker secrets configured**. Protected writes therefore remain read-only until an administrator configures a strong `ROGUE_ADMIN_TOKEN` secret (at least 32 characters) in Cloudflare Workers & Pages → `rogue-autonomous-os` → Settings → Variables and Secrets, then enters the same value in the app Settings page. Never commit secrets to GitHub or source files.

Additional configuration before commerce can go live:

- `PAYMENT_WEBHOOK_SECRET`: at least 32 random characters. The generic webhook expects an HMAC-SHA256 signature in `X-Rogue-Signature: sha256=<hex>` over the exact raw JSON request body. A provider-specific adapter is still required before connecting a real payment provider.
- Bind a private Cloudflare R2 bucket to the Worker as `PRODUCT_FILES`. Store digital assets there and set each product's `asset_key` through a controlled admin workflow before enabling customer downloads.
- Add GitHub repository Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to enable the guarded auto-deploy job. Without these, CI validates but deployment is skipped.
- Ensure the D1 migrations are applied before enabling the new payment event and download-grant routes.

## API status

- `GET /api/health`: public runtime/database health.
- `GET /api/catalog`: public published product metadata only.
- `POST /api/checkout`: creates a pending order using server-side prices. It does not collect payment or mark an order paid.
- `POST /api/webhooks/payment`: accepts normalized payment events only when a valid HMAC secret is configured; amount and currency are checked against the stored order and event IDs are idempotent.
- `GET /api/download?grant=<grant>`: requires a valid order grant, a paid order and the private `PRODUCT_FILES` binding. A product asset must be attached first.
- `POST /api/products/<uuid>/publish`: protected admin endpoint to publish a draft product.
- Protected `/api/sources`, `/api/opportunities`, `/api/products`, `/api/creative-jobs`, and `/api/audit` endpoints require the admin token.

## Scheduled opportunity intake

The Worker checks registered RSS sources every six hours. It limits source count, response size and request time, blocks redirects, and records candidates as `pending_review`; it does not automatically mark opportunities legitimate or perform paid/external actions. Only public HTTPS feed URLs should be registered. The scheduled handler must be deployed before cron runs can be considered active.

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

GitHub Actions validates tests and the production build on pushes and pull requests. On pushes to `main`, it applies D1 migrations and deploys only when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are configured as repository Actions secrets.

## Security and launch limits

- External content is untrusted and must remain subject to review.
- No product is paid until a provider event is authenticated and amount/currency match.
- The webhook is a generic signed contract, not a ready-made Stripe, ToyyibPay or Billplz adapter.
- Private file delivery is blocked until the R2 binding and asset keys are configured.
- Autonomous actions should remain paused until payment, monitoring, budget limits, retries and an emergency stop are verified.
- Free-tier quotas and provider pricing can change; domain, payment, AI, email, storage and high-volume usage may incur costs.
