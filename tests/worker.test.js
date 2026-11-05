import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

test('health endpoint reports service status without exposing secrets', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/health'), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'rogue-autonomous-os');
  assert.equal(body.autonomy, 'paused');
  assert.equal(body.database, 'unconfigured');
});

test('protected source API rejects requests without an admin token', async () => {
  const db = { prepare() { return { first: async () => ({ ok: 1 }), all: async () => ({ results: [] }), bind() { return this; }, run: async () => ({ success: true }) }; } };
  const response = await worker.fetch(new Request('https://example.test/api/sources'), { DB: db, ROGUE_ADMIN_TOKEN: 'x'.repeat(40) });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'unauthorized');
});

test('unknown API paths return a structured 404 when authorized', async () => {
  const db = { prepare() { return { first: async () => ({ ok: 1 }), all: async () => ({ results: [] }), bind() { return this; }, run: async () => ({ success: true }) }; } };
  const token = 'a'.repeat(64);
  const response = await worker.fetch(new Request('https://example.test/api/not-real', { headers: { authorization: 'Bearer ' + token } }), { DB: db, ROGUE_ADMIN_TOKEN: token });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'not_found');
});

function mockDb() {
  return {
    prepare() {
      return {
        first: async () => ({ ok: 1 }),
        all: async () => ({ results: [] }),
        bind() { return this; },
        run: async () => ({ success: true, meta: { changes: 1 } }),
      };
    },
  };
}

test('source API rejects private IPv4 URLs before persistence', async () => {
  const token = 'b'.repeat(64);
  const response = await worker.fetch(new Request('https://example.test/api/sources', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Private source', type: 'website', url: 'http://10.0.0.5/admin' }),
  }), { DB: mockDb(), ROGUE_ADMIN_TOKEN: token });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_url');
});

test('source API persists a valid public HTTPS source', async () => {
  const token = 'c'.repeat(64);
  const response = await worker.fetch(new Request('https://example.test/api/sources', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Official opportunities', type: 'website', url: 'https://example.org/offers', notes: 'Public source' }),
  }), { DB: mockDb(), ROGUE_ADMIN_TOKEN: token });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.url, 'https://example.org/offers');
  assert.equal(body.status, 'registered');
});

test('CORS allows the deployed Worker origin but not arbitrary sites', async () => {
  const allowed = await worker.fetch(new Request('https://example.test/api/health', {
    headers: { origin: 'https://rogue-autonomous-os.rogueomegaos.workers.dev' },
  }), {});
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://rogue-autonomous-os.rogueomegaos.workers.dev');
  const denied = await worker.fetch(new Request('https://example.test/api/health', {
    headers: { origin: 'https://attacker.example' },
  }), {});
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('manual discovery endpoint requires admin auth and returns a safe empty summary', async () => {
  const token = 'd'.repeat(64);
  const db = {
    prepare() {
      return {
        first: async () => ({ ok: 1 }),
        all: async () => ({ results: [] }),
        bind() { return this; },
        run: async () => ({ success: true, meta: { changes: 1 } }),
      };
    },
  };
  const denied = await worker.fetch(new Request('https://example.test/api/discovery/run', { method: 'POST', body: '{}' }), { DB: db, ROGUE_ADMIN_TOKEN: token });
  assert.equal(denied.status, 401);
  const allowed = await worker.fetch(new Request('https://example.test/api/discovery/run', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: '{}',
  }), { DB: db, ROGUE_ADMIN_TOKEN: token });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { ok: true, feeds_checked: 0, candidates_added: 0, feeds_failed: 0 });
});

test('admin login exchanges the secret for a secure HttpOnly cookie without returning it', async () => {
  const token = 'e'.repeat(64);
  const response = await worker.fetch(new Request('https://example.test/api/admin/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }), { ROGUE_ADMIN_TOKEN: token });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie') || '';
  assert.match(cookie, /rogue_admin_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=604800/);
  assert.equal((await response.text()).includes(token), false);
});

test('admin session cookie authorizes protected API and logout clears it', async () => {
  const token = 'f'.repeat(64);
  const db = mockDb();
  const response = await worker.fetch(new Request('https://example.test/api/sources', {
    headers: { cookie: 'rogue_admin_session=' + token },
  }), { DB: db, ROGUE_ADMIN_TOKEN: token });
  assert.equal(response.status, 200);
  const logout = await worker.fetch(new Request('https://example.test/api/admin/session', { method: 'DELETE' }), { ROGUE_ADMIN_TOKEN: token });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/);
});

test('admin session exchange rejects an invalid token', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/admin/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'wrong-token' }),
  }), { ROGUE_ADMIN_TOKEN: 'g'.repeat(64) });
  assert.equal(response.status, 401);
});


test('CORS allows the configured Freebuff app origin', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/health', {
    headers: { origin: 'https://roguehub.freebuff.app' },
  }), {});
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://roguehub.freebuff.app');
});

test('Stripe checkout fails closed until test-mode credentials are configured', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'buyer@example.com', items: [] }),
  }), { DB: mockDb() });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'stripe_not_configured');
});

test('Stripe webhook rejects a missing or forged signature', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
    body: JSON.stringify({ id: 'evt_forged', type: 'checkout.session.completed', data: { object: {} } }),
  }), { DB: mockDb(), STRIPE_WEBHOOK_SECRET: 's'.repeat(40) });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'invalid_signature');
});
