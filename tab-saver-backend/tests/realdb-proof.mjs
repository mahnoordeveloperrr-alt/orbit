// ============================================================================
// REAL DATABASE PROOF — runs the REAL backend against a REAL, DURABLE mongod
// (WiredTiger on-disk dbpath, persistent across restarts), NOT the
// mongodb-memory-server used by launch-hardening.test.mjs.
//
//   1. boot mongod (cached 8.2.6 binary) on 127.0.0.1:27017, fresh dbpath
//   2. boot server.js with MONGO_URI=mongodb://127.0.0.1:27017/orbitabs_realdbqa
//      → assert "MongoDB connected successfully" in server log
//   3. create a verified user through the real Mongoose model (bcrypt pre-save
//      hook runs — no test doubles)
//   4. API round-trip: login → JWT → POST /api/sessions → GET /api/sessions
//   5. FULL RESTART of mongod AND server → same user + session still present
//      (durability across process restarts — the thing memory-server can't prove)
//   6. cleanup (dbpath removed; logs left in node_modules/.cache)
//
// Run:  node tests/realdb-proof.mjs       (from tab-saver-backend/)
//       Needs no Atlas account — proves the real-DB wiring end to end.
//       (A cloud Atlas URI plugs into MONGO_URI with the exact same code path.)
// ============================================================================
import { spawn } from 'child_process';
import { rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const backendDir = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(backendDir, 'package.json'));
const MONGOD = join(backendDir, 'node_modules', '.cache', 'mongodb-binaries', 'mongod-x64-win32-8.2.6.exe');
const CACHE = join(backendDir, 'node_modules', '.cache');
const DBPATH = join(CACHE, 'realdb-qa-datadir');
const MONGO_LOG = join(CACHE, 'realdb-mongod.log');
const URI = 'mongodb://127.0.0.1:27017/orbitabs_realdbqa';
const PORT = 5000;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { cond ? pass++ : fail++; console.log((cond ? '  ✅ ' : '  ❌ ') + name + (cond ? '' : ' — ' + detail)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (!existsSync(MONGOD)) { console.error(`FATAL: mongod binary missing at ${MONGOD}`); process.exit(1); }

// ---- process helpers ----------------------------------------------------------
const startMongod = () => {
  rmSync(MONGO_LOG, { force: true });
  const p = spawn(MONGOD, ['--dbpath', DBPATH, '--port', '27017', '--bind_ip', '127.0.0.1', '--logpath', MONGO_LOG], { stdio: 'ignore' });
  return p;
};
const waitFor = async (file, pattern, tries = 120) => {
  for (let i = 0; i < tries; i++) {
    try { if (readFileSync(file, 'utf8').includes(pattern)) return true; } catch {}
    await sleep(250);
  }
  return false;
};
const startServer = () => {
  const child = spawn('node', ['server.js'], {
    cwd: backendDir,
    env: { ...process.env, MONGO_URI: URI, JWT_SECRET: 'realdb-proof-secret', PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  return { child, getLog: () => log };
};
const api = (path, opts = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, opts).catch(e => ({ status: 0, json: async () => ({ error: e.message }) }));

const cleanupDirs = () => rmSync(DBPATH, { recursive: true, force: true });

// ============================================================================
console.log('\n── 1. Boot REAL mongod (durable on-disk dbpath) ──');
cleanupDirs(); mkdirSync(DBPATH, { recursive: true });
let mongod = startMongod();
let ready = await waitFor(MONGO_LOG, 'Waiting for connections');
ok('mongod listening (WiredTiger, real data dir)', ready, 'mongod log never reached "Waiting for connections"');
if (!ready) { mongod.kill(); process.exit(1); }

console.log('\n── 2. Boot real backend against mongodb://127.0.0.1:27017 ──');
let srv = startServer();
for (let i = 0; i < 80 && !srv.getLog().includes('Server running on port'); i++) await sleep(250);
ok('backend started', srv.getLog().includes('Server running on port'), srv.getLog());
ok('server log shows "MongoDB connected successfully"', srv.getLog().includes('MongoDB connected successfully'), srv.getLog());

console.log('\n── 3. Create verified user via real Mongoose model ──');
const mongoose = require('mongoose');
await mongoose.connect(URI);
const User = require(join(backendDir, 'models', 'User.js'));
const email = `realdb-${Date.now()}@example.com`;
await User.deleteMany({ email });
const u = new User({ name: 'Real DB Proof', email, password: 'Realdb-Passw0rd!', isVerified: true });
await u.save();                       // bcrypt pre-save hook runs for real
const saved = await User.findOne({ email }).lean();
ok('user written to durable DB (bcrypt hash stored)', !!saved && saved.password?.startsWith('$2') && saved.isVerified === true);
await mongoose.disconnect();

console.log('\n── 4. API round-trip: login → JWT → sessions CRUD ──');
const login = await api('/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'Realdb-Passw0rd!' }),
});
const loginBody = await login.json();
ok('login 200 + JWT', login.status === 200 && !!loginBody.token, JSON.stringify({ status: login.status, body: loginBody }));
const token = loginBody.token;

const created = await api('/api/sessions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    name: 'Real DB session',
    schemaVersion: 1,
    windows: [{ tabs: [{ url: 'https://example.com/', title: 'Real', pinned: false, active: true, groupId: -1 }], groups: [] }],
  }),
});
const createdBody = await created.json();
const sessionId = createdBody._id || createdBody.id;
ok('POST /api/sessions persisted', created.status >= 200 && created.status < 300 && !!sessionId, JSON.stringify({ status: created.status, body: createdBody }).slice(0, 300));

const list1 = await (await api('/api/sessions', { headers: { Authorization: `Bearer ${token}` } })).json();
ok('GET /api/sessions returns the created session', Array.isArray(list1) && list1.some(s => (s._id || s.id) === sessionId), JSON.stringify(list1).slice(0, 200));

console.log('\n── 5. FULL RESTART (mongod + server) → durability ──');
// Hard-killing mongod (TerminateProcess on Windows) can land inside WiredTiger's
// journal-commit window (~100 ms default): an acked w:1 write may not be in the
// journal yet and is legitimately lost — that is MongoDB crash semantics, not a
// durability bug. Wait out the journal window before the kill so the proof tests
// "acknowledged write survives restart", which is the guarantee we claim.
await sleep(1200);
srv.child.kill();
mongod.kill();
await sleep(1500);
mongod = startMongod();
ready = await waitFor(MONGO_LOG, 'Waiting for connections');
ok('mongod restarted on same data dir', ready);
srv = startServer();
for (let i = 0; i < 80 && !srv.getLog().includes('Server running on port'); i++) await sleep(250);
ok('backend restarted + reconnected', srv.getLog().includes('MongoDB connected successfully'), srv.getLog());

const login2 = await (await api('/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'Realdb-Passw0rd!' }),
})).json();
ok('user survived restart (login works again)', !!login2.token, JSON.stringify(login2).slice(0, 200));

const list2 = await (await api('/api/sessions', { headers: { Authorization: `Bearer ${login2.token}` } })).json();
ok('session survived restart (data durable on disk)', Array.isArray(list2) && list2.some(s => (s._id || s.id) === sessionId), JSON.stringify(list2).slice(0, 200));

// ---- cleanup -------------------------------------------------------------------
console.log('\n── 6. Cleanup ──');
srv.child.kill();
mongod.kill();
await sleep(500);
cleanupDirs();
ok('temp dbpath removed', !existsSync(DBPATH));

console.log(`\n══ REAL DATABASE PROOF: ${pass} passed, ${fail} failed ══`);
process.exit(fail ? 1 : 0);
