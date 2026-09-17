// Render-level smoke test for OrganizePanel — the regression class that once
// blanked the whole popup (header items pushed without `win`).
//
//   1. PURE  : buildWindowItems() invariants (headers carry `win`, counts,
//              divider placement, orphaned groupId tolerance)
//   2. MOUNT : full <OrganizePanel/> mounted in jsdom against a grouped-window
//              chrome.* mock — the tree must survive and render every row
//   3. CLICK : select → selection bar → "Add to group" → tabs.group() recorded
//   4. DROP  : synthetic drag events → group-add / reorder (chrome.tabs.move)
//              / ungroup, with Chrome's remove-then-insert index semantics
//
// Run: node scripts/organize-smoke.test.mjs   (no test runner — vite SSR + jsdom)

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

/* ---------------- jsdom globals (before any react import) ---------------- */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'KeyboardEvent', 'DragEvent', 'DataTransfer', 'customElements', 'getComputedStyle']) {
  // defineProperty: Node 22 owns a getter-only `navigator` — plain assignment throws
  Object.defineProperty(globalThis, k, { value: dom.window[k] ?? globalThis[k], configurable: true, writable: true });
}
// Menu.jsx animates its popover with requestAnimationFrame — real browsers
// have rAF; the harness must too (fix the harness, not the component).
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/* ---------------- vite SSR loader (JSX + node-deps interop, no react plugin) ---------------- */
const vite = await import('vite');
const server = await vite.createServer({
  root,
  configFile: false,           // skip the app config (its react plugin appends to document — fatal in SSR)
  plugins: [],                 // vite core transforms .jsx natively via esbuild
  optimizeDeps: { disabled: true },
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

/* ---------------- chrome.* mock (grouped window + a second window) ---------------- */
const calls = [];
// capture ALL args (tabs.move passes id + options separately)
const rec = (kind) => async (...a) => { calls.push([kind, JSON.parse(JSON.stringify(a))]); return kind === 'tabs.group' ? 202 : []; };
const groups = [{ id: 101, title: 'Research', color: 'blue', collapsed: false }];
const tabs1 = [
  { id: 11, title: 'GitHub', url: 'https://github.com/', pinned: true, groupId: -1 },
  { id: 12, title: 'Google', url: 'https://google.com/', pinned: false, groupId: 101 },
  { id: 13, title: 'Scholar', url: 'https://scholar.google.com/', pinned: false, groupId: 101 },
  { id: 14, title: 'YouTube', url: 'https://youtube.com/', pinned: false, groupId: -1 },
];
globalThis.chrome = {
  windows: { getAll: async () => [
    { id: 1, focused: true, tabs: tabs1 },
    { id: 2, focused: false, tabs: [{ id: 21, title: 'Docs', url: 'https://docs.example.com/', pinned: false, groupId: -1 }] },
  ] },
  tabGroups: { query: async () => groups, update: rec('tabGroups.update') },
  tabs: {
    group: rec('tabs.group'),
    ungroup: rec('tabs.ungroup'),
    move: rec('tabs.move'),
    query: async () => [],
  },
};

const { default: OrganizePanel } = await server.ssrLoadModule('/src/popup/components/dashboard/OrganizePanel.jsx');
const winItemsMod = await server.ssrLoadModule('/src/popup/components/dashboard/windowItems.js');

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

/* ---------------- helpers ---------------- */
const fire = (el, type, init = {}) => {
  // jsdom ships no DragEvent constructor — MouseEvent carries the handlers fine
  const Ev = type.startsWith('drag') ? (dom.window.DragEvent || dom.window.MouseEvent) : dom.window.Event;
  const e = new Ev(type, { bubbles: true, cancelable: true, ...init });
  // Real browsers always attach dataTransfer to drag events (incl. dragstart,
  // whose handler sets effectAllowed) — mimic that or the handlers reject.
  if (type.startsWith('drag')) {
    Object.defineProperty(e, 'dataTransfer', { value: { dropEffect: 'move', effectAllowed: 'move' } });
  }
  el.dispatchEvent(e);
};
const findRow = (txt) => [...document.querySelectorAll('[draggable="true"]')].find(r => r.textContent.includes(txt));
const tick = (ms = 20) => act(async () => { await new Promise(r => setTimeout(r, ms)); });

/* ---------------- 1. PURE — buildWindowItems ---------------- */
console.log('\nPURE — buildWindowItems');
{
  const win = { id: 1, groups, tabs: tabs1 };
  const items = winItemsMod.buildWindowItems(win);
  ok('every item carries win', items.every(it => it.win === win));
  ok('header count = tabs in group', items.find(i => i.type === 'header').count === 2);
  const kinds = items.map(i => i.type).join(',');
  ok('real order: pinned block first, divider, then header + tabs',
    kinds === 'tab,divider,header,tab,tab,tab');
  const orphan = winItemsMod.buildWindowItems({ id: 9, groups: [], tabs: [{ id: 1, groupId: 77 }] });
  ok('orphaned groupId renders as ungrouped tab, no header',
    orphan.length === 1 && orphan[0].type === 'tab' && orphan[0].inGroup === false);
}

/* ---------------- 2. MOUNT — grouped window must not blank the popup ---------------- */
console.log('\nMOUNT — OrganizePanel in jsdom');
const container = document.getElementById('root');
let _setState;
const Probe = () => { const [, s] = React.useState(0); _setState = s; return React.createElement(OrganizePanel, null); };
act(() => { createRoot(container).render(React.createElement(Probe)); });
await tick(60);
act(() => { _setState(n => n + 1); }); // force a re-render while data is live (same timing class as the P0)
await tick();
{
  const rows = document.querySelectorAll('[draggable="true"]').length;
  ok('no crash on grouped window (P0 regression)', rows === 5); // 4 + 1 second window
  ok('group header rendered with count', document.body.textContent.includes('Research') && document.body.textContent.includes('(2)'));
  ok('pinned boundary divider present', document.body.textContent.includes('pinned ↑'));
  ok('ungroup strip present', document.body.textContent.includes('Drop here to ungroup'));
}

/* ---------------- 3. CLICK — selection bar → Add to group ---------------- */
console.log('\nCLICK — selection bar flow');
{
  // YouTube is UNGROUPED — the polish's "already in group" disabled state
  // would (correctly) block an already-grouped selection like Google.
  act(() => { findRow('YouTube').click(); });
  await tick();
  ok('selection bar appears', document.body.textContent.includes('1 selected'));
  const addBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Add to group'));
  ok('"Add to group" button present', !!addBtn);
  act(() => { addBtn.click(); });
  await tick();
  const menuRows = [...document.querySelectorAll('button')].filter(b => b.textContent.includes('Research'));
  act(() => { menuRows[menuRows.length - 1].click(); });
  await tick();
  const grp = calls.find(c => c[0] === 'tabs.group');
  ok('tabs.group() fired with selected tab', !!grp && grp[1][0].tabIds.includes(14) && grp[1][0].createProperties?.windowId === 1);
  ok('selection cleared after action', !document.body.textContent.includes('selected'));
}

/* ---------------- 4. DROP — group add, reorder semantics, ungroup ---------------- */
console.log('\nDROP — drag/drop handlers');
{
  // drag-to-group: ungrouped "GitHub" (11) onto Research header
  const header = [...document.querySelectorAll('div')].find(d =>
    d.textContent.includes('Research') && d.textContent.includes('(2)') && (d.getAttribute('class') || '').includes('pl-1'));
  act(() => { fire(findRow('GitHub'), 'dragstart'); });
  act(() => { fire(header, 'dragover'); });
  act(() => { fire(header, 'drop'); });
  await tick();
  const g = calls.filter(c => c[0] === 'tabs.group').pop();
  ok('drop on group header → tabs.group([11])', !!g && Array.isArray(g[1][0].tabIds) && g[1][0].tabIds.includes(11));

  // drop-on-tab reorder: move 14 above 13 (downward → same index, remove-then-insert)
  calls.length = 0;
  act(() => { fire(findRow('YouTube'), 'dragstart'); });
  const scholar = findRow('Scholar');
  act(() => { fire(scholar, 'dragover'); });
  act(() => { fire(scholar, 'drop'); });
  await tick();
  const mv = calls.find(c => c[0] === 'tabs.move');
  ok('drop on tab → chrome.tabs.move', !!mv && mv[1][0] === 14 && mv[1][1].windowId === 1);
  ok('reorder index respects remove-then-insert (downward: index unchanged)', !!mv && mv[1][1].index === 2);

  // upward move: 13 above 12 → index 2-1=1
  calls.length = 0;
  act(() => { fire(findRow('Scholar'), 'dragstart'); });
  const google = findRow('Google');
  act(() => { fire(google, 'dragover'); });
  act(() => { fire(google, 'drop'); });
  await tick();
  const mv2 = calls.find(c => c[0] === 'tabs.move');
  ok('upward reorder uses index-1 correction', !!mv2 && mv2[1][0] === 13 && mv2[1][1].index === 1);

  // ungroup strip — innermost element matching the strip label; fires are
  // awaited between steps (flushes drag-state updates before the next event)
  calls.length = 0;
  const strip = [...document.querySelectorAll('div')]
    .filter(d => d.textContent.includes('Drop here to ungroup'))
    .sort((a, b) => a.textContent.length - b.textContent.length)[0];
  act(() => { fire(findRow('Google'), 'dragstart'); }); await tick();
  act(() => { fire(strip, 'dragover'); }); await tick();
  act(() => { fire(strip, 'drop'); });
  await tick();
  const ug = calls.find(c => c[0] === 'tabs.ungroup');
  const ugIds = Array.isArray(ug?.[1]?.[0]) ? ug[1][0] : ug?.[1]?.[0]?.tabIds;
  ok('drop on ungroup strip → tabs.ungroup([12])', Array.isArray(ugIds) && ugIds.includes(12));
}

await server.close();
console.log(`\n${fail === 0 ? '✅' : '❌'} SMOKE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
