// ============================================================================
// RELIABILITY TEST: the "stranger can trust it" hardening
// Run: node scripts/reliability.test.mjs
//
//   A1  empty crash candidate is never queued (recovery never lies)
//   A2  real crash still queues + restores (regression guard)
//   A3  crash window is 12h (MV3 sleep ≠ crash); clean exit never flags
//   A4  quick-save works even with auto-save OFF (explicit action ≠ backup)
//   A5  dead backend → sync skips cleanly (local data untouched)
//   B1  saved-link URLs: chrome://, file:// never rewritten; bare hosts get https
// ============================================================================

import vm from 'node:vm';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerCode = readFileSync(join(root, 'public/background.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- jsdom globals (part B) ---------------- */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'customElements', 'getComputedStyle']) {
  Object.defineProperty(globalThis, k, { value: dom.window[k] ?? globalThis[k], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const vite = await import('vite');
const server = await vite.createServer({
  root, configFile: false, plugins: [], optimizeDeps: { disabled: true },
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
});

/* ---------------- faithful chrome mock (commands sink included) ---------------- */
function createChromeMock() {
  let nextTabId = 5000, nextWinId = 4000, nextGroupId = 50000;
  const state = {
    windows: [], groupMeta: new Map(),
    local: {}, session: {}, badge: '', badgeColor: '', title: '',
    messageListener: null, startupListener: null, commandListener: null,
  };
  const findWin = (id) => state.windows.find(w => w.id === id);
  const chrome = {
    commands: { onCommand: { addListener(cb) { state.commandListener = cb; } } },
    windows: {
      onCreated: { addListener() {} }, onRemoved: { addListener() {} },
      async getAll(opts = {}) {
        return state.windows.map(w => ({
          id: w.id, state: w.state, focused: w.focused,
          ...(opts.populate ? { tabs: w.tabs.map(t => ({ ...t })) } : {})
        }));
      },
      async create({ url = [], focused = false, state: winState = 'normal' } = {}) {
        const win = { id: ++nextWinId, state: winState, focused, tabs: url.map(u => ({ id: ++nextTabId, url: u, title: u, pinned: false, active: false, groupId: -1 })) };
        if (win.tabs[0]) win.tabs[0].active = true;
        state.windows.push(win);
        return { id: win.id, tabs: win.tabs.map(t => ({ ...t })) };
      },
      async update(id, props = {}) {
        const win = findWin(id);
        if (!win) throw new Error('no such window');
        if ('focused' in props) state.windows.forEach(w => (w.focused = w.id === id ? !!props.focused : false));
        if ('state' in props) win.state = props.state;
        return { id: win.id };
      }
    },
    tabs: {
      async group({ tabIds, createProperties = {} } = {}) {
        const gid = ++nextGroupId;
        const win = findWin(createProperties.windowId) || state.windows.find(w => w.tabs.some(t => tabIds.includes(t.id)));
        if (!win) throw new Error('group: no window');
        win.tabs.forEach(t => { if (tabIds.includes(t.id)) t.groupId = gid; });
        state.groupMeta.set(gid, { title: '', color: 'grey', collapsed: false });
        return gid;
      },
      async ungroup(tabIds) { state.windows.forEach(w => w.tabs.forEach(t => { if (tabIds.includes(t.id)) t.groupId = -1; })); },
      async update(tabId, props = {}) {
        const win = state.windows.find(w => w.tabs.some(t => t.id === tabId));
        if (!win) throw new Error('no such tab');
        const tab = win.tabs.find(t => t.id === tabId);
        if (props.pinned === true) {
          tab.pinned = true;
          const idx = win.tabs.indexOf(tab);
          win.tabs.splice(idx, 1);
          const pinnedCount = win.tabs.filter(t => t.pinned).length;
          win.tabs.splice(pinnedCount, 0, tab);
        }
        if (props.pinned === false) tab.pinned = false;
        if (props.active === true) win.tabs.forEach(t => (t.active = t.id === tabId));
        return { id: tabId };
      },
      async query(q = {}) {
        const out = [];
        state.windows.forEach(w => w.tabs.forEach(t => {
          if (q.groupId !== undefined && t.groupId !== q.groupId) return;
          out.push({ ...t, windowId: w.id });
        }));
        return out;
      },
      onCreated: { addListener() {} }, onRemoved: { addListener() {} },
      onMoved: { addListener() {} }, onAttached: { addListener() {} },
      onDetached: { addListener() {} }, onReplaced: { addListener() {} },
      onUpdated: { addListener() {} }
    },
    tabGroups: {
      async query({ windowId } = {}) {
        const win = findWin(windowId);
        if (!win) return [];
        const ids = [...new Set(win.tabs.map(t => t.groupId).filter(g => g !== -1))];
        return ids.map(g => ({ id: g, ...(state.groupMeta.get(g) || { title: '', color: 'grey', collapsed: false }) }));
      },
      async update(groupId, props = {}) {
        const meta = state.groupMeta.get(groupId) || { title: '', color: 'grey', collapsed: false };
        state.groupMeta.set(groupId, { ...meta, ...props });
        return { id: groupId };
      },
      onCreated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} }
    },
    storage: {
      local: {
        async get(keys) {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in state.local) out[k] = state.local[k]; });
          return out;
        },
        async set(obj) { Object.assign(state.local, obj); },
        async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete state.local[k]); }
      },
      session: {
        async get(keys) { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in state.session) out[k] = state.session[k]; }); return out; },
        async set(obj) { Object.assign(state.session, obj); }
      }
    },
    alarms: { create() {}, clear() {}, async getAll() { return []; }, onAlarm: { addListener() {} } },
    action: {
      setBadgeText: async (o) => { state.badge = o.text || ''; },
      setBadgeBackgroundColor: async (o) => { state.badgeColor = o.color || ''; },
      setTitle: async (o) => { state.title = o.title || ''; }
    },
    runtime: {
      onMessage: { addListener(cb) { state.messageListener = cb; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener(cb) { state.startupListener = cb; } },
      async sendMessage() { return { ok: false }; }
    }
  };
  return { chrome, state };
}

