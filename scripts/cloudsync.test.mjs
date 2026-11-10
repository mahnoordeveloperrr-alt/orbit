// ============================================================================
// CLOUD SYNC + ACCOUNT UX TEST
// ----------------------------
// Run: node scripts/cloudsync.test.mjs
//
//   A. Worker full-library sync (real public/background.js in a VM)
//      A1  gates: localOnly / cloudSync-off / not-logged-in (no network)
//      A2  Store-installed default: no Server URL → the baked hosted origin
//          is used (zero-config, never localhost); a Server URL overrides
//      A3  push: only live non-autosave sessions are POSTed (trash + Live
//          Backup excluded); cloudId remembered on each doc
//      A4  pull: cloud sessions merge in additively, deduped by name+createdAt
//          (autosave docs from the server are never imported)
//      A5  last-write-wins: newer local → PUT; newer cloud → adopted locally
//      A6  dead backend → skipped backend-unreachable, local data untouched,
//          honest orbi_sync_status.lastError recorded
//      A7  status contract: { lastSyncAt, pushed, updated, pulled, lastError }
//      A8  SYNC_NOW keeps the legacy result.skipped contract + nests library
//   B. Store quota errors (services/store.js via vite SSR)
//      B1  chrome.storage quota failure → actionable "storage is full" error
//   C. Login UI (real Login.jsx via vite SSR + jsdom)
//      C1  "Forgot password?" link appears only on the login form
//      C2  reset view: email-only form → generic success message from server
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

/* ---------------- jsdom globals (parts B + C) ---------------- */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'customElements', 'getComputedStyle', 'localStorage']) {
  Object.defineProperty(globalThis, k, { value: dom.window[k] ?? globalThis[k], configurable: true, writable: true });
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/* ---------------- minimal chrome mock (worker) ---------------- */
function createChromeMock({ storeInstalled = false } = {}) {
  const state = { local: {}, session: {}, messageListener: null, startupListener: null, commandListener: null, windows: [] };
  const chrome = {
    commands: { onCommand: { addListener(cb) { state.commandListener = cb; } } },
    windows: {
      onCreated: { addListener() {} }, onRemoved: { addListener() {} },
      async getAll() { return state.windows.map(w => ({ ...w })); },
      async getCurrent() { return state.windows.find(w => w.focused) || null; },
    },
    tabs: {
      onCreated: { addListener() {} }, onRemoved: { addListener() {} }, onMoved: { addListener() {} },
      onAttached: { addListener() {} }, onDetached: { addListener() {} }, onReplaced: { addListener() {} }, onUpdated: { addListener() {} },
      async create() { throw new Error('not needed in this suite'); },
      async query() { return []; }, async update() {}, async group() { return 1; }, async ungroup() {},
    },
    tabGroups: { onCreated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, async query() { return []; }, async update() {} },
    storage: {
      local: {
        async get(keys) {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in state.local) out[k] = state.local[k]; });
          return out;
        },
        async set(obj) { Object.assign(state.local, obj); },
        async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete state.local[k]); },
      },
      session: {
        async get(keys) { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in state.session) out[k] = state.session[k]; }); return out; },
        async set(obj) { Object.assign(state.session, obj); },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    alarms: { create() {}, clear() {}, async getAll() { return []; }, onAlarm: { addListener(cb) { state.alarmListener = cb; } } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    runtime: {
      onMessage: { addListener(cb) { state.messageListener = cb; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener(cb) { state.startupListener = cb; } },
      async sendMessage() { return { ok: false }; },
      ...(storeInstalled ? { getManifest: () => ({ update_url: 'https://clients2.google.com/service/update2/crx' }) } : {}),
    },
  };
  return { chrome, state };
}

async function sendMessage(mock, msg) {
  let response = null;
  mock.state.messageListener(msg, {}, (r) => { response = r; });
  for (let i = 0; i < 150 && response === null; i++) await sleep(10);
  return response;
}

