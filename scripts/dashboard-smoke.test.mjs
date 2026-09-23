// Smoke test for the tab-based Dashboard contract:
//   1. MOUNT    — Dashboard renders the Sessions view (title, Save, search, cards)
//   2. VIEWS    — Organize | Settings pills swap views; Settings owns autoSave UI
//   3. SAVE     — Quick Save → captureAllWindowsV1 → createSession recorded
//   4. BANNER   — recoveryCandidate in chrome.storage → banner shows → DISMISS message
//   5. TRASH    — trash icon opens the Trash view (restorable-deletes contract)
//
// Search coverage lives in scripts/search-smoke.test.mjs (not duplicated here).
//
// Run: node scripts/dashboard-smoke.test.mjs   (no test runner — vite SSR + jsdom)

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
};

/* ---------------- jsdom globals (same harness as the other smokes) ---------------- */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'customElements', 'getComputedStyle']) {
  Object.defineProperty(globalThis, k, { value: dom.window[k] ?? globalThis[k], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/* ---------------- vite SSR loader ---------------- */
const vite = await import('vite');
const server = await vite.createServer({
  root, configFile: false, plugins: [],
  optimizeDeps: { disabled: true },
  server: { middlewareMode: true },
  appType: 'custom', logLevel: 'error',
});

/* ---------------- chrome.* mock ---------------- */
const calls = [];
const rec = (kind) => async (...a) => { calls.push([kind, JSON.parse(JSON.stringify(a))]); return { ok: true }; };
const tabs = [
  { id: 1, title: 'GitHub', url: 'https://github.com/', pinned: true, active: false, groupId: -1 },
  { id: 2, title: 'Google', url: 'https://google.com/', pinned: false, active: true, groupId: 101 },
  { id: 3, title: 'Scholar', url: 'https://scholar.google.com/', pinned: false, active: false, groupId: 101 },
];
const win = { id: 1, focused: true, tabs };

// Two LIVE sessions + one trashed (deleted yesterday — inside the 30-day window)
// 'alpha' is PINNED and OLDER than 'beta' — pin-to-top must beat recency.
const iso = (offsetMin) => new Date(Date.now() + offsetMin * 60000).toISOString();
const doc = (id, name, deletedAt, minutesAgo = 60, pinned = false) => ({
  _id: id, name, deletedAt, pinned,
  windows: [{ state: 'normal', focused: true, groups: [], tabs: [{ url: `https://${id}.example.com/`, title: id, pinned: false, active: true, groupId: null }] }],
  createdAt: iso(-minutesAgo), updatedAt: iso(-minutesAgo),
});
const seeded = [doc('alpha', 'Alpha session', null, 60, true), doc('beta', 'Beta session', null, 30, false), doc('gone', 'Trashed session', iso(-1440))];

globalThis.chrome = {
  windows: { getAll: async () => [win], onCreated: { addListener() {} }, onRemoved: { addListener() {} } },
  tabs: {
    query: async () => tabs,
    group: rec('tabs.group'), ungroup: rec('tabs.ungroup'), move: rec('tabs.move'),
    onCreated: { addListener() {} }, onUpdated: { addListener() {} },
    onRemoved: { addListener() {} }, onMoved: { addListener() {} },
    onActivated: { addListener() {} }, onReplaced: { addListener() {} },
  },
  tabGroups: { query: async () => [{ id: 101, title: 'Research', color: 'blue', collapsed: false }], update: rec('tabGroups.update') },
  storage: {
    local: {
      get: async (keys) => {
        const out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(k => {
          if (k === 'orbi_sessions') out[k] = seeded;
          if (k === 'recoveryCandidate') out[k] = { windows: [{ tabs: [{}, {}, {}] }] };
          if (k === 'orbi_settings') out[k] = { autoSave: true };
          if (['snapshot', 'snapshotAt', 'lastAlive', 'cleanExit', 'recoveryPoints', 'crashDetectedAt'].includes(k)) {
            out[k] = k === 'snapshot' ? { windows: [{ tabs: [{}] }] }
              : k === 'snapshotAt' || k === 'lastAlive' ? Date.now() - 30000
              : k === 'cleanExit' ? false : k === 'recoveryPoints' ? [] : Date.now();
          }
        });
        return out;
      },
      set: rec('storage.local.set'), remove: async () => {},
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
  runtime: {
    sendMessage: rec('runtime.sendMessage'),
    onMessage: { addListener() {} },
    lastError: null,
  },
  alarms: { create: async () => {}, onAlarm: { addListener() {} } },
};

/* ---------------- load + helpers ---------------- */
const { default: Dashboard } = await server.ssrLoadModule('/src/popup/pages/Dashboard.jsx');
const React = require('react');

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const act = (fn) => require('react-dom/test-utils').act(fn);
const fire = (el, type, opts = {}) => el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, view: dom.window, ...opts }));
const byText = (selector, text, rootNode = document) =>
  [...rootNode.querySelectorAll(selector)].filter(el => el.textContent.trim().includes(text));
const deepest = (els) => els.sort((a, b) => a.textContent.length - b.textContent.length)[0];
const pill = (label) => deepest(byText('button', label));

console.log('\n── 1. MOUNT: Sessions view ──');
const container = dom.window.document.getElementById('root');
const rootEl = require('react-dom/client').createRoot(container);
await act(async () => { rootEl.render(React.createElement(Dashboard, { cloudUser: null, onOpenLogin: () => {}, onLogout: () => {}, theme: 'light', onCycleTheme: () => {} })); });
await tick(120);

ok('Dashboard header renders', byText('h1', 'Orbitabs').length > 0);
ok('view pills render (Sessions | Organize | Settings)', !!pill('Sessions') && !!pill('Organizer') && !!pill('Settings'));
ok('session cards render from store (live sessions only)', document.querySelectorAll('[class*="session-card-"]').length === 2);
ok('search box present', !!document.querySelector('input[placeholder^="Search saved sessions"]'));
ok('no Settings panel before opening Settings', byText('span', 'Auto-save (Live Backup)').length === 0);

console.log('\n── 1b. PIN: pin-to-top ordering + ⋯ menu ──');
// alpha is pinned but OLDER than beta — it must still render first
const firstCard = document.querySelector('[class*="session-card-"]');
ok('pinned session sorts above newer unpinned session', !!firstCard && firstCard.className.includes('session-card-alpha'));
ok('pin indicator renders on the pinned card', !!firstCard?.querySelector('span[title="Pinned to top"]'));
let menuBtns = [...document.querySelectorAll('button[title="More actions"]')];
ok('every card has a ⋯ menu button', menuBtns.length === 2);
// open the UNPINNED card's menu (DOM order: alpha, beta → index 1)
await act(async () => { fire(menuBtns[1], 'click'); });
await tick(50);
ok('⋯ menu offers “Pin to top” for unpinned session', byText('button', 'Pin to top').length > 0);
calls.length = 0;
await act(async () => { fire(deepest(byText('button', 'Pin to top')), 'click'); });
await tick(80);
ok('Pin → storage write carries pinned:true', calls.some(([k, a]) => k === 'storage.local.set' && JSON.stringify(a[0]).includes('"pinned":true')));
// open the PINNED card's menu (re-query: list re-rendered after the reload)
menuBtns = [...document.querySelectorAll('button[title="More actions"]')];
await act(async () => { fire(menuBtns[0], 'click'); });
await tick(50);
ok('⋯ menu offers “Unpin” for pinned session', byText('button', 'Unpin').length > 0);
calls.length = 0;
await act(async () => { fire(deepest(byText('button', 'Unpin')), 'click'); });
await tick(80);
ok('Unpin → storage write carries pinned:false', calls.some(([k, a]) => k === 'storage.local.set' && JSON.stringify(a[0]).includes('"pinned":false')));

console.log('\n── 2. VIEWS: Organize | Settings ──');
await act(async () => { fire(pill('Organizer'), 'click'); });
await tick(80);
ok('Organize view shows live windows', document.body.textContent.includes('Drop here to ungroup'));

await act(async () => { fire(pill('Settings'), 'click'); });
await tick(80);
ok('Settings page renders with Auto-save + Live Backup controls', document.body.textContent.includes('General') && document.body.textContent.includes('Auto-save') && document.body.textContent.includes('Live Backup'));
ok('Settings recovery history renders from mocked storage', document.body.textContent.includes('Recovery history'));

console.log('\n── 3. SAVE: Quick Save flow ──');
await act(async () => { fire(pill('Sessions'), 'click'); });
await tick(80);
calls.length = 0;
await act(async () => { fire(deepest(byText('button', 'Save')), 'click'); });
await tick(150);
ok('Quick Save → createSession recorded', calls.some(([k]) => k === 'storage.local.set' && JSON.stringify(k ? k : '') && true) || calls.some(([k]) => k === 'storage.local.set'));
ok('save payload written to the sessions key', calls.some(([k, a]) => k === 'storage.local.set' && a[0] && 'orbi_sessions' in a[0]));

console.log('\n── 4. BANNER: crash recovery ──');
calls.length = 0;
const bannerDismiss = deepest(byText('button', 'Not now'));
ok('recovery banner visible with mocked candidate', !!bannerDismiss);
await act(async () => { fire(bannerDismiss, 'click'); });
await tick(450); // let any pending worker reply settle before asserting "gone"
ok('Dismiss → DISMISS_RECOVERY sent, banner gone',
  calls.some(([k, a]) => k === 'runtime.sendMessage' && a[0]?.type === 'DISMISS_RECOVERY') &&
  document.body.textContent.includes('Chrome crashed') === false);

console.log('\n── 5. TRASH: restorable deletes ──');
const trashBtn = [...document.querySelectorAll('button[title*="Trash"]')][0];
ok('trash icon present', !!trashBtn);
await act(async () => { fire(trashBtn, 'click'); });
await tick(80);
ok('Trash view lists the trashed session with Restore', document.body.textContent.includes('Trashed session') && byText('button', 'Restore').length > 0);
ok('Empty Trash offered', byText('button', 'Empty Trash').length > 0);

await server.close();
console.log(`\n✅ DASHBOARD SMOKE: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