async function sendMessage(mock, msg) {
  let response = null;
  mock.state.messageListener(msg, {}, (r) => { response = r; });
  for (let i = 0; i < 100 && response === null; i++) await sleep(10);
  return response;
}

const loadWorker = (mock, extra = {}) => {
  const sandbox = { chrome: mock.chrome, console, setTimeout, clearTimeout, Date, fetch: async () => { throw new Error('ECONNREFUSED'); }, AbortSignal, ...extra };
  vm.createContext(sandbox);
  vm.runInContext(workerCode, sandbox, { filename: 'background.js' });
};

const browserWith = (mock, n = 4) => {
  mock.state.windows.push({ id: 1, state: 'normal', focused: true, tabs: Array.from({ length: n }, (_, i) => ({ id: 100 + i, url: `https://t${i}.example.com`, title: `T${i}`, pinned: i === 0, active: i === 1, groupId: -1 })) });
};

/* ================================================================== *
 * A1 — empty crash candidate never queues
 * ================================================================== */
console.log('\n── A1: empty crash candidate guard ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  // "crashed" per timestamps, but the snapshot captured NOTHING (race with crash)
  mock.state.local.snapshot = { savedAt: Date.now(), windows: [{ state: 'normal', focused: true, tabs: [], groups: [] }] };
  mock.state.local.cleanExit = false;
  mock.state.local.lastAlive = Date.now() - 30000;
  await mock.state.startupListener();
  await sleep(50);
  ok('no recoveryCandidate queued for 0-tab snapshot', !mock.state.local.recoveryCandidate);
  ok('no crash badge shown', mock.state.badge === '');
}

/* ================================================================== *
 * A2 — real crash still queues + restores
 * ================================================================== */
console.log('\n── A2: real crash → candidate → restore ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  browserWith(mock, 4);
  await sendMessage(mock, { type: 'SNAPSHOT_NOW' }); // real capture → local.snapshot
  ok('SNAPSHOT_NOW wrote the crash-proof local snapshot', (mock.state.local.snapshot?.windows?.[0]?.tabs?.length) === 4);
  mock.state.local.cleanExit = false;
  mock.state.local.lastAlive = Date.now() - 30000;
  await mock.state.startupListener();
  await sleep(80);
  const cand = mock.state.local.recoveryCandidate;
  ok('candidate queued with 4 tabs', !!cand && cand.windows[0].tabs.length === 4);
  ok('crash badge "!" + red + title set', mock.state.badge === '!' && mock.state.badgeColor === '#ef4444' && mock.state.title.includes('crashed'));
  mock.state.windows = [];
  const rec = await sendMessage(mock, { type: 'RESTORE_RECOVERY' });
  ok('RESTORE_RECOVERY rebuilds the 4 tabs', rec?.ok === true && rec?.restoredTabs === 4);
  ok('recovery state cleared after restore', !mock.state.local.recoveryCandidate && mock.state.badge === '');
}

/* ================================================================== *
 * A3 — 12h crash window: MV3 sleep ≠ crash; clean exit never flags
 * ================================================================== */
console.log('\n── A3: crash-window semantics ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  browserWith(mock, 3);
  await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
  // Worker frozen for 11 hours (long idle / OS sleep) then Chrome restarted:
  mock.state.local.cleanExit = false;
  mock.state.local.lastAlive = Date.now() - 11 * 3600 * 1000;
  await mock.state.startupListener();
  await sleep(50);
  ok('11h-stale heartbeat still counts as a crash (recovery NOT silently dropped)', !!mock.state.local.recoveryCandidate);

  const mock2 = createChromeMock();
  loadWorker(mock2);
  browserWith(mock2, 3);
  mock2.state.local.cleanExit = true; // graceful shutdown
  mock2.state.local.lastAlive = Date.now();
  await mock2.state.startupListener();
  await sleep(50);
  ok('clean exit never queues recovery', !mock2.state.local.recoveryCandidate && mock2.state.badge === '');
}

