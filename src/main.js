import './style.css';

const state = {
  activeView: 'overview',
  sources: [],
  opportunities: [],
  products: [],
  creativeJobs: [],
  auditEvents: [],
  health: 'Checking',
};

async function refreshHealth() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    const data = await response.json();
    state.health = data.ok && data.database === 'connected' ? 'Online' : 'Degraded';
  } catch { state.health = 'Offline'; }
}

const adminToken = () => sessionStorage.getItem('rogue_admin_token') || '';
async function apiRequest(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (adminToken()) headers.authorization = 'Bearer ' + adminToken();
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || 'Request failed (' + response.status + ')');
  return data;
}
async function refreshSources() {
  try { const data = await apiRequest('/api/sources'); state.sources = data.sources || []; }
  catch (error) { if (error.message !== 'unauthorized') console.warn('Source API unavailable:', error.message); }
}
async function refreshCollection(path, responseKey, stateKey) {
  try { const data = await apiRequest(path); state[stateKey] = data[responseKey] || []; }
  catch (error) { if (error.message !== 'unauthorized') console.warn(path + ' unavailable:', error.message); }
}
async function refreshAll() {
  await Promise.all([refreshSources(), refreshCollection('/api/opportunities', 'opportunities', 'opportunities'), refreshCollection('/api/products', 'products', 'products'), refreshCollection('/api/creative-jobs', 'jobs', 'creativeJobs'), refreshCollection('/api/audit', 'events', 'auditEvents'), refreshHealth()]);
}

const icons = {
  overview: '◈',
  discovery: '⌕',
  sources: '⌘',
  products: '◇',
  creative: '✳',
  activity: '≋',
  settings: '⚙',
};

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function navItem(id, label) {
  return `<button class="nav-item ${state.activeView === id ? 'active' : ''}" data-view="${id}">
    <span class="nav-icon">${icons[id]}</span><span>${label}</span>
    ${id === 'discovery' ? '<span class="nav-count">00</span>' : ''}
  </button>`;
}

function metric(label, value, note, icon) {
  return `<article class="metric-card">
    <div class="metric-top"><span>${label}</span><span class="metric-icon">${icon}</span></div>
    <div class="metric-value">${value}</div><div class="metric-note">${note}</div>
  </article>`;
}

function overview() {
  return `<section class="welcome-row">
      <div><div class="eyebrow"><span class="status-dot"></span> SYSTEM OVERVIEW</div>
        <h1>Command <span>the opportunity.</span></h1>
        <p class="subhead">Your operations, intelligence and commerce engines in one place.</p>
      </div>
      <button class="primary-button" id="run-discovery"><span>↗</span> Run discovery</button>
    </section>
    <section class="metrics-grid">
      ${metric('OPPORTUNITIES FOUND','—','Awaiting first discovery','⌕')}
      ${metric('SOURCES CONNECTED',String(state.sources.length).padStart(2,'0'),'Manual and API sources','⌘')}
      ${metric('PRODUCTS LIVE','00','Catalog not configured','◇')}
      ${metric('SYSTEM HEALTH',state.health,'Runtime status','◉')}
    </section>
    <section class="content-grid">
      <article class="panel pipeline-panel">
        <div class="panel-heading"><div><div class="eyebrow">AUTONOMOUS PIPELINE</div><h2>Discovery workflow</h2></div><span class="pill muted">READY</span></div>
        <div class="pipeline">
          ${[['01','DISCOVER','Find sources and opportunities'],['02','EXTRACT','Collect structured signals'],['03','VERIFY','Check legitimacy and evidence'],['04','SCORE','Rank quality and fit'],['05','ROUTE','Send to the right engine'],['06','LEARN','Record outcomes and improve']].map(([n,t,d],i)=>`<div class="pipeline-step"><div class="step-number">${n}</div><div class="step-copy"><strong>${t}</strong><span>${d}</span></div><span class="step-state">${i===0?'●':'○'}</span></div>`).join('')}
        </div>
        <div class="panel-footer"><span class="muted-text">Autonomy remains paused until sources are configured.</span><span class="tiny-brand">Ω CONTROL</span></div>
      </article>
      <article class="panel activity-panel">
        <div class="panel-heading"><div><div class="eyebrow">LIVE OPERATIONS</div><h2>Activity stream</h2></div><span class="live-label"><i></i> LIVE</span></div>
        <div id="activity-list" class="activity-list">
          <div class="empty-state"><div class="empty-symbol">≋</div><strong>Quiet by design.</strong><p>System events will appear here as you connect sources and run workflows.</p></div>
        </div>
        <div class="panel-footer"><span class="muted-text">Event stream · local session</span><button class="text-button" data-view="activity">View logs ↗</button></div>
      </article>
    </section>
    <section class="panel quickstart">
      <div class="quickstart-mark">R<span>Ø</span></div>
      <div class="quickstart-copy"><div class="eyebrow">NEXT MISSION</div><h2>Give RØGUE something to work with.</h2><p>Add a trusted source first. The system will not invent leads, fabricate evidence or pretend a workflow ran.</p></div>
      <button class="secondary-button" data-view="sources">Configure sources <span>↗</span></button>
    </section>`;
}

