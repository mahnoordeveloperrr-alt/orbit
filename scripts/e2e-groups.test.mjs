// ============================================================================
// END-TO-END TEST: Chrome Tab Groups preservation + restore (real worker code)
// Run: node scripts/e2e-groups.test.mjs
//
// The REAL public/background.js is executed inside a Node VM with a faithful
// chrome.* mock that replicates actual Chrome behaviors:
//   • ungrouped tabs have groupId === -1
//   • chrome.tabs.group() creates a NEW numeric group id
//   • pinning a tab MOVES it to the front (pinned block)
//   • making a tab active deactivates siblings
//   • storage.local survives "browser close" (that's the whole point)
//
// Scenario = the Day-2 promise, exactly:
//   Window 1: Research 🔵 (Google, Scholar, Wikipedia) + Work 🔴 (GitHub, Gmail)
//             + pinned Docs tab + Scholar active
//   Window 2: YouTube
//   Save → close browser → Restore → structure must be identical.
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
 * Faithful Chrome mock
 * ------------------------------------------------------------------ */

function createChromeMock() {
  let nextTabId = 100, nextWinId = 50, nextGroupId = 900;
  const state = {
    windows: [],                                  // {id, state, focused, tabs:[{id,url,title,pinned,active,groupId}]}
    groupMeta: new Map(),                         // groupId -> {title, color, collapsed}
    local: {}, session: {}, badge: '',
    messageListener: null, startupListener: null
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
        const win = {
          id: ++nextWinId, state: winState, focused,
          tabs: url.map(u => ({
            id: ++nextTabId, url: u, title: u.replace(/^https?:\/\//, '').split('/')[0],
            pinned: false, active: false, groupId: -1
          }))
        };
        if (win.tabs[0]) win.tabs[0].active = true; // Chrome activates first tab
        state.windows.push(win);
        return { id: win.id, tabs: win.tabs.map(t => ({ ...t, id: t.id })) };
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
        // Grouping preserves tab order; membership set; group starts uncollapsed
        win.tabs.forEach(t => { if (tabIds.includes(t.id)) t.groupId = gid; });
        state.groupMeta.set(gid, { title: '', color: 'grey', collapsed: false });
        return gid;
      },
      async ungroup(tabIds) {
        state.windows.forEach(w => w.tabs.forEach(t => { if (tabIds.includes(t.id)) t.groupId = -1; }));
      },
      async update(tabId, props = {}) {
        const win = state.windows.find(w => w.tabs.some(t => t.id === tabId));
        if (!win) throw new Error('no such tab ' + tabId);
        const tab = win.tabs.find(t => t.id === tabId);
        if (props.pinned === true) {
          // REAL CHROME BEHAVIOR: pinning moves the tab into the front pinned block
          tab.pinned = true;
          const idx = win.tabs.indexOf(tab);
          win.tabs.splice(idx, 1);
          const pinnedCount = win.tabs.filter(t => t.pinned).length;
          win.tabs.splice(pinnedCount, 0, tab);
        }
        if (props.pinned === false) tab.pinned = false;
        if (props.active === true) {
          win.tabs.forEach(t => (t.active = t.id === tabId));
        }
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
      // no-op event sinks so the worker can register listeners
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
    alarms: {
      create() {}, clear() {}, async getAll() { return []; },
      onAlarm: { addListener() {} }
    },
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

/** Send a runtime message to the loaded worker and await its sendResponse. */
async function sendMessage(mock, msg) {
  let response = null;
  const sendResponse = (r) => { response = r; };
  mock.state.messageListener(msg, {}, sendResponse);
  for (let i = 0; i < 50 && response === null; i++) await sleep(10);
  return response;
}

/* ------------------------------------------------------------------ *
 * Build the EXACT scenario
 * ------------------------------------------------------------------ */

function buildScenario(mock) {
  const { state } = mock;
  const mkTab = (id, url, title, groupId, pinned = false, active = false) =>
    ({ id, url, title, groupId, pinned, active });

  // Window 1: Docs(pinned) | Research 🔵 (Google, Scholar*, Wikipedia) | Work 🔴 collapsed (GitHub, Gmail)
  state.groupMeta.set(10, { title: 'Research', color: 'blue', collapsed: false });
  state.groupMeta.set(20, { title: 'Work', color: 'red', collapsed: true });
  state.windows.push({
    id: 1, state: 'maximized', focused: true,
    tabs: [
      mkTab(101, 'https://docs.example.com', 'Docs', -1, true, false),
      mkTab(102, 'https://google.com', 'Google', 10),
      mkTab(103, 'https://scholar.google.com', 'Scholar', 10, false, true), // active
      mkTab(104, 'https://wikipedia.org', 'Wikipedia', 10),
      mkTab(105, 'https://github.com', 'GitHub', 20),
      mkTab(106, 'https://mail.google.com', 'Gmail', 20)
    ]
  });
  // Window 2: YouTube (ungrouped, active)
  state.windows.push({
    id: 2, state: 'normal', focused: false,
    tabs: [mkTab(201, 'https://youtube.com', 'YouTube', -1, false, true)]
  });
}

/* ------------------------------------------------------------------ *
 * Pretty-print a mock browser state as a tree (for visual proof)
 * ------------------------------------------------------------------ */

function printTree(state, label) {
  const colorEmoji = { blue: '🔵', red: '🔴', green: '🟢', grey: '⚪', yellow: '🟡', purple: '🟣', orange: '🟠', pink: '🩷', cyan: '🩵' };
  console.log(`\n${label}`);
  state.windows.forEach(w => {
    console.log(`Window ${w.id}${w.focused ? ' (focused)' : ''} [${w.state}]`);
    const printed = new Set();
    w.tabs.forEach(t => {
      if (t.groupId !== -1) {
        if (printed.has(t.groupId)) return;
        printed.add(t.groupId);
        const meta = state.groupMeta.get(t.groupId) || {};
        const members = w.tabs.filter(x => x.groupId === t.groupId);
        console.log(`├─ ${colorEmoji[meta.color] || '⚪'} ${meta.title || 'Untitled'}${meta.collapsed ? ' (collapsed)' : ''}`);
        members.forEach(m => console.log(`│  ├─ ${m.title}${m.active ? ' ← active' : ''}`));
      } else {
        console.log(`├─ ${t.pinned ? '📌 ' : ''}${t.title}${t.active ? ' ← active' : ''} (ungrouped)`);
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * RUN
 * ------------------------------------------------------------------ */

console.log('\n═══ E2E: Chrome Tab Groups preserve + restore (real background.js) ═══\n');

const mock = createChromeMock();
const sandbox = { chrome: mock.chrome, console, setTimeout, clearTimeout, Date };
vm.createContext(sandbox);
vm.runInContext(workerCode, sandbox, { filename: 'background.js' });

// ---- 1. THE SCENARIO ----
buildScenario(mock);
printTree(mock.state, '──── ORIGINAL BROWSER STATE ────');

// ---- 2. SAVE (SNAPSHOT_NOW → worker captures through the real capture path) ----
console.log('\n─── SAVE (SNAPSHOT_NOW) ───');
const snapResp = await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
check('worker responded ok to SNAPSHOT_NOW', snapResp?.ok === true);
const saved = mock.state.local.snapshot;
check('snapshot written to crash-proof local storage', !!saved);
check('2 windows captured', saved?.windows?.length === 2);

const w1 = saved.windows[0], w2 = saved.windows[1];
check('W1: 6 tabs in saved order', JSON.stringify(w1.tabs.map(t => t.title)) ===
  JSON.stringify(['Docs', 'Google', 'Scholar', 'Wikipedia', 'GitHub', 'Gmail']));
check('W1: Docs pinned', w1.tabs[0].pinned === true);
check('W1: Scholar active', w1.tabs.find(t => t.title === 'Scholar')?.active === true);
check('W1: Research group captured (blue)', w1.groups.some(g => g.title === 'Research' && g.color === 'blue'));
check('W1: Work group captured (red, collapsed)', w1.groups.some(g => g.title === 'Work' && g.color === 'red' && g.collapsed === true));
const research = w1.groups.find(g => g.title === 'Research');
const work = w1.groups.find(g => g.title === 'Work');
check('W1: membership — Google/Scholar/Wikipedia → Research',
  w1.tabs.filter(t => t.groupId === research.id).map(t => t.title).join(',') === 'Google,Scholar,Wikipedia');
check('W1: membership — GitHub/Gmail → Work',
  w1.tabs.filter(t => t.groupId === work.id).map(t => t.title).join(',') === 'GitHub,Gmail');
check('W1: Docs ungrouped (groupId null)', w1.tabs[0].groupId === null);
check('W2: YouTube captured, ungrouped, active', w2.tabs.length === 1 && w2.tabs[0].groupId === null && w2.tabs[0].active === true);
check('W1 focused, state=maximized', w1.focused === true && w1.state === 'maximized');

// ---- 3. CLOSE THE BROWSER (windows die, storage survives) ----
console.log('\n─── CLOSE BROWSER (windows destroyed, storage survives) ───');
mock.state.windows = [];
mock.state.groupMeta.clear();
check('browser is empty', mock.state.windows.length === 0);

// ---- 4. RESTORE (popup path: RESTORE_SESSION with the saved snapshot) ----
console.log('\n─── RESTORE (RESTORE_SESSION) ───');
const resp = await sendMessage(mock, { type: 'RESTORE_SESSION', session: saved });
check('worker responded ok', resp?.ok === true, String(resp?.error || ''));
check(`restored windows = 2 (got ${resp?.restoredWindows})`, resp?.restoredWindows === 2);
check(`restored tabs = 7 (got ${resp?.restoredTabs})`, resp?.restoredTabs === 7);

printTree(mock.state, '──── RESTORED BROWSER STATE ────');

// ---- 5. VERIFY: the checklist from the Day-2 promise ----
console.log('\n─── VERIFY: groups / colors / names / membership / order / pinned / windows ───');
const r = mock.state;
check('multiple windows: 2 windows back', r.windows.length === 2);
// NOTE: tab TITLES come from page loads after restore (Chrome API cannot set
// titles directly), so all structural checks below match by URL — same as a
// human would verify visually in Chrome.
const rw1 = r.windows.find(w => w.tabs.some(t => t.url === 'https://docs.example.com'));
const rw2 = r.windows.find(w => w.tabs.some(t => t.url === 'https://youtube.com'));
check('Window 1 and Window 2 both rebuilt', !!rw1 && !!rw2);

// Groups same?
const meta = r.groupMeta;
const researchMeta = [...meta.entries()].find(([, m]) => m.title === 'Research')?.[1];
const workMeta = [...meta.entries()].find(([, m]) => m.title === 'Work')?.[1];
check('groups same: Research + Work exist again', !!researchMeta && !!workMeta);
// Colors same?
check('colors same: Research=blue, Work=red', researchMeta?.color === 'blue' && workMeta?.color === 'red');
// Names same?
check('names same: titles preserved', researchMeta?.title === 'Research' && workMeta?.title === 'Work');
// Collapsed state preserved?
check('collapsed state same: Work still collapsed', workMeta?.collapsed === true && researchMeta?.collapsed === false);
// Tabs correct group mein?
const inResearch = rw1.tabs.filter(t => t.groupId !== -1 && meta.get(t.groupId)?.title === 'Research').map(t => t.url);
const inWork = rw1.tabs.filter(t => t.groupId !== -1 && meta.get(t.groupId)?.title === 'Work').map(t => t.url);
check('tabs correct group: Research = Google,Scholar,Wikipedia', inResearch.join(',') === 'https://google.com,https://scholar.google.com,https://wikipedia.org', inResearch.join(','));
check('tabs correct group: Work = GitHub,Gmail', inWork.join(',') === 'https://github.com,https://mail.google.com', inWork.join(','));
check('tabs correct group: Docs + YouTube stay ungrouped',
  rw1.tabs.find(t => t.url === 'https://docs.example.com').groupId === -1 && rw2.tabs[0].groupId === -1);
// Order same?
check('order same: W1 = Docs,Google,Scholar,Wikipedia,GitHub,Gmail',
  JSON.stringify(rw1.tabs.map(t => t.url)) === JSON.stringify(['https://docs.example.com', 'https://google.com', 'https://scholar.google.com', 'https://wikipedia.org', 'https://github.com', 'https://mail.google.com']),
  rw1.tabs.map(t => t.url).join(','));
check('order same: W2 = YouTube', rw2.tabs[0].url === 'https://youtube.com');
// Pinned same?
check('pinned same: Docs pinned first (survived the pin-reorder behavior)', rw1.tabs[0].pinned === true && rw1.tabs[0].url === 'https://docs.example.com');
check('pinned same: no other tab got pinned', rw1.tabs.filter(t => t.pinned).length === 1);
// Active tab same?
check('active same: Scholar active in W1', rw1.tabs.find(t => t.url === 'https://scholar.google.com')?.active === true);
check('active same: YouTube active in W2', rw2.tabs[0].active === true);
// Window state + focus
check('window state same: W1 maximized', rw1.state === 'maximized');
check('focus: W1 (saved focused window) got focus', rw1.focused === true && rw2.focused === false);

// ---- 6. BONUS: crash-recovery path (Test G logic) with the same snapshot ----
console.log('\n─── BONUS: crash detection + RESTORE_RECOVERY (Test G logic) ───');
// Simulate: browser running, crashed, worker restarts
mock.state.windows = [];
mock.state.local.cleanExit = false;
mock.state.local.lastAlive = Date.now();
mock.state.local.snapshot = saved; // still there (crash-proof)
if (mock.state.startupListener) {
  await mock.state.startupListener();
  await sleep(50);
  check('crash detected → recoveryCandidate queued', !!mock.state.local.recoveryCandidate);
  check('crash badge "!" shown', mock.state.badge === '!');
  const rec = await sendMessage(mock, { type: 'RESTORE_RECOVERY' });
  check('recovery restore ok from candidate', rec?.ok === true && rec.restoredWindows === 2);
  check('recovery state cleared after restore', !mock.state.local.recoveryCandidate && mock.state.badge === '');
} else {
  check('crash path testable', false, 'onStartup listener not registered');
}

/* ------------------------------------------------------------------ *
 * RESULT
 * ------------------------------------------------------------------ */

console.log(`\n════════════════════════════════════════════════`);
console.log(`  E2E GROUPS PROMISE: ${pass} passed, ${fail} failed`);
console.log(`  VERDICT: ${fail === 0
  ? '✅ LOGIC LOCKED — structure survives save → close → restore'
  : '❌ BROKEN — fix above before claiming Day 2'}`);
console.log(`════════════════════════════════════════════════\n`);
process.exit(fail > 0 ? 1 : 0);
