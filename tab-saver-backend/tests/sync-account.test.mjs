// ============================================================================
// SYNC + ACCOUNT-LIFECYCLE TEST — full-library sync push (PUT /sessions/:id
// with last-write-wins) and the forgot/reset password flow, against the REAL
// server (server.js) with an in-memory MongoDB.
//
// Run: node tests/sync-account.test.mjs   (from tab-saver-backend/)
// ============================================================================

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const backendDir = join(__dirname, '..');

process.env.MONGOMS_DOWNLOAD_DIR =
  process.env.MONGOMS_DOWNLOAD_DIR || join(backendDir, 'node_modules', '.cache', 'mongodb-binaries');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

console.log('\n── 0. BOOT: memory MongoDB + server ──');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongod = await MongoMemoryServer.create();
const mongoUri = mongod.getUri();
console.log('  memory mongo up');

const PORT = 5097;
const startServer = async () => {
  const child = spawn('node', ['server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      MONGO_URI: mongoUri,
      JWT_SECRET: 'sync-acct-test-secret',
      PORT: String(PORT),
      // No EMAIL_USER/PASS → nodemailer send fails; routes must still behave
      // (forgot-password logs the failure server-side and answers generically).
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 60 && !log.includes('Server running on port'); i++) await wait(250);
  if (!log.includes('Server running on port')) throw new Error('server never started:\n' + log);
  return { child, getLog: () => log };
};

const srv = await startServer();
const api = (path, opts = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, opts).catch(e => ({ status: 0, json: async () => ({ error: e.message }) }));
const json = (h = {}) => ({ ...h, 'Content-Type': 'application/json' });

const mongoose = require('mongoose');
await mongoose.connect(mongoUri);
const User = require(join(backendDir, 'models', 'User'));
const Session = require(join(backendDir, 'models', 'Session'));

/* ------------------------------------------------------------------ *
 * 1. PUT /sessions/:id — sync push with last-write-wins
 * ------------------------------------------------------------------ */
console.log('\n── 1. Session update (sync push) ──');
const email = 'sync-acct@example.com';
await User.deleteMany({ email });
await Session.deleteMany({ userId: { $exists: true } });
await User.create({ name: 'Sync', email, password: 'SyncPass123!', isVerified: true });

const login = await (await api('/api/auth/login', {
  method: 'POST', headers: json(),
  body: JSON.stringify({ email, password: 'SyncPass123!' }),
})).json();
ok('login 200 + token', !!login.token);
const authed = json({ Authorization: `Bearer ${login.token}` });

const created = await (await api('/api/sessions', {
  method: 'POST', headers: authed,
  body: JSON.stringify({
    name: 'Sync me',
    windows: [{ state: 'normal', focused: true, tabs: [{ url: 'https://one.example', title: 'One', pinned: false, active: true, groupId: null }], groups: [] }],
  }),
})).json();
const sid = created._id || created.id;
ok('POST creates the session (updatedAt set server-side)', !!sid && !!created.updatedAt, JSON.stringify(created).slice(0, 200));

const renamed = await (await api(`/api/sessions/${sid}`, {
  method: 'PUT', headers: authed,
  body: JSON.stringify({ name: 'Renamed remotely', updatedAt: new Date().toISOString() }),
})).json();
ok('PUT renames the session', renamed?.name === 'Renamed remotely' || renamed?.session?.name === 'Renamed remotely', JSON.stringify(renamed).slice(0, 200));

// LWW: a STALE client timestamp must NOT overwrite the newer server copy
const stale = await (await api(`/api/sessions/${sid}`, {
  method: 'PUT', headers: authed,
  body: JSON.stringify({ name: 'Stale overwrite attempt', updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
})).json();
ok('stale updatedAt → server keeps newer copy (conflict: server-newer)', stale?.conflict === 'server-newer' && stale?.session?.name === 'Renamed remotely', JSON.stringify(stale).slice(0, 200));

const foreign = await (await api(`/api/sessions/${sid}`, {
  method: 'PUT', headers: json({ Authorization: 'Bearer not-a-real-token' }),
  body: JSON.stringify({ name: 'Nope' }),
}));
ok('PUT with bad token → 401', foreign.status === 401, `got ${foreign.status}`);

const missing = await (await api('/api/sessions/000000000000000000000000', {
  method: 'PUT', headers: authed,
  body: JSON.stringify({ name: 'Ghost' }),
}));
ok('PUT unknown id → 404', missing.status === 404, `got ${missing.status}`);

/* ------------------------------------------------------------------ *
 * 2. FORGOT / RESET PASSWORD — full account-recovery lifecycle
 * ------------------------------------------------------------------ */
console.log('\n── 2. Password recovery ──');
const forgotBody = JSON.stringify({ email });
const genericUnknown = await (await api('/api/auth/forgot-password', {
  method: 'POST', headers: json(), body: JSON.stringify({ email: 'nobody@example.com' }),
})).json();
const genericKnown = await (await api('/api/auth/forgot-password', {
  method: 'POST', headers: json(), body: forgotBody,
})).json();
ok('forgot-password answers identically for known + unknown email (no enumeration)',
  genericUnknown.message === genericKnown.message, JSON.stringify({ genericUnknown, genericKnown }));

const u = await User.findOne({ email }).lean();
ok('reset token + 30-min expiry stored on the user', !!u.resetToken && u.resetTokenExpires > Date.now() && u.resetTokenExpires < Date.now() + 31 * 60 * 1000);

// GET the reset page (link target)
const page = await fetch(`http://127.0.0.1:${PORT}/api/auth/reset-password/${u.resetToken}`);
const pageHtml = await page.text();
ok('GET reset page renders a form for a valid token', page.status === 200 && pageHtml.includes('<form'), `status=${page.status}`);
const badPage = await fetch(`http://127.0.0.1:${PORT}/api/auth/reset-password/deadbeef`);
ok('GET reset page rejects an invalid token', badPage.status === 400, `got ${badPage.status}`);

// JSON reset (the popup/api path)
const resetOk = await (await api(`/api/auth/reset-password/${u.resetToken}`, {
  method: 'POST', headers: json({ Accept: 'application/json' }),
  body: JSON.stringify({ password: 'BrandNewPass42!' }),
})).json();
ok('POST reset with valid token + strong password → success message', /updated/i.test(resetOk.message || resetOk.error || ''), JSON.stringify(resetOk));

const oldLogin = await api('/api/auth/login', {
  method: 'POST', headers: json(),
  body: JSON.stringify({ email, password: 'SyncPass123!' }),
});
ok('OLD password no longer works', oldLogin.status === 400, `got ${oldLogin.status}`);

const newLogin = await (await api('/api/auth/login', {
  method: 'POST', headers: json(),
  body: JSON.stringify({ email, password: 'BrandNewPass42!' }),
})).json();
ok('NEW password signs in', !!newLogin.token, JSON.stringify(newLogin).slice(0, 120));

const uu = await User.findOne({ email }).lean();
ok('reset token is single-use (cleared after success)', !uu.resetToken, JSON.stringify(uu).slice(0, 200));

// Replay with the same token → rejected
const replay = await api(`/api/auth/reset-password/${u.resetToken}`, {
  method: 'POST', headers: json({ Accept: 'application/json' }),
  body: JSON.stringify({ password: 'AnotherPass99!' }),
});
ok('replaying a used token → 400', replay.status === 400, `got ${replay.status}`);

// Expiry: seed a fresh user with an EXPIRED token
await User.updateOne({ email }, { resetToken: 'expired-token-abc', resetTokenExpires: Date.now() - 1000 });
const expired = await api('/api/auth/reset-password/expired-token-abc', {
  method: 'POST', headers: json({ Accept: 'application/json' }),
  body: JSON.stringify({ password: 'Whatever123!' }),
});
ok('expired reset token → 400', expired.status === 400, `got ${expired.status}`);

// Weak password rejected
const u2 = await User.findOne({ email });
u2.resetToken = 'weak-token-xyz';
u2.resetTokenExpires = Date.now() + 60000;
await u2.save();
const weak = await api('/api/auth/reset-password/weak-token-xyz', {
  method: 'POST', headers: json({ Accept: 'application/json' }),
  body: JSON.stringify({ password: 'short' }),
});
ok('password under 8 chars → 400', weak.status === 400, `got ${weak.status}`);

/* ------------------------------------------------------------------ *
 * CLEANUP + RESULT
 * ------------------------------------------------------------------ */
srv.child.kill();
await mongoose.disconnect();
await mongod.stop();

console.log(`\n══ SYNC + ACCOUNT LIFECYCLE: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail > 0 ? 1 : 0);
