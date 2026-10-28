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
