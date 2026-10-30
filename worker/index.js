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
  // Block all literal IP hosts; only DNS hostnames are accepted for registered feeds.
  if (/^[0-9.]+$/.test(host) || host.includes(':')) return null;

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

  // Public catalog exposes published metadata only, never private asset keys.
  if (url.pathname === '/api/catalog' && request.method === 'GET') {
    const { results } = await env.DB.prepare("SELECT id, title, slug, description, price_minor, currency FROM products WHERE status = 'published' ORDER BY created_at DESC LIMIT 100").all();
    return json({ products: results || [] });
  }

  // Provider-neutral webhook contract. Provider-specific signature verification still must be mapped before live use.
  if (url.pathname === '/api/webhooks/payment' && request.method === 'POST') {
    if (!env.PAYMENT_WEBHOOK_SECRET || env.PAYMENT_WEBHOOK_SECRET.length < 32) return json({ error: 'payment_webhook_not_configured' }, 503);
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: 'request_body_too_large' }, 413);
    const signature = (request.headers.get('x-rogue-signature') || '').replace(/^sha256=/, '').toLowerCase();
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.PAYMENT_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
    const expected = Array.from(signed, byte => byte.toString(16).padStart(2, '0')).join('');
    if (signature.length !== expected.length) return json({ error: 'invalid_signature' }, 401);
    let mismatch = 0;
    for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    if (mismatch) return json({ error: 'invalid_signature' }, 401);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: 'invalid_json' }, 400); }
    const eventId = String(body.event_id || '');
    const orderId = String(body.order_id || '');
    const provider = String(body.provider || '').slice(0, 60);
    const reference = String(body.provider_reference || '').slice(0, 180);
    const status = String(body.status || '');
    if (!eventId || eventId.length > 180 || !/^[0-9a-f-]{36}$/i.test(orderId) || !provider || !reference || !['paid','failed','cancelled','refunded'].includes(status)) return json({ error: 'invalid_payment_event' }, 400);
    const seen = await env.DB.prepare('SELECT event_id FROM payment_events WHERE event_id = ?').bind(eventId).first();
    if (seen) return json({ ok: true, duplicate: true });
    const order = await env.DB.prepare('SELECT id, total_minor, currency, status FROM orders WHERE id = ?').bind(orderId).first();
    if (!order) return json({ error: 'order_not_found' }, 404);
    if (status === 'paid') {
      if (Number(body.amount_minor) !== order.total_minor || String(body.currency || '').toUpperCase() !== order.currency) return json({ error: 'payment_amount_mismatch' }, 409);
      if (order.status !== 'pending' && order.status !== 'paid') return json({ error: 'order_not_payable' }, 409);
      await env.DB.prepare("UPDATE orders SET status = 'paid', payment_provider = ?, provider_reference = ?, paid_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'pending'").bind(provider, reference, orderId).run();
    } else if (order.status === 'pending') {
      await env.DB.prepare('UPDATE orders SET status = ? WHERE id = ? AND status = ?').bind(status, orderId, 'pending').run();
    }
    await env.DB.prepare('INSERT INTO payment_events (event_id, order_id, provider, provider_reference, event_status, payload_json) VALUES (?, ?, ?, ?, ?, ?)').bind(eventId, orderId, provider, reference, status, JSON.stringify({ eventId, orderId, status, amount_minor: body.amount_minor, currency: body.currency }).slice(0, 3000)).run();
    await audit(env, 'payment.webhook_processed', 'Signed payment event processed', 'info', { orderId, provider, status, eventId });
    return json({ ok: true });
  }

  // Server-priced order intent. Payment is not considered complete until a signed provider webhook is integrated.
  if (url.pathname === '/api/checkout' && request.method === 'POST') {
    let body;
    try { body = await readJson(request); } catch { return json({ error: 'invalid_json_or_body_too_large' }, 400); }
    const email = String(body.email || '').trim().toLowerCase();
    const items = Array.isArray(body.items) ? body.items : [];
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'invalid_email' }, 400);
    if (!items.length || items.length > 20) return json({ error: 'invalid_items' }, 400);
    const quantities = new Map();
    for (const item of items) {
      const productId = String(item.product_id || '');
      const quantity = Number(item.quantity);
      if (!/^[0-9a-f-]{36}$/i.test(productId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) return json({ error: 'invalid_item' }, 400);
      quantities.set(productId, Math.min(10, (quantities.get(productId) || 0) + quantity));
    }
    let total = 0;
    const pricedItems = [];
    for (const [productId, quantity] of quantities) {
      const product = await env.DB.prepare("SELECT id, price_minor, currency FROM products WHERE id = ? AND status = 'published'").bind(productId).first();
      if (!product) return json({ error: 'product_unavailable' }, 400);
      if (product.currency !== 'MYR' || !Number.isSafeInteger(product.price_minor) || product.price_minor < 0) return json({ error: 'unsupported_price' }, 409);
      total += product.price_minor * quantity;
      if (!Number.isSafeInteger(total)) return json({ error: 'order_total_too_large' }, 400);
      pricedItems.push({ product, quantity });
    }
    const orderId = id();
    await env.DB.prepare("INSERT INTO orders (id, customer_email, currency, total_minor, status, payment_provider) VALUES (?, ?, 'MYR', ?, 'pending', 'unconfigured')").bind(orderId, email, total).run();
    for (const entry of pricedItems) {
      await env.DB.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price_minor) VALUES (?, ?, ?, ?)').bind(orderId, entry.product.id, entry.quantity, entry.product.price_minor).run();
    }
    await audit(env, 'order.created', 'Pending order intent created; no payment received', 'info', { orderId, totalMinor: total });
    return json({ order_id: orderId, status: 'pending', currency: 'MYR', total_minor: total, payment_status: 'not_started', message: 'Payment gateway is not configured. This order is not paid.' }, 201);
  }

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
  if (origin && /^https:\/\/(rogue-autonomous-os\.rogueomegaos\.workers\.dev|rogueomegaos\.github\.io|[a-z0-9-]+\.rogue-autonomous-os\.pages\.dev)$/.test(origin)) headers['access-control-allow-origin'] = origin;
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
  async scheduled(controller, env, ctx) {
    if (!env.DB) return;
    ctx.waitUntil((async () => {
      const { results: feeds } = await env.DB.prepare("SELECT id, url FROM sources WHERE source_type = 'rss' AND status = 'registered' LIMIT 20").all();
      for (const feed of feeds || []) {
        try {
          const sourceUrl = safeSourceUrl(feed.url);
          if (!sourceUrl || !sourceUrl.startsWith('https://')) throw new Error('Only public HTTPS feeds are supported');
          const response = await fetch(sourceUrl, { redirect: 'manual', signal: AbortSignal.timeout(7000), headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
          if (!response.ok || (response.status >= 300 && response.status < 400)) throw new Error('Feed request rejected');
          const contentType = (response.headers.get('content-type') || '').toLowerCase();
          if (!/xml|rss|atom/.test(contentType)) throw new Error('Feed did not return XML');
          if (Number(response.headers.get('content-length') || 0) > 300000) throw new Error('Feed is too large');
          const xml = await response.text();
          if (xml.length > 300000) throw new Error('Feed is too large');
          const entries = xml.match(/<(?:item|entry)\\b[^>]*>[\\s\\S]*?<\\/(?:item|entry)>/gi) || [];
          for (const entry of entries.slice(0, 15)) {
            const tag = (name) => {
              const m = entry.match(new RegExp('<' + name + '(?:\\\\s+[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i'));
              return m ? m[1].replace(/<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').trim() : '';
            };
            const title = tag('title').slice(0, 200);
            const atom = entry.match(/<link\\b[^>]*href=["']([^"']+)["']/i);
            const target = safeSourceUrl(atom ? atom[1] : tag('link'));
            const description = tag('description') || tag('summary');
            if (!title || !target || !target.startsWith('https://')) continue;
            const exists = await env.DB.prepare('SELECT id FROM opportunities WHERE source_id = ? AND target_url = ? LIMIT 1').bind(feed.id, target).first();
            if (exists) continue;
            await env.DB.prepare("INSERT INTO opportunities (id, source_id, title, description, target_url, category, legitimacy_status, score, evidence_json) VALUES (?, ?, ?, ?, ?, 'rss_discovery', 'pending_review', 0, ?)").bind(id(), feed.id, title, description.slice(0, 2000), target, JSON.stringify([{ feed: feed.url, discovered_at: new Date().toISOString() }])).run();
          }
          await audit(env, 'source.fetch_succeeded', 'RSS feed checked; candidates require manual review', 'info', { sourceId: feed.id });
        } catch (error) {
          await env.DB.prepare("UPDATE sources SET status = 'error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(feed.id).run();
          await audit(env, 'source.fetch_failed', 'RSS feed check failed', 'warning', { sourceId: feed.id, reason: String(error).slice(0, 160) });
        }
      }
    })());
  },
};