/* ================================================================== *
 * A4 — quick-save ignores the auto-save gate
 * ================================================================== */
console.log('\n── A4: quick-save with auto-save OFF ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  browserWith(mock, 2);
  mock.state.local.orbi_settings = { autoSave: false };
  await mock.state.commandListener('quick-save');
  await sleep(80);
  const list = mock.state.local.orbi_sessions || [];
  ok('quick-save SAVED despite autoSave=false (explicit action)', list.length === 1 && /^Quick Save — /.test(list[0].name));

  const mock2 = createChromeMock();
  loadWorker(mock2);
  mock2.state.local.orbi_settings = { autoSave: false }; // no windows at all
  await mock2.state.commandListener('quick-save');
  await sleep(80);
  ok('quick-save with 0 tabs still refuses to save an empty session', !(mock2.state.local.orbi_sessions || []).length);
}

/* ================================================================== *
 * A5 — dead backend skips cleanly
 * ================================================================== */
console.log('\n── A5: SYNC_NOW with unreachable backend ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  browserWith(mock, 2);
  await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
  mock.state.local.token = 'fake-jwt'; // signed in, backend down
  // Settings contract: cloud sync is opt-in — enable it so SYNC_NOW actually
  // attempts the network (that's the behavior under test here).
  mock.state.local.orbi_settings = { cloudSync: true };
  const resp = await sendMessage(mock, { type: 'SYNC_NOW' });
  ok('responds ok with skipped=backend-unreachable (no hang, no throw)',
    resp?.ok === true && resp?.result?.skipped === 'backend-unreachable', JSON.stringify(resp));
  ok('local snapshot untouched by failed sync', !!mock.state.local.snapshot);
}

/* ================================================================== *
 * B1 — saved-link URL scheme preservation (UI level)
 * ================================================================== */
console.log('\n── B1: SessionList URL scheme handling ──');
{
  const stored = {
    orbi_sessions: [{
      _id: 'schemes', name: 'Schemes', createdAt: new Date().toISOString(), deletedAt: null,
      windows: [{
        state: 'normal', focused: true, groups: [],
        tabs: [
          { url: 'chrome://settings/', title: 'Settings', pinned: false, active: true, groupId: null },
          { url: 'file:///C:/Users/t/report.pdf', title: 'Report', pinned: false, active: false, groupId: null },
          { url: 'bare-host.example.com/page', title: 'Old bare link', pinned: false, active: false, groupId: null },
        ]
      }]
    }]
  };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => { const o = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in stored) o[k] = stored[k]; }); return o; },
        set: async (obj) => Object.assign(stored, obj),
        remove: async () => {},
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    runtime: {
      sendMessage: async (msg) => { stored.__sent = msg; return { ok: true }; },
      onMessage: { addListener() {} }, lastError: null,
    },
  };

  const { default: SessionList } = await server.ssrLoadModule('/src/popup/components/dashboard/SessionList.jsx');
  const React = require('react');
  const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
  const act = (fn) => require('react-dom/test-utils').act(fn);
  const fire = (el, type) => el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, view: dom.window }));

  const container = dom.window.document.getElementById('root');
  container.innerHTML = '';
  const rootEl = require('react-dom/client').createRoot(container);
  await act(async () => { rootEl.render(React.createElement(SessionList, { sessions: stored.orbi_sessions, onDelete: () => {}, onRenamed: () => {} })); });
  await tick(80);

  // Expand the card to see saved links (chevron now carries a title)
  const card = document.querySelector('[class*="session-card-"]');
  const chevron = [...card.querySelectorAll('button')].find(b => b.title === 'Show saved links');
  ok('expand chevron present', !!chevron);
  await act(async () => { if (chevron) fire(chevron, 'click'); });
  await tick(80);
  const text = document.body.textContent;
  ok('chrome:// link shown unrewritten', text.includes('chrome://settings/'));
  ok('file:// link shown unrewritten', text.includes('file:///C:/Users/t/report.pdf'));
  ok('bare host displayed as saved (rewriting happens at open/restore time)', text.includes('bare-host.example.com/page'));

  // Restore path: message to the worker must carry the SAME unrewritten urls
  const restoreBtn = [...card.querySelectorAll('button')].find(b => b.textContent.trim() === 'Restore');
  await act(async () => { fire(restoreBtn, 'click'); });
  await tick(80);
  const sentUrls = stored.__sent?.session?.windows?.[0]?.tabs?.map(t => t.url) || [];
  ok('restore message keeps chrome:// and file:// intact',
    sentUrls.includes('chrome://settings/') && sentUrls.includes('file:///C:/Users/t/report.pdf') &&
    sentUrls.includes('https://bare-host.example.com/page'), sentUrls.join(' | '));
}

/* ------------------------------------------------------------------ *
 * RESULT
 * ------------------------------------------------------------------ */
console.log(`\n✅ RELIABILITY: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
