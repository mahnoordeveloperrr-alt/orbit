// ============================================================================
// LAUNCH HARDENING TEST — CORS allow-list, rate limiting, account deletion,
// HTTPS + FORCE_HTTPS redirect, running against the REAL server (server.js)
// with an in-memory MongoDB (Atlas is unreachable in this environment).
//
// Run: node tests/launch-hardening.test.mjs   (from tab-saver-backend/)
// ============================================================================

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import https from 'https';
import http from 'http';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const backendDir = join(__dirname, '..');

// Keep the ~800MB mongod download INSIDE the project (node_modules is gitignored).
// The default ~/.cache lands on the system drive, which can be full (it was:
// ENOSPC on C: during launch QA).
process.env.MONGOMS_DOWNLOAD_DIR =
  process.env.MONGOMS_DOWNLOAD_DIR || join(backendDir, 'node_modules', '.cache', 'mongodb-binaries');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 0. In-memory MongoDB + self-signed cert + real server process
 * ------------------------------------------------------------------ */
console.log('\n── 0. BOOT: memory MongoDB + TLS cert + server ──');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongod = await MongoMemoryServer.create();
const mongoUri = mongod.getUri();
console.log('  memory mongo up');

const sslDir = mkdtempSync(join(tmpdir(), 'orbitabs-ssl-'));
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', join(sslDir, 'key.pem'),
  '-out', join(sslDir, 'cert.pem'),
  '-days', '2', '-subj', '/CN=localhost',
], { stdio: 'ignore' });
console.log('  self-signed cert generated');

const PORT = 5099, SSL_PORT = 5444;
const REDIR_PORT = 5098, REDIR_SSL_PORT = 5445;

const startServer = async (env, logName) => {
  const child = spawn('node', ['server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      MONGO_URI: mongoUri,
      JWT_SECRET: 'launch-test-secret',
      ALLOWED_ORIGINS: 'https://app.orbitabs.test,http://localhost:5173',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; process.stdout.write(`  [${logName}] ${d}`); });
  child.stderr.on('data', d => { log += d; process.stdout.write(`  [${logName}!] ${d}`); });
  // wait until the HTTP listener is actually serving (redirect mode logs a different line)
  const ready = () => log.includes('Server running on port') || log.includes('HTTP→HTTPS redirect on port');
  for (let i = 0; i < 60 && !ready(); i++) await sleep(250);
  if (!ready()) throw new Error(`${logName} never started:\n${log}`);
  return { child, getLog: () => log };
};

const srv = await startServer({
  PORT: String(PORT),
  SSL_PORT: String(SSL_PORT),
  SSL_CERT: join(sslDir, 'cert.pem'),
  SSL_KEY: join(sslDir, 'key.pem'),
}, 'main');

/** HTTPS GET/DELETE helper that accepts the self-signed cert. */
const tls = (path, { method = 'GET', port = SSL_PORT, headers = {} } = {}) => new Promise((resolve) => {
  const req = https.request(
    { host: '127.0.0.1', port, path, method, rejectUnauthorized: false, headers },
    (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }
  );
  req.on('error', (e) => resolve({ status: 0, error: e.message, headers: {}, body: '' }));
  req.end();
});
/** Plain HTTP helper (Node fetch does not follow our 301 — we inspect it). */
const plain = (path, { method = 'GET', port = PORT, headers = {} } = {}) => new Promise((resolve) => {
  const req = http.request(
    { host: '127.0.0.1', port, path, method, headers },
    (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }
  );
  req.on('error', (e) => resolve({ status: 0, error: e.message, headers: {}, body: '' }));
  req.end();
});
const api = (path, opts = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, opts);
const preflight = (origin) => api('/api/sessions', {
  method: 'OPTIONS',
  headers: { Origin: origin, 'Access-Control-Request-Method': 'DELETE' },
});

/* ------------------------------------------------------------------ *
 * 1. CORS — explicit allow-list, never '*'
 * ------------------------------------------------------------------ */
