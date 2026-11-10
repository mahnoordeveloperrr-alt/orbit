// ============================================================================
// E2E CLOUD API (CF Worker + D1) — the REAL extension worker talking over
// REAL HTTP to the REAL Cloudflare Worker (cloud-api/worker.js) running in
// workerd (wrangler dev) with a REAL local D1 database.
//
// This is the pre-deploy gate for the hosted SaaS path: same contract the
// Express backend serves, proven against the platform that will serve it.
//
// Run: node scripts/e2e-cloud-api.test.mjs
//
//   W1  wrangler dev boots; /api/health answers 200 {ok:true}
//   W2  register (no email provider → auto-verify) → login → JWT
//   W3  CORS: chrome-extension:// allowed, foreign web origin 403
//   W4  Device A (REAL background.js) pushes library incl. V1.5 metadata
//   W5  rename → LWW PUT → server copy updated
//   W6  Device B (empty store) pulls; second sync is a no-op
//   W7  Device B's newer edit + metadata win on the server; A adopts
//   W8  trash flow (DELETE → GET trash → restore → purge) + autosave upsert
//   W8b cross-device deletion propagation (server delete → both devices trash)
//   W8c local delete → server → other device; restore round-trips
//   W8d sliding session: refresh rotates, replay dies, expired JWT recovers
//   W8e /api/me/plan + server-enforced free-tier quota (402) + health metrics
//   W11 billing webhook flips + version history + share claim (B2/B5/B7)
//   W9  account deletion → stale token 401 (no orphan sessions)
//   W10 wrong password / duplicate email / unauth → honest errors
// ============================================================================

import vm from 'node:vm';
import crypto from 'node:crypto'; // for minting an EXPIRED JWT in W8d
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cloudDir = join(root, 'cloud-api');
const workerCode = readFileSync(join(root, 'public/background.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- boot wrangler dev (local D1, workerd) ---------------- */
// E2E_BASE_URL=https://... → run the SAME suite against a DEPLOYED Worker
// (skips the local boot; everything else, incl. real background.js, identical).
const LIVE = String(process.env.E2E_BASE_URL || '').replace(/\/+$/, '');
const PORT = 8791;
const BASE = LIVE || `http://127.0.0.1:${PORT}`;
const isWin = process.platform === 'win32';
let wrangler = null;
let wlog = '';

const killWrangler = () => {
  if (!wrangler) return;
  try {
    if (isWin) spawnSync('taskkill', ['/pid', String(wrangler.pid), '/T', '/F']);
    else wrangler.kill('SIGTERM');
  } catch { /* already dead */ }
};
// Unconditional cleanup: even on an uncaught crash the workerd tree must die
// (spawnSync so it runs synchronously during process exit).
const dieHard = (err) => { console.error(err); killWrangler(); process.exit(1); };
process.on('uncaughtException', dieHard);
process.on('unhandledRejection', dieHard);
process.on('exit', killWrangler);

if (LIVE) {
  console.log(`\n── 0. TARGET: deployed Worker (${LIVE}) — no local boot ──`);
} else {
console.log('\n── 0. BOOT: wrangler dev (workerd + local D1) ──');
// 🔐 wrangler dev reads local secrets from cloud-api/.dev.vars INSTEAD of the
//    process environment (probe-proven: a process.env var never reaches the
//    worker — .dev.vars' own header says "read instead of process env vars").
//    So this run's config has to live in the FILE: snapshot the dev file,
//    write the test's values (signing secret + small quota), restore
//    byte-for-byte on exit — dev's own values come back untouched.
const devVarsPath = join(cloudDir, '.dev.vars');
const devVarsOriginal = existsSync(devVarsPath) ? readFileSync(devVarsPath, 'utf8') : '';
const restoreDevVars = () => {
  try {
    if (devVarsOriginal) writeFileSync(devVarsPath, devVarsOriginal);
    else if (existsSync(devVarsPath)) rmSync(devVarsPath);
  } catch { /* best-effort on the way out */ }
};
process.on('exit', restoreDevVars);
writeFileSync(devVarsPath, [
  '# Written by scripts/e2e-cloud-api.test.mjs for this run — restored on exit.',
  'JWT_SECRET = "cloud-api-e2e-secret"', // the secret W8d signs its expired JWT with
  'FREE_SESSION_LIMIT = 5',              // small cap → W8e proves enforcement cheaply
  'LEMONSQUEEZY_WEBHOOK_SECRET = "wsec-e2e"', // W11 signs its webhook payloads with this
  '',
].join('\n'));
// Fail fast if a stray wrangler from a previous run still owns the port —
// otherwise we'd unknowingly test stale code/state.
try {
  const probe = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) });
  if (probe.ok) {
    console.error(`Port ${PORT} already in use — kill the stray wrangler dev first.`);
    process.exit(1);
  }
} catch { /* free — good to boot */ }
wrangler = spawn('npx', ['--no-install', 'wrangler', 'dev', '--port', String(PORT), '--local', '--log-level', 'error'], {
  cwd: cloudDir,
  env: {
    ...process.env,
    JWT_SECRET: 'cloud-api-e2e-secret', // NB: wrangler ignores process env for
    // the worker (see .dev.vars write above) — kept so the Express-style
    // spawn stays honest about the intended config.
    // no RESEND_API_KEY → register auto-verifies (the documented no-email mode)
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: isWin, // npx.cmd on Windows
});
wrangler.stdout.on('data', d => (wlog += d));
wrangler.stderr.on('data', d => (wlog += d));
wrangler.on('error', (e) => { console.error('wrangler spawn failed:', e.message); process.exit(1); });
}