function sourcesView() {
  return `<section class="welcome-row"><div><div class="eyebrow">INTELLIGENCE INPUTS</div><h1>Sources <span>& integrations.</span></h1><p class="subhead">Register public websites, RSS feeds or API endpoints for later verification.</p></div></section>
    <section class="panel form-panel"><div class="panel-heading"><div><div class="eyebrow">SOURCE REGISTRY</div><h2>Add a source</h2></div><span class="pill muted">MANUAL MODE</span></div>
      <form id="source-form" class="source-form">
        <label>Source name<input name="name" placeholder="e.g. Company opportunities" required maxlength="80" /></label>
        <label>Source type<select name="type"><option value="website">Public website</option><option value="rss">RSS feed</option><option value="api">API endpoint</option></select></label>
        <label class="full-field">URL<input name="url" type="url" placeholder="https://example.com/opportunities" required /></label>
        <label class="full-field">Notes <textarea name="notes" placeholder="What should this source be used for? (optional)" rows="3" maxlength="500"></textarea></label>
        <div class="form-actions"><p>Only add sources you are authorized to access. Fetching and SSRF protections are not enabled in this UI-only stage.</p><button class="primary-button" type="submit">Add source <span>＋</span></button></div>
      </form>
    </section>
    <section class="panel"><div class="panel-heading"><div><div class="eyebrow">REGISTERED INPUTS</div><h2>Source inventory</h2></div><span class="pill">${state.sources.length} TOTAL</span></div>
      <div id="source-inventory">${renderSources()}</div></section>`;
}

function renderSources() {
  if (!state.sources.length) return '<div class="empty-state compact"><div class="empty-symbol">⌘</div><strong>No sources registered</strong><p>Add a source above to start building the intelligence registry.</p></div>';
  return `<div class="table-wrap"><table><thead><tr><th>SOURCE</th><th>TYPE</th><th>URL</th><th>STATUS</th><th></th></tr></thead><tbody>${state.sources.map((s,i)=>`<tr><td><strong>${escapeHtml(s.name)}</strong><small>${escapeHtml(s.notes || 'No notes')}</small></td><td><span class="pill">${escapeHtml(s.type.toUpperCase())}</span></td><td class="url-cell">${escapeHtml(s.url)}</td><td><span class="status-tag"><i></i> REGISTERED</span></td><td><button class="icon-button" data-remove-source="${i}" aria-label="Remove source">×</button></td></tr>`).join('')}</tbody></table></div>`;
}

function settingsView() {
  return `<section class="welcome-row"><div><div class="eyebrow">SYSTEM CONTROL</div><h1>Settings <span>.</span></h1><p class="subhead">Connect the dashboard to its protected Cloudflare Worker API.</p></div></section>
    <section class="panel form-panel"><div class="panel-heading"><div><div class="eyebrow">ADMIN ACCESS</div><h2>API authentication</h2></div><span class="pill muted">SESSION ONLY</span></div>
      <form id="token-form" class="source-form"><label class="full-field">Worker admin token<input name="token" type="password" autocomplete="off" placeholder="Paste the ROGUE_ADMIN_TOKEN secret" value="${escapeHtml(adminToken())}" required minlength="32" /></label>
      <div class="form-actions"><p>The token is kept in this browser tab's session storage, not committed to GitHub. Create the same secret in Cloudflare Worker settings before using protected endpoints.</p><button class="primary-button" type="submit">Save & test connection <span>↗</span></button></div></form>
      <div id="connection-result" class="muted-text" role="status"></div>
    </section>
    <section class="panel"><div class="eyebrow">SAFETY DEFAULTS</div><h2>Autonomous actions remain paused</h2><p class="subhead">No background source fetching, payments or external actions run until those modules are implemented and tested.</p></section>`;
}