console.log('\n── 1. CORS allow-list ──');
{
  const evil = await preflight('https://evil.example');
  ok('evil web origin gets NO Access-Control-Allow-Origin', !evil.headers.get('access-control-allow-origin'));
  const evil2 = await preflight('http://localhost:9999');
  ok('unlisted local origin (localhost:9999) gets NO ACAO', !evil2.headers.get('access-control-allow-origin'));
  const allowed = await preflight('https://app.orbitabs.test');
  ok('ALLOWED_ORIGINS entry accepted', allowed.headers.get('access-control-allow-origin') === 'https://app.orbitabs.test');
  const dev = await preflight('http://localhost:5173');
  ok('dev popup origin accepted', dev.headers.get('access-control-allow-origin') === 'http://localhost:5173');
  const ext = await preflight('chrome-extension://abcdefghijklmnop');
  ok('chrome-extension:// origin accepted', ext.headers.get('access-control-allow-origin') === 'chrome-extension://abcdefghijklmnop');
  const noOrigin = await api('/api/sessions');
  ok('no-Origin request (curl/server) still reaches the API (401, not blocked)', noOrigin.status === 401);
}

/* ------------------------------------------------------------------ *
 * 2. Security headers
 * ------------------------------------------------------------------ */
console.log('\n── 2. Security headers ──');
{
  const r = await api('/api/sessions');
  ok('X-Content-Type-Options: nosniff', r.headers.get('x-content-type-options') === 'nosniff');
  ok('Referrer-Policy: no-referrer', r.headers.get('referrer-policy') === 'no-referrer');
}

/* ------------------------------------------------------------------ *
 * 3. ACCOUNT DELETION (password-confirmed wipe)
 * ------------------------------------------------------------------ */
console.log('\n── 3. Account deletion ──');
const mongoose = require('mongoose');
await mongoose.connect(mongoUri);
const User = require(join(backendDir, 'models', 'User'));
const Session = require(join(backendDir, 'models', 'Session'));

const email = 'qa-delete@example.com';
await User.deleteMany({ email });
await Session.deleteMany({ userId: { $exists: true } });
const seedUser = await User.create({ name: 'QA', email, password: 'CorrectHorse1!', isVerified: true });
const seedId = String(seedUser._id);
await Session.create({ userId: seedId, name: 'CloudA', windows: [{ state: 'normal', focused: true, tabs: [{ url: 'https://a.example', title: 'A', pinned: false, active: true, groupId: null }], groups: [] }], schemaVersion: 1 });
await Session.create({ userId: seedId, name: 'CloudB', windows: [{ state: 'normal', focused: false, tabs: [{ url: 'https://b.example', title: 'B', pinned: false, active: true, groupId: null }], groups: [] }], schemaVersion: 1 });

const login = await api('/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: 'CorrectHorse1!' }),
});
const loginJson = await login.json();
ok('seeded verified user can log in (200 + token)', login.status === 200 && !!loginJson.token, `status=${login.status} ${JSON.stringify(loginJson)}`);
const token = loginJson.token;
const authed = { Authorization: `Bearer ${token}` };
const json = (h) => ({ ...h, 'Content-Type': 'application/json' });

const delNoPw = await api('/api/auth/account', { method: 'DELETE', headers: json(authed), body: JSON.stringify({}) });
ok('DELETE /account without password → 400', delNoPw.status === 400, `got ${delNoPw.status}`);
const delBadPw = await api('/api/auth/account', { method: 'DELETE', headers: json(authed), body: JSON.stringify({ password: 'wrong-pass' }) });
ok('DELETE /account wrong password → 401', delBadPw.status === 401, `got ${delBadPw.status}`);
ok('wrong-password attempt left user + both cloud sessions intact',
  (await User.countDocuments({ _id: seedId })) === 1 && (await Session.countDocuments({ userId: seedId })) === 2);

const delOk = await api('/api/auth/account', { method: 'DELETE', headers: json(authed), body: JSON.stringify({ password: 'CorrectHorse1!' }) });
const delJson = await delOk.json().catch(() => ({}));
ok('DELETE /account correct password → 200', delOk.status === 200, `got ${delOk.status} ${JSON.stringify(delJson)}`);
ok('user document GONE from DB', (await User.countDocuments({ _id: seedId })) === 0);
ok('all cloud sessions GONE from DB', (await Session.countDocuments({ userId: seedId })) === 0);
const stale = await api('/api/sessions', { headers: authed });
const staleJson = await stale.json().catch(() => ({}));
ok('stale token after deletion → 401 (account-existence check)', stale.status === 401, `got ${stale.status}`);
ok('stale-token 401 message is honest', String(staleJson.error || '').includes('no longer exists'), JSON.stringify(staleJson));