/** Router-style fetch mock: routes(path, opts) → { status, data } | 'throw'. */
function makeFetch(routes) {
  const calls = [];
  const f = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const path = u.replace(/^https?:\/\/[^/]+/, '');
    const h = routes(path, opts, calls);
    if (h === 'throw') throw new Error('ECONNREFUSED');
    return { ok: h.status >= 200 && h.status < 300, status: h.status, json: async () => h.data };
  };
  f.calls = calls;
  return f;
}

const loadWorker = (mock, fetchImpl) => {
  const sandbox = {
    chrome: mock.chrome, console, setTimeout, clearTimeout, Date, JSON,
    AbortSignal, URL,
    fetch: fetchImpl || (async () => { throw new Error('ECONNREFUSED'); }),
  };
  vm.createContext(sandbox);
  vm.runInContext(workerCode, sandbox, { filename: 'background.js' });
};

const WIN1 = [{ state: 'normal', focused: true, tabs: [{ url: 'https://a.example', title: 'A', pinned: false, active: true, groupId: null }], groups: [] }];
const localDoc = (id, over = {}) => ({
  _id: id, name: `Session ${id}`, windows: WIN1, schemaVersion: 1,
  isAutoSave: false, autoKey: null, deletedAt: null,
  createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
});
const cloudDoc = (id, over = {}) => ({
  _id: id, name: `Cloud ${id}`, windows: WIN1,
  createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T09:00:00.000Z',
  isAutoSave: false, ...over,
});
const syncOn = { cloudSync: true, localOnly: false, autoSave: true };

/* ================================================================== *
 * A. Worker full-library sync
 * ================================================================== */
console.log('\n═══ A. Worker full-library sync (real background.js) ═══\n');

console.log('── A1: gates never hit the network ──');
for (const [label, patch, token, expect] of [
  ['local-only', { ...syncOn, localOnly: true }, 'jwt', 'local-only'],
  ['cloud-off', { ...syncOn, cloudSync: false }, 'jwt', 'cloud-sync-off'],
  ['no-token', { ...syncOn }, null, 'not-logged-in'],
]) {
  const mock = createChromeMock();
  const fetch = makeFetch(() => ({ status: 500, data: {} }));
  loadWorker(mock, fetch);
  mock.state.local.orbi_settings = patch;
  if (token) mock.state.local.token = token;
  mock.state.local.orbi_sessions = [localDoc('g1')];
  const r = await sendMessage(mock, { type: 'SYNC_NOW' });
  ok(`${label} → skipped: ${expect} (zero fetches)`,
    r?.result?.skipped === expect && fetch.calls.length === 0, JSON.stringify(r));
}

console.log('── A2: Store-installed default origin ──');
{
  const BAKED = 'https://site-8b67ef3788b2498f88d007d22c888375.freebuff.page'; // STORED_API_ORIGIN
  // Store build, NO Server URL → the baked hosted production origin is used
  // (zero-config cloud), and localhost is never touched.
  const mock = createChromeMock({ storeInstalled: true });
  const fetch = makeFetch((path) => path === '/api/sessions' ? { status: 200, data: [] } : { status: 200, data: {} });
  loadWorker(mock, fetch);
  mock.state.local.orbi_settings = { ...syncOn };
  mock.state.local.token = 'jwt';
  const r = await sendMessage(mock, { type: 'SYNC_NOW' });
  ok('Store install + no Server URL → syncs against the baked hosted origin',
    r?.result?.library?.skipped !== 'server-not-configured' &&
      fetch.calls.length > 0 &&
      fetch.calls.every(c => c.url.startsWith(`${BAKED}/api/`)),
    JSON.stringify({ lib: r?.result?.library, urls: fetch.calls.map(c => c.url) }));
  ok('never touches localhost in a Store build',
    fetch.calls.every(c => !c.url.includes('127.0.0.1') && !c.url.includes('localhost')),
    JSON.stringify(fetch.calls.map(c => c.url)));

  // Store build WITH a Server URL → the explicit override wins
  const mock2 = createChromeMock({ storeInstalled: true });
  const fetch2 = makeFetch((path) => path === '/api/sessions' ? { status: 200, data: [] } : { status: 200, data: {} });
  loadWorker(mock2, fetch2);
  mock2.state.local.orbi_settings = { ...syncOn, apiBaseUrl: 'https://api.orbitabs.example' };
  mock2.state.local.token = 'jwt';
  await sendMessage(mock2, { type: 'SYNC_NOW' });
  ok('Store install + Server URL → requests go to the configured origin',
    fetch2.calls.some(c => c.url.startsWith('https://api.orbitabs.example/api/')),
    JSON.stringify(fetch2.calls.map(c => c.url)));
  ok('Server URL override beats the baked origin (never localhost)',
    fetch2.calls.every(c => !c.url.includes('127.0.0.1') && !c.url.includes('localhost') && !c.url.startsWith(BAKED)),
    JSON.stringify(fetch2.calls.map(c => c.url)));
}

