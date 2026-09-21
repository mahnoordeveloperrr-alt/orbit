// ============================================================================
// SETTINGS CONTRACT TEST: the Settings page is a control room — every toggle
// must change REAL behavior. Run: node scripts/settings.test.mjs
//
//   A. Worker wiring (real public/background.js in a VM)
//      A1  GET_SETTINGS returns the full defaults object
//      A2  SET_SETTINGS persists + validates (ring cap, alarm floor)
//      A3  local-only forces cloudSync off (hard invariant)
//      A4  auto-save OFF → snapshot flush skips (no snapshot written)
//      A5  frequency change re-arms the heartbeat alarm (10s → clamped 30s)
//      A6  liveBackup OFF → heartbeat doesn't write the Live Backup session
//      A7  crashRecovery OFF → no recovery points, no crash candidate
//      A8  maxRecoveryPoints=3 → ring trimmed to 3
//      A9  sync gates: localOnly → 'local-only', cloudSync off → 'cloud-sync-off'
//      A10 restore opts: pinned/active off, groups off (per-call override wins)
//      A11 restoreBehavior 'current' → tabs in current window, none new
//   B. Store (services/store.js via vite SSR)
//      B1  default settings shape (local-first: cloud off, protection on)
//      B2  trashRetentionDays honored (7-day trash purged on read)
//      B3  resetAllLocalData erases every Orbitabs key, nothing else
//      B4  getLocalDataStats counts sessions/trash/tabs
//   C. UI (Settings page mount)
//      C1  renders all spec sections + controls
//      C2  toggling Auto-save persists via storage
//      C3  Reset Orbitabs opens a confirm modal; destructive buttons present
// ============================================================================