let ready = false;
let healthDb = false;
for (let i = 0; i < 240; i++) { // first run may download workerd — be generous
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) {
      ready = true;
      const hb = await r.json().catch(() => ({}));
      healthDb = hb.db === true; // D1 actually bound
      if (healthDb) break;
    }
  } catch { /* not up yet */ }
  await sleep(500);
}
if (!ready) {
  console.error(`no /api/health at ${BASE}:\n` + wlog.slice(-2000));
  killWrangler();
  process.exit(1);
}
ok(LIVE ? 'deployed Worker serving /api/health' : 'wrangler dev (workerd) serving /api/health', true);
ok('D1 binding present (health.db === true)', healthDb);

const api = (path, opts = {}) => fetch(`${BASE}${path}`, opts).catch(e => ({ status: 0, json: async () => ({ error: e.message }) }));
const json = (h = {}) => ({ ...h, 'Content-Type': 'application/json' });

/* ---------------- minimal chrome mock (device) ---------------- */
function createDevice() {
  const state = { local: {}, messageListener: null };
  const chrome = {
    commands: { onCommand: { addListener() {} } },
    windows: { onCreated: { addListener() {} }, onRemoved: { addListener() {} }, async getAll() { return []; }, async getCurrent() { return null; } },
    tabs: {
      onCreated: { addListener() {} }, onRemoved: { addListener() {} }, onMoved: { addListener() {} },
      onAttached: { addListener() {} }, onDetached: { addListener() {} }, onReplaced: { addListener() {} }, onUpdated: { addListener() {} },
      async create() { throw new Error('not needed'); }, async query() { return []; }, async update() {}, async group() { return 1; }, async ungroup() {},
    },
    tabGroups: { onCreated: { addListener() {} }, onUpdated: { addListener() {} }, onRemoved: { addListener() {} }, async query() { return []; }, async update() {} },
    storage: {
      local: {
        async get(keys) { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in state.local) out[k] = state.local[k]; }); return out; },
        async set(obj) { Object.assign(state.local, obj); },
        async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete state.local[k]); },
      },
      session: { async get() { return {}; }, async set() {} },
      onChanged: { addListener() {}, removeListener() {} },
    },
    alarms: { create() {}, clear() {}, async getAll() { return []; }, onAlarm: { addListener() {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    runtime: { onMessage: { addListener(cb) { state.messageListener = cb; } }, onInstalled: { addListener() {} }, onStartup: { addListener() {} }, async sendMessage() { return { ok: false }; } },
  };
  return { chrome, state };
}
const loadDevice = (device) => {
  const sandbox = { chrome: device.chrome, console, setTimeout, clearTimeout, Date, JSON, AbortSignal, URL, fetch: (...a) => fetch(...a) };
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
  isAutoSave: false, autoKey: null, deletedAt: null, tags: [], note: '', folder: null,
  createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
  ...over,
});

/* ---------------- W2: register → login ---------------- */
console.log('\n── W2. Account lifecycle (no-email mode: auto-verify) ──');
const email = `w-e2e-${Date.now()}@example.com`;
const PW = 'CloudApiPass123!';
const reg = await (await api('/api/auth/register', {
  method: 'POST', headers: json(),
  body: JSON.stringify({ name: 'W E2E', email, password: PW }),
})).json();
ok('register succeeds without an email provider', !!reg.message, JSON.stringify(reg));

const dup = await api('/api/auth/register', {
  method: 'POST', headers: json(),
  body: JSON.stringify({ name: 'W E2E', email, password: PW }),
});
const dupBody = await dup.json();
ok('duplicate email → 400 Email already registered',
  dup.status === 400 && /already registered/i.test(dupBody.error || ''), JSON.stringify(dupBody));

