// ============================================================================
// PRODUCTION RELIABILITY TEST — what changes when a stranger's real workday
// runs on top of the extension.
// Run: node scripts/e2e-production.test.mjs
//
// Real worker (public/background.js) in a Node VM with a Chrome-faithful mock,
// plus wall-clock timing. Dimensions the structural suites don't cover:
//
//   P1  LATENCY AT SCALE — capture/restore wall-time at 10/50/120/200 tabs,
//       asserted against generous production budgets (popup feels instant)
//   P2  CONCURRENT AUTO-SAVE — heartbeat + Live Backup upsert firing DURING a
//       big restore must not corrupt either side
//   P3  MV3 COLD START — storage survives a worker eviction between save and
//       restore (new VM, same storage) and restore still works
//   P4  CRASH RECOVERY AT SCALE — 150 tabs across 4 windows: badge → candidate
//       → RESTORE_RECOVERY rebuilds everything
//   P5  STORAGE FOOTPRINT — bytes written to chrome.storage.local at realistic
//       scale (MUST stay far below the 10 MB chrome.storage.local budget);
//       recovery ring capped
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
const now = () => Number(process.hrtime.bigint() / 1000000n); // ms resolution

/* ------------------------------------------------------------------ *
 * Chrome mock — same contract as the other e2e suites
 * ------------------------------------------------------------------ */