function simpleView(id, title, subtitle, label, description) {
  var content = '';
  if (id === 'discovery') {
    content = '<section class="panel form-panel"><div class="panel-heading"><div><div class="eyebrow">CANDIDATE INTAKE</div><h2>Add opportunity for review</h2></div><span class="pill muted">MANUAL REVIEW</span></div><form id="opportunity-form" class="source-form"><label class="full-field">Title<input name="title" required maxlength="200" /></label><label>Category<input name="category" maxlength="80" /></label><label>Source<select name="source_id"><option value="">No linked source</option>' + state.sources.map(s => '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.name) + '</option>').join('') + '</select></label><label class="full-field">Official URL<input name="target_url" type="url" required placeholder="https://..." /></label><label class="full-field">Eligibility and evidence notes<textarea name="description" rows="3" maxlength="5000"></textarea></label><div class="form-actions"><p>New records remain pending review. Verify official source and Malaysia eligibility before approval.</p><button class="primary-button" type="submit">Add candidate ＋</button></div></form></section>' +
    '<section class="panel"><div class="panel-heading"><div><div class="eyebrow">REVIEW QUEUE</div><h2>Opportunities</h2></div><span class="pill">' + state.opportunities.length + ' TOTAL</span></div>' +
    (state.opportunities.length ? '<div class="table-wrap"><table><thead><tr><th>OPPORTUNITY</th><th>STATUS</th><th>SCORE</th><th>LINK</th><th>REVIEW</th></tr></thead><tbody>' + state.opportunities.map(o => '<tr><td><strong>' + escapeHtml(o.title) + '</strong><small>' + escapeHtml(o.category || 'unclassified') + '</small></td><td><span class="pill">' + escapeHtml(String(o.legitimacy_status).replace('_',' ').toUpperCase()) + '</span></td><td>' + Number(o.score || 0) + '/100</td><td><a href="' + escapeHtml(o.target_url) + '" target="_blank" rel="noopener noreferrer">Open ↗</a></td><td>' + (['pending_review','unverified'].includes(o.legitimacy_status) ? '<button class="text-button" data-review="' + escapeHtml(o.id) + '" data-status="verified">Verify</button> <button class="text-button" data-review="' + escapeHtml(o.id) + '" data-status="rejected">Reject</button>' : '—') + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="empty-state compact"><strong>No candidates yet</strong><p>Add a candidate above. Automated crawling is not active.</p></div>') + '</section>';
  } else if (id === 'products') {
    content = '<section class="panel form-panel"><div class="panel-heading"><div><div class="eyebrow">CATALOG</div><h2>Create product draft</h2></div><span class="pill muted">DRAFT ONLY</span></div><form id="product-form" class="source-form"><label class="full-field">Product title<input name="title" required maxlength="160" /></label><label>Price (MYR)<input name="price" type="number" min="0" step="0.01" value="0" required /></label><label>URL slug<input name="slug" maxlength="100" placeholder="Optional" /></label><label class="full-field">Description<textarea name="description" rows="3" maxlength="5000"></textarea></label><div class="form-actions"><p>Prices are stored in sen. Products remain drafts; checkout and downloads are not enabled.</p><button class="primary-button" type="submit">Save draft ＋</button></div></form></section>' +
    '<section class="panel"><div class="panel-heading"><div><div class="eyebrow">PRODUCT INVENTORY</div><h2>Catalog</h2></div><span class="pill">' + state.products.length + ' TOTAL</span></div>' +
    (state.products.length ? '<div class="table-wrap"><table><thead><tr><th>PRODUCT</th><th>PRICE</th><th>STATUS</th></tr></thead><tbody>' + state.products.map(p => '<tr><td><strong>' + escapeHtml(p.title) + '</strong><small>/' + escapeHtml(p.slug) + '</small></td><td>' + escapeHtml(p.currency) + ' ' + (Number(p.price_minor || 0)/100).toFixed(2) + '</td><td><span class="pill">' + escapeHtml(p.status.toUpperCase()) + '</span></td></tr>').join('') + '</tbody></table></div>' : '<div class="empty-state compact"><strong>No products yet</strong><p>Create a draft to start the catalog.</p></div>') + '</section>';
  } else if (id === 'creative') {
    content = '<section class="panel form-panel"><div class="panel-heading"><div><div class="eyebrow">CLIENT INTAKE</div><h2>New creative brief</h2></div><span class="pill muted">BRIEF RECEIVED</span></div><form id="creative-form" class="source-form"><label>Client name<input name="client_name" required maxlength="160" /></label><label>Contact<input name="client_contact" maxlength="250" placeholder="Optional" /></label><label class="full-field">Project title<input name="title" required maxlength="200" /></label><label>Deliverable<select name="deliverable_type"><option>brand identity</option><option>social content</option><option>poster</option><option>video</option><option>website</option><option>ebook</option><option>infographic</option><option>other</option></select></label><label class="full-field">Brief<textarea name="brief" rows="4" maxlength="8000" placeholder="Goals, audience, deliverables, deadline and references"></textarea></label><div class="form-actions"><p>Saved as an intake record. Pricing and file delivery are not connected.</p><button class="primary-button" type="submit">Save brief ＋</button></div></form></section>' +
    '<section class="panel"><div class="panel-heading"><div><div class="eyebrow">PROJECT PIPELINE</div><h2>Creative jobs</h2></div><span class="pill">' + state.creativeJobs.length + ' TOTAL</span></div>' +
    (state.creativeJobs.length ? '<div class="table-wrap"><table><thead><tr><th>PROJECT</th><th>CLIENT</th><th>DELIVERABLE</th><th>STATUS</th></tr></thead><tbody>' + state.creativeJobs.map(j => '<tr><td><strong>' + escapeHtml(j.title) + '</strong><small>' + escapeHtml((j.brief || '').slice(0,100)) + '</small></td><td>' + escapeHtml(j.client_name) + '</td><td>' + escapeHtml(j.deliverable_type) + '</td><td><span class="pill">' + escapeHtml(j.status.replace('_',' ').toUpperCase()) + '</span></td></tr>').join('') + '</tbody></table></div>' : '<div class="empty-state compact"><strong>No briefs received</strong><p>New client briefs will appear here.</p></div>') + '</section>';
  } else {
    content = '<section class="panel"><div class="panel-heading"><div><div class="eyebrow">AUDIT TRAIL</div><h2>Recent events</h2></div><button class="secondary-button" id="refresh-logs">Refresh ↻</button></div>' +
    (state.auditEvents.length ? '<div class="table-wrap"><table><thead><tr><th>EVENT</th><th>SEVERITY</th><th>MESSAGE</th><th>TIME</th></tr></thead><tbody>' + state.auditEvents.map(e => '<tr><td><strong>' + escapeHtml(e.event_type) + '</strong><small>' + escapeHtml(e.actor) + '</small></td><td><span class="pill">' + escapeHtml(e.severity.toUpperCase()) + '</span></td><td>' + escapeHtml(e.message) + '</td><td>' + escapeHtml(String(e.created_at || '').replace('T',' ').slice(0,19)) + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="empty-state compact"><strong>No audit events yet</strong><p>Authenticated operations will be recorded here.</p></div>') + '</section>';
  }
  return '<section class="welcome-row"><div><div class="eyebrow">' + label + '</div><h1>' + title + ' <span>.</span></h1><p class="subhead">' + subtitle + '</p></div></section>' + content;
}

function render() {
  const views = {
    overview,
    discovery: () => simpleView('discovery','Opportunity discovery','Register, inspect and review opportunity candidates.','BOT 00 · DISCOVERY',''),
    sources: sourcesView,
    products: () => simpleView('products','Product engine','Manage digital product drafts and catalog records.','COMMERCE ENGINE A',''),
    creative: () => simpleView('creative','Creative services','Capture and track client creative briefs.','COMMERCE ENGINE B',''),
    activity: () => simpleView('activity','Activity logs','Inspect authenticated operations and recent system events.','OMEGA · OBSERVABILITY',''),
    settings: settingsView,
  };
  const app = document.querySelector('#app');
  app.innerHTML = `<div class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="#" data-view="overview"><span class="brand-symbol">R<span>Ø</span></span><span class="brand-wordmark">RØGUE<small>AUTONOMOUS OS</small></span></a>
      <div class="workspace-label">WORKSPACE <span>⌄</span></div><div class="workspace-card"><div class="workspace-avatar">Ω</div><div><strong>Omega Core</strong><small>Personal workspace</small></div><span class="workspace-menu">•••</span></div>
      <div class="nav-label">COMMAND</div><nav>${navItem('overview','Overview')}${navItem('discovery','Discovery')}${navItem('sources','Sources & Integrations')}</nav>
      <div class="nav-label">COMMERCE</div><nav>${navItem('products','Product Engine')}${navItem('creative','Creative Services')}</nav>
      <div class="nav-label">SYSTEM</div><nav>${navItem('activity','Activity Logs')}${navItem('settings','Settings')}</nav>
      <div class="sidebar-bottom"><div class="runtime-card"><div class="runtime-heading"><span class="status-dot"></span> OMEGA CONTROL <span class="pill muted">SAFE</span></div><p>Autonomous actions are paused until backend controls are configured.</p><div class="runtime-bar"><span></span></div><small>SAFETY MODE · ACTIVE</small></div><div class="profile-row"><div class="profile-avatar">R</div><div><strong>Operator</strong><small>System administrator</small></div><span class="profile-dots">•••</span></div></div>
    </aside>
    <main class="main-area"><header class="topbar"><div class="breadcrumb"><span>RØGUE OS</span><b>/</b><strong>${state.activeView === 'overview' ? 'Command' : state.activeView === 'sources' ? 'Sources & Integrations' : state.activeView[0].toUpperCase()+state.activeView.slice(1)}</strong></div><div class="topbar-right"><span class="environment"><i></i> WORKER LIVE</span><button class="icon-button top-icon" id="help-button" aria-label="About this preview">?</button><div class="top-avatar">R</div></div></header><div class="page-content">${(views[state.activeView] || overview)()}</div><footer class="app-footer"><span>RØGUE AUTONOMOUS COMMERCE OS <b>·</b> FOUNDATION 0.1.0</span><span>BUILT FOR CONTROL. DESIGNED FOR SCALE.</span></footer></main>
  </div>`;
  document.querySelectorAll('[data-view]').forEach((el) => el.addEventListener('click', (event) => {
    event.preventDefault();
    state.activeView = el.dataset.view;
    render();
  }));
  document.querySelector('#token-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = String(new FormData(event.currentTarget).get('token') || '').trim();
    sessionStorage.setItem('rogue_admin_token', token);
    const result = document.querySelector('#connection-result');
    result.textContent = 'Testing protected API…';
    try {
      await apiRequest('/api/sources');
      result.textContent = 'Connected. Source API authentication succeeded.';
      await refreshSources();
    } catch (error) {
      result.textContent = 'Connection failed: ' + error.message + '. Check Worker deployment and the ROGUE_ADMIN_TOKEN secret.';
    }
  });
  document.querySelector('#run-discovery')?.addEventListener('click', () => {
    state.activeView = 'discovery';
    render();
  });
  document.querySelector('#source-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const rawUrl = String(form.get('url') || '').trim();
    try {
      const parsed = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid URL');
      const submitButton = event.currentTarget.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      submitButton.textContent = 'Saving…';
      apiRequest('/api/sources', { method: 'POST', body: JSON.stringify({ name: String(form.get('name')).trim(), type: String(form.get('type')), url: parsed.href, notes: String(form.get('notes') || '').trim() }) })
        .then(() => refreshSources()).then(() => render())
        .catch((error) => { window.alert('Could not save source: ' + error.message); submitButton.disabled = false; submitButton.textContent = 'Add source ＋'; });
    } catch {
      const input = event.currentTarget.elements.url;
      input.setCustomValidity('Enter a valid public HTTP or HTTPS URL without embedded credentials.');
      input.reportValidity();
      input.addEventListener('input', () => input.setCustomValidity(), { once: true });
    }
  });
  document.querySelectorAll('[data-remove-source]').forEach((el) => el.addEventListener('click', async () => {
    const source = state.sources[Number(el.dataset.removeSource)];
    if (!source || !window.confirm('Remove source "' + source.name + '"?')) return;
    try {
      await apiRequest('/api/sources/' + encodeURIComponent(source.id), { method: 'DELETE' });
      await refreshSources();
      render();
    } catch (error) { window.alert('Could not remove source: ' + error.message); }
  }));
  document.querySelector('#help-button')?.addEventListener('click', () => {
    window.alert('RØGUE OS Foundation 0.1.0\nThis is a frontend foundation. Source entries currently live in memory only and disappear on refresh. No automated fetching, payments or AI actions are running.');
  });
}

refreshAll().finally(render);