const wrongLogin = await api('/api/auth/login', {
  method: 'POST', headers: json(),
  body: JSON.stringify({ email, password: 'wrong-password' }),
});
ok('wrong password → 400 Invalid credentials', wrongLogin.status === 400, String(wrongLogin.status));

const loginRes = await (await api('/api/auth/login', {
  method: 'POST', headers: json(),
  body: JSON.stringify({ email, password: PW }),
})).json();
ok('login returns a JWT', !!loginRes.token, JSON.stringify(loginRes).slice(0, 120));
const TOKEN = loginRes.token;

const noAuth = await api('/api/sessions');
ok('GET /api/sessions without token → 401', noAuth.status === 401, String(noAuth.status));

/* ---------------- W3: CORS ---------------- */
console.log('\n── W3. CORS contract ──');
{
  const ext = await api('/api/health', { headers: { Origin: 'chrome-extension://abcdefghijklmnop' } });
  ok('chrome-extension:// origin allowed', ext.headers.get('access-control-allow-origin') === 'chrome-extension://abcdefghijklmnop');
  const foreign = await api('/api/sessions', { headers: { Origin: 'https://evil.example', Authorization: `Bearer ${TOKEN}` } });
  ok('foreign web origin → 403 (no CORS headers)', foreign.status === 403 && !foreign.headers.get('access-control-allow-origin'), String(foreign.status));
  const preflight = await api('/api/sessions', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abcdefghijklmnop', 'Access-Control-Request-Method': 'POST' } });
  ok('preflight answers 204 for extension origins', preflight.status === 204, String(preflight.status));
}

/* ---------------- W4: Device A pushes (REAL background.js) ---------------- */
console.log('\n── W4. Device A: push the library (real worker ↔ real Worker API ↔ real D1) ──');
const settings = { cloudSync: true, localOnly: false, autoSave: true, apiBaseUrl: BASE };
const deviceA = createDevice();
loadDevice(deviceA);
deviceA.state.local.orbi_settings = settings;
deviceA.state.local.token = TOKEN;
deviceA.state.local.orbi_sessions = [
  localDoc('alpha', 'Alpha project'),
  localDoc('beta', 'Beta research', { tags: ['research', 'q4'], note: 'sources for the report', folder: 'Work' }),
  localDoc('auto', 'Auto-save — Live Backup', { isAutoSave: true, autoKey: 'live-backup' }),
  localDoc('gone', 'Trashed session', { deletedAt: '2026-10-12T00:00:00.000Z' }),
];
const rA = await syncNow(deviceA);
ok('SYNC_NOW ok (real HTTP → real D1)', rA?.ok === true, JSON.stringify(rA).slice(0, 200));
ok('library pushed=2 (trash + Live Backup excluded)',
  rA?.result?.library?.pushed === 2, JSON.stringify(rA?.result));
ok('device A status honest (pushed=2, no error)',
  deviceA.state.local.orbi_sync_status?.pushed === 2 && deviceA.state.local.orbi_sync_status?.lastError === null,
  JSON.stringify(deviceA.state.local.orbi_sync_status));

const list = await (await api('/api/sessions', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
ok('server holds exactly the 2 live sessions', Array.isArray(list) && list.length === 2, JSON.stringify(list.map?.(s => s.name)));
const betaSrv = list.find(s => s.name === 'Beta research');
ok('server stored V1.5 metadata (tags/note/folder)',
  betaSrv && JSON.stringify(betaSrv.tags) === '["research","q4"]' && betaSrv.note === 'sources for the report' && betaSrv.folder === 'Work',
  JSON.stringify(betaSrv && { tags: betaSrv.tags, note: betaSrv.note, folder: betaSrv.folder }));

/* ---------------- W5: rename → LWW PUT ---------------- */
console.log('\n── W5. Device A: rename → LWW PUT ──');
{
  const doc = deviceA.state.local.orbi_sessions.find(s => s.name === 'Alpha project');
  doc.name = 'Alpha project (renamed)';
  doc.updatedAt = new Date().toISOString(); // newer than the server copy
  const r = await syncNow(deviceA);
  ok('rename synced to the server (updated=1)', r?.result?.library?.updated === 1, JSON.stringify(r?.result?.library));
  const after = await (await api('/api/sessions', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  ok('server copy carries the new name', after.some(s => s.name === 'Alpha project (renamed)'),
    JSON.stringify(after.map(s => s.name)));
}

/* ---------------- W6: Device B pulls ---------------- */
console.log('\n── W6. Device B: fresh device pulls everything ──');
const deviceB = createDevice();
loadDevice(deviceB);
deviceB.state.local.orbi_settings = settings;
deviceB.state.local.token = TOKEN;
deviceB.state.local.orbi_sessions = []; // empty store = new device
const rB = await syncNow(deviceB);
ok('Device B pulled both sessions', rB?.result?.library?.pulled === 2, JSON.stringify(rB?.result?.library));
const bList = deviceB.state.local.orbi_sessions;
const betaB = bList.find(s => s.name === 'Beta research');
ok('pulled docs are restorable v1 + carry metadata',
  bList.length === 2 && betaB && JSON.stringify(betaB.tags) === '["research","q4"]' && betaB.folder === 'Work',
  JSON.stringify(bList.map(s => [s.name, s.tags])));
ok('pulled docs remember their cloudId', bList.every(s => !!s.cloudId), JSON.stringify(bList.map(s => s.cloudId)));
const rB2 = await syncNow(deviceB);
ok('Device B second sync is a no-op (0 pushed / 0 pulled)',
  rB2?.result?.library?.pushed === 0 && rB2?.result?.library?.pulled === 0, JSON.stringify(rB2?.result?.library));

/* ---------------- W7: B's newer edit + metadata win ---------------- */
console.log('\n── W7. Device B: newer edit wins on the server ──');
{
  const doc = deviceB.state.local.orbi_sessions.find(s => s.name === 'Beta research');
  doc.name = 'Beta research (from B)';
  doc.tags = ['research', 'from-b'];
  doc.note = 'edited on device B';
  doc.folder = 'Work/2026';
  doc.updatedAt = new Date(Date.now() + 1000).toISOString();
  await syncNow(deviceB);
  const after = await (await api('/api/sessions', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  const srv = after.find(s => s.name === 'Beta research (from B)');
  ok('server adopted Device B\'s newer copy + metadata',
    srv && JSON.stringify(srv.tags) === '["research","from-b"]' && srv.note === 'edited on device B' && srv.folder === 'Work/2026',
    JSON.stringify(srv && { tags: srv.tags, note: srv.note, folder: srv.folder }));
  await syncNow(deviceA);
  ok('Device A picked up B\'s rename + metadata on its next sync',
    deviceA.state.local.orbi_sessions.some(s => s.name === 'Beta research (from B)' && s.folder === 'Work/2026'),
    JSON.stringify(deviceA.state.local.orbi_sessions.map(s => s.name)));
}

/* ---------------- W8: trash flow + autosave upsert ---------------- */
console.log('\n── W8. Trash flow + autosave upsert ──');
{
  const betaId = (await (await api('/api/sessions', { headers: { Authorization: `Bearer ${TOKEN}` } })).json())
    .find(s => s.name === 'Beta research (from B)')._id;

  const del = await api(`/api/sessions/${betaId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
  ok('DELETE soft-deletes (undoable)', del.status === 200, String(del.status));
  const live = await (await api('/api/sessions', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  ok('trashed session leaves the live list', !live.some(s => s._id === betaId), JSON.stringify(live.map(s => s.name)));
  const trash = await (await api('/api/sessions/trash', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  ok('trashed session appears in /trash', Array.isArray(trash) && trash.some(s => s._id === betaId), JSON.stringify(trash.map?.(s => s.name)));

  const restore = await api(`/api/sessions/${betaId}/restore`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
  ok('restore returns it to live', restore.status === 200, String(restore.status));

  // autosave upsert twice → exactly one live-backup doc, newest content
  const as1 = await api('/api/sessions/autosave', {
    method: 'POST', headers: json({ Authorization: `Bearer ${TOKEN}` }),
    body: JSON.stringify({ name: 'Auto-save — Live Backup', windows: WIN('https://backup1.example') }),
  });
  ok('autosave upsert creates the Live Backup doc', as1.status === 200, String(as1.status));
  await api('/api/sessions/autosave', {
    method: 'POST', headers: json({ Authorization: `Bearer ${TOKEN}` }),
    body: JSON.stringify({ name: 'Auto-save — Live Backup', windows: WIN('https://backup2.example') }),
  });
  const all = await (await api('/api/sessions', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  const autos = all.filter(s => s.isAutoSave);
  ok('second autosave UPSERTS (exactly one Live Backup, latest content)',
    autos.length === 1 && JSON.stringify(autos[0].windows).includes('backup2.example'),
    JSON.stringify(autos.map(a => a.windows?.[0]?.tabs?.[0]?.url)));
  ok('Live Backup excluded from the sync library count', all.filter(s => !s.isAutoSave).length === 2,
    JSON.stringify(all.map(s => [s.name, s.isAutoSave])));
}

/* ---------------- W8b–W8e: SaaS hardening (A1 sync deletes, A2 quota, A3 refresh, A4 metrics) ---------------- */
console.log('\n── W8b. Cross-device deletion propagation (server delete → both devices) ──');
{
  const live = await (await api('/api/sessions', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  const betaId = live.find(s => s.name === 'Beta research (from B)')?._id;
  ok('fixture: beta is live before the delete', !!betaId, JSON.stringify(live.map(s => s.name)));

  const del = await api(`/api/sessions/${betaId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
  ok('server DELETE answers 200 (undoable)', del.status === 200, String(del.status));
  const tb = await (await api('/api/sessions/tombstones', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  ok('GET /tombstones lists it (id + deletedAt)',
    Array.isArray(tb) && tb.some(t => t._id === betaId && t.deletedAt), JSON.stringify(tb));

  await syncNow(deviceA);
  const aBeta = deviceA.state.local.orbi_sessions.find(s => s.name === 'Beta research (from B)');
  ok('Device A moved the server-deleted session to ITS trash',
    !!aBeta?.deletedAt, JSON.stringify(aBeta && { name: aBeta.name, deletedAt: aBeta.deletedAt }));
  ok('Device A status counts the propagated delete (deleted>=1, no error)',
    (deviceA.state.local.orbi_sync_status?.deleted || 0) >= 1 && deviceA.state.local.orbi_sync_status?.lastError === null,
    JSON.stringify(deviceA.state.local.orbi_sync_status));

  await syncNow(deviceB);
  const bBeta = deviceB.state.local.orbi_sessions.find(s => s.name === 'Beta research (from B)');
  ok('Device B moved it to ITS trash too', !!bBeta?.deletedAt, JSON.stringify(bBeta && { deletedAt: bBeta.deletedAt }));

  const again = await syncNow(deviceB);
  ok('re-sync after the tombstone is a no-op (no churn, no resurrection)',
    again?.result?.library?.deleted === 0 && again?.result?.library?.pulled === 0,
    JSON.stringify(again?.result?.library));
}

console.log('\n── W8c. Local delete → server → other device; restore round-trips ──');
{
  const alphaLocal = deviceA.state.local.orbi_sessions.find(s => s.name === 'Alpha project (renamed)');
  ok('fixture: Device A holds alpha with a cloudId',
    !!alphaLocal?.cloudId, JSON.stringify(alphaLocal && { name: alphaLocal.name, cloudId: alphaLocal.cloudId }));
  alphaLocal.deletedAt = new Date().toISOString(); // what the popup's trash action writes
  const rA = await syncNow(deviceA);
  ok('Device A pushed its local delete (deleted>=1, honest status)',
    (rA?.result?.library?.deleted || 0) >= 1 && deviceA.state.local.orbi_sync_status?.lastError === null,
    JSON.stringify(rA?.result?.library));

  const liveNow = await (await api('/api/sessions', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  ok('server no longer serves alpha (trashed there)',
    !liveNow.some(s => s._id === alphaLocal.cloudId), JSON.stringify(liveNow.map(s => s.name)));
  const trashNow = await (await api('/api/sessions/trash', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  ok('alpha landed in server trash',
    trashNow.some(s => s._id === alphaLocal.cloudId), JSON.stringify(trashNow.map(s => s.name)));

  await syncNow(deviceB);
  const bAlpha = deviceB.state.local.orbi_sessions.find(s => s.cloudId === alphaLocal.cloudId);
  ok('Device B trashed alpha from the tombstone',
    !!bAlpha?.deletedAt, JSON.stringify(bAlpha && { name: bAlpha.name, deletedAt: bAlpha.deletedAt }));

  const res = await api(`/api/sessions/${alphaLocal.cloudId}/restore`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
  ok('server restore returns it to live', res.status === 200, String(res.status));
  await syncNow(deviceB);
  ok('Device B un-trashed it (restored>=1)',
    !deviceB.state.local.orbi_sessions.find(s => s.cloudId === alphaLocal.cloudId)?.deletedAt &&
      (deviceB.state.local.orbi_sync_status?.restored || 0) >= 1,
    JSON.stringify(deviceB.state.local.orbi_sync_status));
  await syncNow(deviceA);
  ok('Device A un-trashed it too (restored>=1)',
    !deviceA.state.local.orbi_sessions.find(s => s.cloudId === alphaLocal.cloudId)?.deletedAt &&
      (deviceA.state.local.orbi_sync_status?.restored || 0) >= 1,
    JSON.stringify(deviceA.state.local.orbi_sync_status));
}

console.log('\n── W8d. Sliding session (A3): refresh rotates, replay dies, expiry recovers ──');
const login2 = await (await api('/api/auth/login', {
  method: 'POST', headers: json(),
  body: JSON.stringify({ email, password: PW }),
})).json();
{
  ok('login now also returns a refresh token',
    !!login2.token && !!login2.refreshToken, JSON.stringify(login2).slice(0, 140));
  const rf = await (await api('/api/auth/refresh', {
    method: 'POST', headers: json(),
    body: JSON.stringify({ refreshToken: login2.refreshToken }),
  })).json();
  ok('refresh exchanges for a NEW access token + rotated refresh token',
    !!rf.token && !!rf.refreshToken && rf.refreshToken !== login2.refreshToken,
    JSON.stringify({ hasToken: !!rf.token, rotated: rf.refreshToken !== login2.refreshToken }));
  const withNew = await api('/api/sessions', { headers: { Authorization: `Bearer ${rf.token}` } });
  ok('refreshed access token authorizes the API', withNew.status === 200, String(withNew.status));
  const replay = await api('/api/auth/refresh', {
    method: 'POST', headers: json(),
    body: JSON.stringify({ refreshToken: login2.refreshToken }), // already spent
  });
  ok('spent (rotated) refresh token replays → 401', replay.status === 401, String(replay.status));
  const garbage = await api('/api/auth/refresh', {
    method: 'POST', headers: json(), body: JSON.stringify({ refreshToken: 'not-a-real-token' }),
  });
  ok('unknown refresh token → 401', garbage.status === 401, String(garbage.status));

  // Real client path (REAL background.js): hand Device A an EXPIRED access JWT
  // + a live refresh token → sync must refresh silently and carry on.
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const head = b64u({ alg: 'HS256', typ: 'JWT' });
  const body64 = b64u({ id: login2.user.id, iat: nowSec - 20 * 24 * 3600, exp: nowSec - 10 });
  const sig = crypto.createHmac('sha256', 'cloud-api-e2e-secret')
    .update(`${head}.${body64}`).digest('base64url');
  const expiredJwt = `${head}.${body64}.${sig}`;
  deviceA.state.local.token = expiredJwt;
  deviceA.state.local.refreshToken = rf.refreshToken;
  const r = await syncNow(deviceA);
  ok('expired access JWT → silent refresh → sync succeeds (no sign-out)',
    !!r?.result?.library && deviceA.state.local.orbi_sync_status?.lastError === null &&
      deviceA.state.local.token !== expiredJwt,
    JSON.stringify({ lib: r?.result?.library, status: deviceA.state.local.orbi_sync_status, tokenSwapped: deviceA.state.local.token !== expiredJwt }));
  ok('rotated pair persisted for the next sync', !!deviceA.state.local.refreshToken && deviceA.state.local.refreshToken !== rf.refreshToken,
    JSON.stringify({ hasRt: !!deviceA.state.local.refreshToken }));
}

console.log('\n── W8e. /api/me/plan + server-enforced quota (A2) + health metrics (A4) ──');
{
  const pl = await (await api('/api/me/plan', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  const limit = pl.limits?.maxSyncedSessions;
  ok('GET /api/me/plan → free plan + enforced limit + usage',
    pl.plan === 'free' && typeof limit === 'number' && limit > 0 && typeof pl.usage?.syncedSessions === 'number',
    JSON.stringify(pl));
  if (!LIVE) {
    ok('local run: .dev.vars quota override reaches the worker (limit=5)', limit === 5, JSON.stringify(limit));
  }
  const planNoAuth = await api('/api/me/plan');
  ok('/api/me/plan without a token → 401', planNoAuth.status === 401, String(planNoAuth.status));

  let over = null, created = 0;
  for (let i = 0; i < limit + 3; i++) {
    const r = await api('/api/sessions', {
      method: 'POST', headers: json({ Authorization: `Bearer ${TOKEN}` }),
      body: JSON.stringify({ name: `quota-${i}`, windows: WIN(`https://quota${i}.example`) }),
    });
    if (r.status === 402) { over = r; break; }
    if (r.status !== 200) break;
    created++;
  }
  ok('creates stop at the cap with an honest 402',
    !!over && created >= 1, JSON.stringify({ created, status: over && over.status, limit }));
  const overBody = await over.json();
  ok('402 body carries code quota-exceeded + plan + limit',
    overBody.code === 'quota-exceeded' && overBody.plan === 'free' && overBody.limit === limit,
    JSON.stringify(overBody));
  const pl2 = await (await api('/api/me/plan', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  ok('usage now exactly at the cap', pl2.usage.syncedSessions === limit, JSON.stringify({ usage: pl2.usage, limit }));
  const trashThen = await api('/api/sessions/trash', { headers: { Authorization: `Bearer ${TOKEN}` } });
  ok('the quota never counts trash or Live Backup', trashThen.status === 200, String(trashThen.status));

  // Client side of the same rule: a fresh device over the cap gets an honest
  // status error, keeps its local data, and stops hammering the endpoint.
  const deviceC = createDevice();
  loadDevice(deviceC);
  deviceC.state.local.orbi_settings = settings;
  deviceC.state.local.token = TOKEN;
  deviceC.state.local.orbi_sessions = Array.from({ length: 3 }, (_, i) => localDoc(`over${i}`, `Over quota ${i}`));
  const rc = await syncNow(deviceC);
  ok('over-cap device records quota-exceeded honestly',
    deviceC.state.local.orbi_sync_status?.lastError === 'quota-exceeded',
    JSON.stringify(deviceC.state.local.orbi_sync_status));
  ok('quota refusal never blanks local data (its own 3 sessions survive)',
    ['Over quota 0', 'Over quota 1', 'Over quota 2'].every(n =>
      deviceC.state.local.orbi_sessions.some(s => s.name === n)),
    JSON.stringify(deviceC.state.local.orbi_sessions.map(s => s.name)));
  ok('nothing was pushed past the cap',
    (rc?.result?.library?.pushed || 0) === 0, JSON.stringify(rc?.result?.library));

  const hb = await (await api('/api/health')).json();
  ok('/api/health carries the ops metrics snapshot (A4: requests/errors/p95)',
    hb.ok === true && hb.metrics && typeof hb.metrics.requests === 'number' &&
      typeof hb.metrics.errors === 'number' && typeof hb.metrics.p95Ms === 'number',
    JSON.stringify(hb.metrics));
}

/* ---------------- W11: billing flips + version history + share claim ---------------- */
console.log('\n── W11. Billing webhook, version history, shared sessions (B2/B5/B7) ──');
{
  // Fresh user pair — earlier sections left user A at the free cap.
  const stamp = Date.now();
  const mkUser = async (tag) => {
    const em = `w11-${tag}-${stamp}@example.com`;
    await api('/api/auth/register', {
      method: 'POST', headers: json(),
      body: JSON.stringify({ name: `W11 ${tag}`, email: em, password: PW }),
    });
    const l = await (await api('/api/auth/login', {
      method: 'POST', headers: json(),
      body: JSON.stringify({ email: em, password: PW }),
    })).json();
    return { token: l.token, id: l.user?.id, email: em };
  };
  const E = await mkUser('e');
  const F = await mkUser('f');
  const authE = { Authorization: `Bearer ${E.token}` };
  const authF = { Authorization: `Bearer ${F.token}` };

  const planE = await (await api('/api/me/plan', { headers: authE })).json();
  ok('fresh account: free plan + 3-version depth + billing not configured',
    planE.plan === 'free' && planE.features?.maxVersions === 3 &&
      planE.billing?.configured === false && planE.limits?.maxSyncedSessions === 5,
    JSON.stringify(planE));

  const co = await api('/api/billing/checkout', { method: 'POST', headers: authE });
  ok('checkout without credentials → 503 billing-not-configured', co.status === 503, String(co.status));

  // Version history: create + two content edits → snapshots archived
  const sres = await (await api('/api/sessions', {
    method: 'POST', headers: json(authE),
    body: JSON.stringify({ name: 'v0', windows: [{ tabs: [{ url: 'https://v0.example', title: 'v0' }], groups: [] }] }),
  })).json();
  const sid = sres._id || sres.id;
  ok('session created for the version test', !!sid, JSON.stringify(sres).slice(0, 120));
  const put = (name) => api(`/api/sessions/${sid}`, {
    method: 'PUT', headers: json(authE),
    body: JSON.stringify({ name, windows: [{ tabs: [{ url: `https://${name}.example`, title: name }], groups: [] }], updatedAt: new Date().toISOString() }),
  });
  await put('v1'); await sleep(5); await put('v2');
  const vers = await (await api(`/api/sessions/${sid}/versions`, { headers: authE })).json();
  ok('two content edits → at least two archived versions',
    Array.isArray(vers) && vers.length >= 2, JSON.stringify(vers).slice(0, 160));
  ok('version rows carry createdAt + tab counts',
    !!vers[0]?.createdAt && typeof vers[0]?.tabs === 'number', JSON.stringify(vers[0]));

  const oldest = vers[vers.length - 1];
  const restored = await (await api(`/api/sessions/${sid}/versions/${oldest._id}/restore`, {
    method: 'POST', headers: authE,
  })).json();
  ok('restoring the oldest snapshot rolls back to v0 content',
    restored.name === 'v0' && JSON.stringify(restored.windows).includes('v0.example'),
    JSON.stringify(restored).slice(0, 160));
  const vers2 = await (await api(`/api/sessions/${sid}/versions`, { headers: authE })).json();
  ok('the restore itself archived the pre-restore state (append-only history)',
    vers2.length >= 3, JSON.stringify({ n: vers2.length }));

  // Share → a second account claims; re-claim dedupes
  const share = await (await api(`/api/sessions/${sid}/share`, {
    method: 'POST', headers: authE,
  })).json();
  ok('share mint returns token + 30-day expiry',
    !!share.token && !!share.expiresAt, JSON.stringify(share).slice(0, 140));
  const prev = await (await api(`/api/shares/${share.token}`, { headers: authF })).json();
  ok('share preview shows name + counts, never the owner email',
    prev.name === 'v0' && typeof prev.tabs === 'number' && !JSON.stringify(prev).includes(E.email),
    JSON.stringify(prev));
  const claim = await (await api(`/api/shares/${share.token}`, {
    method: 'POST', headers: authF,
  })).json();
  ok('claim imports a copy into the other account',
    claim.deduped === false && !!claim.sessionId, JSON.stringify(claim).slice(0, 140));
  const claim2 = await (await api(`/api/shares/${share.token}`, {
    method: 'POST', headers: authF,
  })).json();
  ok('re-claiming dedupes — no duplicate piles up', claim2.deduped === true, JSON.stringify(claim2).slice(0, 140));

  // Billing webhook — the ONLY path that can write users.plan
  const WSEC = 'wsec-e2e'; // must match .dev.vars written at boot
  const sign = (obj) => {
    const raw = JSON.stringify(obj);
    return { raw, sig: crypto.createHmac('sha256', WSEC).update(raw).digest('hex') };
  };
  const payload = { event: 'subscription_created', meta: { custom_data: { user_id: E.id } } };
  const { raw, sig } = sign(payload);
  const bad = await api('/api/billing/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': 'deadbeef' }, body: raw,
  });
  ok('webhook with a wrong signature → 401', bad.status === 401, String(bad.status));
  const good = await api('/api/billing/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': sig }, body: raw,
  });
  ok('signed subscription_created is accepted', good.status === 200, String(good.status));
  const planPro = await (await api('/api/me/plan', { headers: authE })).json();
  ok('pro entitlement live: unlimited sync + 20-version depth',
    planPro.plan === 'pro' && planPro.limits?.maxSyncedSessions === -1 && planPro.features?.maxVersions === 20,
    JSON.stringify(planPro));
  const again = await api('/api/billing/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': sig }, body: raw,
  });
  ok('replayed event is idempotent', again.status === 200, String(again.status));
  const off = sign({ event: 'subscription_expired', meta: { custom_data: { user_id: E.id } } });
  await api('/api/billing/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': off.sig }, body: off.raw,
  });
  const planBack = await (await api('/api/me/plan', { headers: authE })).json();
  ok('subscription_expired returns the account to free', planBack.plan === 'free', JSON.stringify(planBack));

  // Purge kills history + share links with the row
  await api(`/api/sessions/${sid}`, { method: 'DELETE', headers: authE });
  await api(`/api/sessions/${sid}/purge`, { method: 'DELETE', headers: authE });
  const goneVers = await api(`/api/sessions/${sid}/versions`, { headers: authE });
  ok('purged session: version list 404s (history died with it)', goneVers.status === 404, String(goneVers.status));
  const goneShare = await api(`/api/shares/${share.token}`, { headers: authF });
  ok('purged session: its share token is dead too', goneShare.status === 404, String(goneShare.status));
}

/* ---------------- W9: account deletion → stale token 401 ---------------- */
console.log('\n── W9. Account deletion (privacy-policy commitment) ──');
{
  const wrongDel = await api('/api/auth/account', {
    method: 'DELETE', headers: json({ Authorization: `Bearer ${TOKEN}` }),
    body: JSON.stringify({ password: 'not-my-password' }),
  });
  ok('wrong password → 401, account NOT deleted', wrongDel.status === 401, String(wrongDel.status));

  const del = await api('/api/auth/account', {
    method: 'DELETE', headers: json({ Authorization: `Bearer ${TOKEN}` }),
    body: JSON.stringify({ password: PW }),
  });
  ok('account + all cloud data deleted', del.status === 200, String(del.status));
  const stale = await api('/api/sessions', { headers: { Authorization: `Bearer ${TOKEN}` } });
  ok('stale token now 401 (no orphan sessions)', stale.status === 401, String(stale.status));
}

killWrangler();
await sleep(200);
console.log(`\n════════════════════════════════════════════════`);
console.log(`  E2E CLOUD API (${LIVE || 'local wrangler dev'}): ${pass} passed, ${fail} failed`);
console.log(`════════════════════════════════════════════════\n`);
process.exit(fail > 0 ? 1 : 0);
