// 🔍 Smoke test for Session Search (Dashboard search box):
//   1. UNIT: sessionMatchesQuery / filterSessions — name, URL, title,
//      case-insensitivity, legacy docs, empty query, sort-order preservation.
//   2. MOUNT: typing in the search box filters the rendered session cards.
//
// Run: node scripts/search-smoke.test.mjs   (no test runner — vite SSR + jsdom)

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

/* ---------------- jsdom globals (same harness as organize-smoke) ---------------- */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'KeyboardEvent', 'DragEvent', 'DataTransfer', 'customElements', 'getComputedStyle']) {
  Object.defineProperty(globalThis, k, { value: dom.window[k] ?? globalThis[k], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/* ---------------- vite SSR loader (JSX + node-deps interop, no react plugin) ---------------- */
const vite = await import('vite');
const server = await vite.createServer({
  root,
  configFile: false,
  plugins: [],
  optimizeDeps: { disabled: true },
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

/* ---------------- chrome.* mock ---------------- */
const rec = (kind) => async (...a) => { void kind; void a; return { ok: true }; };
const tabs = [
  { id: 1, title: 'GitHub', url: 'https://github.com/', pinned: true, active: false, groupId: -1 },
  { id: 2, title: 'Google', url: 'https://google.com/', pinned: false, active: true, groupId: 101 },
  { id: 3, title: 'Scholar', url: 'https://scholar.google.com/', pinned: false, active: false, groupId: 101 },
];
const win = { id: 1, focused: true, tabs };

// Three live sessions with distinct searchable content (newest-first in the store):
const docs = [
  {
    _id: 'docs-github', name: 'Work repos', windows: [{
      state: 'normal', focused: true,
      tabs: [
        { url: 'https://github.com/codebuff/repo', title: 'Codebuff Repo', pinned: false, active: true, groupId: null },
        { url: 'https://google.com/', title: 'Google', pinned: false, active: false, groupId: null },
      ],
      groups: [],
    }],
    createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date().toISOString(), deletedAt: null,
  },
  {
    _id: 'docs-mdn', name: 'Reading list', windows: [{
      state: 'normal', focused: true,
      tabs: [{ url: 'https://developer.mozilla.org/en-US/', title: 'MDN Web Docs', pinned: false, active: true, groupId: null }],
      groups: [],
    }],
    createdAt: new Date(Date.now() - 2000).toISOString(), updatedAt: new Date().toISOString(), deletedAt: null,
  },
  {
    // LEGACY urls[] shape — proves search covers normalizeSession'd docs too
    _id: 'docs-legacy', name: 'Legacy doc', urls: ['https://scholar.google.com/'],
    createdAt: new Date(Date.now() - 3000).toISOString(), updatedAt: new Date().toISOString(), deletedAt: null,
  },
];

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
        if (keys === 'orbi_sessions') return { orbi_sessions: docs };
        return {};
      },
      set: rec('storage.local.set'), remove: async () => {},
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
  runtime: { sendMessage: rec('runtime.sendMessage'), onMessage: { addListener() {} }, lastError: null },
  alarms: { create: async () => {}, onAlarm: { addListener() {} } },
};

/* ---------------- 1. UNIT: matcher + filter ---------------- */
console.log('\n── UNIT: sessionSearch matcher ──');
const { sessionMatchesQuery, filterSessions } = await server.ssrLoadModule('/src/popup/utils/sessionSearch.js');

ok('empty query matches everything', sessionMatchesQuery(docs[0], '') && sessionMatchesQuery(docs[0], '   '));
ok('name match (case-insensitive)', sessionMatchesQuery(docs[0], 'WORK REPOS'));
ok('name partial match', sessionMatchesQuery(docs[1], 'read'));
ok('url match', sessionMatchesQuery(docs[1], 'developer.mozilla'));
ok('url match via legacy-normalized doc', sessionMatchesQuery(docs[2], 'scholar.google'));
ok('tab title match', sessionMatchesQuery(docs[1], 'mdn web'));
ok('no false positive', !sessionMatchesQuery(docs[1], 'github') && !sessionMatchesQuery(docs[0], 'mdn'));
ok('corrupt doc hidden when filtering', !sessionMatchesQuery({ _id: 'x', windows: 'garbage' }, 'x'));

const filtered = filterSessions(docs, 'google');
ok('filter keeps newest-first order', filtered.map(s => s._id).join(',') === 'docs-github,docs-legacy');
ok('filter returns new array, input untouched', filterSessions(docs, 'google') !== docs && docs.length === 3);
ok('whitespace-only query = no filter', filterSessions(docs, '   ').length === 3);

/* ---------------- 2. MOUNT: Dashboard search box filters live ---------------- */
console.log('\n── MOUNT: Dashboard search box ──');
const { default: Dashboard } = await server.ssrLoadModule('/src/popup/pages/Dashboard.jsx');
const React = require('react');

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const act = (fn) => require('react-dom/test-utils').act(fn);
const fire = (el, type, opts = {}) => el.dispatchEvent(new dom.window[type === 'keydown' ? 'KeyboardEvent' : 'MouseEvent'](type, { bubbles: true, cancelable: true, view: dom.window, ...opts }));

const container = dom.window.document.getElementById('root');
const rootEl = require('react-dom/client').createRoot(container);
await act(async () => { rootEl.render(React.createElement(Dashboard, { cloudUser: null, onOpenLogin: () => {}, onLogout: () => {}, theme: 'light', onCycleTheme: () => {} })); });
await tick(120);

const sessionCards = () => document.querySelectorAll('[class*="session-card-"]').length;
ok('all 3 sessions render before search', sessionCards() === 3);

const input = document.querySelector('input[placeholder^="Search sessions"]');
ok('search input renders', !!input);
if (!input) { console.log(`\n❌ SEARCH SMOKE: ${pass} passed, ${fail} failed\n`); process.exit(1); }

// Type into the input — onChange is delegated at the root, so set value + fire input
const setNativeValue = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};
await act(async () => { setNativeValue(input, 'mozilla'); });
await tick(80);
ok('typing "mozilla" filters to 1 card (URL match)', sessionCards() === 1);

await act(async () => { setNativeValue(input, 'Work repos'); });
await tick(80);
ok('typing a name filters to 1 card (name match)', sessionCards() === 1);

await act(async () => { setNativeValue(input, 'zzz-no-match'); });
await tick(80);
ok('no match shows empty state', sessionCards() === 0 && document.body.textContent.includes('No sessions match'));

// Escape clears the query (Dashboard's onKeyDown handler)
await act(async () => { fire(input, 'keydown', { key: 'Escape' }); });
await tick(80);
ok('Escape clears search — all sessions back', sessionCards() === 3);

/* ---------------- report ---------------- */
console.log(`\n✅ SEARCH SMOKE: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