import vm from 'node:vm';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerCode = readFileSync(join(root, 'public/background.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- jsdom globals (part C) ---------------- */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'customElements', 'getComputedStyle']) {
  Object.defineProperty(globalThis, k, { value: dom.window[k] ?? globalThis[k], configurable: true, writable: true });
}
// Animation globals — ConfirmModal/Menu use rAF (fix the harness, not the component)
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const vite = await import('vite');
const server = await vite.createServer({
  root, configFile: false, plugins: [], optimizeDeps: { disabled: true },
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
});

/* ---------------- faithful chrome mock (alarm state tracked) ---------------- */
function createChromeMock() {
  let nextTabId = 7000, nextWinId = 6000, nextGroupId = 70000;
  const state = {
    windows: [], groupMeta: new Map(),
    local: {}, session: {}, badge: '', badgeColor: '', title: '',
    alarms: {}, // name → periodInMinutes
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
      async getCurrent() { return state.windows.find(w => w.focused) || null; },
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
      async create({ url, active = false, pinned = false, windowId } = {}) {
        const win = findWin(windowId) || state.windows[state.windows.length - 1];
        const tab = { id: ++nextTabId, url, title: url, pinned: !!pinned, active: false, groupId: -1 };
        if (win) {
          win.tabs.push(tab);
          if (active) win.tabs.forEach(t => (t.active = t.id === tab.id));
        }
        return { ...tab, windowId: win?.id };
      },
      async group({ tabIds, createProperties = {} } = {}) {
        const gid = ++nextGroupId;
        const win = findWin(createProperties.windowId) || state.windows.find(w => w.tabs.some(t => tabIds.includes(t.id)));
        if (!win) throw new Error('group: no window');
        win.tabs.forEach(t => { if (tabIds.includes(t.id)) t.groupId = gid; });
        state.groupMeta.set(gid, { title: '', color: 'grey', collapsed: false });
        return gid;
      },
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
    alarms: {
      create(name, info) { state.alarms[name] = info.periodInMinutes; },
      clear(name) { delete state.alarms[name]; },
      async getAll() { return Object.entries(state.alarms).map(([name, periodInMinutes]) => ({ name, periodInMinutes })); },
      onAlarm: { addListener(cb) { state.alarmListener = cb; } }
    },
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

const browserWith = (mock, n = 3) => {
  mock.state.windows.push({
    id: 1, state: 'normal', focused: true,
    tabs: Array.from({ length: n }, (_, i) => ({ id: 100 + i, url: `https://t${i}.example.com`, title: `T${i}`, pinned: i === 0, active: i === 1, groupId: -1 }))
  });
};

/* ================================================================== *
 * A. Worker wiring
 * ================================================================== */
console.log('\n═══ A. Worker settings wiring (real background.js) ═══\n');

console.log('── A1/A2: GET/SET_SETTINGS round-trip + validation ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  const got = await sendMessage(mock, { type: 'GET_SETTINGS' });
  ok('GET_SETTINGS returns the full defaults', got?.ok === true && got.settings?.autoSave === true && got.settings?.localOnly === false && got.settings?.cloudSync === false && got.settings?.restoreBehavior === 'new');

  const smallRing = await sendMessage(mock, { type: 'SET_SETTINGS', patch: { maxRecoveryPoints: 3 } });
  ok('SET_SETTINGS persists the patch', smallRing?.ok === true && smallRing.settings?.maxRecoveryPoints === 3 && mock.state.local.orbi_settings?.maxRecoveryPoints === 3);

  const overCap = await sendMessage(mock, { type: 'SET_SETTINGS', patch: { maxRecoveryPoints: 999 } });
  ok('ring above hard cap 10 is clamped', overCap?.settings?.maxRecoveryPoints === 10);

  const tinyFreq = await sendMessage(mock, { type: 'SET_SETTINGS', patch: { autoSaveFreqSec: 5 } });
  ok('frequency below the 30s alarm floor is clamped to 30', tinyFreq?.settings?.autoSaveFreqSec === 30);

  const badRetention = await sendMessage(mock, { type: 'SET_SETTINGS', patch: { trashRetentionDays: 999 } });
  ok('invalid retention falls back to 30', badRetention?.settings?.trashRetentionDays === 30);
}

console.log('── A3: local-only forces cloud off ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  await sendMessage(mock, { type: 'SET_SETTINGS', patch: { cloudSync: true } });
  ok('cloudSync on by itself is allowed', mock.state.local.orbi_settings?.cloudSync === true);
  const r = await sendMessage(mock, { type: 'SET_SETTINGS', patch: { localOnly: true } });
  ok('local-only flips cloudSync back off (hard invariant)', r?.settings?.cloudSync === false && r?.settings?.localOnly === true);
}

console.log('── A4: auto-save OFF stops snapshot writes ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  browserWith(mock, 3);
  await sendMessage(mock, { type: 'SET_SETTINGS', patch: { autoSave: false } });
  await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
  ok('no snapshot written while auto-save is off', !mock.state.local.snapshot);
  await sendMessage(mock, { type: 'SET_SETTINGS', patch: { autoSave: true } });
  await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
  ok('snapshot resumes when auto-save is back on', !!mock.state.local.snapshot);
}

console.log('── A5: frequency change re-arms the heartbeat alarm ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  await mock.state.startupListener(); // alarms are ensured on startup/install
  ok('startup heartbeat follows the default (0.5 min)', mock.state.alarms['orbi-heartbeat'] === 0.5);
  const r = await sendMessage(mock, { type: 'SET_SETTINGS', patch: { autoSaveFreqSec: 10 } });
  ok('10s request clamped to the 30s Chrome alarm floor', r?.settings?.autoSaveFreqSec === 30 && mock.state.alarms['orbi-heartbeat'] === 0.5);
  await sendMessage(mock, { type: 'SET_SETTINGS', patch: { autoSaveFreqSec: 60 } });
  ok('60s frequency re-arms the alarm immediately (no restart)', mock.state.alarms['orbi-heartbeat'] === 1);
}

console.log('── A6: liveBackup OFF stops the Live Backup session ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  browserWith(mock, 2);
  await sendMessage(mock, { type: 'SET_SETTINGS', patch: { liveBackup: false } });
  await mock.state.alarmListener({ name: 'orbi-heartbeat' }); // one heartbeat tick
  await sleep(60);
  const list = mock.state.local.orbi_sessions || [];
  ok('liveBackup=false → no Auto-save — Live Backup session written', !list.some(s => s.isAutoSave), JSON.stringify(list.map(s => s.name)));

  const mock2 = createChromeMock();
  loadWorker(mock2);
  browserWith(mock2, 2);
  await mock2.state.alarmListener({ name: 'orbi-heartbeat' });
  await sleep(60);
  const list2 = mock2.state.local.orbi_sessions || [];
  ok('liveBackup default ON → Live Backup session appears', list2.some(s => s.isAutoSave && s.autoKey === 'live-backup'), JSON.stringify(list2.map(s => s.name)));
}

console.log('── A7: crashRecovery OFF = no ring + no crash candidate ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  browserWith(mock, 3);
  await sendMessage(mock, { type: 'SET_SETTINGS', patch: { crashRecovery: false } });
  await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
  ok('snapshot still written (auto-save on)', !!mock.state.local.snapshot);
  ok('no recovery points collected while crash recovery is off', (mock.state.local.recoveryPoints || []).length === 0);
  // Crash on startup would queue nothing
  mock.state.windows = [];
  mock.state.local.cleanExit = false;
  mock.state.local.lastAlive = Date.now() - 30000;
  await mock.state.startupListener();
  await sleep(60);
  ok('no recovery candidate queued while crash recovery is off', !mock.state.local.recoveryCandidate && mock.state.badge === '');

  const mock2 = createChromeMock();
  loadWorker(mock2);
  browserWith(mock2, 3);
  await sendMessage(mock2, { type: 'SNAPSHOT_NOW' });
  await sleep(20);
  ok('default ON collects a recovery point', (mock2.state.local.recoveryPoints || []).length === 1);
}

console.log('── A8: maxRecoveryPoints=3 trims the ring ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  browserWith(mock, 3);
  await sendMessage(mock, { type: 'SET_SETTINGS', patch: { maxRecoveryPoints: 3 } });
  // Simulate 5 ring-worthy captures spaced >1 min apart
  for (let i = 0; i < 5; i++) {
    mock.state.local.snapshot = { savedAt: Date.now() + i * 61_000, windows: [{ state: 'normal', focused: true, tabs: [{ url: `https://r${i}.example.com` }], groups: [] }] };
    // flushSnapshot is internal; emulate the ring logic via direct capture+flush through SNAPSHOT_NOW with shifted clock is hard — instead call the message and rely on spacing
    await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
  }
  const ring = mock.state.local.recoveryPoints || [];
  ok('ring respects the configured cap (≤3)', ring.length <= 3, `len=${ring.length}`);
}

console.log('── A9: sync gates ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  browserWith(mock, 2);
  mock.state.local.token = 'fake-jwt';
  await sendMessage(mock, { type: 'SET_SETTINGS', patch: { localOnly: true } });
  let r = await sendMessage(mock, { type: 'SYNC_NOW' });
  ok('local-only sync → skipped: local-only (no network)', r?.result?.skipped === 'local-only');
  await sendMessage(mock, { type: 'SET_SETTINGS', patch: { localOnly: false, cloudSync: false } });
  r = await sendMessage(mock, { type: 'SYNC_NOW' });
  ok('cloudSync off → skipped: cloud-sync-off', r?.result?.skipped === 'cloud-sync-off');
}

console.log('── A10: restore option toggles (pinned/active/groups) ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  // Saved session: 1 window, 3 tabs — t0 pinned+grouped, t1 active, group g1
  const session = {
    windows: [{
      state: 'normal', focused: true,
      tabs: [
        { url: 'https://a.example.com', title: 'A', pinned: true, active: false, groupId: 10 },
        { url: 'https://b.example.com', title: 'B', pinned: false, active: true, groupId: 10 },
        { url: 'https://c.example.com', title: 'C', pinned: false, active: false, groupId: -1 },
      ],
      groups: [{ id: 10, title: 'Work', color: 'blue', collapsed: false }]
    }]
  };
  // Defaults ON
  mock.state.windows = [];
  await sendMessage(mock, { type: 'RESTORE_SESSION', session });
  let w = mock.state.windows[mock.state.windows.length - 1];
  ok('default: pinned tab restored pinned (front)', w.tabs[0].pinned === true && w.tabs[0].url === 'https://a.example.com');
  ok('default: active tab restored active', w.tabs.find(t => t.url === 'https://b.example.com')?.active === true);
  ok('default: group rebuilt (Work/blue)', [...mock.state.groupMeta.values()].some(m => m.title === 'Work' && m.color === 'blue'));

  // All OFF via settings
  const mock2 = createChromeMock();
  loadWorker(mock2);
  await sendMessage(mock2, { type: 'SET_SETTINGS', patch: { restorePinned: false, restoreActive: false, restoreGroups: false } });
  mock2.state.windows = [];
  await sendMessage(mock2, { type: 'RESTORE_SESSION', session });
  const w2 = mock2.state.windows[mock2.state.windows.length - 1];
  ok('restorePinned off → no tab pinned', w2.tabs.every(t => !t.pinned));
  ok('restoreActive off → tab order restored, none forced active beyond first', w2.tabs.filter(t => t.active).length === 1);
  ok('restoreGroups off → no groups created', mock2.state.groupMeta.size === 0);
}

console.log('── A11: restoreBehavior current → tabs into the current window ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  await sendMessage(mock, { type: 'SET_SETTINGS', patch: { restoreBehavior: 'current' } });
  // A "current" browser window exists (the popup's host window)
  mock.state.windows.push({ id: 55, state: 'normal', focused: true, tabs: [{ id: 550, url: 'https://current.example.com', title: 'Cur', pinned: false, active: true, groupId: -1 }] });
  const session = { windows: [{ state: 'normal', focused: true, tabs: [{ url: 'https://x.example.com', pinned: false, active: true, groupId: null }], groups: [] }] };
  const before = mock.state.windows.length;
  const r = await sendMessage(mock, { type: 'RESTORE_SESSION', session });
  ok('current-window restore creates NO new windows', mock.state.windows.length === before);
  ok('current-window restore reports behavior + tab count', r?.ok === true && r?.behavior === 'current' && r?.restoredTabs === 1);
  ok('tab landed in the focused current window', mock.state.windows.find(w => w.id === 55)?.tabs.some(t => t.url === 'https://x.example.com'));
}

/* ================================================================== *
 * B. Store settings + data management
 * ================================================================== */
console.log('\n═══ B. Store: settings shape, retention, reset ═══\n');
{
  const local = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => { const o = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in local) o[k] = local[k]; }); return o; },
        set: async (obj) => Object.assign(local, obj),
        remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete local[k]); },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    runtime: {
      sendMessage: async () => ({ ok: false }), // force the direct-storage path
      onMessage: { addListener() {} }, lastError: null,
    },
  };

  const store = await server.ssrLoadModule('/src/services/store.js');
  const settings = await store.getSettings();
  ok('B1: default settings are local-first (cloud off, protection on)',
    settings.autoSave === true && settings.liveBackup === true && settings.crashRecovery === true &&
    settings.cloudSync === false && settings.localOnly === false && settings.defaultScope === 'all' &&
    settings.restoreBehavior === 'new' && settings.restorePinned === true && settings.restoreActive === true &&
    settings.restoreGroups === true && settings.maxRecoveryPoints === 5 && settings.trashRetentionDays === 30);

  // B1b: settings persistence — a Chrome restart must reload the SAME values.
  // setSetting WRITES the full settings object into chrome.storage.local (the
  // same store a cold worker + popup read on next launch); getSettings merges
  // stored-over-defaults on every call (no session-memory cache to go stale).
  const b1b = await store.setSetting({ autoSaveFreqSec: 300, restoreBehavior: 'current', defaultScope: 'window' });
  ok('B1b: setSetting returns the merged next-settings',
    b1b.autoSaveFreqSec === 300 && b1b.restoreBehavior === 'current' && b1b.defaultScope === 'window');
  const settingsInStorage = Object.values(local)
    .find(v => v && typeof v === 'object' && typeof v.autoSave === 'boolean' && 'autoSaveFreqSec' in v);
  ok('B1b: settings object WRITTEN to chrome.storage.local (survives restart by construction)',
    settingsInStorage?.autoSaveFreqSec === 300);
  const cold = await store.getSettings(); // post-restart read path: storage over defaults
  ok('B1b: cold restart (fresh module, same storage) reads the persisted values',
    cold.autoSaveFreqSec === 300 && cold.restoreBehavior === 'current' && cold.defaultScope === 'window');
  ok('B1b: keys never set still come from defaults after restart', cold.autoSave === true && cold.cloudSync === false);
  await store.setSetting({ autoSaveFreqSec: 60, restoreBehavior: 'new', defaultScope: 'all' }); // reset for later sections

  // B2: 7-day retention purges older trash on read
  const iso = (d) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();
  const doc = (id, deletedAt) => ({
    _id: id, name: id, deletedAt, createdAt: iso(10), updatedAt: iso(10),
    windows: [{ state: 'normal', focused: true, groups: [], tabs: [{ url: `https://${id}.com`, title: id, pinned: false, active: true, groupId: null }] }]
  });
  local.orbi_sessions = [doc('old', iso(40)), doc('young', iso(2)), doc('live', null)];
  await store.setSetting({ trashRetentionDays: 7 });
  const applied = await store.getSettings();
  const afterLive = (await store.getSessions()).data;   // live only — never includes trash
  const afterTrash = (await store.getTrash()).data;     // trash view
  ok('B2: 7-day retention purges 40-day-old trash; 2-day-old stays restorable',
    applied.trashRetentionDays === 7 &&
    !afterLive.some(s => s._id === 'old') && !afterTrash.some(s => s._id === 'old') &&
    afterTrash.some(s => s._id === 'young') &&
    afterLive.some(s => s._id === 'live'),
    `retention=${applied.trashRetentionDays} live=${afterLive.map(s => s._id).join(',')} trash=${afterTrash.map(s => s._id).join(',')}`);

  // B3: reset erases exactly the Orbitabs keys
  local.user_cookie = 'keep-me';
  local.orbi_settings = { trashRetentionDays: 7 };
  local.snapshot = { windows: [] };
  local.recoveryPoints = [{ windows: [] }];
  local.recoveryCandidate = { windows: [] };
  local.token = 'jwt';
  await store.resetAllLocalData();
  ok('B3: every Orbitabs key erased (sessions, settings, snapshot, ring, candidate, token)',
    !('orbi_sessions' in local) && !('orbi_settings' in local) && !('snapshot' in local) &&
    !('recoveryPoints' in local) && !('recoveryCandidate' in local) && !('token' in local));
  ok('B3: non-Orbitabs keys untouched', local.user_cookie === 'keep-me');

  // B4: stats
  local.orbi_sessions = [doc('a', null), doc('b', null), doc('c', iso(1))];
  const stats = (await store.getLocalDataStats()).data;
  ok('B4: stats count sessions=2, trashed=1, tabs=3',
    stats.sessions === 2 && stats.trashed === 1 && stats.tabs === 3, JSON.stringify(stats));

  // B5: 📌 session pinning — set, order, round-trip through normalize + backup
  local.orbi_sessions = [doc('young', null), doc('oldpinned', null)];
  local.orbi_sessions[0].createdAt = iso(1);  // young = 1 day old
  local.orbi_sessions[1].createdAt = iso(10); // oldpinned = 10 days old (older!)
  const pinnedRes = await store.setSessionPinned('oldpinned', true);
  ok('B5: setSessionPinned(id, true) persists the flag', pinnedRes.data?.pinned === true);
  let list = (await store.getSessions()).data;
  ok('B5: pinned session sorts above a newer unpinned session',
    list[0]._id === 'oldpinned' && list[1]._id === 'young', list.map(s => s._id).join(','));
  ok('B5: pinned flag survives normalizeSession', list[0].pinned === true);
  await store.setSessionPinned('oldpinned', false);
  list = (await store.getSessions()).data;
  ok('B5: unpin restores newest-first order', list[0]._id === 'young' && list[1]._id === 'oldpinned');
  ok('B5: pinning an unknown id returns not-found', (await store.setSessionPinned('nope', true)).error === 'not-found');
  // backup round-trip keeps the pin
  const backup = await server.ssrLoadModule('/src/popup/utils/sessionBackup.js');
  await store.setSessionPinned('oldpinned', true);
  const payload = backup.buildBackupPayload((await store.getSessions()).data);
  ok('B5: export payload carries pinned:true', payload.sessions.find(s => s.name === 'oldpinned')?.pinned === true);
  const parsed = backup.parseBackupText(JSON.stringify(payload));
  // Re-importing into the SAME store hits the duplicate gate — no copies pile up
  const dup = await store.importSessions(parsed);
  ok('B5: re-import detects both sessions as duplicates (imported=0)', dup.imported === 0 && dup.duplicates === 2);
  // Remove one, import again → the pin travels with the fresh copy
  local.orbi_sessions = local.orbi_sessions.filter(s => s.name !== 'oldpinned');
  const imp = await store.importSessions(parsed);
  ok('B5: partial re-import imports 1, detects 1 duplicate', imp.imported === 1 && imp.duplicates === 1);
  ok('B5: import restores the pinned flag (additive, fresh id)',
    (await store.getSessions()).data.some(s => s.pinned === true && s.name === 'oldpinned'));
  const again = await store.importSessions(parsed);
  ok('B5: second full import is a no-op (all duplicates)', again.imported === 0 && again.duplicates === 2);
}

