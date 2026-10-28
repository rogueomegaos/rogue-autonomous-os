const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health' && request.method === 'GET') {
      let database = 'unconfigured';
      if (env.DB && env.DB.prepare) {
        try {
          await env.DB.prepare('SELECT 1 AS ok').first();
          database = 'connected';
        } catch {
          database = 'unavailable';
        }
      }
      return json({
        ok: true,
        service: 'rogue-autonomous-os',
        version: '0.1.0',
        mode: 'foundation',
        database,
        autonomy: 'paused',
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'not_implemented', message: 'This API route is not implemented in the foundation release.' }, 501);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('RØGUE OS foundation is running. Build the frontend with npm run build.', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