console.log('── A3: push (live non-autosave only) ──');
{
  const mock = createChromeMock();
  let posted = 0;
  // Distinguish GET (list) from POST (create)
  const fetch3 = makeFetch((path, opts) => {
    if (opts.method === 'POST') { posted++; return { status: 200, data: { _id: `cloud-${posted}` } }; }
    return { status: 200, data: [] }; // GET list = empty
  });
  loadWorker(mock, fetch3);
  mock.state.local.orbi_settings = { ...syncOn };
  mock.state.local.token = 'jwt';
  mock.state.local.orbi_sessions = [
    localDoc('live1', { name: 'Live One' }),
    localDoc('live2', { name: 'Live Two' }),
    localDoc('auto', { name: 'Auto-save — Live Backup', isAutoSave: true, autoKey: 'live-backup' }),
    localDoc('trash', { name: 'Trashed', deletedAt: '2026-10-10T10:00:00.000Z' }),
  ];
  const r = await sendMessage(mock, { type: 'SYNC_NOW' });
  const lib = r?.result?.library || {};
  ok('exactly 2 sessions pushed (trash + Live Backup excluded)',
    lib.pushed === 2 && posted === 2, JSON.stringify({ lib, posted }));
  const bodies = fetch3.calls.filter(c => c.method === 'POST').map(c => c.body);
  ok('push payloads carry name + windows (v1)', bodies.every(b => b.name && Array.isArray(b.windows)), JSON.stringify(bodies));
  const docs = mock.state.local.orbi_sessions;
  ok('cloudId remembered on pushed docs for future updates',
    docs.filter(d => d.cloudId).length === 2, JSON.stringify(docs.map(d => [d._id, d.cloudId])));
  ok('orbi_sync_status recorded (pushed=2, no error)',
    mock.state.local.orbi_sync_status?.pushed === 2 && mock.state.local.orbi_sync_status?.lastError === null,
    JSON.stringify(mock.state.local.orbi_sync_status));
}