/* ------------------------------------------------------------------ *
 * 4. RATE LIMITING — auth: 25 / 15 min / IP
 * ------------------------------------------------------------------ */
console.log('\n── 4. Rate limiting ──');
{
  const bodies = JSON.stringify({ email: 'hammer@example.com', password: 'nope' });
  let sawEarlyNormal = false, saw429 = false, first429 = -1;
  for (let i = 1; i <= 34; i++) {
    const r = await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodies });
    if (r.status === 429) { if (first429 < 0) first429 = i; saw429 = true; }
    else if (i <= 10) sawEarlyNormal = true;
    if (i === 34) {
      ok('early attempts are NOT rate-limited (normal 400/401)', sawEarlyNormal && first429 > 10, `first429=${first429}`);
      const err = await r.json().catch(() => ({}));
      ok('hammering past the limit → 429 with JSON message', r.status === 429 && /Too many auth/.test(err.error || ''), `status=${r.status} ${JSON.stringify(err)}`);
      ok('429 carries RateLimit headers', !!(r.headers.get('ratelimit') || r.headers.get('ratelimit-limit') || r.headers.get('retry-after')), [...r.headers.keys()].join(','));
    }
  }
  ok('auth rate limit actually engages (429 seen)', saw429 && first429 > 10, `first429=${first429}`);
  const other = await api('/api/sessions');
  ok('non-auth endpoint unaffected by auth limiter (401, not 429)', other.status === 401, `got ${other.status}`);
}

/* ------------------------------------------------------------------ *
 * 5. HTTPS — real TLS listener on SSL_PORT
 * ------------------------------------------------------------------ */
console.log('\n── 5. HTTPS (TLS on port ' + SSL_PORT + ') ──');
{
  const r = await tls('/api/sessions');
  ok('TLS listener answers JSON over https (self-signed)', r.status === 401 && r.body.includes('token'), `status=${r.status} body=${r.body.slice(0, 80)}`);
  ok('response served through node:https (not the plain HTTP port)', r.status !== 0, r.error || '');
}

/* ------------------------------------------------------------------ *
 * 6. FORCE_HTTPS — second instance: 301 redirect + HSTS
 * ------------------------------------------------------------------ */
console.log('\n── 6. FORCE_HTTPS redirect + HSTS (port ' + REDIR_PORT + ') ──');
const srv2 = await startServer({
  PORT: String(REDIR_PORT),
  SSL_PORT: String(REDIR_SSL_PORT),
  FORCE_HTTPS: '1',
  SSL_CERT: join(sslDir, 'cert.pem'),
  SSL_KEY: join(sslDir, 'key.pem'),
}, 'redir');
{
  const r = await plain('/api/sessions', { port: REDIR_PORT });
  ok('plain HTTP → 301 redirect', r.status === 301, `got ${r.status}`);
  ok('redirect Location points at https://<host>:SSL_PORT', String(r.headers.location || '').startsWith(`https://127.0.0.1:${REDIR_SSL_PORT}/`), r.headers.location);
  const t = await tls('/api/sessions', { port: REDIR_SSL_PORT });
  ok('HTTPS instance serves normally (401 without token)', t.status === 401, `got ${t.status}`);
  ok('HSTS header present on HTTPS responses when FORCE_HTTPS=1',
    String(t.headers['strict-transport-security'] || '').includes('max-age=31536000'), JSON.stringify(t.headers));
}

/* ------------------------------------------------------------------ *
 * CLEANUP + RESULT
 * ------------------------------------------------------------------ */
srv.child.kill();
srv2.child.kill();
await mongoose.disconnect();
await mongod.stop();
rmSync(sslDir, { recursive: true, force: true });

console.log(`\n✅ LAUNCH HARDENING: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
