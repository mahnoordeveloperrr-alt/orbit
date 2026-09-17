// ============================================================================
// E2E: Chrome commands API — keyboard shortcuts (real public/background.js)
// Run: node scripts/e2e-commands.test.mjs
//
// The REAL worker runs in a Node VM with the faithful chrome.* mock extended
// with a chrome.commands event sink. Covers:
//   1. quick-save  → named session appears in orbi_sessions, newest-first
//   2. restore-last → reopens the newest non-deleted session (structure check)
//   3. trash hygiene → trashed sessions are never restored
//   4. missing-command → restore-last is a silent no-op
//   5. QUICK_SAVE message → same path as the keyboard command
// ============================================================================

import vm from 'node:vm';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerCode = readFileSync(join(root, 'public/background.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.json'), 'utf8'));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Faithful Chrome mock (same contract as e2e-groups) + commands sink
 * ------------------------------------------------------------------ */

function createChromeMock() {
  let nextTabId = 2000, nextWinId = 1500, nextGroupId = 19000;
  const state = {
    windows: [], groupMeta: new Map(),
    local: {}, session: {}, badge: '', badgeColor: '',
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
        const win = {
          id: ++nextWinId, state: winState, focused,
          tabs: url.map(u => ({ id: ++nextTabId, url: u, title: u.replace(/^https?:\/\//, '').split('/')[0], pinned: false, active: false, groupId: -1 }))
        };
        if (win.tabs[0]) win.tabs[0].active = true;
        state.windows.push(win);
        return { id: win.id, tabs: win.tabs.map(t => ({ ...t })) };
      },
      async update(id, props = {}) {
        const win = findWin(id);
        if (!win) throw new Error('no such window ' + id);
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
      setBadgeBackgroundColor: async (o) => { state.badgeColor = o.color || ''; },
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

/** Fire a keyboard command and wait for the async handler to settle. */
async function pressCommand(mock, command) {
  await mock.state.commandListener(command);
  await sleep(50);
}

/* ------------------------------------------------------------------ *
 * Load the real worker + manifest contract checks
 * ------------------------------------------------------------------ */

console.log('\n═══ COMMANDS: keyboard shortcuts (real background.js) ═══\n');

const mock = createChromeMock();
const sandbox = { chrome: mock.chrome, console, setTimeout, clearTimeout, Date };
vm.createContext(sandbox);
vm.runInContext(workerCode, sandbox, { filename: 'background.js' });

// ---- 0. manifest contract ----
const cmds = manifest.commands || {};
check('manifest declares quick-save + restore-last', !!cmds['quick-save'] && !!cmds['restore-last']);
check('suggested keys are Alt+Shift+S / Alt+Shift+R',
  cmds['quick-save']?.suggested_key?.default === 'Alt+Shift+S' &&
  cmds['restore-last']?.suggested_key?.default === 'Alt+Shift+R');
check('worker registered a commands listener', typeof mock.state.commandListener === 'function');

/* ---- scenario: live browser with groups + pinned, ready to save ---- */
const gWork = { title: 'Work', color: 'blue', collapsed: false };
mock.state.groupMeta.set(10, { title: 'Work', color: 'blue', collapsed: false });
mock.state.groupMeta.set(20, { title: 'Research', color: 'red', collapsed: true });
mock.state.windows.push(
  {
    id: 1, state: 'maximized', focused: true,
    tabs: [
      { id: 101, url: 'https://docs.example.com', title: 'Docs', groupId: -1, pinned: true, active: false },
      { id: 102, url: 'https://github.com', title: 'GitHub', groupId: 10, pinned: false, active: true },
      { id: 103, url: 'https://gmail.com', title: 'Gmail', groupId: 10, pinned: false, active: false },
      { id: 104, url: 'https://scholar.google.com', title: 'Scholar', groupId: 20, pinned: false, active: false },
    ]
  },
  { id: 2, state: 'normal', focused: false, tabs: [{ id: 201, url: 'https://youtube.com', title: 'YouTube', groupId: -1, pinned: false, active: true }] }
);
void gWork;

/* ------------------------------------------------------------------ *
 * 1. quick-save via keyboard
 * ------------------------------------------------------------------ */
console.log('\n── 1. quick-save (Alt+Shift+S) ──');
await pressCommand(mock, 'quick-save');

const sessions = mock.state.local.orbi_sessions || [];
check('one named session written to orbi_sessions', sessions.length === 1);
check('name starts with "Quick Save —" and includes tab count', /^Quick Save — /.test(sessions[0]?.name || '') && /\(5 tabs\)/.test(sessions[0]?.name));
check('NOT an auto-save doc (isAutoSave=false)', sessions[0]?.isAutoSave === false);
check('v1 schema carried (windows[] with both groups)', Array.isArray(sessions[0]?.windows) && sessions[0].windows[0].groups.length === 2);
check('silent success → green ✓ badge pulse', mock.state.badge === '✓' && mock.state.badgeColor === '#16a34a');
await sleep(1300);
check('badge auto-clears', mock.state.badge === '');

/* ------------------------------------------------------------------ *
 * 2. restore-last via keyboard
 * ------------------------------------------------------------------ */
console.log('\n── 2. restore-last (Alt+Shift+R) ──');
mock.state.windows = []; // browser wiped — exactly the use case for the hotkey
mock.state.groupMeta.clear();

const resp = await pressCommand(mock, 'restore-last');
const live = mock.state.windows;
check('restore-last reopened 2 windows', live.length === 2);
const rw1 = live.find(w => w.tabs.some(t => t.url === 'https://docs.example.com'));
check('W1 rebuilt with 4 tabs in saved order',
  JSON.stringify(rw1?.tabs.map(t => t.url)) === JSON.stringify(['https://docs.example.com', 'https://github.com', 'https://gmail.com', 'https://scholar.google.com']));
check('pinned tab pinned again', rw1?.tabs[0].pinned === true);
const workId = rw1.tabs.find(t => t.url === 'https://github.com').groupId;
check('Work group rebuilt (blue, membership by id)', mock.state.groupMeta.get(workId)?.title === 'Work' && mock.state.groupMeta.get(workId)?.color === 'blue');
check('Research group rebuilt (collapsed)', [...mock.state.groupMeta.values()].some(m => m.title === 'Research' && m.collapsed === true));
check('focused window = saved focused (W1)', live.find(w => w.focused) === rw1);
void resp;

/* ------------------------------------------------------------------ *
 * 3. trash hygiene + newest-first
 * ------------------------------------------------------------------ */
console.log('\n── 3. trash hygiene + newest-first selection ──');
// Trash the quick save, add a newer + an older session
const qs = mock.state.local.orbi_sessions[0];
qs.deletedAt = new Date().toISOString();
const newer = { _id: 'newer', name: 'Newer manual session', createdAt: new Date(Date.now() + 60000).toISOString(), deletedAt: null, windows: [{ state: 'normal', focused: true, tabs: [{ url: 'https://newer.example.com', title: '', pinned: false, active: true, groupId: null }], groups: [] }] };
const older = { _id: 'older', name: 'Older session', createdAt: new Date(Date.now() - 60000).toISOString(), deletedAt: null, windows: [{ state: 'normal', focused: true, tabs: [{ url: 'https://older.example.com', title: '', pinned: false, active: true, groupId: null }], groups: [] }] };
mock.state.local.orbi_sessions = [qs, newer, older];

mock.state.windows = [];
mock.state.groupMeta.clear();
await pressCommand(mock, 'restore-last');
check('trashed session skipped', !mock.state.windows.some(w => w.tabs.some(t => t.url.includes('docs.example'))));
check('newest NON-deleted session chosen (newer, not older)', mock.state.windows.some(w => w.tabs.some(t => t.url === 'https://newer.example.com')));

/* ------------------------------------------------------------------ *
 * 4. missing command → silent no-op
 * ------------------------------------------------------------------ */
console.log('\n── 4. restore-last with nothing restorable ──');
mock.state.windows = [];
mock.state.groupMeta.clear();
mock.state.local.orbi_sessions = []; // empty store
await pressCommand(mock, 'restore-last');
check('empty store → no windows opened, no crash', mock.state.windows.length === 0);

/* ------------------------------------------------------------------ *
 * 5. QUICK_SAVE message (popup path shares the worker logic)
 * ------------------------------------------------------------------ */
console.log('\n── 5. QUICK_SAVE runtime message ──');
// Rebuild a tiny browser state so the save has content
mock.state.windows.push({ id: 9, state: 'normal', focused: true, tabs: [{ id: 901, url: 'https://single.example.com', title: 'S', groupId: -1, pinned: false, active: true }] });
const qsResp = await sendMessage(mock, { type: 'QUICK_SAVE' });
check('QUICK_SAVE responds ok with counts', qsResp?.ok === true && qsResp?.tabs === 1 && qsResp?.windows === 1);
check('quick save lands in the (previously emptied) store', (mock.state.local.orbi_sessions || []).length === 1);

/* ------------------------------------------------------------------ *
 * RESULT
 * ------------------------------------------------------------------ */

console.log(`\n════════════════════════════════════════════════`);
console.log(`  E2E COMMANDS: ${pass} passed, ${fail} failed`);
console.log(`  VERDICT: ${fail === 0 ? '✅ KEYBOARD SHORTCUTS LOCKED' : '❌ BROKEN — see failures above'}`);
console.log(`════════════════════════════════════════════════\n`);
process.exit(fail > 0 ? 1 : 0);