console.log('── A4: pull (additive, deduped, autosave skipped) ──');
{
  const mock = createChromeMock();
  const fetch4 = makeFetch((path) => {
    if (path === '/api/sessions') {
      return { status: 200, data: [
        cloudDoc('cx', { name: 'From Cloud', createdAt: '2026-09-02T12:00:00.000Z' }),
        cloudDoc('ca', { name: 'Auto-save — Live Backup', isAutoSave: true }),      // server autosave → skip
        cloudDoc('cdup', { name: 'Same Name', createdAt: '2026-10-01T10:00:00.000Z' }), // dup of local signature → skip
      ] };
    }
    return { status: 200, data: { _id: 'new' } };
  });
  loadWorker(mock, fetch4);
  mock.state.local.orbi_settings = { ...syncOn };
  mock.state.local.token = 'jwt';
  mock.state.local.orbi_sessions = [localDoc('localA', { name: 'Same Name' })];
  const r = await sendMessage(mock, { type: 'SYNC_NOW' });
  const lib = r?.result?.library || {};
  ok('one cloud session pulled in', lib.pulled === 1, JSON.stringify(lib));
  const list = mock.state.local.orbi_sessions;
  ok('pulled doc carries cloudId + local id', list.some(d => d.cloudId === 'cx' && String(d._id).startsWith('local-')), JSON.stringify(list.map(d => [d._id, d.cloudId])));
  ok('server autosave doc NOT imported', !list.some(d => d.name === 'Auto-save — Live Backup' && d.cloudId === 'ca'), JSON.stringify(list.map(d => d.name)));
  ok('duplicate signature NOT re-imported', list.filter(d => d.name === 'Same Name').length === 1, JSON.stringify(list.map(d => d.name)));

  // Second run → full dedupe (nothing new anywhere)
  const r2 = await sendMessage(mock, { type: 'SYNC_NOW' });
  const lib2 = r2?.result?.library || {};
  ok('second sync is a no-op (pulled=0, pushed=0)', lib2.pulled === 0 && lib2.pushed === 0, JSON.stringify(lib2));
  ok('session list did not grow on re-sync', mock.state.local.orbi_sessions.length === list.length);
}

console.log('── A5: last-write-wins both directions ──');
{
  // (a) newer LOCAL → PUT to the server
  const mockA = createChromeMock();
  const fetchA = makeFetch((path, opts) => {
    if (opts.method === 'PUT') return { status: 200, data: { _id: 'c9', name: 'Renamed locally' } };
    if (path === '/api/sessions') {
      return { status: 200, data: [cloudDoc('c9', { name: 'Old name', updatedAt: '2026-09-01T00:00:00.000Z' })] };
    }
    return { status: 200, data: {} };
  });
  loadWorker(mockA, fetchA);
  mockA.state.local.orbi_settings = { ...syncOn };
  mockA.state.local.token = 'jwt';
  mockA.state.local.orbi_sessions = [localDoc('L9', {
    name: 'Renamed locally', cloudId: 'c9',
    createdAt: '2026-09-01T00:00:00.000Z', // same signature as cloud doc
    updatedAt: '2026-10-14T09:00:00.000Z', // newer than server
  })];
  const rA = await sendMessage(mockA, { type: 'SYNC_NOW' });
  ok('newer local copy → PUT issued (updated=1)', (rA?.result?.library?.updated === 1) && fetchA.calls.some(c => c.method === 'PUT'), JSON.stringify({ r: rA?.result?.library, calls: fetchA.calls.map(c => c.method + ' ' + c.url) }));

  // (b) newer CLOUD → adopted locally, no PUT
  const mockB = createChromeMock();
  const fetchB = makeFetch((path) => {
    if (path === '/api/sessions') {
      return { status: 200, data: [cloudDoc('c8', { name: 'Cloud newer name', updatedAt: '2026-10-14T08:00:00.000Z' })] };
    }
    return { status: 200, data: {} };
  });
  loadWorker(mockB, fetchB);
  mockB.state.local.orbi_settings = { ...syncOn };
  mockB.state.local.token = 'jwt';
  mockB.state.local.orbi_sessions = [localDoc('L8', {
    name: 'Local old name', cloudId: 'c8',
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z', // older than server
  })];
  const rB = await sendMessage(mockB, { type: 'SYNC_NOW' });
  ok('newer cloud copy adopted locally (no PUT)', (rB?.result?.library?.updated === 1) && !fetchB.calls.some(c => c.method === 'PUT'), JSON.stringify(rB?.result?.library));
  ok('local doc now carries the cloud name', mockB.state.local.orbi_sessions.some(d => d.name === 'Cloud newer name'), JSON.stringify(mockB.state.local.orbi_sessions.map(d => d.name)));
}

