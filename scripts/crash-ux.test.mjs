// ============================================================================
// CRASH UX TEST — recovery-points ring, dismiss, restore-point, gates
// Run: node scripts/crash-ux.test.mjs
//
//   C1  recovery-points ring grows with each flush (spaced > 1 min apart)
//   C2  ring is capped at maxRecoveryPoints (default 5; hard-max 10)
//   C3  flushSnapshot with crashRecovery=false skips ring maintenance
//   C4  empty-window snapshot never enters the ring
//   C5  RESTORE_RECOVERY_POINT opens the indexed snapshot
//   C6  RESTORE_RECOVERY_POINT with bad index returns no-such-recovery-point
//   C7  DISMISS_RECOVERY clears badge and candidate without restoring
//   C8  crashRecovery=false → no badge even when crash conditions are met
//   C9  SET_SETTINGS enforces maxRecoveryPoints hard-cap (1–10)
//  C10  recovery candidate cleared after successful RESTORE_RECOVERY
// ============================================================================

import vm from 'node:vm';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerCode = readFileSync(join(root, 'public/background.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else       { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ─── minimal chrome mock ─────────────────────────────────────── */
function createChromeMock() {
  let nextTabId = 9000, nextWinId = 8000;
  const state = {
    windows: [], local: {}, session: {},
    badge: '', badgeColor: '', title: '',
    messageListener: null, startupListener: null, commandListener: null,
  };
  const findWin = id => state.windows.find(w => w.id === id);
  const chrome = {
    commands: { onCommand: { addListener(cb) { state.commandListener = cb; } } },
    windows: {
      onCreated:  { addListener() {} },
      onRemoved:  { addListener() {} },
      async getAll(opts = {}) {
        return state.windows.map(w => ({
          id: w.id, state: w.state, focused: w.focused,
          ...(opts.populate ? { tabs: w.tabs.map(t => ({ ...t })) } : {}),
        }));
      },
      async create({ url = [], focused = false, state: ws = 'normal' } = {}) {
        const win = {
          id: ++nextWinId, state: ws, focused,
          tabs: url.map(u => ({ id: ++nextTabId, url: u, title: u, pinned: false, active: false, groupId: -1 })),
        };
        if (win.tabs[0]) win.tabs[0].active = true;
        state.windows.push(win);
        return { id: win.id, tabs: win.tabs.map(t => ({ ...t })) };
      },
      async update(id, props = {}) {
        const win = findWin(id);
        if (!win) throw new Error('no such window');
        if ('focused' in props) state.windows.forEach(w => (w.focused = w.id === id ? !!props.focused : false));
        if ('state'   in props) win.state = props.state;
        return { id: win.id };
      },
    },
    tabs: {
      async group({ tabIds, createProperties = {} } = {}) {
        const win = findWin(createProperties.windowId) ||
          state.windows.find(w => w.tabs.some(t => tabIds.includes(t.id)));
        if (!win) throw new Error('group: no window');
        const gid = Date.now();
        win.tabs.forEach(t => { if (tabIds.includes(t.id)) t.groupId = gid; });
        return gid;
      },
      async ungroup(tabIds) {
        state.windows.forEach(w => w.tabs.forEach(t => { if (tabIds.includes(t.id)) t.groupId = -1; }));
      },
      async update(tabId, props = {}) {
        const tab = state.windows.flatMap(w => w.tabs).find(t => t.id === tabId);
        if (!tab) throw new Error('no such tab');
        if (props.pinned !== undefined) tab.pinned = props.pinned;
        if (props.active === true) state.windows.forEach(w => w.tabs.forEach(t => (t.active = t.id === tabId)));
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
      onCreated:  { addListener() {} }, onRemoved:  { addListener() {} },
      onMoved:    { addListener() {} }, onAttached: { addListener() {} },
      onDetached: { addListener() {} }, onReplaced: { addListener() {} },
      onUpdated:  { addListener() {} },
    },
    tabGroups: {
      async query({ windowId } = {}) {
        const win = findWin(windowId);
        if (!win) return [];
        const ids = [...new Set(win.tabs.map(t => t.groupId).filter(g => g !== -1))];
        return ids.map(g => ({ id: g, title: '', color: 'grey', collapsed: false }));
      },
      async update(groupId) { return { id: groupId }; },
      onCreated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} },
    },
    storage: {
      local: {
        async get(keys) {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in state.local) out[k] = state.local[k]; });
          return out;
        },
        async set(obj)    { Object.assign(state.local, obj); },
        async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete state.local[k]); },
      },
      session: {
        async get(keys) {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in state.session) out[k] = state.session[k]; });
          return out;
        },
        async set(obj) { Object.assign(state.session, obj); },
      },
    },
    alarms: {
      create() {}, clear() {},
      async getAll() { return []; },
      onAlarm: { addListener() {} },
    },
    action: {
      setBadgeText:            async o => { state.badge      = o.text  || ''; },
      setBadgeBackgroundColor: async o => { state.badgeColor = o.color || ''; },
      setTitle:                async o => { state.title      = o.title || ''; },
    },
    runtime: {
      onMessage:  { addListener(cb) { state.messageListener = cb; } },
      onInstalled: { addListener() {} },
      onStartup:  { addListener(cb) { state.startupListener = cb; } },
      async sendMessage() { return { ok: false }; },
    },
  };
  return { chrome, state };
}

