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


async function stripeSignatureValid(raw, header, secret) {
  if (!secret || secret.length < 32 || !header) return false;
  const parts = Object.fromEntries(header.split(',').map(part => {
    const i = part.indexOf('=');
    return i > 0 ? [part.slice(0, i), part.slice(i + 1)] : ['', ''];
  }).filter(([k]) => k));
  const timestamp = Number(parts.t);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300 || !parts.v1) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts.t + '.' + raw)));
  const expected = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  return parts.v1.split(',').some(sig => {
    if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
    let mismatch = 0;
    for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ sig.toLowerCase().charCodeAt(i);
    return mismatch === 0;
  });
}

async function stripeRequest(env, path, params) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_SECRET_KEY.startsWith('sk_')) throw new Error('stripe_not_configured');
  const response = await fetch('https://api.stripe.com/v1/' + path, {
    method: params ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, ...(params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error('stripe_api_error_' + response.status);
  return data;
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY) throw new Error('Request body too large');
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new Error('Request body too large');
  return JSON.parse(raw || '{}');
}

function cookieValue(request, name) {
  const cookies = request.headers.get('cookie') || '';
  for (const part of cookies.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}

function authorized(request, env) {
  const expected = env.ROGUE_ADMIN_TOKEN;
  if (!expected || expected.length < 32) return false;
  const provided = request.headers.get('authorization') || '';
  const bearer = provided.startsWith('Bearer ') && provided.slice(7) === expected;
  const cookie = cookieValue(request, 'rogue_admin_session');
  return bearer || (cookie.length === expected.length && cookie === expected);
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

  // Exchange the admin secret for a short-lived HttpOnly cookie so it is not stored in JavaScript-accessible storage.
  if (url.pathname === '/api/admin/session' && request.method === 'POST') {
    let body;
    try { body = await readJson(request); } catch { return json({ error: 'invalid_json_or_body_too_large' }, 400); }
    const expected = env.ROGUE_ADMIN_TOKEN || '';
    const provided = String(body.token || '');
    if (expected.length < 32 || provided.length !== expected.length || provided !== expected) return json({ error: 'unauthorized', message: 'Invalid admin token.' }, 401);
    return new Response(JSON.stringify({ ok: true, expires_in: 604800 }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': 'rogue_admin_session=' + expected + '; HttpOnly; Secure; SameSite=None; Path=/api; Max-Age=604800',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
    });
  }
  if (url.pathname === '/api/admin/session' && request.method === 'DELETE') {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': 'rogue_admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=0',
      },
    });
  }
  if (!env.DB) return json({ error: 'database_unconfigured' }, 503);

  // Public catalog exposes published metadata only, never private asset keys.
  if (url.pathname === '/api/catalog' && request.method === 'GET') {
    const { results } = await env.DB.prepare("SELECT id, title, slug, description, price_minor, currency FROM products WHERE status = 'published' ORDER BY created_at DESC LIMIT 100").all();
    return json({ products: results || [] });
  }

  // Download delivery requires a private R2 binding; the grant alone never bypasses paid-order checks.
  if (url.pathname === '/api/download' && request.method === 'GET') {
    if (!env.PRODUCT_FILES) return json({ error: 'private_asset_storage_not_configured' }, 503);
    const grant = url.searchParams.get('grant') || '';
    if (!/^[0-9a-f]{64}$/.test(grant)) return json({ error: 'invalid_download_grant' }, 401);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(grant)));
    const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    const row = await env.DB.prepare("SELECT g.order_id FROM order_download_grants g JOIN orders o ON o.id = g.order_id WHERE g.grant_hash = ? AND g.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND o.status = 'paid'").bind(hash).first();
    if (!row) return json({ error: 'grant_invalid_or_order_unpaid' }, 403);
    const { results } = await env.DB.prepare('SELECT p.asset_key FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ?').bind(row.order_id).all();
    const keys = (results || []).map(item => item.asset_key).filter(Boolean);
    if (!keys.length) return json({ error: 'product_asset_not_attached' }, 404);
    if (keys.length !== 1) return json({ error: 'multiple_asset_delivery_not_supported' }, 501);
    const object = await env.PRODUCT_FILES.get(keys[0]);
    if (!object) return json({ error: 'asset_not_found' }, 404);
    const headers = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    object.writeHttpMetadata(headers);
    headers.set('cache-control', 'private, no-store');
    headers.set('content-disposition', 'attachment; filename="' + (keys[0].split('/').pop() || 'download').replace(/[^a-zA-Z0-9._-]/g, '_') + '"');
    return new Response(object.body, { headers });
  }

  // Stripe's official signature header is verified against the untouched request body.
  if (url.pathname === '/api/webhooks/stripe' && request.method === 'POST') {
    if (!env.STRIPE_WEBHOOK_SECRET || env.STRIPE_WEBHOOK_SECRET.length < 32) return json({ error: 'stripe_webhook_not_configured' }, 503);
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: 'request_body_too_large' }, 413);
    if (!await stripeSignatureValid(raw, request.headers.get('stripe-signature') || '', env.STRIPE_WEBHOOK_SECRET)) {
      await audit(env, 'payment.webhook_rejected', 'Stripe webhook signature rejected', 'warning');
      return json({ error: 'invalid_signature' }, 401);
    }
    let event;
    try { event = JSON.parse(raw); } catch { return json({ error: 'invalid_json' }, 400); }
    const eventId = String(event.id || '');
    const type = String(event.type || '');
    if (!eventId || eventId.length > 180) return json({ error: 'invalid_event' }, 400);
    const seen = await env.DB.prepare('SELECT event_id FROM payment_events WHERE event_id = ?').bind(eventId).first();
    if (seen) return json({ ok: true, duplicate: true });
    const session = event.data && event.data.object;
    if (!session || !['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(type)) {
      // Record unrelated verified Stripe events to make retries idempotent.
      if (session) await env.DB.prepare('INSERT INTO payment_events (event_id, order_id, provider, provider_reference, event_status, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(eventId, String(session.metadata?.order_id || ''), 'stripe', String(session.id || ''), type, JSON.stringify({ type }).slice(0, 3000)).run();
      return json({ ok: true, ignored: true });
    }
    const orderId = String(session.metadata?.order_id || session.client_reference_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) return json({ error: 'order_metadata_missing' }, 400);
    if (session.mode !== 'payment') return json({ error: 'unsupported_checkout_mode' }, 400);
    const order = await env.DB.prepare('SELECT id, total_minor, currency, status FROM orders WHERE id = ?').bind(orderId).first();
    if (!order) return json({ error: 'order_not_found' }, 404);
    const paid = session.payment_status === 'paid';
    if (paid) {
      if (Number(session.amount_total) !== order.total_minor || String(session.currency || '').toUpperCase() !== order.currency) return json({ error: 'payment_amount_mismatch' }, 409);
      if (order.status === 'pending') {
        await env.DB.prepare("UPDATE orders SET status = 'paid', payment_provider = 'stripe', provider_reference = ?, paid_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'pending'")
          .bind(String(session.payment_intent || session.id), orderId).run();
      } else if (order.status !== 'paid') return json({ error: 'order_not_payable' }, 409);
    } else if (type === 'checkout.session.completed') {
      // Delayed payment methods may complete Checkout before the funds settle.
      await env.DB.prepare('INSERT INTO payment_events (event_id, order_id, provider, provider_reference, event_status, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(eventId, orderId, 'stripe', String(session.id || ''), 'payment_pending', JSON.stringify({ type, payment_status: session.payment_status }).slice(0, 3000)).run();
      return json({ ok: true, payment_pending: true });
    }
    await env.DB.prepare('INSERT INTO payment_events (event_id, order_id, provider, provider_reference, event_status, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(eventId, orderId, 'stripe', String(session.id || ''), type, JSON.stringify({ type, payment_status: session.payment_status, amount_total: session.amount_total, currency: session.currency }).slice(0, 3000)).run();
    await audit(env, 'payment.stripe_verified', 'Verified Stripe payment event processed', 'info', { orderId, eventId, type });
    return json({ ok: true, paid });
  }

  // Server prices the order, then creates a Stripe-hosted Checkout Session. Never mark paid here.
  if (url.pathname === '/api/checkout' && request.method === 'POST') {
    let body;
    try { body = await readJson(request); } catch { return json({ error: 'invalid_json_or_body_too_large' }, 400); }
    if (!env.STRIPE_SECRET_KEY) return json({ error: 'stripe_not_configured' }, 503);
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
      const product = await env.DB.prepare("SELECT id, title, description, price_minor, currency FROM products WHERE id = ? AND status = 'published'").bind(productId).first();
      if (!product || product.currency !== 'MYR' || !Number.isSafeInteger(product.price_minor) || product.price_minor <= 0) return json({ error: 'product_unavailable_or_unsupported_price' }, 400);
      total += product.price_minor * quantity;
      if (!Number.isSafeInteger(total)) return json({ error: 'order_total_too_large' }, 400);
      pricedItems.push({ product, quantity });
    }
    const orderId = id();
    await env.DB.prepare("INSERT INTO orders (id, customer_email, currency, total_minor, status, payment_provider) VALUES (?, ?, 'MYR', ?, 'pending', 'stripe')").bind(orderId, email, total).run();
    for (const entry of pricedItems) {
      await env.DB.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price_minor) VALUES (?, ?, ?, ?)').bind(orderId, entry.product.id, entry.quantity, entry.product.price_minor).run();
    }
    try {
      const origin = env.PUBLIC_APP_URL || new URL(request.url).origin;
      if (!origin.startsWith('https://')) throw new Error('invalid_public_app_url');
      const params = {
        mode: 'payment',
        success_url: origin.replace(/\/$/, '') + '/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
        cancel_url: origin.replace(/\/$/, '') + '/?checkout=cancelled&order_id=' + orderId,
        customer_email: email,
        client_reference_id: orderId,
        'metadata[order_id]': orderId,
        'payment_intent_data[metadata][order_id]': orderId,
      };
      pricedItems.forEach((entry, index) => {
        params['line_items[' + index + '][price_data][currency]'] = 'myr';
        params['line_items[' + index + '][price_data][unit_amount]'] = String(entry.product.price_minor);
        params['line_items[' + index + '][price_data][product_data][name]'] = entry.product.title.slice(0, 250);
        params['line_items[' + index + '][price_data][product_data][description]'] = String(entry.product.description || 'Digital product').slice(0, 500);
        params['line_items[' + index + '][quantity]'] = String(entry.quantity);
      });
      const session = await stripeRequest(env, 'checkout/sessions', params);
      await audit(env, 'order.checkout_created', 'Stripe Checkout Session created; payment pending', 'info', { orderId, sessionId: session.id, totalMinor: total });
      return json({ order_id: orderId, status: 'pending', currency: 'MYR', total_minor: total, checkout_url: session.url, checkout_session_id: session.id }, 201);
    } catch (error) {
      await audit(env, 'order.checkout_failed', 'Stripe Checkout Session creation failed', 'error', { orderId, reason: String(error).slice(0, 160) });
      return json({ error: 'checkout_session_creation_failed' }, 502);
    }
  }

  // After Stripe redirects back, independently retrieve the Session and require a paid order before minting a download grant.
  if (url.pathname === '/api/orders/download-link' && request.method === 'GET') {
    const sessionId = url.searchParams.get('session_id') || '';
    if (!/^cs_(test_|live_)[A-Za-z0-9]+$/.test(sessionId)) return json({ error: 'invalid_checkout_session' }, 400);
    let session;
    try { session = await stripeRequest(env, 'checkout/sessions/' + encodeURIComponent(sessionId)); }
    catch { return json({ error: 'checkout_session_unavailable' }, 502); }
    const orderId = String(session.metadata?.order_id || session.client_reference_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(orderId) || session.payment_status !== 'paid') return json({ error: 'payment_not_verified' }, 403);
    const order = await env.DB.prepare("SELECT id, status FROM orders WHERE id = ? AND payment_provider = 'stripe'").bind(orderId).first();
    if (!order || order.status !== 'paid') return json({ error: 'order_not_paid' }, 403);
    const grantBytes = crypto.getRandomValues(new Uint8Array(32));
    const grant = Array.from(grantBytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const grantDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(grant)));
    const grantHash = Array.from(grantDigest, byte => byte.toString(16).padStart(2, '0')).join('');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare('INSERT INTO order_download_grants (grant_hash, order_id, expires_at) VALUES (?, ?, ?)').bind(grantHash, orderId, expiresAt).run();
    await audit(env, 'order.download_grant_issued', 'Paid order download grant issued after Stripe Session verification', 'info', { orderId, sessionId });
    return json({ ok: true, order_id: orderId, download_url: '/api/download?grant=' + grant, expires_at: expiresAt });
  }

  if (!authorized(request, env)) return json({ error: 'unauthorized', message: 'Open Settings and enter the Worker admin token for this browser session.' }, 401);

  if (url.pathname === '/api/discovery/run' && request.method === 'POST') {
    const [rss, apiSources] = await Promise.all([runRssDiscovery(env), runJsonApiDiscovery(env)]);
    const result = {
      feeds_checked: rss.feeds_checked || 0,
      feeds_failed: rss.feeds_failed || 0,
      apis_checked: apiSources.apis_checked || 0,
      apis_failed: apiSources.apis_failed || 0,
      candidates_added: (rss.candidates_added || 0) + (apiSources.candidates_added || 0),
    };
    await audit(env, 'discovery.manual_run', 'Manual RSS and JSON API discovery completed', 'info', result);
    return json({ ok: true, ...result });
  }

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
  const publishMatch = url.pathname.match(/^\/api\/products\/([0-9a-f-]{36})\/publish$/i);
  if (publishMatch && request.method === 'POST') {
    const result = await env.DB.prepare("UPDATE products SET status = 'published', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'draft'").bind(publishMatch[1]).run();
    if (!result.meta?.changes) return json({ error: 'draft_product_not_found' }, 404);
    await audit(env, 'product.published', 'Product published to the public catalog', 'info', { productId: publishMatch[1] });
    return json({ ok: true, status: 'published', id: publishMatch[1] });
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
  if (origin && /^https:\/\/(rogue-autonomous-os\.rogueomegaos\.workers\.dev|roguehub\.freebuff\.app|rogueomegaos\.github\.io)$/.test(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-credentials'] = 'true';
  }
  return headers;
}


async function runRssDiscovery(env) {
  if (!env.DB) throw new Error('database_unconfigured');
  const { results: feeds } = await env.DB.prepare("SELECT id, url FROM sources WHERE source_type = 'rss' AND status IN ('registered','error') LIMIT 20").all();
  const summary = { feeds_checked: 0, candidates_added: 0, feeds_failed: 0 };
  for (const feed of feeds || []) {
    summary.feeds_checked++;
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
      const entries = xml.match(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)>/gi) || [];
      for (const entry of entries.slice(0, 15)) {
        const clean = (value) => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
        const titleMatch = entry.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
        const linkMatch = entry.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
        const atom = entry.match(/<link\b[^>]*href=["']([^"']+)["']/i);
        const descMatch = entry.match(/<(?:description|summary)\b[^>]*>([\s\S]*?)<\/(?:description|summary)>/i);
        const title = titleMatch ? clean(titleMatch[1]).slice(0, 200) : '';
        const link = atom ? atom[1] : (linkMatch ? clean(linkMatch[1]) : '');
        const target = safeSourceUrl(link);
        const description = descMatch ? clean(descMatch[1]) : '';
        if (!title || !target || !target.startsWith('https://')) continue;
        const exists = await env.DB.prepare('SELECT id FROM opportunities WHERE source_id = ? AND target_url = ? LIMIT 1').bind(feed.id, target).first();
        if (exists) continue;
        await env.DB.prepare("INSERT INTO opportunities (id, source_id, title, description, target_url, category, legitimacy_status, score, evidence_json) VALUES (?, ?, ?, ?, ?, 'rss_discovery', 'pending_review', 0, ?)").bind(id(), feed.id, title, description.slice(0, 2000), target, JSON.stringify([{ feed: feed.url, discovered_at: new Date().toISOString() }])).run();
        summary.candidates_added++;
      }
      await env.DB.prepare("UPDATE sources SET status = 'registered', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(feed.id).run();
      await audit(env, 'source.fetch_succeeded', 'RSS feed checked; candidates require manual review', 'info', { sourceId: feed.id });
    } catch (error) {
      summary.feeds_failed++;
      await env.DB.prepare("UPDATE sources SET status = 'error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(feed.id).run();
      await audit(env, 'source.fetch_failed', 'RSS feed check failed', 'warning', { sourceId: feed.id, reason: String(error).slice(0, 160) });
    }
  }
  return summary;
}

async function runJsonApiDiscovery(env) {
  if (!env.DB) throw new Error('database_unconfigured');
  const { results: sources } = await env.DB.prepare("SELECT id, url FROM sources WHERE source_type = 'api' AND status IN ('registered','error') LIMIT 20").all();
  const summary = { apis_checked: 0, candidates_added: 0, apis_failed: 0 };
  for (const source of sources || []) {
    summary.apis_checked++;
    try {
      const sourceUrl = safeSourceUrl(source.url);
      if (!sourceUrl || !sourceUrl.startsWith('https://')) throw new Error('Only public HTTPS APIs are supported');
      const response = await fetch(sourceUrl, { redirect: 'manual', signal: AbortSignal.timeout(7000), headers: { accept: 'application/json' } });
      if (!response.ok || (response.status >= 300 && response.status < 400)) throw new Error('API request rejected');
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('json')) throw new Error('API did not return JSON');
      if (Number(response.headers.get('content-length') || 0) > 300000) throw new Error('API response is too large');
      const raw = await response.text();
      if (raw.length > 300000) throw new Error('API response is too large');
      const payload = JSON.parse(raw);
      const entries = Array.isArray(payload) ? payload
        : [payload?.data, payload?.jobs, payload?.items, payload?.results].find(Array.isArray) || [];
      for (const entry of entries.slice(0, 15)) {
        if (!entry || typeof entry !== 'object') continue;
        const title = String(entry.title || entry.name || entry.position || '').trim().slice(0, 200);
        const linkValue = entry.url || entry.job_url || entry.link || entry.html_url || entry.absolute_url || '';
        if (!String(linkValue).trim()) continue;
        let target = null;
        try { target = safeSourceUrl(new URL(String(linkValue), sourceUrl).href); } catch {}
        const description = String(entry.description || entry.summary || entry.body || entry.snippet || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 2000);
        if (!title || !target || !target.startsWith('https://')) continue;
        const exists = await env.DB.prepare('SELECT id FROM opportunities WHERE source_id = ? AND target_url = ? LIMIT 1').bind(source.id, target).first();
        if (exists) continue;
        await env.DB.prepare("INSERT INTO opportunities (id, source_id, title, description, target_url, category, legitimacy_status, score, evidence_json) VALUES (?, ?, ?, ?, ?, 'api_discovery', 'pending_review', 0, ?)").bind(id(), source.id, title, description, target, JSON.stringify([{ api: source.url, discovered_at: new Date().toISOString() }])).run();
        summary.candidates_added++;
      }
      await env.DB.prepare("UPDATE sources SET status = 'registered', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(source.id).run();
      await audit(env, 'source.api_fetch_succeeded', 'JSON API checked; candidates require review', 'info', { sourceId: source.id });
    } catch (error) {
      summary.apis_failed++;
      await env.DB.prepare("UPDATE sources SET status = 'error', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(source.id).run();
      await audit(env, 'source.api_fetch_failed', 'JSON API check failed', 'warning', { sourceId: source.id, reason: String(error).slice(0, 160) });
    }
  }
  return summary;
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
    ctx.waitUntil(Promise.all([runRssDiscovery(env), runJsonApiDiscovery(env)]));
  }
};