console.log('── A6: dead backend skips cleanly + honest status ──');
{
  const mock = createChromeMock();
  const fetch6 = makeFetch(() => 'throw');
  loadWorker(mock, fetch6);
  mock.state.local.orbi_settings = { ...syncOn };
  mock.state.local.token = 'jwt';
  mock.state.local.orbi_sessions = [localDoc('keep1'), localDoc('keep2')];
  const r = await sendMessage(mock, { type: 'SYNC_NOW' });
  ok('library skipped backend-unreachable (no throw, no hang)', r?.result?.library?.skipped === 'backend-unreachable', JSON.stringify(r?.result));
  ok('local sessions untouched', mock.state.local.orbi_sessions.length === 2, JSON.stringify(mock.state.local.orbi_sessions.map(d => d._id)));
  ok('status records the failure honestly', mock.state.local.orbi_sync_status?.lastError === 'backend-unreachable', JSON.stringify(mock.state.local.orbi_sync_status));
}

console.log('── A7/A8: status contract + SYNC_NOW legacy shape ──');
{
  const mock = createChromeMock();
  const fetch8 = makeFetch((path, opts) => {
    if (opts.method === 'POST') return { status: 200, data: { _id: 'c1' } };
    return { status: 200, data: [] };
  });
  loadWorker(mock, fetch8);
  mock.state.local.orbi_settings = { ...syncOn };
  mock.state.local.token = 'jwt';
  mock.state.local.orbi_sessions = [localDoc('s1')];
  const r = await sendMessage(mock, { type: 'SYNC_NOW' });
  const st = mock.state.local.orbi_sync_status || {};
  ok('status shape: lastSyncAt + counts + lastError fields present',
    typeof st.lastSyncAt === 'number' && typeof st.pushed === 'number' && typeof st.updated === 'number' && typeof st.pulled === 'number' && 'lastError' in st,
    JSON.stringify(st));
  ok('SYNC_NOW nests the library result under result.library', !!r?.result?.library, JSON.stringify(r?.result));
}

/* ================================================================== *
 * A9. 🔄 Deletion propagation (tombstones in + out) — the A1 fix:
 * a trash here reaches every device, a restore un-trashes them, and a
 * local edit NEWER than the delete survives instead of dying.
 * ================================================================== */