const loadWorker = (mock, extra = {}) => {
  const sandbox = {
    chrome: mock.chrome, console, setTimeout, clearTimeout, Date,
    fetch: async () => { throw new Error('ECONNREFUSED'); },
    AbortSignal, ...extra,
  };
  vm.createContext(sandbox);
  vm.runInContext(workerCode, sandbox, { filename: 'background.js' });
};

async function sendMessage(mock, msg) {
  let response = null;
  mock.state.messageListener(msg, {}, r => { response = r; });
  for (let i = 0; i < 150 && response === null; i++) await sleep(10);
  return response;
}

/** Seed a window with n normal tabs */
const browserWith = (mock, n = 3) => {
  mock.state.windows.push({
    id: 1, state: 'normal', focused: true,
    tabs: Array.from({ length: n }, (_, i) => ({
      id: 100 + i, url: `https://t${i}.example.com`, title: `T${i}`,
      pinned: false, active: i === 0, groupId: -1,
    })),
  });
};

/* ================================================================== *
 * C1 — recovery-points ring grows across flushes
 * ================================================================== */
console.log('\n── C1: recovery-points ring grows ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  browserWith(mock, 3);

  // First flush — ring should have 1 entry
  await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
  await sleep(60);
  const pts1 = mock.state.local.recoveryPoints || [];
  ok('ring has 1 entry after first flush', pts1.length === 1, `got ${pts1.length}`);
  ok('ring entry has windows array', Array.isArray(pts1[0]?.windows));

  // Advance clock so the gap condition is met (> 1 minute)
  const BASE = pts1[0]?.savedAt || Date.now();
  mock.state.local.recoveryPoints[0].savedAt = BASE - 90_000; // age it back 90s

  // Second flush — ring should grow to 2
  await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
  await sleep(60);
  const pts2 = mock.state.local.recoveryPoints || [];
  ok('ring grows to 2 entries after second flush', pts2.length === 2, `got ${pts2.length}`);
  ok('newest entry is at index 0 (ring is newest-first)', pts2[0].savedAt >= pts2[1].savedAt);
}

/* ================================================================== *
 * C2 — ring capped at maxRecoveryPoints
 * ================================================================== */
console.log('\n── C2: ring cap enforcement ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  browserWith(mock, 2);

  // Set cap to 3 via settings
  mock.state.local.orbi_settings = { maxRecoveryPoints: 3 };

  // Seed ring with 3 entries that are "old enough" to be overwritten
  const fakeOld = (offset) => ({
    savedAt: Date.now() - offset,
    windows: [{ state: 'normal', focused: true, groups: [], tabs: [{ url: 'https://old.example.com', title: 'Old', pinned: false, active: true, groupId: null }] }],
    schemaVersion: 1,
  });
  mock.state.local.recoveryPoints = [fakeOld(5 * 60_000), fakeOld(10 * 60_000), fakeOld(15 * 60_000)];

  // Age the newest to allow a new one in
  mock.state.local.recoveryPoints[0].savedAt = Date.now() - 90_000;

  await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
  await sleep(80);
  const pts = mock.state.local.recoveryPoints || [];
  ok('ring capped at 3 (maxRecoveryPoints=3)', pts.length === 3, `got ${pts.length}`);
}

/* ================================================================== *
 * C3 — crashRecovery=false skips ring entirely
 * ================================================================== */
console.log('\n── C3: crashRecovery=false skips ring ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  browserWith(mock, 2);
  mock.state.local.orbi_settings = { crashRecovery: false };

  await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
  await sleep(80);
  const pts = mock.state.local.recoveryPoints;
  ok('no recoveryPoints written when crashRecovery=false', !pts || pts.length === 0,
    pts ? `got ${pts.length} entries` : 'undefined ✓');
  ok('snapshot itself still written (crash-proof copy)', !!mock.state.local.snapshot);
}

