# RØGUE Autonomous Commerce OS

A modular foundation for opportunity discovery, lead intelligence, digital commerce, creative services and safe workflow orchestration.

> **Status: Foundation 0.1.0.** The responsive dashboard and initial Cloudflare Worker/D1 scaffolding are committed. This is not yet a production-ready autonomous agent. The current source registry is held in browser memory only; discovery, authentication, payments and file delivery are not implemented.

## Stack

- Vite static frontend
- Cloudflare Workers with Static Assets
- Cloudflare D1 schema for future persistent records
- GitHub as source control and deployment source

## Live foundation deployment

- Worker: https://rogue-autonomous-os.rogueomegaos.workers.dev
- Health endpoint: https://rogue-autonomous-os.rogueomegaos.workers.dev/api/health
- Cloudflare D1 database: `rogue-autonomous-os` (APAC)
- Runtime: Cloudflare Workers
- Admin API: protected by the `ROGUE_ADMIN_TOKEN` Worker secret

The Worker and D1 database have been created. The current live deployment is a snapshot uploaded through the Cloudflare API; GitHub pushes do not yet auto-deploy. The admin secret is not configured automatically by this repository setup, so protected source management remains locked until a secret is set in Cloudflare. In Cloudflare Dashboard, open **Workers & Pages → rogue-autonomous-os → Settings → Variables and Secrets**, add a secret named `ROGUE_ADMIN_TOKEN` with a random value of at least 32 characters, then enter the same value under **Settings** inside the app. Do not commit the token to GitHub or place it in a source file.

## Local development

Requires a current Node.js LTS release.

```bash
npm install
npm run dev
```

Create a production frontend build:

```bash
npm run build
npm run preview
```

## Cloudflare setup

1. Install dependencies with `npm install`.
2. Create a D1 database named `rogue-autonomous-os` in your Cloudflare account.
3. Replace the placeholder `database_id` in `wrangler.toml` with the real D1 database ID.
4. Apply the schema using the Wrangler CLI:

   ```bash
   npx wrangler d1 migrations apply rogue-autonomous-os --remote
   ```

5. Build and deploy:

   ```bash
   npm run build
   npm run cf:deploy
   ```

The Worker health route is `GET /api/health`. It reports whether the D1 binding is configured and reachable. The other `/api/*` routes deliberately return `501 Not Implemented` until they are built.

## Project structure

- `src/main.js` — dashboard UI and source registry prototype
- `src/style.css` — responsive matte-dark RØGUE interface
- `worker/index.js` — Cloudflare Worker entry point and health endpoint
- `migrations/0001_initial.sql` — initial D1 schema for sources, opportunities, products, orders, creative jobs and audit events
- `wrangler.toml` — Worker, static assets and D1 binding configuration

## Architecture roadmap

1. Foundation UI and runtime health
2. Persistent Sources & Integrations API with input validation
3. Secure source fetching with SSRF protections, allowlists, size/time limits and evidence capture
4. Opportunity discovery, verification, scoring and review workflow
5. Product catalog, orders, verified payment webhooks and time-limited private downloads
6. Creative-service jobs and private asset delivery
7. OMEGA orchestration, audit logs, rate limits, retries and emergency stop
8. CI checks and controlled Cloudflare deployment

## Security principles

- Never put API keys or payment secrets in browser code or Git.
- Treat fetched web pages and external feeds as untrusted input.
- Block loopback, private, link-local and metadata IP ranges during server-side URL resolution; re-check redirects and DNS results to defend against SSRF.
- Verify payment webhook signatures and use idempotency before marking orders paid.
- Keep original customer assets private and issue short-lived download URLs only after authorization.
- Keep autonomous actions paused until permissions, budgets, monitoring and a reliable stop mechanism exist.

## Cost note

The starter is designed to use free-tier-friendly services where available. Provider quotas and pricing can change. Domain registration, payment processing, AI generation, email and high-volume storage or compute may incur costs.
