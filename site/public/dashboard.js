/* Orbitabs web dashboard (B4) — vanilla JS, no build step.
   Same-origin would be ideal, but the API worker and this site are separate
   deployments on *.freebuff.page: the worker's CORS allow-list already
   permits *.freebuff.page origins, and every /api call still carries the
   user's own JWT. Nothing here can do more than the extension can.
   B5: ?share=TOKEN opens the claim flow (sign in → preview → import). */

(() => {
  'use strict';

  // 🌍 API origin — production default matches the extension's Store build
  //    (src/services/api.js STORED_API_ORIGIN). ?api= or localStorage override
  //    points the dashboard at a local backend for development.
  const STORED_API_ORIGIN = 'https://site-8b67ef3788b2498f88d007d22c888375.freebuff.page';
  const params = new URLSearchParams(location.search);
  if (params.get('api')) localStorage.setItem('orbi_web_api', params.get('api').replace(/\/+$/, ''));
  const API = (localStorage.getItem('orbi_web_api') || STORED_API_ORIGIN).replace(/\/+$/, '');
  const SHARE_TOKEN = params.get('share') || '';

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'orbi_web_token';
  const REFRESH_KEY = 'orbi_web_refresh';
  const USER_KEY = 'orbi_web_user';

  let sessions = [];
  let plan = null;
  let query = '';
  let activeFolder = null;
  let expandedId = null;
  let sharePreview = null; // { name, windows, tabs, expiresAt } for ?share=

  /* ---------------- transport ---------------- */
  const authHeaders = () => {
    const t = localStorage.getItem(TOKEN_KEY);
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  async function api(path, { method = 'GET', body, auth = true } = {}) {
    const doFetch = () => fetch(`${API}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth ? authHeaders() : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let res = await doFetch();
    // 401 → rotate the refresh token ONCE; only a dead refresh signs out.
    if (res.status === 401 && auth && localStorage.getItem(REFRESH_KEY) && !path.startsWith('/auth/')) {
      const r = await fetch(`${API}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: localStorage.getItem(REFRESH_KEY) }),
      });
      if (r.ok) {
        const d = await r.json().catch(() => ({}));
        if (d.token) {
          localStorage.setItem(TOKEN_KEY, d.token);
          if (d.refreshToken) localStorage.setItem(REFRESH_KEY, d.refreshToken);
          res = await doFetch();
        } else signOut(false);
      } else signOut(false);
    } else if (res.status === 401 && auth && !path.startsWith('/auth/')) {
      signOut(false);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ---------------- chrome-free session helpers ---------------- */
  const winList = (s) => (Array.isArray(s.windows) && s.windows.length
    ? s.windows
    : (Array.isArray(s.urls) && s.urls.length
      ? [{ tabs: s.urls.map((u) => ({ url: u, title: '' })), groups: [] }]
      : []));
  const allTabs = (s) => winList(s).flatMap((w) => (Array.isArray(w.tabs) ? w.tabs : []));
  const normalizeUrl = (u) => (!u ? '' : /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u) ? u : `https://${u}`);
  const savedLabel = (s) => {
    const t = new Date(s.updatedAt || s.createdAt);
    const diff = (Date.now() - t.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    return t.toLocaleDateString();
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /* ---------------- views ---------------- */
  const showAuth = (withBanner) => {
    $('auth-view').classList.remove('hidden');
    $('app-view').classList.add('hidden');
    $('share-banner').classList.toggle('hidden', !withBanner);
  };

  function showApp() {
    $('auth-view').classList.add('hidden');
    $('app-view').classList.remove('hidden');
    const u = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    $('user-email').textContent = u?.email || '';
    refreshAll();
  }

  function signOut(callServer = true) {
    if (callServer) api('/auth/logout', { method: 'POST', body: { refreshToken: localStorage.getItem(REFRESH_KEY) } }).catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    showAuth(false);
  }

  const toast = (msg, kind = 'ok') => {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast ${kind}`;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 3600);
  };

  /* ---------------- data loads ---------------- */
  async function refreshAll() {
    try {
      plan = await api('/me/plan');
      renderPlan();
    } catch { plan = null; renderPlan(); }
    try {
      sessions = await api('/sessions');
      $('status-line').textContent = `${sessions.length} session${sessions.length === 1 ? '' : 's'} in your library`;
      renderFolders();
      renderSessions();
    } catch (err) {
      $('status-line').textContent = err.status === 401 ? 'Sign in to see your sessions.' : `Could not load sessions — ${err.message}`;
      sessions = [];
      renderSessions();
    }
    if (SHARE_TOKEN) await loadSharePreview();
  }

  function renderPlan() {
    const chip = $('plan-chip');
    const card = $('plan-card');
    if (!plan) { chip.textContent = '—'; chip.className = 'chip plan-free'; card.innerHTML = ''; return; }
    const isPro = plan.plan === 'pro';
    chip.textContent = isPro ? 'PRO' : 'FREE';
    chip.className = `chip ${isPro ? 'plan-pro' : 'plan-free'}`;
    const used = plan.usage?.syncedSessions ?? sessions.length;
    const limit = plan.limits?.maxSyncedSessions ?? '—';
    card.innerHTML = isPro
      ? `<div class="plan-title">✨ Pro — unlimited sync</div>
         <p>Version history keeps the last ${plan.features?.maxVersions ?? 20} states of every session.</p>`
      : `<div class="plan-title">Free plan</div>
         <p>${used}/${limit} sessions synced. Pro removes the sync cap (local storage on your devices is never capped).</p>
         <button id="upgrade-btn" class="btn primary small">Upgrade to Pro</button>`;
    const btn = $('upgrade-btn');
    if (btn) btn.addEventListener('click', upgrade);
  }

  async function upgrade() {
    const btn = $('upgrade-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
    try {
      const r = await api('/billing/checkout', { method: 'POST' });
      // Redirect only to a real HTTPS checkout URL — never to a scheme the
      // server didn't earn (javascript:, data:, …).
      if (r.url && /^https:\/\//i.test(r.url)) location.href = r.url;
      else toast(r.url ? 'Checkout returned a non-HTTPS URL.' : 'Checkout did not return a URL.', 'err');
    } catch (err) {
      toast(err.data?.code === 'billing-not-configured'
        ? 'Payments are not live on this server yet — nothing was charged.'
        : (err.message || 'Could not start checkout.'), 'err');
      if (btn) { btn.disabled = false; btn.textContent = 'Upgrade to Pro'; }
    }
  }

  /* ---------------- filtering ---------------- */
  const matches = (s) => {
    if (activeFolder && (s.folder || null) !== activeFolder) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const hay = [s.name, s.folder || '', s.note || '', ...(s.tags || []),
      ...allTabs(s).map((t) => `${t.title || ''} ${t.url || ''}`)].join(' ').toLowerCase();
    return hay.includes(q);
  };

  function renderFolders() {
    const counts = {};
    sessions.forEach((s) => {
      const f = s.folder || null;
      counts[f] = (counts[f] || 0) + 1;
    });
    const items = [null, ...Object.keys(counts).filter(Boolean).sort()];
    $('folder-list').innerHTML = items.map((f) => `
      <li class="${activeFolder === f ? 'active' : ''}" data-folder="${f === null ? '' : esc(f)}">
        <span>${f === null ? 'All sessions' : esc(f)}</span><span>${f === null ? sessions.length : counts[f]}</span>
      </li>`).join('');
    $('folder-list').querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () => {
        activeFolder = li.dataset.folder || null;
        renderFolders();
        renderSessions();
      });
    });
  }

  /* ---------------- sessions ---------------- */
  const GROUP_DOT = {
    grey: '#94a3b8', blue: '#60a5fa', red: '#f87171', yellow: '#fbbf24',
    green: '#34d399', pink: '#f472b6', purple: '#a78bfa', cyan: '#22d3ee', orange: '#fb923c',
  };

  function renderSessions() {
    const list = sessions.filter(matches);
    const el = $('session-list');
    if (!list.length) {
      el.innerHTML = `<div class="empty"><h3>${sessions.length ? 'Nothing matches' : 'No sessions yet'}</h3>
        <p>${sessions.length ? 'Try a different search or folder.' : 'Save a session in the Orbitabs extension — it appears here after the next sync.'}</p></div>`;
      return;
    }
    el.innerHTML = list.map((s, i) => {
      const wins = winList(s);
      const tabs = allTabs(s);
      const open = expandedId === i;
      return `<article class="session" data-i="${i}">
        <h4 title="${esc(s.name)}">${esc(s.name)}</h4>
        <div class="summary">${tabs.length} tab${tabs.length === 1 ? '' : 's'} · ${wins.length} window${wins.length === 1 ? '' : 's'} · saved ${savedLabel(s)}</div>
        ${s.folder ? `<div class="summary">📁 ${esc(s.folder)}</div>` : ''}
        ${s.note ? `<div class="note" title="${esc(s.note)}">${esc(s.note)}</div>` : ''}
        ${(s.tags || []).length ? `<div class="tags">${s.tags.slice(0, 6).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
        <div class="actions">
          <button class="btn small" data-act="toggle">${open ? 'Hide links' : 'Show links'}</button>
          <button class="btn small" data-act="copy">Copy links</button>
          <button class="btn small" data-act="csv">CSV</button>
          <button class="btn small" data-act="json">JSON</button>
        </div>
        ${open ? `<div class="windows">${wins.map((w, wi) => `
          <div class="window">
            <div class="window-title">Window ${wi + 1}</div>
${(w.tabs || []).map((t) => {
              const url = normalizeUrl(t.url);
              const dot = t.groupId
                ? (w.groups || []).find((g) => g.id === t.groupId)
                : null;
              // Linkify ONLY http(s). Session data can arrive via a share link
              // (someone else's session), so an attacker-supplied
              // "javascript:"/"data:" URL must render as inert text, never as
              // a clickable href (stored-XSS-on-click into this origin, where
              // the auth token lives in localStorage).
              const hrefOk = /^https?:/i.test(url);
              const open = hrefOk
                ? `a href="${esc(url)}" target="_blank" rel="noopener noreferrer"`
                : 'span title="(non-web link — not opened)"';
              return `<${open} class="tab-row">
                <span class="tab-dot" style="background:${GROUP_DOT[dot?.color] || '#475569'}"></span>
                <span class="tab-title">${esc(t.title || url || '(untitled)')}</span>
                <span class="tab-url">${esc(url)}</span>
              </${hrefOk ? 'a' : 'span'}>`;
            }).join('')}
          </div>`).join('')}</div>` : ''}
      </article>`;
    }).join('');

    el.querySelectorAll('.session').forEach((card) => {
      const i = Number(card.dataset.i);
      const s = list[i];
      card.querySelectorAll('button[data-act]').forEach((b) => {
        b.addEventListener('click', () => {
          const act = b.dataset.act;
          if (act === 'toggle') { expandedId = expandedId === i ? null : i; renderSessions(); }
          if (act === 'copy') copyLinks(s);
          if (act === 'csv') downloadFile(`${safeName(s)}.csv`, toCsv(s), 'text/csv');
          if (act === 'json') downloadFile(`${safeName(s)}.json`, JSON.stringify(s, null, 2), 'application/json');
        });
      });
    });
  }

  const safeName = (s) => (s.name || 'session').replace(/[^\w.-]+/g, '_').slice(0, 60);

  async function copyLinks(s) {
    const text = allTabs(s).map((t) => normalizeUrl(t.url)).filter(Boolean).join('\n');
    if (!text) return toast('This session has no links.', 'err');
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${text.split('\n').length} link(s).`);
    } catch {
      toast('Clipboard unavailable — use the CSV export instead.', 'err');
    }
  }

  const toCsv = (s) => {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['session', 'window', 'tab', 'title', 'url']];
    winList(s).forEach((w, wi) => (w.tabs || []).forEach((t, ti) => {
      rows.push([s.name, wi + 1, ti + 1, t.title || '', normalizeUrl(t.url)]);
    }));
    return rows.map((r) => r.map(q).join(',')).join('\n');
  };

  function downloadFile(name, text, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------------- B5 share import ---------------- */
  async function loadSharePreview() {
    if (!localStorage.getItem(TOKEN_KEY)) return; // auth view already shows the banner
    try {
      sharePreview = await api(`/shares/${encodeURIComponent(SHARE_TOKEN)}`);
      const card = $('import-card');
      card.classList.remove('hidden');
      card.innerHTML = `
        <div class="meta">
          <h3>🔗 Shared with you: ${esc(sharePreview.name)}</h3>
          <p>${sharePreview.windows} window${sharePreview.windows === 1 ? '' : 's'} · ${sharePreview.tabs} tab${sharePreview.tabs === 1 ? '' : 's'}
             · link valid until ${new Date(sharePreview.expiresAt).toLocaleDateString()}</p>
        </div>
        <button id="claim-btn" class="btn primary">Import into my library</button>
        <button id="claim-dismiss" class="btn ghost">Dismiss</button>`;
      $('claim-btn').addEventListener('click', claimShare);
      $('claim-dismiss').addEventListener('click', dismissShare);
    } catch (err) {
      const card = $('import-card');
      card.classList.remove('hidden');
      card.innerHTML = `<div class="meta"><h3>🔗 Share link</h3><p>${esc(err.message)}</p></div>
        <button id="claim-dismiss" class="btn ghost">Dismiss</button>`;
      $('claim-dismiss').addEventListener('click', dismissShare);
    }
  }

  async function claimShare() {
    const btn = $('claim-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
    try {
      const r = await api(`/shares/${encodeURIComponent(SHARE_TOKEN)}`, { method: 'POST' });
      toast(r.deduped ? 'Already in your library — nothing duplicated.' : 'Imported into your library ✓');
      dismissShare();
      await refreshAll();
    } catch (err) {
      toast(err.data?.code === 'quota-exceeded'
        ? `${err.message} Upgrade to Pro for unlimited sync.`
        : (err.message || 'Import failed.'), 'err');
      if (btn) { btn.disabled = false; btn.textContent = 'Import into my library'; }
    }
  }

  function dismissShare() {
    $('import-card').classList.add('hidden');
    history.replaceState(null, '', location.pathname);
  }

  /* ---------------- boot ---------------- */
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('login-btn');
    const errEl = $('auth-error');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    errEl.classList.add('hidden');
    try {
      const r = await api('/auth/login', {
        method: 'POST',
        auth: false,
        body: { email: $('email').value.trim(), password: $('password').value },
      });
      localStorage.setItem(TOKEN_KEY, r.token);
      if (r.refreshToken) localStorage.setItem(REFRESH_KEY, r.refreshToken);
      localStorage.setItem(USER_KEY, JSON.stringify(r.user || {}));
      showApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  $('forgot-link').addEventListener('click', async (e) => {
    e.preventDefault();
    const email = $('email').value.trim();
    if (!email) return toast('Enter your email first, then click forgot password.', 'err');
    try {
      await api('/auth/forgot-password', { method: 'POST', auth: false, body: { email } });
      toast('If that email has an account, a reset link is on its way.');
    } catch {
      toast('Could not send the request — try again.', 'err');
    }
  });

  $('signout-btn').addEventListener('click', () => signOut(true));
  $('search').addEventListener('input', (e) => { query = e.target.value; expandedId = null; renderSessions(); });

  // 🚀 boot — a stored session goes straight to the app; otherwise sign-in.
  if (localStorage.getItem(TOKEN_KEY)) showApp();
  else showAuth(!!SHARE_TOKEN);
})();