/* ================================================================== *
 * C4 — empty-window snapshot never enters ring
 * ================================================================== */
console.log('\n── C4: empty snapshot skipped by ring ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  // No windows added → snapshot will have 0 tabs

  await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
  await sleep(80);
  const pts = mock.state.local.recoveryPoints;
  ok('ring empty when browser has 0 tabs', !pts || pts.length === 0,
    pts ? `got ${pts.length}` : 'undefined ✓');
}

/* ================================================================== *
 * C5 — RESTORE_RECOVERY_POINT opens indexed snapshot
 * ================================================================== */
console.log('\n── C5: RESTORE_RECOVERY_POINT ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  browserWith(mock, 2);

  // Seed ring manually with 2 points (3-tab and 2-tab)
  const makePoint = (n, offset) => ({
    savedAt: Date.now() - offset,
    schemaVersion: 1,
    windows: [{
      state: 'normal', focused: true, groups: [],
      tabs: Array.from({ length: n }, (_, i) => ({
        url: `https://rp${i}.example.com`, title: `RP${i}`,
        pinned: false, active: i === 0, groupId: null,
      })),
    }],
  });
  mock.state.local.recoveryPoints = [makePoint(3, 60_000), makePoint(2, 120_000)];

  // Restore point index 1 (the 2-tab one)
  mock.state.windows = []; // clear so restore opens new windows
  const resp = await sendMessage(mock, { type: 'RESTORE_RECOVERY_POINT', index: 1 });
  ok('RESTORE_RECOVERY_POINT ok:true', resp?.ok === true, JSON.stringify(resp));
  ok('restored 2 tabs from point index 1', resp?.restoredTabs === 2, `restoredTabs=${resp?.restoredTabs}`);

  // Restore point index 0 (the 3-tab one)
  mock.state.windows = [];
  const resp0 = await sendMessage(mock, { type: 'RESTORE_RECOVERY_POINT', index: 0 });
  ok('RESTORE_RECOVERY_POINT index 0 ok:true', resp0?.ok === true, JSON.stringify(resp0));
  ok('restored 3 tabs from point index 0', resp0?.restoredTabs === 3, `restoredTabs=${resp0?.restoredTabs}`);
}

/* ================================================================== *
 * C6 — RESTORE_RECOVERY_POINT bad index → no-such-recovery-point
 * ================================================================== */
console.log('\n── C6: RESTORE_RECOVERY_POINT bad index ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  mock.state.local.recoveryPoints = []; // empty ring

  const resp = await sendMessage(mock, { type: 'RESTORE_RECOVERY_POINT', index: 0 });
  ok('bad index returns ok:false', resp?.ok === false, JSON.stringify(resp));
  ok('error is no-such-recovery-point', resp?.error === 'no-such-recovery-point', resp?.error);

  // Also test out-of-bounds on a non-empty ring
  const mock2 = createChromeMock();
  loadWorker(mock2);
  mock2.state.local.recoveryPoints = [{
    savedAt: Date.now() - 90_000, schemaVersion: 1,
    windows: [{ state: 'normal', focused: true, groups: [], tabs: [{ url: 'https://x.com', title: 'X', pinned: false, active: true, groupId: null }] }],
  }];
  const resp2 = await sendMessage(mock2, { type: 'RESTORE_RECOVERY_POINT', index: 99 });
  ok('out-of-bounds index returns no-such-recovery-point', resp2?.error === 'no-such-recovery-point', resp2?.error);
}

/* ================================================================== *
 * C7 — DISMISS_RECOVERY clears badge without restoring
 * ================================================================== */
console.log('\n── C7: DISMISS_RECOVERY ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  browserWith(mock, 3);

  // Set up crash state manually
  mock.state.local.recoveryCandidate = {
    savedAt: Date.now() - 60_000, schemaVersion: 1,
    windows: [{ state: 'normal', focused: true, groups: [], tabs: [{ url: 'https://lost.example.com', title: 'Lost', pinned: false, active: true, groupId: null }] }],
  };
  mock.state.local.crashDetectedAt = Date.now() - 60_000;
  mock.state.badge = '!';
  mock.state.badgeColor = '#ef4444';

  const resp = await sendMessage(mock, { type: 'DISMISS_RECOVERY' });
  ok('DISMISS_RECOVERY ok:true', resp?.ok === true, JSON.stringify(resp));
  ok('recoveryCandidate cleared after dismiss', !mock.state.local.recoveryCandidate);
  ok('badge cleared after dismiss', mock.state.badge === '');
  ok('no new windows opened (tabs count unchanged)', mock.state.windows.length === 1);
}