function createChromeMock() {
  let nextTabId = 20000, nextWinId = 15000, nextGroupId = 90000;
  const state = {
    windows: [], groupMeta: new Map(),
    local: {}, session: {}, badge: '', badgeColor: '',
    messageListener: null, startupListener: null,
    syncs: [],                                   // [path] of fetch POSTs
    heartbeatHandler: null,
  };
  const findWin = (id) => state.windows.find(w => w.id === id);
  const chrome = {
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
    alarms: {
      create() {}, clear() {}, async getAll() { return []; },
      onAlarm: { addListener(cb) { state.heartbeatHandler = cb; } }
    },
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

// Production mock fetch: records autosave POSTs, "server" always reachable
function prodFetch(state) {
  return async (url) => {
    state.syncs.push(String(url));
    return { ok: true, json: async () => ({ upserted: true }) };
  };
}

function loadWorker(mock) {
  const sandbox = { chrome: mock.chrome, console, setTimeout, clearTimeout, Date, fetch: prodFetch(mock.state), AbortSignal };
  vm.createContext(sandbox);
  vm.runInContext(workerCode, sandbox, { filename: 'background.js' });
}

async function sendMessage(mock, msg) {
  let response = null;
  mock.state.messageListener(msg, {}, (r) => { response = r; });
  for (let i = 0; i < 200 && response === null; i++) await sleep(5);
  return response;
}

/** Build `nTabs` tabs spread across `nWins` windows with groups in every window. */
function buildBrowser(mock, nTabs, nWins) {
  const { state } = mock;
  const per = Math.max(1, Math.floor(nTabs / nWins));
  let made = 0, tabId = 100, groupId = 10;
  for (let w = 0; w < nWins; w++) {
    const win = { id: w + 1, state: w === 0 ? 'maximized' : 'normal', focused: w === 0, tabs: [] };
    const g1 = ++groupId, g2 = ++groupId;
    state.groupMeta.set(g1, { title: `W${w + 1} Research`, color: 'blue', collapsed: false });
    state.groupMeta.set(g2, { title: `W${w + 1} Work`, color: 'red', collapsed: w % 2 === 1 });
    for (let i = 0; i < per && made < nTabs; i++, made++) {
      const url = `https://${(made % 97)}.prod-site${made}.example.com/path?a=${made}&q=${'x'.repeat(20)}`;
      win.tabs.push({
        id: ++tabId, url, title: `Production Tab ${made}`, groupId: -1,
        pinned: i % 25 === 0, active: i === 1
      });
    }
    // group half the non-pinned tabs: first third → g1, next third → g2
    const free = win.tabs.filter(t => !t.pinned);
    free.slice(0, Math.floor(free.length / 3)).forEach(t => (t.groupId = g1));
    free.slice(Math.floor(free.length / 3), 2 * Math.floor(free.length / 3)).forEach(t => (t.groupId = g2));
    if (win.tabs.length) state.windows.push(win);
  }
  return { windows: nWins, groups: nWins * 2, tabs: made };
}

const snapshotBytes = (state) => JSON.stringify(state.local.snapshot || {}).length;
const liveTabCount = (state) => state.windows.reduce((n, w) => n + w.tabs.length, 0);

/* ================================================================== *
 * P1 — LATENCY AT SCALE (wall-clock, generous production budgets)
 * ================================================================== */
console.log('\n═══ P1: LATENCY AT SCALE ═══\n');
for (const [nTabs, nWins, budgetCapture, budgetRestore] of [[10, 1, 200, 400], [50, 2, 400, 800], [120, 3, 700, 1500], [200, 5, 1200, 2500]]) {
  console.log(`── ${nTabs} tabs / ${nWins} window${nWins > 1 ? 's' : ''} ──`);
  const mock = createChromeMock();
  loadWorker(mock);
  const built = buildBrowser(mock, nTabs, nWins);

  const t0 = now();
  const snap = await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
  const tCapture = now() - t0;
  check(`${nTabs}: capture ok`, snap?.ok === true);
  check(`${nTabs}: all tabs captured (${built.tabs})`, mock.state.local.snapshot.windows.reduce((n, w) => n + w.tabs.length, 0) === built.tabs);
  check(`${nTabs}: capture ${tCapture}ms ≤ ${budgetCapture}ms budget`, tCapture <= budgetCapture, `${tCapture}ms`);

  mock.state.windows = [];
  mock.state.groupMeta.clear();
  const t1 = now();
  const resp = await sendMessage(mock, { type: 'RESTORE_SESSION', session: mock.state.local.snapshot });
  const tRestore = now() - t1;
  check(`${nTabs}: restore ok (${resp?.restoredWindows} windows, ${resp?.restoredTabs} tabs)`, resp?.ok === true && resp?.restoredTabs === built.tabs);
  check(`${nTabs}: live tabs back (${liveTabCount(mock.state)})`, liveTabCount(mock.state) === built.tabs);
  check(`${nTabs}: restore ${tRestore}ms ≤ ${budgetRestore}ms budget`, tRestore <= budgetRestore, `${tRestore}ms`);
}

/* ================================================================== *
 * P2 — CONCURRENT AUTO-SAVE during a big restore
 * ================================================================== */
console.log('\n═══ P2: AUTO-SAVE FIRING DURING RESTORE (120 tabs) ═══\n');
{
  const mock = createChromeMock();
  loadWorker(mock);
  buildBrowser(mock, 120, 3);
  await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
  const snapshotRef = JSON.parse(JSON.stringify(mock.state.local.snapshot)); // immutable copy
  check('pre-restore snapshot valid (120 tabs)', snapshotRef.windows.reduce((n, w) => n + w.tabs.length, 0) === 120);

  mock.state.windows = [];
  mock.state.groupMeta.clear();

  // The heartbeat alarm fires (snapshot flush + Live Backup upsert) while a
  // 120-tab restore is still running — the classic production overlap.
  check('worker registered the alarm handler', typeof mock.state.heartbeatHandler === 'function');
  const heartbeat = mock.state.heartbeatHandler({ name: 'orbi-heartbeat', scheduledTime: Date.now() });
  const restore = sendMessage(mock, { type: 'RESTORE_SESSION', session: snapshotRef });
  const resp = await restore;
  await heartbeat;
  await sleep(60);

  check('restore completed correctly despite concurrent heartbeat', resp?.ok === true && resp?.restoredTabs === 120, JSON.stringify(resp));
  check('no tab duplication from the concurrent save', liveTabCount(mock.state) === 120, `live=${liveTabCount(mock.state)}`);
  // Chrome-honest order invariant: pinning MOVES tabs into the front pinned
  // block (real Chrome behavior, replicated by the mock). So exact layout
  // equals the snapshot ONLY when pins were already contiguous at the front.
  // The restore guarantee is: same pinned SET + same unpinned RELATIVE order.
  const urlOf = (w) => w.tabs.map(t => t.url);
  const chromeHonest = (wSnap, wLive) => {
    const pinnedSet = (w) => JSON.stringify(w.tabs.filter(t => t.pinned).map(t => t.url).sort());
    const unpinnedOrder = (w) => JSON.stringify(w.tabs.filter(t => !t.pinned).map(t => t.url));
    return pinnedSet(wSnap) === pinnedSet(wLive) && unpinnedOrder(wSnap) === unpinnedOrder(wLive);
  };
  check('every window: pinned set + unpinned order preserved (Chrome pin-block semantics)',
    snapshotRef.windows.length === mock.state.windows.length &&
    snapshotRef.windows.every((ws, i) => chromeHonest(ws, mock.state.windows[i])),
    `windows=${mock.state.windows.length}`);
  check('same tab count per window',
    snapshotRef.windows.every((ws, i) => urlOf(ws).length === urlOf(mock.state.windows[i]).length));

  // Live Backup captured MID-restore is eventually consistent — the next
  // heartbeat (30s later in production) must reflect the full state.
  await mock.state.heartbeatHandler({ name: 'orbi-heartbeat', scheduledTime: Date.now() });
  await sleep(80);
  const lb = (mock.state.local.orbi_sessions || []).find(s => s.isAutoSave && s.autoKey === 'live-backup');
  check("next heartbeat's Live Backup carries the full 120 tabs",
    !!lb && (lb.windows || []).reduce((n, w) => n + w.tabs.length, 0) === 120,
    String(lb ? (lb.windows || []).reduce((n, w) => n + w.tabs.length, 0) : 'missing'));
  check('no torn write: Live Backup doc is structurally valid v1',
    !!lb && Array.isArray(lb.windows) && lb.windows.every(w => Array.isArray(w.tabs) && Array.isArray(w.groups)));
}

/* ================================================================== *
 * P3 — MV3 COLD START between save and restore
 * ================================================================== */
console.log('\n═══ P3: WORKER EVICTED BETWEEN SAVE AND RESTORE ═══\n');
{
  const mockA = createChromeMock();
  loadWorker(mockA);
  buildBrowser(mockA, 60, 2);
  await sendMessage(mockA, { type: 'SNAPSHOT_NOW' });
  const preserved = JSON.parse(JSON.stringify(mockA.state.local)); // storage survives eviction

  // New worker instance (new VM), same storage — chrome.runtime restarts the worker
  const mockB = createChromeMock();
  mockB.state.local = preserved;
  loadWorker(mockB);
  mockB.state.windows = [];
  mockB.state.groupMeta.clear();

  const resp = await sendMessage(mockB, { type: 'RESTORE_SESSION', session: mockB.state.local.snapshot });
  check('cold-started worker restores the saved session', resp?.ok === true && resp?.restoredTabs === 60);
  check('60 tabs live after cold-start restore', liveTabCount(mockB.state) === 60);

  // And the cold worker's alarm machinery re-arms itself (production re-protection)
  const hb = await sendMessage(mockB, { type: 'SNAPSHOT_NOW' });
  check('cold worker captures fresh snapshots again', hb?.ok === true && (mockB.state.local.snapshot?.windows || []).reduce((n, w) => n + w.tabs.length, 0) === 60);
}

/* ================================================================== *
 * P4 — CRASH RECOVERY AT SCALE (150 tabs, 4 windows)
 * ================================================================== */
console.log('\n═══ P4: CRASH RECOVERY AT SCALE ═══\n');
{
  const mock = createChromeMock();
  loadWorker(mock);
  const built = buildBrowser(mock, 150, 4); // floor(150/4)*4 = 148 actual tabs
  await sendMessage(mock, { type: 'SNAPSHOT_NOW' });

  // Hard crash: windows die, NO clean exit, heartbeat still fresh
  mock.state.windows = [];
  mock.state.groupMeta.clear();
  mock.state.local.cleanExit = false;
  mock.state.local.lastAlive = Date.now() - 20000;

  const t0 = now();
  await mock.state.startupListener();
  await sleep(80);
  const cand = mock.state.local.recoveryCandidate;
  const tDetect = now() - t0;
  check(`crash detected → candidate queued at scale (${built.tabs} tabs)`,
    !!cand && cand.windows.reduce((n, w) => n + w.tabs.length, 0) === built.tabs);
  check('badge "!" shown', mock.state.badge === '!');
  check(`crash detection ${tDetect}ms (instant UX)`, tDetect < 1000, `${tDetect}ms`);

  const t1 = now();
  const rec = await sendMessage(mock, { type: 'RESTORE_RECOVERY' });
  const tRecRestore = now() - t1;
  check(`RESTORE_RECOVERY rebuilt 4 windows / ${built.tabs} tabs`, rec?.ok === true && rec?.restoredWindows === 4 && rec?.restoredTabs === built.tabs);
  check(`recovery restore ${tRecRestore}ms ≤ 3s budget`, tRecRestore <= 3000, `${tRecRestore}ms`);
  check('recovery state cleared', !mock.state.local.recoveryCandidate && mock.state.badge === '');
}

/* ================================================================== *
 * P5 — STORAGE FOOTPRINT (the 10 MB chrome.storage.local budget)
 * ================================================================== */
console.log('\n═══ P5: STORAGE FOOTPRINT ═══\n');
{
  const mock = createChromeMock();
  loadWorker(mock);
  buildBrowser(mock, 200, 5);
  await sendMessage(mock, { type: 'SNAPSHOT_NOW' });

  const snapBytes = snapshotBytes(mock.state);
  check(`200-tab snapshot size ${snapBytes} bytes (< 1 MB)`, snapBytes < 1_000_000, `${snapBytes}B`);

  // Heartbeat writes: snapshot + session + local + recoveryPoints ring
  await mock.state.heartbeatHandler({ name: 'orbi-heartbeat', scheduledTime: Date.now() });
  await sleep(80);
  const totalBytes = Object.entries(mock.state.local)
    .filter(([k]) => k !== 'token') // token size is negligible/user-dependent
    .reduce((n, [, v]) => n + JSON.stringify(v).length, 0);
  check(`total local footprint after heartbeat ${totalBytes} bytes (< 2 MB)`, totalBytes < 2_000_000, `${totalBytes}B`);
  check(`footprint uses ${(totalBytes / (10 * 1024 * 1024) * 100).toFixed(1)}% of chrome.storage.local's 10 MB budget`, totalBytes < 2_000_000);

  const ring = mock.state.local.recoveryPoints || [];
  check(`recovery ring capped (${ring.length} ≤ 5)`, ring.length <= 5);
  check('ring entries are full snapshots', ring.every(p => Array.isArray(p.windows)));
}

/* ------------------------------------------------------------------ *
 * RESULT
 * ------------------------------------------------------------------ */
console.log(`\n════════════════════════════════════════════════`);
console.log(`  PRODUCTION RELIABILITY: ${pass} passed, ${fail} failed`);
console.log(`  VERDICT: ${fail === 0
  ? '✅ PRODUCTION-GRADE — latency, concurrency, cold starts, crash scale and storage all hold'
  : '❌ NOT READY — see failures above'}`);
console.log(`════════════════════════════════════════════════\n`);
process.exit(fail > 0 ? 1 : 0);