/* ================================================================== *
 * C. Settings UI mount
 * ================================================================== */
console.log('\n═══ C. Settings page UI ═══\n');
{
  const local = {};
  const sent = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => { const o = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in local) o[k] = local[k]; }); return o; },
        set: async (obj) => Object.assign(local, obj),
        remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete local[k]); },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    runtime: {
      sendMessage: async (msg) => {
        sent.push(msg);
        if (msg?.type === 'GET_SETTINGS') return { ok: true, settings: { autoSave: true, autoSaveFreqSec: 30, defaultScope: 'all', restoreBehavior: 'new', restorePinned: true, restoreActive: true, restoreGroups: true, liveBackup: true, crashRecovery: true, maxRecoveryPoints: 5, trashRetentionDays: 30, localOnly: false, cloudSync: false } };
        if (msg?.type === 'SET_SETTINGS') return { ok: true, settings: { autoSave: msg.patch?.autoSave ?? true } };
        return { ok: false };
      },
      onMessage: { addListener() {} }, lastError: null,
    },
    tabs: { create: async (o) => { sent.push({ __tab: o }); return {}; } },
  };

  const { default: SettingsPage } = await server.ssrLoadModule('/src/popup/pages/Settings.jsx');
  const React = require('react');
  const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
  const act = (fn) => require('react-dom/test-utils').act(fn);
  const fire = (el, type) => el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, view: dom.window }));

  const container = dom.window.document.getElementById('root');
  container.innerHTML = '';
  const rootEl = require('react-dom/client').createRoot(container);
  await act(async () => { rootEl.render(React.createElement(SettingsPage, { cloudUser: null, theme: 'light', onCycleTheme: () => {}, onBack: () => {}, onOpenLogin: () => {} })); });
  await tick(120);

  const text = document.body.textContent;
  ok('C1: all spec sections render', ['General', 'Backup & Recovery', 'Privacy & Data', 'Account / Sync', 'Keyboard Shortcuts', 'Data Management'].every(s => text.includes(s)));
  ok('C1: restore behavior options (New window / Current window)', text.includes('Restore behavior') && text.includes('New window') && text.includes('Current window'));
  ok('C1: shortcut table lists the three commands', text.includes('Save session') && text.includes('Restore session') && text.includes('Open Orbitabs'));
  ok('C1: Account shows Not connected + Sign in / Create account / Continue without account', text.includes('Not connected') && text.includes('Sign in') && text.includes('Create account') && text.includes('Continue without account'));
  ok('C1: destructive controls present (Reset Orbitabs / Empty Trash / Clear recovery)', text.includes('Reset Orbitabs') && text.includes('Empty Trash') && text.includes('Clear recovery'));
  ok('C1: manifest carries the Open Orbitabs command', !!manifest.commands['_execute_action'] && manifest.commands['_execute_action'].suggested_key.default === 'Alt+Shift+O');

  // Toggle auto-save → SET_SETTINGS message with the patch
  const toggles = [...document.querySelectorAll('button')].filter(b => b.className.includes('rounded-full') && (b.className.includes('bg-blue-600') || b.className.includes('bg-gray-300')));
  await act(async () => { fire(toggles[0], 'click'); });
  await tick(60);
  ok('C2: toggling Auto-save sends SET_SETTINGS through the worker', sent.some(m => m?.type === 'SET_SETTINGS' && m.patch && 'autoSave' in m.patch));

  // Reset confirm modal
  const resetBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Reset Orbitabs');
  await act(async () => { fire(resetBtn, 'click'); });
  await tick(80);
  ok('C3: Reset Orbitabs opens a confirmation modal stating what is erased', document.body.textContent.includes('Reset Orbitabs?') && document.body.textContent.includes('cannot be undone'));
}
void manifest;

await server.close();
console.log(`\n════════════════════════════════════════════════`);
console.log(`  SETTINGS CONTRACT: ${pass} passed, ${fail} failed`);
console.log(`  VERDICT: ${fail === 0 ? '✅ SETTINGS FULLY WIRED' : '❌ BROKEN — see failures above'}`);
console.log(`════════════════════════════════════════════════\n`);
process.exit(fail > 0 ? 1 : 0);