console.log('\n═══ A9. Deletion propagation (tombstones) ═══\n');
{
  // (a) local trash with a cloudId → DELETE pushed to the server
  const mock = createChromeMock();
  const f = makeFetch((path, opts) => {
    if (opts.method === 'DELETE') return { status: 200, data: { message: 'Session deleted (undoable)' } };
    if (path === '/api/sessions/tombstones') return { status: 200, data: [] };
    if (path === '/api/sessions') {
      return { status: 200, data: [cloudDoc('c1', { name: 'Deleted locally', updatedAt: '2026-10-01T00:00:00.000Z' })] };
    }
    return { status: 200, data: {} };
  });
  loadWorker(mock, f);
  mock.state.local.orbi_settings = { ...syncOn };
  mock.state.local.token = 'jwt';
  mock.state.local.orbi_sessions = [localDoc('d1', {
    name: 'Deleted locally', cloudId: 'c1',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: '2026-10-14T09:00:00.000Z', // the popup's trash action
  })];
  const r = await sendMessage(mock, { type: 'SYNC_NOW' });
  ok('local trash with a cloudId → DELETE issued (deleted=1)',
    r?.result?.library?.deleted === 1 && f.calls.some(c => c.method === 'DELETE' && c.url.includes('/api/sessions/c1')),
    JSON.stringify(f.calls.map(c => `${c.method} ${c.url}`)));
  ok('push-side delete recorded in the honest status',
    mock.state.local.orbi_sync_status?.deleted === 1 && mock.state.local.orbi_sync_status?.lastError === null,
    JSON.stringify(mock.state.local.orbi_sync_status));

  // (b) server tombstone → local copy moves to THIS device's trash (idempotent)
  const mock2 = createChromeMock();
  const f2 = makeFetch((path) => {
    if (path === '/api/sessions/tombstones') return { status: 200, data: [{ _id: 'c2', deletedAt: '2026-10-14T10:00:00.000Z' }] };
    if (path === '/api/sessions') return { status: 200, data: [] }; // soft-deleted rows never list
    return { status: 200, data: {} };
  });
  loadWorker(mock2, f2);
  mock2.state.local.orbi_settings = { ...syncOn };
  mock2.state.local.token = 'jwt';
  mock2.state.local.orbi_sessions = [localDoc('d2', {
    name: 'Deleted elsewhere', cloudId: 'c2',
    updatedAt: '2026-10-01T00:00:00.000Z',
  })];
  const r2 = await sendMessage(mock2, { type: 'SYNC_NOW' });
  ok('cloud tombstone trashes the local copy (deleted=1)',
    r2?.result?.library?.deleted === 1 && !!mock2.state.local.orbi_sessions[0].deletedAt,
    JSON.stringify({ lib: r2?.result?.library, doc: mock2.state.local.orbi_sessions[0] }));
  ok('no resurrection attempt (no POST/PUT after the tombstone)',
    !f2.calls.some(c => c.method === 'POST' || c.method === 'PUT'),
    JSON.stringify(f2.calls.map(c => `${c.method} ${c.url}`)));
  const r2b = await sendMessage(mock2, { type: 'SYNC_NOW' });
  ok('re-sync with the tombstone still there is a no-op',
    r2b?.result?.library?.deleted === 0 && r2b?.result?.library?.pulled === 0,
    JSON.stringify(r2b?.result?.library));

  // (c) cloud copy live AGAIN (restored elsewhere) + newer stamp → un-trash here
  const mock3 = createChromeMock();
  const f3 = makeFetch((path) => {
    if (path === '/api/sessions/tombstones') return { status: 200, data: [] }; // lifted on restore
    if (path === '/api/sessions') {
      return { status: 200, data: [cloudDoc('c3', { name: 'Restored elsewhere', updatedAt: '2026-10-14T12:00:00.000Z' })] };
    }
    return { status: 200, data: {} };
  });
  loadWorker(mock3, f3);
  mock3.state.local.orbi_settings = { ...syncOn };
  mock3.state.local.token = 'jwt';
  mock3.state.local.orbi_sessions = [localDoc('d3', {
    name: 'Restored elsewhere', cloudId: 'c3',
    deletedAt: '2026-10-14T09:00:00.000Z', // deleted here BEFORE the restore
    updatedAt: '2026-10-01T00:00:00.000Z',
  })];
  const r3 = await sendMessage(mock3, { type: 'SYNC_NOW' });
  ok('server restore un-trashes the local copy (restored=1)',
    r3?.result?.library?.restored === 1 && !mock3.state.local.orbi_sessions[0].deletedAt,
    JSON.stringify({ lib: r3?.result?.library, doc: mock3.state.local.orbi_sessions[0] }));
  ok('restore adopted the server stamp (no churn next sync)',
    mock3.state.local.orbi_sessions[0].updatedAt === '2026-10-14T12:00:00.000Z',
    JSON.stringify(mock3.state.local.orbi_sessions[0].updatedAt));

  // (d) local restore → stamp is NEWER than the tombstone (store.js bumps
  // updatedAt on restore) → LWW PUT revives the server row instead.
  const mock4 = createChromeMock();
  const f4 = makeFetch((path, opts) => {
    if (path === '/api/sessions/tombstones') return { status: 200, data: [{ _id: 'c4', deletedAt: '2026-10-14T09:00:00.000Z' }] };
    if (opts.method === 'PUT') return { status: 200, data: { _id: 'c4', name: 'Session d4', updatedAt: '2026-10-14T11:00:00.000Z' } };
    if (path === '/api/sessions') return { status: 200, data: [] }; // still trashed server-side
    return { status: 200, data: {} };
  });
  loadWorker(mock4, f4);
  mock4.state.local.orbi_settings = { ...syncOn };
  mock4.state.local.token = 'jwt';
  mock4.state.local.orbi_sessions = [localDoc('d4', {
    name: 'Session d4', cloudId: 'c4',
    deletedAt: null,                                        // user restored it here
    updatedAt: '2026-10-14T10:00:00.000Z',                  // store.js bumps on restore
  })];
  const r4 = await sendMessage(mock4, { type: 'SYNC_NOW' });
  ok('local restore (newer stamp) revives via LWW PUT — not re-trashed',
    r4?.result?.library?.deleted === 0 && mock4.state.local.orbi_sessions[0].deletedAt === null &&
      f4.calls.some(c => c.method === 'PUT' && c.url.includes('/api/sessions/c4')),
    JSON.stringify({ lib: r4?.result?.library, calls: f4.calls.map(c => `${c.method} ${c.url}`) }));
  ok('revive adopted the server stamp (no churn next sync)',
    mock4.state.local.orbi_sessions[0].updatedAt === '2026-10-14T11:00:00.000Z',
    JSON.stringify(mock4.state.local.orbi_sessions[0].updatedAt));

  // (e) purged row (404 on the revive PUT) → the newer edit is SAVED under a
  // fresh id instead of looping forever; the old id's tombstone stands.
  const mock5 = createChromeMock();
  const f5 = makeFetch((path, opts) => {
    if (path === '/api/sessions/tombstones') return { status: 200, data: [{ _id: 'c5', deletedAt: '2026-10-14T09:00:00.000Z' }] };
    if (opts.method === 'PUT') return { status: 404, data: { error: 'Session not found' } }; // purged server-side
    if (opts.method === 'POST' && path === '/api/sessions') {
      return { status: 200, data: { _id: 'c5-fresh', updatedAt: '2026-10-14T10:30:00.000Z' } };
    }
    if (path === '/api/sessions') return { status: 200, data: [] };
    return { status: 200, data: {} };
  });
  loadWorker(mock5, f5);
  mock5.state.local.orbi_settings = { ...syncOn };
  mock5.state.local.token = 'jwt';
  mock5.state.local.orbi_sessions = [localDoc('d5', {
    name: 'Newer than the purge', cloudId: 'c5',
    deletedAt: null,
    updatedAt: '2026-10-14T10:00:00.000Z', // edit AFTER the delete → wins
  })];
  const r5 = await sendMessage(mock5, { type: 'SYNC_NOW' });
  ok('404 on revive → edit recreated under a fresh id (pushed=1, no data loss)',
    r5?.result?.library?.pushed === 1 && mock5.state.local.orbi_sessions[0].cloudId === 'c5-fresh' &&
      f5.calls.some(c => c.method === 'PUT') && f5.calls.some(c => c.method === 'POST'),
    JSON.stringify({ lib: r5?.result?.library, cloudId: mock5.state.local.orbi_sessions[0].cloudId, calls: f5.calls.map(c => `${c.method} ${c.url}`) }));
}

