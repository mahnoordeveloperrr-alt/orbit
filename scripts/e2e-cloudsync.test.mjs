// ============================================================================
// E2E CLOUD SYNC — the JOIN proof: the REAL service worker (public/background.js)
// talking over REAL HTTP to the REAL backend (tab-saver-backend/server.js)
// backed by a REAL MongoDB (memory server, same code path as Atlas).
//
// cloudsync.test.mjs proves the worker logic (mocked fetch) and
// sync-account.test.mjs proves the API surface — this suite proves the two
// halves actually work together, including the checklist's headline ask:
// "device A uploads → device B downloads", plus last-write-wins renames.
//
// Run: node scripts/e2e-cloudsync.test.mjs
//
//   D1  account seeded → login returns a JWT
//   D2  Device A pushes its live library (trash + Live Backup excluded)
//   D3  Device A rename → PUT → server copy updated (LWW)
//   D4  Device B (empty store) pulls the library; second sync is a no-op
//   D5  Device B's newer edit wins on the server
//   D7  deletion propagation + plan/quota + refresh rotation (A1/A2/A3)
//   D8  billing webhook + version history + share claim (B2/B5/B7)
//   D6  honest sync status written on both devices
// ============================================================================

import vm from 'node:vm';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { spawn } from 'child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const backendDir = join(root, 'tab-saver-backend');
const workerCode = readFileSync(join(root, 'public/background.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- real backend: memory mongo + server.js ---------------- */
console.log('\n── 0. BOOT: real backend + real MongoDB ──');
process.env.MONGOMS_DOWNLOAD_DIR =
  process.env.MONGOMS_DOWNLOAD_DIR || join(backendDir, 'node_modules', '.cache', 'mongodb-binaries');
const backendReq = createRequire(join(backendDir, 'package.json'));
const { MongoMemoryServer } = backendReq('mongodb-memory-server');
const mongod = await MongoMemoryServer.create();
const mongoUri = mongod.getUri();

const PORT = 5096;
const server = spawn('node', ['server.js'], {
  cwd: backendDir,
  env: { ...process.env, MONGO_URI: mongoUri, JWT_SECRET: 'e2e-sync-secret', PORT: String(PORT),
    // Small free-tier cap so D7 can prove server-side quota enforcement cheaply
    FREE_SESSION_LIMIT: '4',
    // D8 signs its Lemon Squeezy webhook payloads with this (no LS API key →
    // billing stays honestly 'not configured', which D8 also proves)
    LEMONSQUEEZY_WEBHOOK_SECRET: 'cloudsync-wsec' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', d => (serverLog += d));
server.stderr.on('data', d => (serverLog += d));
for (let i = 0; i < 80 && !serverLog.includes('Server running on port'); i++) await sleep(250);
if (!serverLog.includes('Server running on port')) {
  console.error(serverLog); process.exit(1);
}
ok('real backend running against a real MongoDB', true);

const BASE = `http://127.0.0.1:${PORT}`;
const api = (path, opts = {}) => fetch(`${BASE}${path}`, opts);
const json = (h = {}) => ({ ...h, 'Content-Type': 'application/json' });

const mongoose = backendReq('mongoose');
await mongoose.connect(mongoUri);
const User = backendReq(join(backendDir, 'models', 'User'));
const Session = backendReq(join(backendDir, 'models', 'Session'));

/* ---------------- minimal chrome mock (device) ---------------- */
function createDevice() {
  const state = { local: {}, messageListener: null };
  const chrome = {
    commands: { onCommand: { addListener() {} } },
    windows: {
      onCreated: { addListener() {} }, onRemoved: { addListener() {} },
      async getAll() { return []; }, async getCurrent() { return null; },
    },
    tabs: {
      onCreated: { addListener() {} }, onRemoved: { addListener() {} }, onMoved: { addListener() {} },
      onAttached: { addListener() {} }, onDetached: { addListener() {} }, onReplaced: { addListener() {} }, onUpdated: { addListener() {} },
      async create() { throw new Error('not needed'); }, async query() { return []; },
      async update() {}, async group() { return 1; }, async ungroup() {},
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
      session: { async get() { return {}; }, async set() {} },
      onChanged: { addListener() {} },
    },
    alarms: { create() {}, clear() {}, async getAll() { return []; }, onAlarm: { addListener() {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    runtime: {
      onMessage: { addListener(cb) { state.messageListener = cb; } },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      async sendMessage() { return { ok: false }; },
    },
  };
  return { chrome, state };
}

const loadDevice = (device) => {
  const sandbox = {
    chrome: device.chrome, console, setTimeout, clearTimeout, Date, JSON,
    AbortSignal, URL,
    fetch: (...args) => fetch(...args), // REAL network
  };
  vm.createContext(sandbox);
  vm.runInContext(workerCode, sandbox, { filename: 'background.js' });
};

async function syncNow(device) {
  let response = null;
  device.state.messageListener({ type: 'SYNC_NOW' }, {}, (r) => { response = r; });
  for (let i = 0; i < 300 && response === null; i++) await sleep(20);
  return response;
}

const WIN = (url) => [{ state: 'normal', focused: true, tabs: [{ url, title: url, pinned: false, active: true, groupId: null }], groups: [] }];
const localDoc = (id, name, over = {}) => ({
  _id: id, name, windows: WIN(`https://${id}.example`), schemaVersion: 1,
  isAutoSave: false, autoKey: null, deletedAt: null,
  // 🆕 V1.5 metadata defaults — beta's doc below carries real values
  tags: [], note: '', folder: null,
  createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
});

/* ---------------- D1: account + login ---------------- */
console.log('\n── D1. Account + JWT ──');
const email = 'e2e-sync@example.com';
await User.deleteMany({ email });
await Session.deleteMany({ userId: { $exists: true } });
await User.create({ name: 'E2E', email, password: 'E2eSyncPass123!', isVerified: true });
const login = await (await api('/api/auth/login', {
  method: 'POST', headers: json(),
  body: JSON.stringify({ email, password: 'E2eSyncPass123!' }),
})).json();
ok('login returns a JWT', !!login.token, JSON.stringify(login).slice(0, 120));
const settings = { cloudSync: true, localOnly: false, autoSave: true, apiBaseUrl: BASE };

/* ---------------- D2: Device A pushes ---------------- */
console.log('\n── D2. Device A: push the library ──');
const deviceA = createDevice();
loadDevice(deviceA);
deviceA.state.local.orbi_settings = settings;
deviceA.state.local.token = login.token;
deviceA.state.local.orbi_sessions = [
  localDoc('alpha', 'Alpha project'),
  // 🆕 V1.5: beta carries metadata — the E2E proof that tags/note/folder
  // survive device A → real server → real mongo → device B unchanged.
  localDoc('beta', 'Beta research', { tags: ['research', 'q4'], note: 'sources for the report', folder: 'Work' }),
  localDoc('auto', 'Auto-save — Live Backup', { isAutoSave: true, autoKey: 'live-backup' }),
  localDoc('gone', 'Trashed session', { deletedAt: '2026-10-12T00:00:00.000Z' }),
];
const rA = await syncNow(deviceA);
ok('SYNC_NOW ok (real HTTP, real mongo)', rA?.ok === true, JSON.stringify(rA).slice(0, 200));
ok('library pushed=2 (trash + Live Backup excluded)',
  rA?.result?.library?.pushed === 2, JSON.stringify(rA?.result));
const inDb = await Session.find({}).lean();
ok('server holds exactly the 2 live sessions', inDb.length === 2 && inDb.every(s => ['Alpha project', 'Beta research'].includes(s.name)), JSON.stringify(inDb.map(s => s.name)));
ok('server docs carry v1 windows + updatedAt', inDb.every(s => Array.isArray(s.windows) && s.windows.length === 1 && !!s.updatedAt));
{
  // 🆕 V1.5 metadata round-trip through the REAL server + REAL mongo
  const betaSrv = inDb.find(s => s.name === 'Beta research');
  ok('server stored the metadata (tags/note/folder)',
    betaSrv && JSON.stringify(betaSrv.tags) === '["research","q4"]' && betaSrv.note === 'sources for the report' && betaSrv.folder === 'Work',
    JSON.stringify(betaSrv && { tags: betaSrv.tags, note: betaSrv.note, folder: betaSrv.folder }));
  const oldClient = await fetch(`${BASE}/api/sessions`, { method: 'GET', headers: json({ Authorization: `Bearer ${login.token}` }) }).then(r => r.json());
  const betaListed = Array.isArray(oldClient) && oldClient.find(s => s.name === 'Beta research');
  ok('GET list returns the metadata to any device',
    betaListed && Array.isArray(betaListed.tags) && betaListed.note === 'sources for the report' && betaListed.folder === 'Work',
    JSON.stringify(betaListed && { tags: betaListed.tags, folder: betaListed.folder }));
}
ok('device A status honest (pushed=2, no error)',
  deviceA.state.local.orbi_sync_status?.pushed === 2 && deviceA.state.local.orbi_sync_status?.lastError === null,
  JSON.stringify(deviceA.state.local.orbi_sync_status));

/* ---------------- D3: rename on A → PUT → server updated ---------------- */
console.log('\n── D3. Device A: rename → LWW PUT ──');
{
  const doc = deviceA.state.local.orbi_sessions.find(s => s.name === 'Alpha project');
  doc.name = 'Alpha project (renamed)';
  doc.updatedAt = new Date().toISOString(); // newer than server copy
  const r = await syncNow(deviceA);
  ok('rename synced to the server (updated=1)', r?.result?.library?.updated === 1, JSON.stringify(r?.result?.library));
  const srv = await Session.find({ name: 'Alpha project (renamed)' }).lean();
  ok('server copy now has the new name', srv.length === 1, JSON.stringify((await Session.find({}).lean()).map(s => s.name)));
}

/* ---------------- D4: Device B pulls ---------------- */
console.log('\n── D4. Device B: fresh device pulls everything ──');
const deviceB = createDevice();
loadDevice(deviceB);
deviceB.state.local.orbi_settings = settings;
deviceB.state.local.token = login.token;
deviceB.state.local.orbi_sessions = []; // empty store = new device
const rB = await syncNow(deviceB);
ok('Device B pulled both sessions', rB?.result?.library?.pulled === 2, JSON.stringify(rB?.result?.library));
const bList = deviceB.state.local.orbi_sessions;
ok('pulled docs are restorable v1 (windows + names)',
  bList.length === 2 && bList.every(s => Array.isArray(s.windows) && s.windows[0].tabs[0].url.includes('.example')),
  JSON.stringify(bList.map(s => [s.name, s.windows?.length])));
ok('pulled docs remember their cloudId', bList.every(s => !!s.cloudId), JSON.stringify(bList.map(s => s.cloudId)));
ok('renamed session arrives with the NEW name', bList.some(s => s.name === 'Alpha project (renamed)'));
{
  // 🆕 V1.5: device B's pulled copy keeps the metadata byte-for-byte
  const betaB = bList.find(s => s.name === 'Beta research');
  ok('device B pulled the metadata intact',
    betaB && JSON.stringify(betaB.tags) === '["research","q4"]' && betaB.note === 'sources for the report' && betaB.folder === 'Work',
    JSON.stringify(betaB && { tags: betaB.tags, note: betaB.note, folder: betaB.folder }));
}
const rB2 = await syncNow(deviceB);
ok('Device B second sync is a no-op (0 pushed / 0 pulled)',
  rB2?.result?.library?.pushed === 0 && rB2?.result?.library?.pulled === 0, JSON.stringify(rB2?.result?.library));
ok('Device B store did not grow on re-sync', deviceB.state.local.orbi_sessions.length === 2);

/* ---------------- D5: B's newer edit wins ---------------- */
console.log('\n── D5. Device B: newer edit wins on the server ──');
{
  const doc = deviceB.state.local.orbi_sessions.find(s => s.name === 'Beta research');
  doc.name = 'Beta research (from B)';
  // 🆕 V1.5: the same LWW PUT also updates metadata (edit from the second device)
  doc.tags = ['research', 'from-b'];
  doc.note = 'edited on device B';
  doc.folder = 'Work/2026';
  doc.updatedAt = new Date(Date.now() + 1000).toISOString(); // strictly newer
  await syncNow(deviceB);
  const srv = await Session.find({ name: 'Beta research (from B)' }).lean();
  ok('server adopted Device B\'s newer copy', srv.length === 1, JSON.stringify((await Session.find({}).lean()).map(s => s.name)));
  ok('LWW PUT updated the metadata on the server',
    srv[0] && JSON.stringify(srv[0].tags) === '["research","from-b"]' && srv[0].note === 'edited on device B' && srv[0].folder === 'Work/2026',
    JSON.stringify(srv[0] && { tags: srv[0].tags, note: srv[0].note, folder: srv[0].folder }));
  // A syncs again → adopts B's rename (pull-side LWW)
  await syncNow(deviceA);
  ok('Device A picked up B\'s rename on its next sync',
    deviceA.state.local.orbi_sessions.some(s => s.name === 'Beta research (from B)'),
    JSON.stringify(deviceA.state.local.orbi_sessions.map(s => s.name)));
  // 🆕 V1.5: device A's adopted copy carries B's metadata too (LWW branch)
  const betaA = deviceA.state.local.orbi_sessions.find(s => s.name === 'Beta research (from B)');
  ok('Device A adopted B\'s metadata with the rename (LWW branch)',
    betaA && JSON.stringify(betaA.tags) === '["research","from-b"]' && betaA.note === 'edited on device B' && betaA.folder === 'Work/2026',
    JSON.stringify(betaA && { tags: betaA.tags, note: betaA.note, folder: betaA.folder }));
}

/* ---------------- D7: deletion propagation + plan/quota + refresh (A1/A2/A3) ---------------- */
console.log('\n── D7. Tombstones round-trip, server-enforced quota, refresh rotation ──');
{
  const authH = () => json({ Authorization: `Bearer ${login.token}` });

  // (1) server-side delete → tombstone → BOTH devices trash their copies
  const srv = await Session.find({}).lean();
  const beta = srv.find(s => s.name === 'Beta research (from B)');
  ok('fixture: beta live on the server', !!beta, JSON.stringify(srv.map(s => s.name)));
  const del = await api(`/api/sessions/${beta._id}`, { method: 'DELETE', headers: authH() });
  ok('Express DELETE answers 200', del.status === 200, String(del.status));
  const tb = await (await api('/api/sessions/tombstones', { headers: authH() })).json();
  ok('Express GET /tombstones lists the delete',
    Array.isArray(tb) && tb.some(t => String(t._id) === String(beta._id) && t.deletedAt), JSON.stringify(tb));

  await syncNow(deviceA);
  const aBeta = deviceA.state.local.orbi_sessions.find(s => s.name === 'Beta research (from B)');
  ok('Device A moved it to ITS trash', !!aBeta?.deletedAt, JSON.stringify(aBeta && { deletedAt: aBeta.deletedAt }));
  await syncNow(deviceB);
  const bBeta = deviceB.state.local.orbi_sessions.find(s => s.name === 'Beta research (from B)');
  ok('Device B moved it to ITS trash too', !!bBeta?.deletedAt, JSON.stringify(bBeta && { deletedAt: bBeta.deletedAt }));
  const again = await syncNow(deviceB);
  ok('re-sync after the tombstone is a no-op (no churn)',
    again?.result?.library?.deleted === 0 && again?.result?.library?.pulled === 0,
    JSON.stringify(again?.result?.library));

  // (2) LOCAL delete on A → server → B
  const alphaLocal = deviceA.state.local.orbi_sessions.find(s => s.name === 'Alpha project (renamed)');
  ok('fixture: Device A holds alpha with a cloudId', !!alphaLocal?.cloudId,
    JSON.stringify(alphaLocal && { name: alphaLocal.name, cloudId: alphaLocal.cloudId }));
  alphaLocal.deletedAt = new Date().toISOString(); // the popup's trash action
  const rA = await syncNow(deviceA);
  ok('Device A pushed its local delete (deleted>=1, no error)',
    (rA?.result?.library?.deleted || 0) >= 1 && deviceA.state.local.orbi_sync_status?.lastError === null,
    JSON.stringify(rA?.result?.library));
  const trashNow = await (await api('/api/sessions/trash', { headers: authH() })).json();
  ok('alpha landed in server trash',
    trashNow.some(s => String(s._id) === String(alphaLocal.cloudId)), JSON.stringify(trashNow.map(s => s.name)));
  await syncNow(deviceB);
  const bAlpha = deviceB.state.local.orbi_sessions.find(s => s.cloudId === alphaLocal.cloudId);
  ok('Device B trashed alpha from the tombstone', !!bAlpha?.deletedAt, JSON.stringify(bAlpha && { deletedAt: bAlpha.deletedAt }));

  // (3) restore server-side → BOTH devices un-trash
  const rr = await api(`/api/sessions/${alphaLocal.cloudId}/restore`, { method: 'POST', headers: authH() });
  ok('server restore returns it to live', rr.status === 200, String(rr.status));
  await syncNow(deviceA);
  ok('Device A un-trashed alpha (restored>=1)',
    !deviceA.state.local.orbi_sessions.find(s => s.cloudId === alphaLocal.cloudId)?.deletedAt &&
      (deviceA.state.local.orbi_sync_status?.restored || 0) >= 1,
    JSON.stringify(deviceA.state.local.orbi_sync_status));
  await syncNow(deviceB);
  ok('Device B un-trashed alpha too',
    !deviceB.state.local.orbi_sessions.find(s => s.cloudId === alphaLocal.cloudId)?.deletedAt,
    JSON.stringify(deviceB.state.local.orbi_sync_status));

  // (4) plan + server-enforced free-tier quota (Express path)
  const pl = await (await api('/api/me/plan', { headers: authH() })).json();
  ok('GET /api/me/plan → free + enforced limit + usage',
    pl.plan === 'free' && pl.limits?.maxSyncedSessions === 4 && typeof pl.usage?.syncedSessions === 'number',
    JSON.stringify(pl));
  let over = null, created = 0;
  for (let i = 0; i < 8; i++) {
    const r = await api('/api/sessions', {
      method: 'POST', headers: authH(),
      body: JSON.stringify({ name: `quota-${i}`, windows: WIN(`https://q${i}.example`) }),
    });
    if (r.status === 402) { over = r; break; }
    if (r.status !== 200) break;
    created++;
  }
  ok('Express enforces the cap with an honest 402', !!over && created >= 1,
    JSON.stringify({ created, status: over && over.status }));
  const overBody = await over.json();
  ok('402 body: code quota-exceeded + plan + limit',
    overBody.code === 'quota-exceeded' && overBody.plan === 'free' && overBody.limit === 4,
    JSON.stringify(overBody));

  // (5) sliding session: refresh rotates, replay dies
  const login2 = await (await api('/api/auth/login', {
    method: 'POST', headers: json(), body: JSON.stringify({ email, password: 'E2eSyncPass123!' }),
  })).json();
  ok('Express login returns a refresh token', !!login2.token && !!login2.refreshToken,
    JSON.stringify(login2).slice(0, 120));
  const rf = await (await api('/api/auth/refresh', {
    method: 'POST', headers: json(), body: JSON.stringify({ refreshToken: login2.refreshToken }),
  })).json();
  ok('refresh rotates (new access + new refresh)',
    !!rf.token && !!rf.refreshToken && rf.refreshToken !== login2.refreshToken,
    JSON.stringify({ hasToken: !!rf.token, rotated: rf.refreshToken !== login2.refreshToken }));
  const withNew = await api('/api/sessions', { headers: json({ Authorization: `Bearer ${rf.token}` }) });
  ok('refreshed access token authorizes the API', withNew.status === 200, String(withNew.status));
  const replay = await api('/api/auth/refresh', {
    method: 'POST', headers: json(), body: JSON.stringify({ refreshToken: login2.refreshToken }),
  });
  ok('spent refresh token replays → 401', replay.status === 401, String(replay.status));
}

/* ---------------- D8: billing + versions + shares (B2/B5/B7) ---------------- */
console.log('\n── D8. Billing webhook, version history, shared sessions (Express) ──');
{
  const nodeCrypto = backendReq('crypto');
  const SessionVersion = backendReq(join(backendDir, 'models', 'SessionVersion'));
  const Share = backendReq(join(backendDir, 'models', 'Share'));

  const stamp = Date.now();
  const mkUser = async (tag) => {
    const em = `d8-${tag}-${stamp}@example.com`;
    await User.create({ name: `D8 ${tag}`, email: em, password: 'D8Pass123!', isVerified: true });
    const l = await (await api('/api/auth/login', {
      method: 'POST', headers: json(),
      body: JSON.stringify({ email: em, password: 'D8Pass123!' }),
    })).json();
    return { token: l.token, id: l.user?.id, email: em };
  };
  const C = await mkUser('c');
  const D = await mkUser('d');
  const authC = { Authorization: `Bearer ${C.token}` };
  const authD = { Authorization: `Bearer ${D.token}` };

  const plan0 = await (await api('/api/me/plan', { headers: json(authC) })).json();
  ok('Express plan: free + 3-version depth + billing not configured',
    plan0.plan === 'free' && plan0.features?.maxVersions === 3 &&
      plan0.billing?.configured === false && plan0.limits?.maxSyncedSessions === 4,
    JSON.stringify(plan0));

  const co = await api('/api/billing/checkout', { method: 'POST', headers: json(authC) });
  ok('Express checkout without credentials → 503 billing-not-configured', co.status === 503, String(co.status));

  const sres = await (await api('/api/sessions', {
    method: 'POST', headers: json(authC),
    body: JSON.stringify({ name: 'v0', windows: [{ tabs: [{ url: 'https://v0.example', title: 'v0' }], groups: [] }] }),
  })).json();
  const sid = String(sres._id);
  const put = (name) => api(`/api/sessions/${sid}`, {
    method: 'PUT', headers: json(authC),
    body: JSON.stringify({ name, windows: [{ tabs: [{ url: `https://${name}.example`, title: name }], groups: [] }], updatedAt: new Date().toISOString() }),
  });
  await put('v1'); await sleep(20); await put('v2');
  const vers = await (await api(`/api/sessions/${sid}/versions`, { headers: json(authC) })).json();
  ok('Express: two content edits → two archived versions',
    Array.isArray(vers) && vers.length >= 2, JSON.stringify(vers).slice(0, 160));
  const oldest = vers[vers.length - 1];
  const restored = await (await api(`/api/sessions/${sid}/versions/${oldest._id}/restore`, {
    method: 'POST', headers: json(authC),
  })).json();
  ok('Express restore rolls the session back to v0',
    restored.name === 'v0' && JSON.stringify(restored.windows).includes('v0.example'),
    JSON.stringify(restored).slice(0, 160));

  const share = await (await api(`/api/sessions/${sid}/share`, {
    method: 'POST', headers: json(authC),
  })).json();
  ok('Express share mint → token + expiry',
    !!share.token && !!share.expiresAt, JSON.stringify(share).slice(0, 140));
  const prev = await (await api(`/api/shares/${share.token}`, { headers: json(authD) })).json();
  ok('Express share preview: name + counts, no owner email',
    prev.name === 'v0' && typeof prev.tabs === 'number' && !JSON.stringify(prev).includes(C.email),
    JSON.stringify(prev));
  const claim = await (await api(`/api/shares/${share.token}`, {
    method: 'POST', headers: json(authD),
  })).json();
  ok('Express claim imports a copy', claim.deduped === false && !!claim.sessionId, JSON.stringify(claim).slice(0, 140));
  const claim2 = await (await api(`/api/shares/${share.token}`, {
    method: 'POST', headers: json(authD),
  })).json();
  ok('Express re-claim dedupes', claim2.deduped === true, JSON.stringify(claim2).slice(0, 140));

  // Webhook — HMAC over the exact raw bytes (secret from the child's env)
  const WSEC = 'cloudsync-wsec';
  const sign = (obj) => {
    const raw = JSON.stringify(obj);
    return { raw, sig: nodeCrypto.createHmac('sha256', WSEC).update(raw).digest('hex') };
  };
  const payload = { meta: { event_name: 'subscription_created', custom_data: { userId: C.id } } };
  const { raw, sig } = sign(payload);
  const bad = await api('/api/billing/webhook', {
    method: 'POST', headers: json({ 'x-signature': 'deadbeef' }), body: raw,
  });
  ok('Express webhook wrong signature → 401', bad.status === 401, String(bad.status));
  const good = await api('/api/billing/webhook', {
    method: 'POST', headers: json({ 'x-signature': sig }), body: raw,
  });
  const goodBody = await good.json();
  ok('Express signed subscription_created → plan pro',
    good.status === 200 && goodBody.plan === 'pro', JSON.stringify(goodBody));
  const planPro = await (await api('/api/me/plan', { headers: json(authC) })).json();
  ok('Express pro: unlimited sync + 20-version depth',
    planPro.plan === 'pro' && planPro.limits?.maxSyncedSessions === -1 && planPro.features?.maxVersions === 20,
    JSON.stringify(planPro));
  const extra = await api('/api/sessions', {
    method: 'POST', headers: json(authC),
    body: JSON.stringify({ name: 'pro-extra', windows: [{ tabs: [{ url: 'https://p.example' }], groups: [] }] }),
  });
  ok('pro quota is unlimited (create past the free cap succeeds)', extra.status === 200, String(extra.status));
  const idem = await api('/api/billing/webhook', {
    method: 'POST', headers: json({ 'x-signature': sig }), body: raw,
  });
  ok('replayed event is idempotent (unchanged)', (await idem.json()).unchanged === true, String(idem.status));
  const off = sign({ meta: { event_name: 'subscription_expired', custom_data: { userId: C.id } } });
  await api('/api/billing/webhook', {
    method: 'POST', headers: json({ 'x-signature': off.sig }), body: off.raw,
  });
  const back = await (await api('/api/me/plan', { headers: json(authC) })).json();
  ok('Express subscription_expired → back to free', back.plan === 'free', JSON.stringify(back));

  // Purge cascade — DB-level proof (models are in-process here)
  await api(`/api/sessions/${sid}`, { method: 'DELETE', headers: json(authC) });
  await api(`/api/sessions/${sid}/purge`, { method: 'DELETE', headers: json(authC) });
  const vLeft = await SessionVersion.countDocuments({ sessionId: sid });
  const sLeft = await Share.countDocuments({ sessionId: sid });
  ok('purged session: version + share rows are gone from the DB',
    vLeft === 0 && sLeft === 0, JSON.stringify({ vLeft, sLeft }));

  // Account deletion cascades the bookkeeping tables (privacy commitment)
  const del = await api('/api/auth/account', {
    method: 'DELETE', headers: json(authC), body: JSON.stringify({ password: 'D8Pass123!' }),
  });
  ok('account deletion succeeds with the right password', del.status === 200, String(del.status));
  const vMine = await SessionVersion.countDocuments({ userId: C.id });
  const sMine = await Share.countDocuments({ userId: C.id });
  ok('account deletion wipes version history + shares',
    vMine === 0 && sMine === 0, JSON.stringify({ vMine, sMine }));
  const dList = await (await api('/api/sessions', { headers: json(authD) })).json();
  ok("the claimer's imported copy survives the sharer's deletion",
    dList.some((x) => x.name === 'v0'), JSON.stringify(dList.map((x) => x.name)));
}

/* ---------------- D6: dead server → honest status, no data loss ---------------- */
console.log('\n── D6. Server down: honest skip, local data intact ──');
{
  server.kill();
  await sleep(300);
  const before = JSON.stringify(deviceB.state.local.orbi_sessions);
  const r = await syncNow(deviceB);
  ok('SYNC_NOW answers skipped: backend-unreachable (no hang)', r?.result?.library?.skipped === 'backend-unreachable', JSON.stringify(r?.result).slice(0, 200));
  ok('Device B local data byte-identical after failure', JSON.stringify(deviceB.state.local.orbi_sessions) === before);
  ok('failure recorded honestly in status', deviceB.state.local.orbi_sync_status?.lastError === 'backend-unreachable', JSON.stringify(deviceB.state.local.orbi_sync_status));
}

/* ---------------- cleanup ---------------- */
try { server.kill(); } catch { /* already dead in D6 */ }
await mongoose.disconnect();
await mongod.stop();

console.log(`\n════════════════════════════════════════════════`);
console.log(`  E2E CLOUD SYNC (real worker ↔ real backend ↔ real MongoDB): ${pass} passed, ${fail} failed`);
console.log(`════════════════════════════════════════════════\n`);
process.exit(fail > 0 ? 1 : 0);
