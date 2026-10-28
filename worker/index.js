const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  },
});

const id = () => crypto.randomUUID();
const MAX_BODY = 16_384;

function safeSourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^\\[|\\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host === 'metadata.google.internal' || host.endsWith('.internal')) return null;

  // Reject literal IPv6 hosts until a resolver-aware public-address policy exists.
  if (host.includes(':')) return null;
  const octets = host.split('.');
  if (octets.length === 4 && octets.every(part => /^\\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const [a, b, c] = octets.map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0 && c === 0) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113)) return null;
  }
  return url.href;
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY) throw new Error('Request body too large');
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new Error('Request body too large');
  return JSON.parse(raw || '{}');
}

function authorized(request, env) {
  const expected = env.ROGUE_ADMIN_TOKEN;
  if (!expected || expected.length < 32) return false;
  const provided = request.headers.get('authorization') || '';
  return provided.startsWith('Bearer ') && provided.slice(7) === expected;
}

async function audit(env, type, message, severity = 'info', metadata = {}) {
  if (!env.DB) return;
  await env.DB.prepare('INSERT INTO audit_events (id, actor, event_type, severity, message, metadata_json) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id(), 'admin-token', type, severity, message.slice(0, 500), JSON.stringify(metadata).slice(0, 3000)).run();
}

async function api(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (url.pathname === '/api/health' && request.method === 'GET') {
    let database = 'unconfigured';
    let counts = {};
    if (env.DB) {
      try {
        await env.DB.prepare('SELECT 1 AS ok').first();
        database = 'connected';
        const result = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM sources) AS sources, (SELECT COUNT(*) FROM opportunities) AS opportunities, (SELECT COUNT(*) FROM products WHERE status = \'published\') AS products, (SELECT COUNT(*) FROM orders WHERE status = \'paid\') AS paid_orders').first();
        counts = result || {};
      } catch { database = 'unavailable'; }
    }
    return json({ ok: true, service: 'rogue-autonomous-os', version: '0.2.0', mode: 'foundation', database, autonomy: 'paused', counts, timestamp: new Date().toISOString() });
  }
  if (!url.pathname.startsWith('/api/')) return null;
  if (!env.DB) return json({ error: 'database_unconfigured' }, 503);
  if (!authorized(request, env)) return json({ error: 'unauthorized', message: 'Set the ROGUE_ADMIN_TOKEN secret in the Worker and provide it in this browser session.' }, 401);

  if (url.pathname === '/api/sources' && request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id, name, source_type AS type, url, notes, status, created_at FROM sources ORDER BY created_at DESC LIMIT 200').all();
    return json({ sources: results || [] });
  }
  if (url.pathname === '/api/sources' && request.method === 'POST') {
    let body;
    try { body = await readJson(request); } catch { return json({ error: 'invalid_json_or_body_too_large' }, 400); }
    const name = String(body.name || '').trim();
    const type = String(body.type || '');
    const sourceUrl = safeSourceUrl(String(body.url || ''));
    const notes = String(body.notes || '').trim();
    if (!name || name.length > 120) return json({ error: 'invalid_name' }, 400);
    if (!['website', 'rss', 'api'].includes(type)) return json({ error: 'invalid_source_type' }, 400);
    if (!sourceUrl) return json({ error: 'invalid_url', message: 'Use a valid public HTTP/HTTPS URL without credentials or local/private hostnames.' }, 400);
    if (notes.length > 1000) return json({ error: 'notes_too_long' }, 400);
    const sourceId = id();
    await env.DB.prepare('INSERT INTO sources (id, name, source_type, url, notes, status) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(sourceId, name, type, sourceUrl, notes, 'registered').run();
    await audit(env, 'source.created', 'Source registered', 'info', { sourceId, type });
    return json({ id: sourceId, name, type, url: sourceUrl, notes, status: 'registered' }, 201);
  }
  const sourceMatch = url.pathname.match(/^\/api\/sources\/([0-9a-f-]{36})$/i);
  if (sourceMatch && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM sources WHERE id = ?').bind(sourceMatch[1]).run();
    await audit(env, 'source.deleted', 'Source removed', 'warning', { sourceId: sourceMatch[1] });
    return json({ ok: true });
  }
  if (url.pathname === '/api/opportunities' && request.method === 'GET') {
    const status = url.searchParams.get('status');
    const query = status && ['unverified','pending_review','verified','rejected'].includes(status)
      ? env.DB.prepare('SELECT id, title, description, target_url, category, legitimacy_status, score, discovered_at FROM opportunities WHERE legitimacy_status = ? ORDER BY score DESC, discovered_at DESC LIMIT 200').bind(status)
      : env.DB.prepare('SELECT id, title, description, target_url, category, legitimacy_status, score, discovered_at FROM opportunities ORDER BY score DESC, discovered_at DESC LIMIT 200');
    const { results } = await query.all();
    return json({ opportunities: results || [] });
  }
  if (url.pathname === '/api/opportunities' && request.method === 'POST') {
    let body;
    try { body = await readJson(request); } catch { return json({ error: 'invalid_json_or_body_too_large' }, 400); }
    const title = String(body.title || '').trim();
    const targetUrl = safeSourceUrl(String(body.target_url || body.url || ''));
    const description = String(body.description || '').trim();
    const category = String(body.category || 'unclassified').trim().slice(0, 80);
    const sourceId = body.source_id ? String(body.source_id) : null;
    if (!title || title.length > 200) return json({ error: 'invalid_title' }, 400);
    if (!targetUrl) return json({ error: 'invalid_url' }, 400);
    if (description.length > 5000) return json({ error: 'description_too_long' }, 400);
    if (sourceId) {
      const source = await env.DB.prepare('SELECT id FROM sources WHERE id = ?').bind(sourceId).first();
      if (!source) return json({ error: 'source_not_found' }, 400);
    }
    const opportunityId = id();
    await env.DB.prepare('INSERT INTO opportunities (id, source_id, title, description, target_url, category, legitimacy_status, score, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(opportunityId, sourceId, title, description, targetUrl, category, 'pending_review', 0, '[]').run();
    await audit(env, 'opportunity.created', 'Opportunity added for manual review', 'info', { opportunityId });
    return json({ id: opportunityId, title, target_url: targetUrl, legitimacy_status: 'pending_review', score: 0 }, 201);
  }
  const opportunityMatch = url.pathname.match(/^\/api\/opportunities\/([0-9a-f-]{36})\/review$/i);
  if (opportunityMatch && request.method === 'POST') {
    let body;
    try { body = await readJson(request); } catch { return json({ error: 'invalid_json_or_body_too_large' }, 400); }
    const status = String(body.status || '');
    const score = Number(body.score ?? 0);
    if (!['pending_review', 'verified', 'rejected'].includes(status) || !Number.isInteger(score) || score < 0 || score > 100) return json({ error: 'invalid_review' }, 400);
    const result = await env.DB.prepare('UPDATE opportunities SET legitimacy_status = ?, score = ?, reviewed_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id = ?')
      .bind(status, score, opportunityMatch[1]).run();
    if (!result.meta?.changes) return json({ error: 'opportunity_not_found' }, 404);
    await audit(env, 'opportunity.reviewed', 'Opportunity review status changed', status === 'rejected' ? 'warning' : 'info', { opportunityId: opportunityMatch[1], status, score });
    return json({ ok: true, status, score });
  }
  if (url.pathname === '/api/products' && request.method === 'POST') {
    let body;
    try { body = await readJson(request); } catch { return json({ error: 'invalid_json_or_body_too_large' }, 400); }
    const title = String(body.title || '').trim();
    const description = String(body.description || '').trim();
    const slug = String(body.slug || title.toLowerCase()).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
    const price = Number(body.price_minor ?? 0);
    if (!title || title.length > 160 || !slug) return json({ error: 'invalid_product' }, 400);
    if (description.length > 5000 || !Number.isSafeInteger(price) || price < 0) return json({ error: 'invalid_product_fields' }, 400);
    const productId = id();
    try {
      await env.DB.prepare('INSERT INTO products (id, title, slug, description, price_minor, currency, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(productId, title, slug, description, price, 'MYR', 'draft').run();
    } catch { return json({ error: 'slug_already_exists_or_invalid_product' }, 409); }
    await audit(env, 'product.created', 'Product draft created', 'info', { productId });
    return json({ id: productId, title, slug, price_minor: price, currency: 'MYR', status: 'draft' }, 201);
  }
  if (url.pathname === '/api/creative-jobs' && request.method === 'POST') {
    let body;
    try { body = await readJson(request); } catch { return json({ error: 'invalid_json_or_body_too_large' }, 400); }
    const clientName = String(body.client_name || '').trim();
    const title = String(body.title || '').trim();
    const brief = String(body.brief || '').trim();
    const contact = String(body.client_contact || '').trim();
    const deliverable = String(body.deliverable_type || 'other').trim().slice(0, 50);
    if (!clientName || clientName.length > 160 || !title || title.length > 200) return json({ error: 'invalid_job' }, 400);
    if (brief.length > 8000 || contact.length > 250) return json({ error: 'job_fields_too_long' }, 400);
    const jobId = id();
    await env.DB.prepare('INSERT INTO creative_jobs (id, client_name, client_contact, title, brief, deliverable_type, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(jobId, clientName, contact, title, brief, deliverable, 'brief_received').run();
    await audit(env, 'creative_job.created', 'Creative service job created', 'info', { jobId });
    return json({ id: jobId, client_name: clientName, title, deliverable_type: deliverable, status: 'brief_received' }, 201);
  }
  if (url.pathname === '/api/audit' && request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id, actor, event_type, severity, message, metadata_json, created_at FROM audit_events ORDER BY created_at DESC LIMIT 100').all();
    return json({ events: results || [] });
  }
  if (url.pathname === '/api/products' && request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id, title, slug, description, price_minor, currency, status, created_at FROM products ORDER BY created_at DESC LIMIT 200').all();
    return json({ products: results || [] });
  }
  if (url.pathname === '/api/creative-jobs' && request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT id, client_name, title, deliverable_type, status, quoted_minor, currency, created_at FROM creative_jobs ORDER BY created_at DESC LIMIT 200').all();
    return json({ jobs: results || [] });
  }
  return json({ error: 'not_found' }, 404);
}

function corsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  const headers = { 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'Authorization,Content-Type', 'vary': 'Origin' };
  if (origin && /^https:\/\/(rogue-autonomous-os\.rogueomegaos\.workers\\.dev|rogueomegaos\.github\.io|[a-z0-9-]+\.rogue-autonomous-os\.pages\.dev)$/.test(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        const response = await api(request, env, url);
        if (response) {
          const headers = new Headers(response.headers);
          for (const [key, value] of Object.entries(corsHeaders(request))) headers.set(key, value);
          return new Response(response.body, { status: response.status, headers });
        }
      }
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('RØGUE OS foundation is running. Build the frontend with npm run build.', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    } catch (error) {
      console.error('request_failed', { path: url.pathname, message: String(error).slice(0, 300) });
      return json({ error: 'internal_error', request_id: crypto.randomUUID() }, 500);
    }
  },
};