/* ================================================================== *
 * B. Store quota errors
 * ================================================================== */
console.log('\n═══ B. Store quota errors ═══\n');
{
  const vite = await import('vite');
  const server = await vite.createServer({
    root, configFile: false, plugins: [], optimizeDeps: { disabled: true },
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
  });

  // chrome.storage.local.set throws a quota error (full disk)
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => { const e = new Error('QUOTA_BYTES quota exceeded'); e.name = 'QuotaExceededError'; throw e; },
        remove: async () => {},
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    runtime: { sendMessage: async () => ({ ok: false }), onMessage: { addListener() {} }, lastError: null },
  };
  const store = await server.ssrLoadModule('/src/services/store.js');
  let threw = null;
  try {
    await store.createSession({ name: 'Quota test', windows: WIN1 });
  } catch (e) { threw = e; }
  ok('B1: quota failure rejects (never a silent no-op)', !!threw, 'createSession resolved');
  ok('B1: error text is actionable (mentions storage full + export)',
    /storage is full/i.test(threw?.message || '') && /export/i.test(threw?.message || ''), threw?.message);
  ok('B1: error tagged as quota for programmatic handling', threw?.quota === true);

  // Non-quota storage failure keeps the raw reason visible
  globalThis.chrome.storage.local.set = async () => { throw new Error('backend broke'); };
  let threw2 = null;
  try { await store.createSession({ name: 'Other error', windows: WIN1 }); } catch (e) { threw2 = e; }
  ok('B1: non-quota storage failure surfaces the real message',
    /backend broke/.test(threw2?.message || ''), threw2?.message);

  await server.close();
}

