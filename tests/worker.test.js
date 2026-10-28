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