/* ================================================================== *
 * C8 — crashRecovery=false → no badge even when crash conditions met
 * ================================================================== */
console.log('\n── C8: crashRecovery=false suppresses badge ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  browserWith(mock, 3);

  await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
  mock.state.local.cleanExit = false;
  mock.state.local.lastAlive = Date.now() - 30_000;
  mock.state.local.orbi_settings = { crashRecovery: false };

  await mock.state.startupListener();
  await sleep(80);

  ok('no recoveryCandidate when crashRecovery=false', !mock.state.local.recoveryCandidate);
  ok('badge stays blank when crashRecovery=false', mock.state.badge === '');
}

/* ================================================================== *
 * C9 — SET_SETTINGS enforces maxRecoveryPoints hard-cap
 * ================================================================== */
console.log('\n── C9: SET_SETTINGS maxRecoveryPoints clamp ──');
{
  const mock = createChromeMock();
  loadWorker(mock);

  // Try to set above hard cap (10)
  await sendMessage(mock, { type: 'SET_SETTINGS', patch: { maxRecoveryPoints: 999 } });
  await sleep(50);
  const s1 = mock.state.local.orbi_settings;
  ok('maxRecoveryPoints clamped to 10 (hard cap)', s1?.maxRecoveryPoints === 10, `got ${s1?.maxRecoveryPoints}`);

  // 0 is falsy → treated as "not set", falls back to default (5) then clamps to max(1,min(10,5))=5
  await sendMessage(mock, { type: 'SET_SETTINGS', patch: { maxRecoveryPoints: 0 } });
  await sleep(50);
  const s2 = mock.state.local.orbi_settings;
  ok('maxRecoveryPoints=0 (falsy) coerces to default 5', s2?.maxRecoveryPoints === 5, `got ${s2?.maxRecoveryPoints}`);

  // Negative values: Number(-1) = -1 → -1 || 5 = 5 (falsy-guard), clamps to max(1,min(10,5))=5
  await sendMessage(mock, { type: 'SET_SETTINGS', patch: { maxRecoveryPoints: -1 } });
  await sleep(50);
  const s2b = mock.state.local.orbi_settings;
  // -1 is truthy, so Math.max(1, Math.min(10, -1)) = Math.max(1, -1) = 1
  ok('maxRecoveryPoints=-1 clamped to minimum 1', s2b?.maxRecoveryPoints === 1, `got ${s2b?.maxRecoveryPoints}`);

  // Valid mid-range value
  await sendMessage(mock, { type: 'SET_SETTINGS', patch: { maxRecoveryPoints: 5 } });
  await sleep(50);
  const s3 = mock.state.local.orbi_settings;
  ok('maxRecoveryPoints=5 accepted unchanged', s3?.maxRecoveryPoints === 5, `got ${s3?.maxRecoveryPoints}`);
}

/* ================================================================== *
 * C10 — recovery candidate cleared after successful RESTORE_RECOVERY
 * ================================================================== */
console.log('\n── C10: candidate cleared after RESTORE_RECOVERY ──');
{
  const mock = createChromeMock();
  loadWorker(mock);
  browserWith(mock, 4);

  // Simulate a crash
  await sendMessage(mock, { type: 'SNAPSHOT_NOW' });
  mock.state.local.cleanExit = false;
  mock.state.local.lastAlive = Date.now() - 30_000;
  await mock.state.startupListener();
  await sleep(80);

  ok('crash candidate present before restore', !!mock.state.local.recoveryCandidate);
  ok('crash badge set before restore', mock.state.badge === '!');

  mock.state.windows = []; // simulate a fresh browser
  const resp = await sendMessage(mock, { type: 'RESTORE_RECOVERY' });
  ok('RESTORE_RECOVERY ok:true', resp?.ok === true, JSON.stringify(resp));
  ok('candidate cleared after restore', !mock.state.local.recoveryCandidate);
  ok('crashDetectedAt cleared after restore', !mock.state.local.crashDetectedAt);
  ok('badge cleared after restore', mock.state.badge === '');
  ok('tabs restored (4 tabs)', resp?.restoredTabs === 4, `restoredTabs=${resp?.restoredTabs}`);
}

/* ------------------------------------------------------------------ *
 * RESULT
 * ------------------------------------------------------------------ */
console.log(`\n✅ CRASH-UX: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
