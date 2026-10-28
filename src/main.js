import './style.css';

const state = {
  activeView: 'overview',
  sources: [],
  opportunities: [],
  health: 'Checking',
};

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
  return `<section class="welcome-row"><div><div class="eyebrow">${label}</div><h1>${title} <span>.</span></h1><p class="subhead">${subtitle}</p></div></section>
    <section class="panel placeholder-panel"><div class="placeholder-icon">${icons[id] || '◈'}</div><div class="eyebrow">FOUNDATION PHASE</div><h2>${description}</h2><p>This module is intentionally not simulated. It will be connected to persistent storage and validated workflows in a later implementation step.</p><span class="pill muted">NOT IMPLEMENTED YET</span></section>`;
}

function render() {
  const views = {
    overview,
    discovery: () => simpleView('discovery','Opportunity discovery','Find, verify and rank opportunities from configured sources.','BOT 00 · DISCOVERY','The discovery engine needs a secure server-side fetcher, source policies and evidence records.'),
    sources: sourcesView,
    products: () => simpleView('products','Product engine','Manage digital products, offers and protected customer downloads.','COMMERCE ENGINE A','The product catalog, order lifecycle and payment verification are not connected yet.'),
    creative: () => simpleView('creative','Creative services','Track client briefs, production jobs and deliverable approvals.','COMMERCE ENGINE B','The creative workflow needs job records, asset storage and production integrations.'),
    activity: () => simpleView('activity','Activity logs','Inspect orchestration events, failures and safety limits.','OMEGA · OBSERVABILITY','Persistent audit logs and emergency-stop controls will be added with the backend.'),
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
    <main class="main-area"><header class="topbar"><div class="breadcrumb"><span>RØGUE OS</span><b>/</b><strong>${state.activeView === 'overview' ? 'Command' : state.activeView === 'sources' ? 'Sources & Integrations' : state.activeView[0].toUpperCase()+state.activeView.slice(1)}</strong></div><div class="topbar-right"><span class="environment"><i></i> LOCAL PREVIEW</span><button class="icon-button top-icon" id="help-button" aria-label="About this preview">?</button><div class="top-avatar">R</div></div></header><div class="page-content">${(views[state.activeView] || overview)()}</div><footer class="app-footer"><span>RØGUE AUTONOMOUS COMMERCE OS <b>·</b> FOUNDATION 0.1.0</span><span>BUILT FOR CONTROL. DESIGNED FOR SCALE.</span></footer></main>
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

refreshSources().finally(render);