/* ================================================================== *
 * C. Login UI — forgot password
 * ================================================================== */
console.log('\n═══ C. Login UI: password recovery ═══\n');
{
  const vite = await import('vite');
  const server = await vite.createServer({
    root, configFile: false, plugins: [], optimizeDeps: { disabled: true },
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
  });

  // Real HTTP server on the dev origin (api.js default) — exercises the REAL
  // axios instance, the request interceptor, and URL resolution end to end.
  const http = require('http');
  const apiCalls = [];
  const apiServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      apiCalls.push({ url: req.url, method: req.method });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/auth/forgot-password' && req.method === 'POST') {
        res.end(JSON.stringify({ message: 'If that email has an account, a reset link is on its way.' }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    apiServer.once('error', reject);
    apiServer.listen(5000, '127.0.0.1', resolve);
  });

  // chrome present but NOT store-installed + no apiBaseUrl → dev default origin
  globalThis.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } },
    runtime: { sendMessage: async () => ({ ok: false }), onMessage: { addListener() {} }, lastError: null },
  };

  const { default: LoginPage } = await server.ssrLoadModule('/src/popup/pages/Login.jsx');
  const React = require('react');
  const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
  const act = (fn) => require('react-dom/test-utils').act(fn);
  const fire = (el, type) => el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, view: dom.window }));
  const typeInto = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };

  const container = dom.window.document.getElementById('root');
  container.innerHTML = '';
  const rootEl = require('react-dom/client').createRoot(container);
  await act(async () => { rootEl.render(React.createElement(LoginPage, { onLogin: () => {}, onCancel: () => {} })); });
  await tick(120);

  ok('C1: login form shows "Forgot password?"', document.body.textContent.includes('Forgot password?'));
  ok('C1: no reset prompt before clicking', !document.body.textContent.includes('Send reset link'));

  const forgotBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Forgot password?');
  await act(async () => { fire(forgotBtn, 'click'); });
  await tick(80);
  ok('C2: reset view renders email-only form', document.body.textContent.includes('Send reset link') && document.body.textContent.includes('Reset your password'));
  ok('C2: password field hidden in reset view', !document.querySelector('input[type="password"]'));
  ok('C2: back link present', document.body.textContent.includes('Back to login'));

  const emailInput = document.querySelector('input[type="email"]');
  await act(async () => { typeInto(emailInput, 'user@example.com'); });
  await tick(40);
  const form = document.querySelector('form');
  await act(async () => { form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); });
  await tick(150);
  ok('C2: forgot-password request sent', apiCalls.some(c => c.url === '/api/auth/forgot-password' && c.method === 'POST'), JSON.stringify(apiCalls));
  ok('C2: generic server message shown (no enumeration)',
    document.body.textContent.includes('If that email has an account, a reset link is on its way.'));

  // Back link restores the login form
  const backBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '← Back to login');
  await act(async () => { fire(backBtn, 'click'); });
  await tick(80);
  ok('C2: back returns to the login form (password field back)', !!document.querySelector('input[type="password"]'));

  apiServer.close();
  await server.close();
}

console.log(`\n════════════════════════════════════════════════`);
console.log(`  CLOUD SYNC + ACCOUNT UX: ${pass} passed, ${fail} failed`);
console.log(`  VERDICT: ${fail === 0 ? '✅ FULL SYNC WIRED' : '❌ BROKEN — see failures above'}`);
console.log(`════════════════════════════════════════════════\n`);
process.exit(fail > 0 ? 1 : 0);
