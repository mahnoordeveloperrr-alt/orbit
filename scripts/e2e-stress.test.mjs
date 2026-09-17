// ============================================================================
// END-TO-END STRESS TEST: scale, multi-window, multi-group, pinned, weird URLs,
// repeated save/restore — the REAL public/background.js in a Node VM.
// Run: node scripts/e2e-stress.test.mjs
//
// Same harness contract as e2e-groups.test.mjs (faithful Chrome mock), plus:
//   • a chrome.windows.create that can be told to FAIL (fault injection) so we
//     can drive restore's graceful-degradation path deterministically
//   • chrome.tabs.create for the per-tab fallback path
//   • a declarative buildWindow() helper (10 lines of spec → real mock state)
//
// Six scenarios:
//   S1 SCALE      — 10 / 50 / 120 tabs in one window
//   S2 WINDOWS    — 5 windows, mixed states, focus migration
//   S3 GROUPS     — 9 groups / all 9 Chrome colors, collapsed mix, interleaved
//   S4 PINNED     — all-pinned, none-pinned, active-inside-pinned-block
//   S5 URLS       — unusual URLs round-trip; hostile restore degrades to tabs
//   S6 CYCLES     — repeated save→wipe→restore (3×), double-restore, re-save
// ============================================================================

import vm from 'node:vm';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerCode = readFileSync(join(root, 'public/background.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Faithful Chrome mock (extended: fault injection + tabs.create)
 * ------------------------------------------------------------------ */

function createChromeMock() {
  let nextTabId = 1000, nextWinId = 500, nextGroupId = 9000;
  const state = {
    windows: [],
    groupMeta: new Map(),
    local: {}, session: {}, badge: '',
    messageListener: null, startupListener: null,
    failWindowCreate: false,       // fault injection: windows.create throws
    windowsCreated: 0, tabsCreated: 0,
  };

  const findWin = (id) => state.windows.find(w => w.id === id);

  const chrome = {
    windows: {
      onCreated: { addListener() {} },
      onRemoved: { addListener() {} },
      async getAll(opts = {}) {
        return state.windows.map(w => ({
          id: w.id, state: w.state, focused: w.focused,
          ...(opts.populate ? { tabs: w.tabs.map(t => ({ ...t })) } : {})
        }));
      },
      async create({ url = [], focused = false, state: winState = 'normal' } = {}) {
        if (state.failWindowCreate) throw new Error(' simulated window create failure');
        const win = {
          id: ++nextWinId, state: winState, focused,
          tabs: url.map(u => ({
            id: ++nextTabId, url: u, title: u.replace(/^https?:\/\//, '').split('/')[0],
            pinned: false, active: false, groupId: -1
          }))
        };
        if (win.tabs[0]) win.tabs[0].active = true;
        state.windows.push(win);
        state.windowsCreated++;
        return { id: win.id, tabs: win.tabs.map(t => ({ ...t })) };
      },
      async update(id, props = {}) {
        const win = findWin(id);
        if (!win) throw new Error('no such window ' + id);
        if ('focused' in props) {
          state.windows.forEach(w => (w.focused = w.id === id ? !!props.focused : false));
        }
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
      async ungroup(tabIds) {
        state.windows.forEach(w => w.tabs.forEach(t => { if (tabIds.includes(t.id)) t.groupId = -1; }));
      },
      async create({ url } = {}) {
        const win = state.windows[0] || { id: ++nextWinId, state: 'normal', focused: false, tabs: [] };
        if (!win.tabs) state.windows.push(win);
        const tab = { id: ++nextTabId, url, title: String(url).replace(/^https?:\/\//, '').split('/')[0], pinned: false, active: false, groupId: -1 };
        win.tabs.push(tab);
        state.tabsCreated++;
        return { id: tab.id };
      },
      async update(tabId, props = {}) {
        const win = state.windows.find(w => w.tabs.some(t => t.id === tabId));
        if (!win) throw new Error('no such tab ' + tabId);
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
        return { id: groupId, ...state.groupMeta.get(groupId) };
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
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {}
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
  const sendResponse = (r) => { response = r; };
  mock.state.messageListener(msg, {}, sendResponse);
  for (let i = 0; i < 100 && response === null; i++) await sleep(10);
  return response;
}

/* ------------------------------------------------------------------ *
 * Declarative browser builder — spec in, faithful mock state out
 * ------------------------------------------------------------------ */

const CHROME_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

/**
 * spec: [{ state, focused, tabs: [{ url, title?, group?: {title,color,collapsed}, pinned?, active? }] }]
 * Consecutive tabs sharing the same group OBJECT create one real group.
 * Returns { specWindows } so tests can reference group objects.
 */
function buildBrowser(mock, specs) {
  const { state } = mock;
  let tabId = 100, groupId = 10;
  const groupIds = new Map(); // group OBJECT -> one stable chrome groupId (interleave-safe)
  specs.forEach((spec, wi) => {
    const win = { id: 1 + wi, state: spec.state || 'normal', focused: !!spec.focused, tabs: [] };
    spec.tabs.forEach(t => {
      let gid = -1;
      if (t.group) {
        if (!groupIds.has(t.group)) {
          groupId += 1;
          groupIds.set(t.group, groupId);
          state.groupMeta.set(groupId, { title: t.group.title || '', color: t.group.color || 'grey', collapsed: !!t.group.collapsed });
        }
        gid = groupIds.get(t.group);
      }
      win.tabs.push({ id: ++tabId, url: t.url, title: t.title || t.url, groupId: gid, pinned: !!t.pinned, active: !!t.active });
    });
    // REAL CHROME INVARIANT: every window has exactly one active tab — if the
    // spec didn't mark one, Chrome would have activated the first tab.
    if (win.tabs.length > 0 && !win.tabs.some(t => t.active)) win.tabs[0].active = true;
    state.windows.push(win);
  });
}

/** Real capture through the worker (SNAPSHOT_NOW) → snapshot object. */
async function capture(mock) {
  const resp = await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
  if (!resp?.ok) throw new Error('SNAPSHOT_NOW failed: ' + String(resp?.error));
  return mock.state.local.snapshot;
}

/** Destroy all windows + group metadata (browser closed/crashed). */
function wipeBrowser(mock) {
  mock.state.windows = [];
  mock.state.groupMeta.clear();
}

/** Restore a snapshot through the worker's real RESTORE_SESSION path. */
function restore(mock, snapshot) {
  return sendMessage(mock, { type: 'RESTORE_SESSION', session: snapshot });
}

/** Structural round-trip comparison: snapshot windows vs live mock windows. */
function structureOf(state) {
  return state.windows.map(w => ({
    tabs: w.tabs.map(t => ({
      url: t.url, pinned: t.pinned, active: t.active,
      group: t.groupId === -1 ? null : (state.groupMeta.get(t.groupId) || {}).title || '?'
    })),
    pinnedBlock: w.tabs.filter(t => t.pinned).map(t => t.url),
    active: (w.tabs.find(t => t.active) || {}).url || null
  }));
}

/* ================================================================== *
 * S1 — SCALE: 10 / 50 / 120 tabs
 * ================================================================== */
console.log('\n═══ S1: SCALE — 10 / 50 / 120 tabs ═══\n');

for (const N of [10, 50, 120]) {
  console.log(`── ${N} tabs in one window ──`);
  const mock = createChromeMock();
  const sandbox = { chrome: mock.chrome, console, setTimeout, clearTimeout, Date };
  vm.createContext(sandbox);
  vm.runInContext(workerCode, sandbox, { filename: 'background.js' });

  const urls = Array.from({ length: N }, (_, i) => `https://site${i}.example.com/page?i=${i}`);
  buildBrowser(mock, [{ state: 'normal', focused: true, tabs: urls.map((url, i) => ({ url, active: i === Math.floor(N / 2) })) }]);

  const snap = await capture(mock);
  check(`${N}: captured ${N} tabs in order`, snap.windows.length === 1 && snap.windows[0].tabs.length === N);
  check(`${N}: order preserved`, snap.windows[0].tabs.every((t, i) => t.url === urls[i]));
  check(`${N}: mid tab active`, snap.windows[0].tabs[Math.floor(N / 2)].active === true);

  wipeBrowser(mock);
  const resp = await restore(mock, snap);
  check(`${N}: restore ok (${resp?.restoredTabs} tabs)`, resp?.ok === true && resp?.restoredTabs === N, String(resp?.error));
  const live = mock.state.windows[0];
  check(`${N}: all ${N} back in order`, live?.tabs.map(t => t.url).join() === urls.join());
  check(`${N}: active tab round-tripped`, live?.tabs.find(t => t.active)?.url === urls[Math.floor(N / 2)]);
}

/* ================================================================== *
 * S2 — WINDOWS: 5 windows, mixed states, focus migration
 * ================================================================== */
console.log('\n═══ S2: WINDOWS — 5 windows, mixed states, focus ═══\n');
{
  const mock = createChromeMock();
  const sandbox = { chrome: mock.chrome, console, setTimeout, clearTimeout, Date };
  vm.createContext(sandbox);
  vm.runInContext(workerCode, sandbox, { filename: 'background.js' });

  buildBrowser(mock, [
    { state: 'maximized', focused: false, tabs: [{ url: 'https://w0.example.com' }] },
    { state: 'normal', focused: true, tabs: [{ url: 'https://w1.example.com' }, { url: 'https://w1b.example.com' }] },
    { state: 'minimized', focused: false, tabs: [{ url: 'https://w2.example.com' }] },
    { state: 'fullscreen', focused: false, tabs: [{ url: 'https://w3.example.com' }] },
    { state: 'normal', focused: false, tabs: [{ url: 'https://w4.example.com' }] },
  ]);

  const snap = await capture(mock);
  check('5 windows captured', snap.windows.length === 5);
  check('states captured (maximized/normal/minimized/fullscreen/normal)',
    JSON.stringify(snap.windows.map(w => w.state)) === JSON.stringify(['maximized', 'normal', 'minimized', 'fullscreen', 'normal']));
  check('exactly one focused window (W2)', snap.windows.filter(w => w.focused).length === 1 && snap.windows[1].focused);

  wipeBrowser(mock);
  const resp = await restore(mock, snap);
  check('restore ok: 5 windows', resp?.ok === true && resp?.restoredWindows === 5, String(resp?.error));
  const r = mock.state;
  check('5 live windows after restore', r.windows.length === 5);
  check('states restored (incl. minimized + fullscreen)',
    JSON.stringify(r.windows.map(w => w.state)) === JSON.stringify(['maximized', 'normal', 'minimized', 'fullscreen', 'normal']),
    r.windows.map(w => w.state).join(','));
  check('focus migrated to saved focused window (W1 tabs)', r.windows.find(w => w.focused)?.tabs.some(t => t.url === 'https://w1.example.com'));
}

/* ================================================================== *
 * S3 — GROUPS: 9 groups / 9 colors, collapsed mix, interleaved tabs
 * ================================================================== */
console.log('\n═══ S3: GROUPS — 9 groups, 9 colors, collapsed mix, interleaved ═══\n');
{
  const mock = createChromeMock();
  const sandbox = { chrome: mock.chrome, console, setTimeout, clearTimeout, Date };
  vm.createContext(sandbox);
  vm.runInContext(workerCode, sandbox, { filename: 'background.js' });

  const g = (title, color, collapsed) => ({ title, color, collapsed });
  const G = CHROME_COLORS.map((c, i) => g(`G${i + 1}-${c}`, c, i % 3 === 0)); // G1,G4,G7 collapsed
  // Interleave: g1 g2 g1 g3 g2 g1 g4 g3 ... — membership, not position, must win
  const pattern = [0, 1, 0, 2, 1, 0, 3, 2, 4, 3, 5, 4, 6, 5, 7, 6, 8, 7, 8];
  const tabs = pattern.map((gi, i) => ({ url: `https://g${gi}.example.com/t${i}`, group: G[gi] }));

  buildBrowser(mock, [{ state: 'normal', focused: true, tabs }]);

  const snap = await capture(mock);
  const w = snap.windows[0];
  check('9 group definitions captured', w.groups.length === 9);
  check('all 9 Chrome colors preserved', JSON.stringify(w.groups.map(x => x.color).sort()) === JSON.stringify([...CHROME_COLORS].sort()));
  check('collapsed flags preserved (3 collapsed)', w.groups.filter(x => x.collapsed).length === 3);
  check('19 interleave tabs captured', w.tabs.length === 19);
  check('interleaved membership intact (per-group counts)',
    CHROME_COLORS.every((c, i) => w.tabs.filter(t => t.groupId === w.groups[i].id).length === pattern.filter(p => p === i).length));

  wipeBrowser(mock);
  const resp = await restore(mock, snap);
  check('restore ok', resp?.ok === true, String(resp?.error));
  const r = mock.state;
  const liveGroups = [...r.groupMeta.values()];
  check('9 groups rebuilt', liveGroups.length === 9);
  check('titles survive (G1-grey … G9-orange)', liveGroups.map(x => x.title).sort().join() === G.map(x => x.title).sort().join());
  check('colors survive', JSON.stringify(liveGroups.map(x => x.color).sort()) === JSON.stringify([...CHROME_COLORS].sort()));
  check('collapsed survives (3 collapsed)', liveGroups.filter(x => x.collapsed).length === 3);
  check('tab order survives the group() calls (19 tabs, URLs in saved order)',
    JSON.stringify(r.windows[0].tabs.map(t => t.url)) === JSON.stringify(pattern.map((gi, i) => `https://g${gi}.example.com/t${i}`)),
    r.windows[0].tabs.map(t => t.url).slice(0, 6).join(','));
  check('no tab landed in the wrong group',
    r.windows[0].tabs.every(t => t.groupId !== -1));
  const misgrouped = r.windows[0].tabs.filter(t => {
    const n = Number(r.groupMeta.get(t.groupId).title.match(/^G(\d+)/)[1]);
    return !t.url.startsWith(`https://g${n - 1}.`);
  });
  check('every tab is in its exact original group (0 misgrouped)', misgrouped.length === 0, misgrouped.map(t => t.url).join(','));
}

/* ================================================================== *
 * S4 — PINNED: all-pinned, none-pinned, active inside pinned block
 * ================================================================== */
console.log('\n═══ S4: PINNED — edge cases ═══\n');
{
  const mock = createChromeMock();
  const sandbox = { chrome: mock.chrome, console, setTimeout, clearTimeout, Date };
  vm.createContext(sandbox);
  vm.runInContext(workerCode, sandbox, { filename: 'background.js' });

  buildBrowser(mock, [
    { state: 'normal', focused: true, tabs: [
      { url: 'https://p1.example.com', pinned: true },
      { url: 'https://p2.example.com', pinned: true, active: true }, // active INSIDE pinned block
      { url: 'https://p3.example.com', pinned: true },
    ]},
    { state: 'normal', focused: false, tabs: [{ url: 'https://u1.example.com' }, { url: 'https://u2.example.com' }] },
  ]);

  const snap = await capture(mock);
  const w1 = snap.windows[0];
  check('all-pinned window: 3 pinned captured', w1.tabs.filter(t => t.pinned).length === 3);
  check('active-inside-pinned captured', w1.tabs.find(t => t.url === 'https://p2.example.com')?.active === true);

  wipeBrowser(mock);
  const resp = await restore(mock, snap);
  check('restore ok', resp?.ok === true, String(resp?.error));
  const r = mock.state;
  const rw1 = r.windows.find(w => w.tabs.some(t => t.url === 'https://p1.example.com'));
  const rw2 = r.windows.find(w => w.tabs.some(t => t.url === 'https://u1.example.com'));
  check('all 3 pinned again, pinned block first', rw1.tabs.filter(t => t.pinned).length === 3 && rw1.tabs.slice(0, 3).every(t => t.pinned));
  check('pinned order preserved', JSON.stringify(rw1.tabs.map(t => t.url)) === JSON.stringify(['https://p1.example.com', 'https://p2.example.com', 'https://p3.example.com']));
  check('active stayed inside pinned block', rw1.tabs.find(t => t.url === 'https://p2.example.com')?.active === true);
  check('unpinned window: zero pinned', rw2.tabs.every(t => !t.pinned));
  check('unpinned window order preserved', JSON.stringify(rw2.tabs.map(t => t.url)) === JSON.stringify(['https://u1.example.com', 'https://u2.example.com']));
}

/* ================================================================== *
 * S5 — URLS: unusual URLs round-trip; hostile restore degrades to tabs
 * ================================================================== */
console.log('\n═══ S5: UNUSUAL URLS — round-trip + graceful degradation ═══\n');
{
  const mock = createChromeMock();
  const sandbox = { chrome: mock.chrome, console, setTimeout, clearTimeout, Date };
  vm.createContext(sandbox);
  vm.runInContext(workerCode, sandbox, { filename: 'background.js' });

  const weirdUrls = [
    'chrome://settings/',                                 // chrome scheme
    'chrome-extension://abcdefg/popup.html',              // extension scheme
    'file:///C:/Users/tester/report.pdf',                 // file scheme
    'https://example.com/pa th?q=hello world&lang=en#frag', // spaces + unicode-ish query
    'https://例え.テスト/ページ?x=1',                          // IDN
    'https://user:pass@example.com/secret?a=1',           // userinfo
    'https://very-long-domain.a.b.c.d.e.f.g.example.com/' + 'x'.repeat(300), // very long
    'https://example.com/' + encodeURIComponent('🎉emoji'), // emoji path
  ];
  buildBrowser(mock, [{ state: 'normal', focused: true, tabs: weirdUrls.map((url, i) => ({ url, active: i === 0 })) }]);

  const snap = await capture(mock);
  check('all 8 unusual URLs captured verbatim', snap.windows[0].tabs.map(t => t.url).join('\n') === weirdUrls.join('\n'));

  // Happy-path restore with every URL succeeding
  wipeBrowser(mock);
  let resp = await restore(mock, snap);
  check('happy restore: 1 window, 8 tabs', resp?.ok === true && resp?.restoredWindows === 1 && resp?.restoredTabs === 8);
  check('happy restore: URLs byte-identical', mock.state.windows[0].tabs.map(t => t.url).join('\n') === weirdUrls.join('\n'));

  // HOSTILE restore: windows.create now ALWAYS fails → per-tab fallback
  wipeBrowser(mock);
  mock.state.windowsCreated = 0; // count only this restore's creations
  mock.state.tabsCreated = 0;
  mock.state.failWindowCreate = true;
  resp = await restore(mock, snap);
  check('hostile restore: still ok (graceful degradation)', resp?.ok === true, String(resp?.error));
  check('hostile restore: 0 windows created', resp?.restoredWindows === 0);
  check(`hostile restore: tabs opened individually (got ${resp?.restoredTabs})`, resp?.restoredTabs === 8);
  check('fault injection actually engaged (windowsCreated === 0)', mock.state.windowsCreated === 0 && mock.state.tabsCreated === 8);

  // Empty-window edge: a window with NO tabs is skipped by capture
  const mock2 = createChromeMock();
  const sandbox2 = { chrome: mock2.chrome, console, setTimeout, clearTimeout, Date };
  vm.createContext(sandbox2);
  vm.runInContext(workerCode, sandbox2, { filename: 'background.js' });
  buildBrowser(mock2, [
    { state: 'normal', focused: true, tabs: [{ url: 'https://real.example.com' }] },
    { state: 'normal', focused: false, tabs: [] },
  ]);
  const snap2 = await capture(mock2);
  check('empty window skipped by capture', snap2.windows.length === 1 && snap2.windows[0].tabs.length === 1);
}

/* ================================================================== *
 * S6 — CYCLES: repeated save → wipe → restore; double restore; re-save
 * ================================================================== */
console.log('\n═══ S6: REPEATED SAVE/RESTORE — 3 cycles + double restore ═══\n');
{
  const mock = createChromeMock();
  const sandbox = { chrome: mock.chrome, console, setTimeout, clearTimeout, Date };
  vm.createContext(sandbox);
  vm.runInContext(workerCode, sandbox, { filename: 'background.js' });

  const gWork = { title: 'Work', color: 'blue', collapsed: false };
  const gRef = { title: 'Research', color: 'red', collapsed: true };
  buildBrowser(mock, [
    { state: 'maximized', focused: true, tabs: [
      { url: 'https://docs.example.com', pinned: true },
      { url: 'https://google.com', group: gWork },
      { url: 'https://scholar.google.com', group: gRef, active: true },
      { url: 'https://github.com', group: gWork },
      { url: 'https://news.ycombinator.com' },
    ]},
    { state: 'normal', focused: false, tabs: [{ url: 'https://youtube.com' }] },
  ]);

  const expected = JSON.stringify([
    { tabs: [
      { url: 'https://docs.example.com', pinned: true, active: false, group: null },
      { url: 'https://google.com', pinned: false, active: false, group: 'Work' },
      { url: 'https://scholar.google.com', pinned: false, active: true, group: 'Research' },
      { url: 'https://github.com', pinned: false, active: false, group: 'Work' },
      { url: 'https://news.ycombinator.com', pinned: false, active: false, group: null }],
      pinnedBlock: ['https://docs.example.com'],
      active: 'https://scholar.google.com' },
    { tabs: [{ url: 'https://youtube.com', pinned: false, active: true, group: null }],
      pinnedBlock: [],
      active: 'https://youtube.com' }
  ]);

  // Snapshot STRUCTURE comparator — deliberately ignores tab TITLES: the worker
  // never restores titles (Chrome derives them from page loads), so titles
  // legitimately differ between the saved and a re-captured snapshot.
  const snapStructure = (snap) => JSON.stringify(
    (snap?.windows || []).map(w => ({
      state: w.state, focused: w.focused,
      groups: (w.groups || []).map(g => ({ title: g.title, color: g.color, collapsed: g.collapsed })),
      tabs: (w.tabs || []).map(t => ({
        url: t.url, pinned: t.pinned, active: t.active,
        group: t.groupId ? ((w.groups || []).find(g => g.id === t.groupId) || {}).title ?? null : null
      }))
    }))
  );

  // Repeated save→wipe→restore cycles: the snapshot must stay structure-stable
  let snapshot = null;
  for (let cycle = 1; cycle <= 3; cycle++) {
    const snap = await capture(mock); // captures the LIVE state (restored by the previous cycle)
    if (cycle === 1) snapshot = snap;
    const now = JSON.stringify(structureOf(mock.state));
    check(`cycle ${cycle}: live structure = expected`, now === expected, now.slice(0, 80));
    check(`cycle ${cycle}: snapshot structure identical to cycle 1`, snapStructure(snap) === snapStructure(snapshot));
    wipeBrowser(mock);
    const resp = await restore(mock, snap);
    check(`cycle ${cycle}: restore ok (2 windows, 6 tabs)`, resp?.ok === true && resp?.restoredWindows === 2 && resp?.restoredTabs === 6, String(resp?.error));
  }

  // Double restore from the SAME snapshot — restores are ADDITIVE by design
  // (same semantics as Chrome's own session restore): re-restoring re-opens
  // the same windows. It must duplicate cleanly, never destroy or corrupt.
  wipeBrowser(mock);
  await restore(mock, snapshot);
  await restore(mock, snapshot);
  check('double restore: additive duplication (4 windows, both copies exact)',
    mock.state.windows.length === 4 && JSON.stringify(structureOf(mock.state)) === JSON.stringify([...JSON.parse(expected), ...JSON.parse(expected)]));

  // Re-save AFTER a restore (save → restore → save → compare structure)
  const resaved = await capture(mock); // captures the 4-window doubled state
  // NOTE: `focused` is legitimately NOT part of this comparison — the second
  // restore focused ITS copy of the saved focused window (last-focus wins,
  // same as real Chrome), so only the first restore's copy still shows focused.
  const noFocus = (s) => JSON.stringify(JSON.parse(s).map(({ focused, ...w }) => w));
  const single = JSON.parse(snapStructure(resaved));
  check('re-save after restore: each doubled copy keeps the exact structure',
    single.length === 4 &&
    noFocus(JSON.stringify(single.slice(0, 2))) === noFocus(JSON.stringify(single.slice(2, 4))) &&
    noFocus(JSON.stringify(single.slice(0, 2))) === noFocus(snapStructure(snapshot)));
}

/* ------------------------------------------------------------------ *
 * RESULT
 * ------------------------------------------------------------------ */

console.log(`\n════════════════════════════════════════════════`);
console.log(`  E2E STRESS: ${pass} passed, ${fail} failed`);
console.log(`  VERDICT: ${fail === 0
  ? '✅ STRESS-PROOF — scale, windows, groups, pinned, URLs and cycles all survive'
  : '❌ BROKEN — see failures above'}`);
console.log(`════════════════════════════════════════════════\n`);
process.exit(fail > 0 ? 1 : 0);
