// ============================================================================
// ORBITABS CLOUD API — Cloudflare Worker + D1
// ----------------------------------------------------------------------------
// Drop-in implementation of the SAME REST contract the extension already
// speaks (tab-saver-backend routes/auth.js + routes/sessions.js), so the
// store build works by pointing Settings → Server URL at this Worker's
// origin. Zero extension changes.
//
// Deliberate differences from the Express server (each honest + documented):
//   • Passwords: PBKDF2-SHA256 (100k) via WebCrypto instead of bcrypt —
//     Workers have no native bcrypt; the wire contract (plaintext-over-HTTPS
//     in, token out) is identical.
//   • Email: RESEND_API_KEY is OPTIONAL. Without it, register auto-verifies
//     (message says "you can sign in now") and forgot-password answers the
//     same generic message but cannot deliver a link. With the key set,
//     verification + reset emails are sent for real.
//   • Rate limiting: per-isolate fixed window (auth 25/15min, api 300/15min
//     per IP) — mirrors express-rate-limit; Cloudflare WAF sits in front too.
//
// Schema bootstraps itself idempotently on first request (CREATE TABLE
// IF NOT EXISTS) — no manual migration step on deploy.
// ============================================================================

const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_LIMIT = 25;
const API_LIMIT = 300;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const JWT_TTL_SEC = 7 * 24 * 60 * 60; // 7d — same as jsonwebtoken expiresIn '7d'
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d sliding session (per device)
// 💰 FREE TIER QUOTA — enforced HERE, not in the UI (a client flag is
//    tamper-proof-proof by being server-side). Pro flips to unlimited the
//    moment billing lands (plan column already on users). Set
//    FREE_SESSION_LIMIT=-1 to disable the cap entirely.
const DEFAULT_FREE_SESSION_LIMIT = 100;
const freeLimit = (env) => {
  const raw = env.FREE_SESSION_LIMIT;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_FREE_SESSION_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_FREE_SESSION_LIMIT;
};
/* 💰 TIERS (B1) — ONE definition read by /api/me/plan, the quota gate and
   version pruning, so what the popup is TOLD can never drift from what the
   server ENFORCES. 'free': capped sync + short version history.
   'pro': unlimited sync + deep history — flipped only by the billing
   webhook (never by the client). maxSyncedSessions -1 = unlimited. */
const TIERS = {
  free: { maxSyncedSessions: (env) => freeLimit(env), maxVersions: 3 },
  pro: { maxSyncedSessions: () => -1, maxVersions: 20 },
};
const tierFor = (plan, env) => {
  const t = TIERS[plan] || TIERS.free;
  return {
    maxSyncedSessions: t.maxSyncedSessions(env),
    maxVersions: t.maxVersions,
  };
};
const planOf = async (db, userId) => {
  const row = await db.prepare('SELECT plan FROM users WHERE id = ?').bind(userId).first();
  return (row && row.plan) || 'free';
};

/* 🛒 BILLING (B2) — Lemon Squeezy, Merchant of Record (handles global VAT).
   Secrets are OPTIONAL env: without them /checkout answers an honest
   503 billing-not-configured and NOTHING about plans changes — the webhook
   is the ONLY thing that can ever set plan='pro'. (Paddle would slot in the
   same two seams: POST /checkout + a signed /webhook.) */
const lsConfig = (env) => ({
  apiKey: String(env.LEMONSQUEEZY_API_KEY || ''),
  storeId: String(env.LEMONSQUEEZY_STORE_ID || ''),
  variantId: String(env.LEMONSQUEEZY_VARIANT_ID || ''),
  secret: String(env.LEMONSQUEEZY_WEBHOOK_SECRET || ''),
  portalUrl: String(env.BILLING_PORTAL_URL || ''),
});
const billingConfigured = (env) => {
  const c = lsConfig(env);
  return !!(c.apiKey && c.storeId && c.variantId);
};

// Timing-safe hex compare (webhook signature) — no early-out on first byte.
function sigMatches(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });

const html = (body, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

const b64url = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlDecode = (s) => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(pad + '='.repeat((4 - (pad.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

const randHex = (bytes = 12) => {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const safeJsonParse = (text, fallback = null) => {
  try { return JSON.parse(text); } catch { return fallback; }
};

const sha256Hex = async (s) => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/* ------------------------------------------------------------------ *
 * SERVER-SIDE OPS METRICS (A4) — aggregate counters ONLY. No client
 * analytics, no PII, no per-user tracking: the privacy promise in
 * docs/PRIVACY_POLICY.md stays byte-for-byte true (this is the operator's own
 * server counting its own requests, like any load balancer log).
 * Per-isolate window flushed as ONE structured log line every 60s or 500
 * requests — Cloudflare makes those queryable; /api/health exposes a live
 * snapshot so an uptime probe can alert on error-rate drift.
 * ------------------------------------------------------------------ */
const metrics = {
  startedAt: Date.now(), lastFlush: Date.now(),
  window: { requests: 0, errors: 0, s2xx: 0, s4xx: 0, s5xx: 0, register: 0, login: 0, refresh: 0, creates: 0, deletes: 0, quota: 0, billing: 0 },
  byRoute: {}, durations: [], // ring of the last 500 durations for p95
};
function recordRequest(route, status, ms) {
  const w = metrics.window;
  w.requests += 1;
  if (status >= 500) { w.errors += 1; w.s5xx += 1; }
  else if (status >= 400) w.s4xx += 1;
  else w.s2xx += 1;
  metrics.byRoute[route] = (metrics.byRoute[route] || 0) + 1;
  metrics.durations.push(ms);
  if (metrics.durations.length > 500) metrics.durations.shift();
  const now = Date.now();
  if (now - metrics.lastFlush >= 60000 || w.requests >= 500) flushMetrics(now);
}
function p95(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}
function flushMetrics(now = Date.now()) {
  const line = {
    ev: 'orbitabs.metrics', iso: new Date(now).toISOString(),
    isolateUptimeMs: now - metrics.startedAt, windowMs: now - metrics.lastFlush,
    ...metrics.window, p95Ms: p95(metrics.durations), routes: metrics.byRoute,
  };
  console.log(JSON.stringify(line)); // one queryable line, no PII
  metrics.window = { requests: 0, errors: 0, s2xx: 0, s4xx: 0, s5xx: 0, register: 0, login: 0, refresh: 0, creates: 0, deletes: 0, quota: 0, billing: 0 };
  metrics.byRoute = {};
  metrics.lastFlush = now;
}
const metricsSnapshot = () => ({
  uptimeMs: Date.now() - metrics.startedAt,
  requests: metrics.window.requests,
  errors: metrics.window.errors,
  p95Ms: p95(metrics.durations),
});
const routeName = (p) => (p === '/api/health' ? 'health'
  : p.startsWith('/api/auth/') ? 'auth'
  : p === '/api/me/plan' ? 'me'
  : p.startsWith('/api/sessions') ? 'sessions' : 'other');

/* ------------------------------------------------------------------ *
 * CORS — mirror of server.js: chrome-extension:// always allowed, web
 * origins from ALLOWED_ORIGINS, curl (no Origin) allowed.
 * ------------------------------------------------------------------ */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const ok = origin.startsWith('chrome-extension://') || allowed.includes(origin)
    // Our own Sites-hosted pages (privacy / pricing / web dashboard) — same
    // project domain; they still can only use a token the user signed in with.
    || origin.endsWith('.freebuff.page');
  if (!ok) return { blocked: true };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
}

/* ------------------------------------------------------------------ *
 * Rate limiting — per-isolate fixed window (same numbers as Express)
 * ------------------------------------------------------------------ */
const buckets = new Map(); // key -> { count, resetAt }
function rateOk(ip, bucket, limit, windowMs, now = Date.now()) {
  const key = `${bucket}|${ip}`;
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) { b = { count: 0, resetAt: now + windowMs }; buckets.set(key, b); }
  b.count += 1;
  if (buckets.size > 10000) buckets.clear(); // isolate hygiene
  return b.count <= limit;
}
const tooMany = (msg) => json({ error: msg }, 429, {
  'Retry-After': String(Math.ceil(AUTH_WINDOW_MS / 1000)),
});

/* ------------------------------------------------------------------ *
 * Password hashing — PBKDF2-SHA256, 100k iterations
 * ------------------------------------------------------------------ */
const PBKDF2_ITER = 100000;

async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    key, 256
  );
  return `pbkdf2$${PBKDF2_ITER}$${b64url(salt)}$${b64url(bits)}`;
}

async function verifyPassword(pw, stored) {
  const m = /^pbkdf2\$(\d+)\$([^$]+)\$([^$]+)$/.exec(String(stored || ''));
  if (!m) return false;
  const [, iter, saltB64, hashB64] = m;
  const salt = b64urlDecode(saltB64);
  const expected = b64urlDecode(hashB64);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']
  );
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: Number(iter), hash: 'SHA-256' },
    key, expected.length * 8
  ));
  // constant-time compare
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
  return diff === 0;
}

/* ------------------------------------------------------------------ *
 * JWT — HS256, same header/payload shape jsonwebtoken produces
 * ------------------------------------------------------------------ */
async function jwtSign(payload, secret) {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(new TextEncoder().encode(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + JWT_TTL_SEC,
  })));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

async function jwtVerify(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const ok = await crypto.subtle.verify(
    'HMAC', key, b64urlDecode(sig), new TextEncoder().encode(`${header}.${body}`)
  );
  if (!ok) return null;
  const payload = safeJsonParse(new TextDecoder().decode(b64urlDecode(body)));
  if (!payload || !payload.exp || Math.floor(Date.now() / 1000) >= payload.exp) return null;
  return payload;
}

/* ------------------------------------------------------------------ *
 * Body parsing — JSON or urlencoded (the reset page posts a form)
 * ------------------------------------------------------------------ */
async function readBody(request) {
  const ctype = request.headers.get('Content-Type') || '';
  if (ctype.includes('application/json')) return safeJsonParse(await request.text(), {});
  if (ctype.includes('application/x-www-form-urlencoded')) {
    const fd = await request.formData();
    const out = {};
    for (const [k, v] of fd.entries()) out[k] = String(v);
    return out;
  }
  return safeJsonParse(await request.text(), {});
}

/* ------------------------------------------------------------------ *
 * D1 schema — idempotent bootstrap.
 * NOTE: each statement runs via prepare().run() individually — D1's exec()
 * statement-splitting differs between local miniflare and production, and
 * splitting our multi-line DDL at newlines produced SQLITE_ERROR. One
 * statement per call is unambiguous on both sides.
 * ------------------------------------------------------------------ */
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT UNIQUE NOT NULL,
     password_hash TEXT NOT NULL,
     is_verified INTEGER NOT NULL DEFAULT 0,
     verification_token TEXT,
     verification_token_expires REAL,
     reset_token TEXT,
     reset_token_expires REAL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     name TEXT NOT NULL,
     windows TEXT,
     schema_version INTEGER,
     urls TEXT,
     groups TEXT,
     tags TEXT,
     note TEXT DEFAULT '',
     folder TEXT,
     is_auto_save INTEGER NOT NULL DEFAULT 0,
     auto_key TEXT,
     deleted_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_autosave ON sessions(user_id, auto_key)`,
  // 🔁 DELETION PROPAGATION — a tombstone survives the row it marks (purge
  //    deletes the session row; the tombstone is what tells other devices).
  `CREATE TABLE IF NOT EXISTS tombstones (
     id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     deleted_at TEXT NOT NULL,
     PRIMARY KEY (user_id, id)
   )`,
  // 🔑 SLIDING SESSION — one refresh token per device, rotated on use.
  `CREATE TABLE IF NOT EXISTS refresh_tokens (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     expires REAL NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id)`,
  // 🕘 VERSION HISTORY (B7) — previous states of a session, kept server-side
  //    per tier depth (3 free / 20 pro) and archived on every content write.
  `CREATE TABLE IF NOT EXISTS session_versions (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     snapshot TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_versions_session ON session_versions(user_id, session_id, created_at)`,
  // 🔗 SHARE LINKS (B5) — a token→snapshot row the web dashboard claims
  //    from (claim re-checks quota + dedupe server-side).
  `CREATE TABLE IF NOT EXISTS shares (
     token TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     snapshot TEXT NOT NULL,
     created_at TEXT NOT NULL,
     expires_at REAL NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id)`,
];
// Columns added AFTER the first deploy — CREATE TABLE IF NOT EXISTS never
// touches an existing users table, so ALTERs run idempotently (PRAGMA guard:
// D1 rejects a duplicate-column ALTER with SQLITE_ERROR).
const USER_COLUMN_DDL = {
  plan: `ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'`,
};
let schemaReady = null;
async function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const stmt of SCHEMA_STATEMENTS) await db.prepare(stmt).run();
      const info = await db.prepare('PRAGMA table_info(users)').all();
      const have = new Set((info.results || []).map((c) => c.name));
      for (const [col, ddl] of Object.entries(USER_COLUMN_DDL)) {
        if (!have.has(col)) await db.prepare(ddl).run();
      }
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

/* Tombstone helpers — soft-delete, purge and restore ALL funnel through
   these so /api/sessions/tombstones can never drift from the trash. */
const markTombstone = (db, userId, id, whenIso) => db.prepare(
  `INSERT INTO tombstones (id, user_id, deleted_at) VALUES (?, ?, ?)
   ON CONFLICT(user_id, id) DO UPDATE SET deleted_at = excluded.deleted_at`
).bind(id, userId, whenIso).run();
const clearTombstone = (db, userId, id) => db.prepare(
  'DELETE FROM tombstones WHERE user_id = ? AND id = ?'
).bind(userId, id).run();

/* Orphan sweep — versions/shares of rows that no longer exist (purged or
   30-day-expired). Called after every purge path so history/share links of
   a permanently deleted session die with it. */
const sweepOrphans = async (db, userId) => {
  await db.prepare('DELETE FROM session_versions WHERE user_id = ? AND session_id NOT IN (SELECT id FROM sessions WHERE user_id = ?)')
    .bind(userId, userId).run();
  await db.prepare('DELETE FROM shares WHERE user_id = ? AND session_id NOT IN (SELECT id FROM sessions WHERE user_id = ?)')
    .bind(userId, userId).run();
};

/* 🕘 VERSION HISTORY (B7) — archive the PREVIOUS state before every content
   write, then prune to the tier's depth (3 free / 20 pro). Snapshots are
   server-side only; restoring one is itself a write, so it bumps updated_at
   and every other device LWW-adopts the restored content on its next sync. */
const snapshotOf = (row) => JSON.stringify({
  name: row.name,
  windows: safeJsonParse(row.windows, null),
  urls: safeJsonParse(row.urls, []),
  groups: safeJsonParse(row.groups, []),
  tags: safeJsonParse(row.tags, []),
  note: row.note || '',
  folder: row.folder || null,
  // createdAt rides along: a CLAIMED copy keeps the original creation time,
  // which is exactly what the share-claim dedupe keys on.
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
async function archiveVersion(db, userId, row, maxVersions) {
  if (!row || !(maxVersions > 0)) return;
  await db.prepare(
    'INSERT INTO session_versions (id, user_id, session_id, snapshot, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(randHex(10), userId, row.id, snapshotOf(row), new Date().toISOString()).run();
  const { results } = await db.prepare(
    'SELECT id FROM session_versions WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC'
  ).bind(userId, row.id).all();
  for (const stale of results.slice(maxVersions)) {
    await db.prepare('DELETE FROM session_versions WHERE id = ?').bind(stale.id).run();
  }
}

/* ------------------------------------------------------------------ *
 * Doc shaping — D1 row → the exact JSON the extension expects
 * ------------------------------------------------------------------ */
function userOut(row) {
  return { _id: row.id, name: row.name, email: row.email };
}

function sessionOut(row) {
  if (!row) return null;
  const isV1 = !!row.windows;
  return {
    _id: row.id,
    name: row.name,
    schemaVersion: row.schema_version,
    windows: isV1 ? safeJsonParse(row.windows, []) : null,
    urls: isV1 ? [] : safeJsonParse(row.urls, []),
    groups: isV1 ? [] : safeJsonParse(row.groups, []),
    tags: safeJsonParse(row.tags, []),
    note: row.note || '',
    folder: row.folder || null,
    isAutoSave: !!row.is_auto_save,
    autoKey: row.auto_key,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** v1 normalizer — mirrors normalizeToV1 in routes/sessions.js. */
function normalizeToV1(row) {
  const doc = sessionOut(row);
  if (!doc) return null;
  let windows = null;
  if (Array.isArray(doc.windows) && doc.windows.length) {
    windows = doc.windows
      .filter((w) => w && typeof w === 'object' && Array.isArray(w.tabs))
      .map((w) => ({
        state: w.state || 'normal',
        focused: !!w.focused,
        tabs: w.tabs
          .filter((t) => t && typeof t === 'object' && String(t.url || '').trim())
          .map((t) => ({
            url: String(t.url).trim(),
            title: String(t.title || ''),
            pinned: !!t.pinned,
            active: !!t.active,
            groupId: t.groupId != null && t.groupId !== '' ? String(t.groupId) : null,
          })),
        groups: (Array.isArray(w.groups) ? w.groups : []).map((g, i) => ({
          id: g && g.id != null ? String(g.id) : `g${i + 1}`,
          title: String((g && g.title) || ''),
          color: (g && g.color) || 'grey',
          collapsed: !!(g && g.collapsed),
        })),
      }))
      .filter((w) => w.tabs.length > 0);
  } else if (Array.isArray(doc.urls) && doc.urls.length) {
    const tabs = doc.urls.map((u) => String(u).trim()).filter(Boolean)
      .map((url) => ({ url, title: '', pinned: false, active: false, groupId: null }));
    if (tabs.length) windows = [{ state: 'normal', focused: true, tabs, groups: [] }];
  }
  if (!windows || !windows.length) return null;
  return {
    _id: doc._id,
    name: doc.name || 'Untitled session',
    schemaVersion: 1,
    windows,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    note: doc.note || '',
    folder: doc.folder || null,
    isAutoSave: doc.isAutoSave,
    autoKey: doc.autoKey,
    deletedAt: doc.deletedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/* ------------------------------------------------------------------ *
 * Metadata sanitizers — mirror sessionSchema.js sanitizeTags etc.
 * ------------------------------------------------------------------ */
const sanitizeTags = (raw) => (Array.isArray(raw) ? raw : [])
  .filter((t) => typeof t === 'string' && t.trim())
  .map((t) => t.trim().slice(0, 40))
  .slice(0, 20);
const sanitizeNote = (v) => (typeof v === 'string' ? v.slice(0, 500) : '');
const sanitizeFolder = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 50) : null);

/* ------------------------------------------------------------------ *
 * Optional email (Resend) — verification + reset
 * ------------------------------------------------------------------ */
async function sendEmail(env, to, subject, innerHtml) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM, to, subject,
      html: `<div style="font-family: Inter, sans-serif; max-width: 500px; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">${innerHtml}</div>`,
    }),
  });
  return res.ok;
}

/* ------------------------------------------------------------------ *
 * Auth middleware — mirror of middleware/auth.js
 * ------------------------------------------------------------------ */
async function requireUser(request, env) {
  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  if (!token) return { error: json({ error: 'No token, authorization denied' }, 401) };
  const payload = await jwtVerify(token, env.JWT_SECRET);
  if (!payload || !payload.id) return { error: json({ error: 'Token is not valid' }, 401) };
  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(payload.id).first();
  if (!user) return { error: json({ error: 'Account no longer exists — sign in again' }, 401) };
  return { userId: payload.id };
}

/* ------------------------------------------------------------------ *
 * AUTH routes
 * ------------------------------------------------------------------ */
async function handleAuth(request, url, env, ctx) {
  const path = url.pathname.replace('/api/auth', '');
  const body = request.method === 'POST' || request.method === 'DELETE' ? await readBody(request) : {};

  // POST /register
  if (path === '/register' && request.method === 'POST') {
    const { name, email, password } = body;
    if (!name || !email || !password) return json({ error: 'Name, email and password are required' }, 400);
    if (String(password).length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);
    const normEmail = String(email).trim();
    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(normEmail).first();
    if (existing) return json({ error: 'Email already registered' }, 400);

    const id = randHex(12);
    const now = new Date().toISOString();
    const hasEmail = !!(env.RESEND_API_KEY && env.EMAIL_FROM);
    const token = hasEmail ? randHex(32) : null;

    await env.DB.prepare(
      `INSERT INTO users (id, name, email, password_hash, is_verified, verification_token, verification_token_expires, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, String(name).trim(), normEmail, await hashPassword(String(password)),
           hasEmail ? 0 : 1, token, hasEmail ? Date.now() + 3600000 : null, now).run();
    metrics.window.register += 1;

    if (hasEmail) {
      const base = String(env.APP_BASE_URL || '').replace(/\/+$/, '');
      const verifyUrl = `${base}/api/auth/verify/${token}`;
      // Best-effort email; failure never leaks whether the account exists later
      await sendEmail(env, normEmail, 'Verify your Orbitabs account',
        `<h2 style="color:#4f46e5;">Welcome to Orbitabs! 🚀</h2>
         <p>Click the button below to verify your email and start saving your sessions.</p>
         <a href="${verifyUrl}" style="background:#4f46e5;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin:10px 0;">Verify Email</a>
         <p style="color:#64748b;font-size:12px;">If you didn't register, ignore this email.</p>`).catch(() => {});
      return json({ message: 'Registration successful! Please check your email to verify.', needsVerification: true });
    }
    // No email provider configured — instant, honest: the account is usable now.
    return json({ message: 'Account created — you can sign in now.', needsVerification: true });
  }

  // GET /verify/:token
  if (path.startsWith('/verify/') && request.method === 'GET') {
    const token = path.slice('/verify/'.length);
    const user = await env.DB.prepare(
      'SELECT id FROM users WHERE verification_token = ? AND verification_token_expires > ?'
    ).bind(token, Date.now()).first();
    if (!user) return html('<h3 style="color:red;">Invalid or expired link</h3>', 400);
    await env.DB.prepare(
      'UPDATE users SET is_verified = 1, verification_token = NULL, verification_token_expires = NULL WHERE id = ?'
    ).bind(user.id).run();
    return html(`<div style="font-family: Inter; text-align: center; padding: 50px;">
      <h2 style="color:#4f46e5;">✅ Email Verified!</h2>
      <p>You can now close this tab and login to your Orbitabs extension.</p></div>`);
  }

  // POST /login
  if (path === '/login' && request.method === 'POST') {
    const { email, password } = body;
    const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(String(email || '').trim()).first();
    if (!user) return json({ error: 'Invalid credentials' }, 400);
    if (!user.is_verified) {
      return json({ error: 'Email not verified! Check your inbox.' }, 403);
    }
    if (!(await verifyPassword(String(password || ''), user.password_hash))) {
      return json({ error: 'Invalid credentials' }, 400);
    }
    const token = await jwtSign({ id: user.id }, env.JWT_SECRET);
    // 🔑 Sliding session: a rotating refresh token per device (30d). The
    //    access JWT stays 7d — when it expires the extension refreshes
    //    instead of kicking the user out to the sign-in screen.
    const refreshToken = randHex(32);
    await env.DB.prepare(
      'INSERT INTO refresh_tokens (token_hash, user_id, expires, created_at) VALUES (?, ?, ?, ?)'
    ).bind(await sha256Hex(refreshToken), user.id, Date.now() + REFRESH_TTL_MS, new Date().toISOString()).run();
    await env.DB.prepare('DELETE FROM refresh_tokens WHERE expires < ?').bind(Date.now()).run(); // prune expired
    metrics.window.login += 1;
    return json({ token, refreshToken, user: { id: user.id, name: user.name, email: user.email } });
  }

  // POST /refresh — exchange a refresh token for a NEW access JWT + a NEW
  // refresh token (rotation: the presented token is spent, replay = 401).
  // Tokens are stored hashed (SHA-256), one row per device.
  if (path === '/refresh' && request.method === 'POST') {
    const rt = String(body.refreshToken || '');
    if (!rt) return json({ error: 'Refresh token required' }, 400);
    const hash = await sha256Hex(rt);
    const row = await env.DB.prepare(
      'SELECT user_id FROM refresh_tokens WHERE token_hash = ? AND expires > ?'
    ).bind(hash, Date.now()).first();
    if (!row) return json({ error: 'Refresh token is not valid' }, 401);
    const newRt = randHex(32);
    await env.DB.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').bind(hash).run();
    await env.DB.prepare(
      'INSERT INTO refresh_tokens (token_hash, user_id, expires, created_at) VALUES (?, ?, ?, ?)'
    ).bind(await sha256Hex(newRt), row.user_id, Date.now() + REFRESH_TTL_MS, new Date().toISOString()).run();
    metrics.window.refresh += 1;
    return json({ token: await jwtSign({ id: row.user_id }, env.JWT_SECRET), refreshToken: newRt });
  }

  // POST /logout — best-effort: spends THIS device's refresh token so a
  // stolen copy dies with the session. Local sign-out works without it.
  if (path === '/logout' && request.method === 'POST') {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    if (body.refreshToken) {
      await env.DB.prepare('DELETE FROM refresh_tokens WHERE token_hash = ? AND user_id = ?')
        .bind(await sha256Hex(String(body.refreshToken)), auth.userId).run();
    }
    return json({ message: 'Signed out' });
  }

  // POST /forgot-password — always the generic message (no enumeration)
  if (path === '/forgot-password' && request.method === 'POST') {
    const generic = { message: 'If that email has an account, a reset link is on its way.' };
    const email = String(body.email || '').trim();
    if (!email) return json(generic);
    const user = await env.DB.prepare('SELECT id, email FROM users WHERE email = ?').bind(email).first();
    if (user && env.RESEND_API_KEY && env.EMAIL_FROM) {
      const token = randHex(32);
      await env.DB.prepare(
        'UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?'
      ).bind(token, Date.now() + 30 * 60 * 1000, user.id).run();
      const base = String(env.APP_BASE_URL || '').replace(/\/+$/, '');
      const resetUrl = `${base}/api/auth/reset-password/${token}`;
      await sendEmail(env, user.email, 'Reset your Orbitabs password',
        `<h2 style="color:#4f46e5;">Password reset 🔑</h2>
         <p>Click the button below to choose a new password. The link expires in 30 minutes and can be used once.</p>
         <a href="${resetUrl}" style="background:#4f46e5;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin:10px 0;">Reset Password</a>
         <p style="color:#64748b;font-size:12px;">If you didn't request this, ignore this email — your password stays unchanged.</p>`).catch(() => {});
    }
    return json(generic);
  }

  // GET /reset-password/:token — the form page
  if (path.startsWith('/reset-password/') && request.method === 'GET') {
    const token = path.slice('/reset-password/'.length);
    const user = await env.DB.prepare(
      'SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > ?'
    ).bind(token, Date.now()).first();
    if (!user) return html('<h3 style="color:red;">Invalid or expired reset link</h3>', 400);
    return html(`<div style="font-family: Inter; text-align:center; padding:50px;">
      <h2 style="color:#4f46e5;">Choose a new password</h2>
      <form method="POST" action="/api/auth/reset-password/${token}" style="display:inline-block; text:left;">
        <input name="password" type="password" required minlength="8" placeholder="New password" style="padding:10px; border:1px solid #cbd5e1; border-radius:8px; width:240px;" />
        <br/><br/>
        <button type="submit" style="background:#4f46e5; color:white; padding:10px 24px; border-radius:8px; border:0;">Set new password</button>
      </form></div>`);
  }

  // POST /reset-password/:token
  if (path.startsWith('/reset-password/') && request.method === 'POST') {
    const wantsJson = String(request.headers.get('Accept') || '').includes('json')
      || (request.headers.get('Content-Type') || '').includes('application/json');
    const fail = (status, msg) => (wantsJson
      ? json({ error: msg }, status)
      : html(`<h3 style="color:red;">${msg}</h3>`, status));
    const token = path.slice('/reset-password/'.length);
    const password = String(body.password || '').trim();
    if (password.length < 8) return fail(400, 'Password must be at least 8 characters');
    const user = await env.DB.prepare(
      'SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > ?'
    ).bind(token, Date.now()).first();
    if (!user) return fail(400, 'Invalid or expired reset link');
    await env.DB.prepare(
      'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?'
    ).bind(await hashPassword(password), user.id).run();
    if (wantsJson) return json({ message: 'Password updated — sign in with your new password.' });
    return html(`<div style="font-family: Inter; text-align:center; padding:50px;">
      <h2 style="color:#16a34a;">✅ Password updated</h2>
      <p>You can now close this tab and sign in to Orbitabs with your new password.</p></div>`);
  }

  // DELETE /account — password-confirmed wipe (privacy policy commitment)
  if (path === '/account' && request.method === 'DELETE') {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    if (!body.password) {
      return json({ error: 'Password confirmation required to delete the account' }, 400);
    }
    const user = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(auth.userId).first();
    if (!user || !(await verifyPassword(String(body.password), user.password_hash))) {
      return json({ error: 'Incorrect password — account NOT deleted' }, 401);
    }
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(auth.userId).run();
    // "Account and all cloud data" now includes the new bookkeeping tables:
    // tombstones (deletion marks) and refresh tokens (sessions on devices).
    await env.DB.prepare('DELETE FROM tombstones WHERE user_id = ?').bind(auth.userId).run();
    await env.DB.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(auth.userId).run();
    await env.DB.prepare('DELETE FROM session_versions WHERE user_id = ?').bind(auth.userId).run();
    await env.DB.prepare('DELETE FROM shares WHERE user_id = ?').bind(auth.userId).run();
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(auth.userId).run();
    return json({ message: 'Account and all cloud data permanently deleted' });
  }

  return json({ error: 'Not found' }, 404);
}

/* ------------------------------------------------------------------ *
 * SESSIONS routes — mirror of routes/sessions.js
 * ------------------------------------------------------------------ */
async function handleSessions(request, url, env) {
  const auth = await requireUser(request, env);
  if (auth.error) return auth.error;
  const userId = auth.userId;
  const path = url.pathname.replace('/api/sessions', '').replace(/\/+$/, '') || '/';
  const isWrite = ['POST', 'PUT', 'DELETE'].includes(request.method);
  const body = isWrite ? await readBody(request) : {};

  // GET / — live sessions (trash auto-purged, v1-normalized)
  if (path === '/' && request.method === 'GET') {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_MS).toISOString();
    await env.DB.prepare(
      'DELETE FROM sessions WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?'
    ).bind(userId, cutoff).run();
    // Tombstones follow the same 30-day retention as the trash they mark —
    // otherwise the table grows forever after every purge.
    await env.DB.prepare('DELETE FROM tombstones WHERE user_id = ? AND deleted_at < ?')
      .bind(userId, cutoff).run();
    const { results } = await env.DB.prepare(
      'SELECT * FROM sessions WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC'
    ).bind(userId).all();
    const out = [];
    for (const row of results) {
      const norm = normalizeToV1(row);
      if (norm) out.push(norm);
    }
    return json(out);
  }

  // POST / — create (createdAt from the client keeps the dedupe signature stable)
  if (path === '/' && request.method === 'POST') {
    // 💰 FREE-TIER QUOTA — enforced HERE (server-side). The client never
    //    decides its own limit; an over-quota create is an honest 402 the
    //    extension surfaces as a status error instead of a silent drop.
    const planRow = await env.DB.prepare('SELECT plan FROM users WHERE id = ?').bind(userId).first();
    const plan = (planRow && planRow.plan) || 'free';
    const limit = plan === 'pro' ? -1 : freeLimit(env);
    if (limit >= 0) {
      const usage = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND deleted_at IS NULL AND is_auto_save = 0'
      ).bind(userId).first();
      if ((usage?.n || 0) >= limit) {
        metrics.window.quota += 1;
        return json({
          error: `Plan limit reached — the ${plan} plan syncs up to ${limit} sessions.`,
          code: 'quota-exceeded', plan, limit,
        }, 402);
      }
    }
    const { name, windows, urls, groups, createdAt, updatedAt, tags, note, folder } = body;
    const id = randHex(12);
    const now = new Date().toISOString();
    const created = (createdAt && !isNaN(new Date(createdAt))) ? new Date(createdAt).toISOString() : now;
    const stamp = (updatedAt && !isNaN(new Date(updatedAt))) ? new Date(updatedAt).toISOString() : now;
    const isV1 = Array.isArray(windows);
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, name, windows, schema_version, urls, groups, tags, note, folder,
        is_auto_save, auto_key, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`
    ).bind(id, userId, String(name || 'Untitled session'),
           isV1 ? JSON.stringify(windows) : null, isV1 ? 1 : null,
           isV1 ? null : JSON.stringify(Array.isArray(urls) ? urls : []),
           isV1 ? null : JSON.stringify(Array.isArray(groups) ? groups : []),
           JSON.stringify(sanitizeTags(tags)), sanitizeNote(note), sanitizeFolder(folder),
           created, stamp).run();
    const row = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first();
    metrics.window.creates += 1;
    return json(sessionOut(row));
  }

  // GET /tombstones — 🔄 DELETION PROPAGATION: ids deleted (trashed or
  // purged) that other devices still hold live copies of. Same auth + rate
  // bucket as the list endpoint; pruned with the 30-day trash retention.
  if (path === '/tombstones' && request.method === 'GET') {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_MS).toISOString();
    await env.DB.prepare('DELETE FROM tombstones WHERE user_id = ? AND deleted_at < ?')
      .bind(userId, cutoff).run();
    const { results } = await env.DB.prepare(
      'SELECT id, deleted_at FROM tombstones WHERE user_id = ? ORDER BY deleted_at DESC'
    ).bind(userId).all();
    return json(results.map((r) => ({ _id: r.id, deletedAt: r.deleted_at })));
  }

  // POST /autosave — one upserted Live Backup per user
  if (path === '/autosave' && request.method === 'POST') {
    const { name, windows, urls, groups } = body;
    const autoKey = 'live-backup';
    const now = new Date().toISOString();
    const isV1 = Array.isArray(windows);
    const existing = await env.DB.prepare(
      'SELECT id FROM sessions WHERE user_id = ? AND auto_key = ?'
    ).bind(userId, autoKey).first();
    if (existing) {
      await env.DB.prepare(
        `UPDATE sessions SET name = ?, windows = ?, schema_version = ?, urls = ?, groups = ?,
           created_at = ?, updated_at = ? WHERE id = ?`
      ).bind(String(name || 'Auto-save — Live Backup'),
             isV1 ? JSON.stringify(windows) : null, isV1 ? 1 : null,
             isV1 ? null : JSON.stringify(Array.isArray(urls) ? urls : []),
             isV1 ? null : JSON.stringify(Array.isArray(groups) ? groups : []),
             now, now, existing.id).run();
      return json(sessionOut(await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(existing.id).first()));
    }
    const id = randHex(12);
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, name, windows, schema_version, urls, groups, tags, note, folder,
        is_auto_save, auto_key, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '', NULL, 1, ?, NULL, ?, ?)`
    ).bind(id, userId, String(name || 'Auto-save — Live Backup'),
           isV1 ? JSON.stringify(windows) : null, isV1 ? 1 : null,
           isV1 ? null : JSON.stringify(Array.isArray(urls) ? urls : []),
           isV1 ? null : JSON.stringify(Array.isArray(groups) ? groups : []),
           autoKey, now, now).run();
    return json(sessionOut(await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first()));
  }

  // 🕘 GET /:id/versions — B7: list version history (what actually exists;
  // depth is enforced by tier-pruning at write time).
  if (/^\/[^/]+\/versions$/.test(path) && request.method === 'GET') {
    const id = path.slice(1, path.indexOf('/versions'));
    const row = await env.DB.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').bind(id, userId).first();
    if (!row) return json({ error: 'Session not found' }, 404);
    const { results } = await env.DB.prepare(
      'SELECT id, snapshot, created_at FROM session_versions WHERE user_id = ? AND session_id = ? ORDER BY created_at DESC'
    ).bind(userId, id).all();
    return json(results.map((r) => {
      const snap = safeJsonParse(r.snapshot, {}) || {};
      const wins = Array.isArray(snap.windows) ? snap.windows : [];
      const tabs = wins.reduce((n, w) => n + (Array.isArray(w?.tabs) ? w.tabs.length : 0), 0)
        + (Array.isArray(snap.urls) ? snap.urls.length : 0);
      return {
        _id: r.id, createdAt: r.created_at,
        name: snap.name || 'Untitled session', windows: wins.length, tabs,
        updatedAt: snap.updatedAt || null,
      };
    }));
  }

  // POST /:id/versions/:vid/restore — apply an old state as the NEW current
  // write: current state is archived first, updated_at bumps, so every other
  // device picks the restored content up through the normal LWW path.
  if (/^\/[^/]+\/versions\/[^/]+\/restore$/.test(path) && request.method === 'POST') {
    const id = path.slice(1, path.indexOf('/versions'));
    const vid = path.slice(path.indexOf('/versions/') + '/versions/'.length, path.indexOf('/restore'));
    const row = await env.DB.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').bind(id, userId).first();
    if (!row) return json({ error: 'Session not found' }, 404);
    const ver = await env.DB.prepare(
      'SELECT snapshot FROM session_versions WHERE id = ? AND user_id = ? AND session_id = ?'
    ).bind(vid, userId, id).first();
    if (!ver) return json({ error: 'Version not found' }, 404);
    const snap = safeJsonParse(ver.snapshot, null);
    if (!snap) return json({ error: 'Version unreadable' }, 500);
    await archiveVersion(env.DB, userId, row, tierFor(await planOf(env.DB, userId), env).maxVersions);
    const wins = Array.isArray(snap.windows) && snap.windows.length ? snap.windows : null;
    await env.DB.prepare(
      `UPDATE sessions SET name = ?, windows = ?, schema_version = ?, urls = ?, groups = ?, tags = ?, note = ?, folder = ?, updated_at = ? WHERE id = ? AND user_id = ?`
    ).bind(
      snap.name || row.name,
      wins ? JSON.stringify(wins) : null, wins ? 1 : null,
      wins ? '[]' : JSON.stringify(Array.isArray(snap.urls) ? snap.urls : []),
      wins ? '[]' : JSON.stringify(Array.isArray(snap.groups) ? snap.groups : []),
      JSON.stringify(sanitizeTags(snap.tags)), sanitizeNote(snap.note), sanitizeFolder(snap.folder),
      new Date().toISOString(), id, userId
    ).run();
    return json(sessionOut(await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first()));
  }

  // 🔗 POST /:id/share — B5: mint a 30-day share link (one live link per
  // session — re-sharing rotates the token, killing the old link).
  if (/^\/[^/]+\/share$/.test(path) && request.method === 'POST') {
    const id = path.slice(1, path.indexOf('/share'));
    const row = await env.DB.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').bind(id, userId).first();
    if (!row) return json({ error: 'Session not found' }, 404);
    if (row.deleted_at) return json({ error: 'Sessions in trash cannot be shared' }, 400);
    const token = randHex(24);
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await env.DB.prepare('DELETE FROM shares WHERE user_id = ? AND session_id = ?').bind(userId, id).run();
    await env.DB.prepare(
      'INSERT INTO shares (token, user_id, session_id, snapshot, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(token, userId, id, snapshotOf(row), new Date().toISOString(), expiresAt).run();
    const base = String(env.APP_BASE_URL || '').replace(/\/+$/, '');
    return json({
      token,
      url: base ? `${base}/dashboard.html?share=${token}` : null,      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  // PUT /:id — last-write-wins (server wins on older client stamps)
  if (path.startsWith('/') && path.length > 1 && request.method === 'PUT') {
    const id = path.slice(1);
    const row = await env.DB.prepare(
      'SELECT * FROM sessions WHERE id = ? AND user_id = ?'
    ).bind(id, userId).first();
    if (!row) return json({ error: 'Session not found' }, 404);

    const { name, windows, urls, groups, updatedAt, tags, note, folder } = body;
    if (updatedAt && row.updated_at && new Date(updatedAt) < new Date(row.updated_at)) {
      return json({ message: 'server copy is newer — kept', conflict: 'server-newer', session: sessionOut(row) }, 200);
    }
    // 🔄 A write to a TRASHED row: the client's stamp is >= the server copy
    // (soft-delete bumps updated_at = deletedAt), so LWW says the newer edit
    // REVIVES the session — tombstone lifted with it.
    let revive = false;
    if (row.deleted_at) {
      if (updatedAt && new Date(updatedAt) >= new Date(row.deleted_at)) {
        revive = true;
        await clearTombstone(env.DB, userId, id);
      } else {
        return json({ message: 'server copy is newer — kept', conflict: 'server-newer', session: sessionOut(row) }, 200);
      }
    }
    // 🕘 B7 — archive the state we're about to overwrite (tier-pruned)
    await archiveVersion(env.DB, userId, row, tierFor(await planOf(env.DB, userId), env).maxVersions);
    const sets = []; const vals = [];
    if (typeof name === 'string' && name.trim()) { sets.push('name = ?'); vals.push(name.trim()); }
    if (Array.isArray(windows) && windows.length > 0) {
      sets.push('windows = ?', 'schema_version = 1', "urls = '[]'", "groups = '[]'");
      vals.push(JSON.stringify(windows));
    } else if (Array.isArray(urls)) {
      sets.push('urls = ?', 'groups = ?');
      vals.push(JSON.stringify(urls), JSON.stringify(Array.isArray(groups) ? groups : []));
    }
    if (Array.isArray(tags)) { sets.push('tags = ?'); vals.push(JSON.stringify(sanitizeTags(tags))); }
    if (typeof note === 'string') { sets.push('note = ?'); vals.push(sanitizeNote(note)); }
    if (folder !== undefined) { sets.push('folder = ?'); vals.push(sanitizeFolder(folder)); }
    sets.push('updated_at = ?'); vals.push(new Date().toISOString());
    if (revive) sets.push('deleted_at = NULL');
    await env.DB.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .bind(...vals, id, userId).run();
    return json(sessionOut(await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first()));
  }

  // GET /trash
  if (path === '/trash' && request.method === 'GET') {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_MS).toISOString();
    await env.DB.prepare(
      'DELETE FROM sessions WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?'
    ).bind(userId, cutoff).run();
    await env.DB.prepare('DELETE FROM tombstones WHERE user_id = ? AND deleted_at < ?')
      .bind(userId, cutoff).run();
    await sweepOrphans(env.DB, userId); // versions/shares of expired trash rows
    const { results } = await env.DB.prepare(
      'SELECT * FROM sessions WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC'
    ).bind(userId).all();
    return json(results.map(sessionOut));
  }

  // DELETE /trash/purge — empty the whole trash (tombstones SURVIVE the rows:
  // other devices must learn about every purge, not just soft-deletes)
  if (path === '/trash/purge' && request.method === 'DELETE') {
    const { results } = await env.DB.prepare(
      'SELECT id, deleted_at FROM sessions WHERE user_id = ? AND deleted_at IS NOT NULL'
    ).bind(userId).all();
    const r = await env.DB.prepare(
      'DELETE FROM sessions WHERE user_id = ? AND deleted_at IS NOT NULL'
    ).bind(userId).run();
    for (const row of results) await markTombstone(env.DB, userId, row.id, row.deleted_at);
    await sweepOrphans(env.DB, userId);
    return json({ message: `${r.meta.changes} sessions permanently deleted.` });
  }

  // POST /restore/bulk
  if (path === '/restore/bulk' && request.method === 'POST') {
    const ids = Array.isArray(body.ids) ? body.ids : null;
    if (!ids || !ids.length) return json({ error: 'No valid IDs provided' }, 400);
    const placeholders = ids.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id FROM sessions WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (${placeholders})`
    ).bind(userId, ...ids).all();
    const nowIso = new Date().toISOString();
    const r = await env.DB.prepare(
      `UPDATE sessions SET deleted_at = NULL, updated_at = ? WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (${placeholders})`
    ).bind(nowIso, userId, ...ids).run();
    // Restore is a WRITE: bump updated_at (done above) + lift the tombstone
    // so other devices un-trash their copies instead of re-applying it.
    for (const row of results) await clearTombstone(env.DB, userId, row.id);
    return json({ message: `${r.meta.changes} sessions restored.`, restoredCount: r.meta.changes });
  }

  // DELETE /bulk — soft-delete many
  if (path === '/bulk' && request.method === 'DELETE') {
    const ids = Array.isArray(body.ids) ? body.ids : null;
    if (!ids || !ids.length) return json({ error: 'No valid IDs provided' }, 400);
    const placeholders = ids.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id FROM sessions WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`
    ).bind(userId, ...ids).all();
    const nowIso = new Date().toISOString();
    const r = await env.DB.prepare(
      `UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`
    ).bind(nowIso, nowIso, userId, ...ids).run();
    for (const row of results) await markTombstone(env.DB, userId, row.id, nowIso);
    metrics.window.deletes += results.length;
    return json({ message: `${r.meta.changes} sessions deleted (undoable).`, deletedCount: r.meta.changes });
  }

  // /:id/purge — permanent delete of ONE trashed session (tombstone kept)
  if (/^\/[^/]+\/purge$/.test(path) && request.method === 'DELETE') {
    const id = path.slice(1, path.indexOf('/purge'));
    const row = await env.DB.prepare(
      'SELECT id, deleted_at FROM sessions WHERE id = ? AND user_id = ?'
    ).bind(id, userId).first();
    if (!row) return json({ error: 'Session not found' }, 404);
    if (!row.deleted_at) return json({ error: 'Session is not in trash' }, 400);
    await markTombstone(env.DB, userId, row.id, row.deleted_at);
    await env.DB.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').bind(id, userId).run();
    // history + share links of a purged session die with it
    await env.DB.prepare('DELETE FROM session_versions WHERE user_id = ? AND session_id = ?').bind(userId, id).run();
    await env.DB.prepare('DELETE FROM shares WHERE user_id = ? AND session_id = ?').bind(userId, id).run();
    metrics.window.deletes += 1;
    return json({ message: 'Session permanently deleted' });
  }

  // /:id/restore — undo one delete (also a write: bumped + tombstone lifted)
  if (/^\/[^/]+\/restore$/.test(path) && request.method === 'POST') {
    const id = path.slice(1, path.indexOf('/restore'));
    const row = await env.DB.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').bind(id, userId).first();
    if (!row) return json({ error: 'Session not found' }, 404);
    await env.DB.prepare('UPDATE sessions SET deleted_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?')
      .bind(new Date().toISOString(), id, userId).run();
    await clearTombstone(env.DB, userId, id);
    return json(sessionOut(await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first()));
  }

  // DELETE /:id — soft delete (trash, undoable)
  if (path.startsWith('/') && path.length > 1 && request.method === 'DELETE') {
    const id = path.slice(1);
    const row = await env.DB.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?').bind(id, userId).first();
    if (!row) return json({ error: 'Session not found' }, 404);
    const nowIso = new Date().toISOString();
    // updated_at rides along with the delete: a delete IS a write, so a
    // client edit older than it must lose (LWW) and a NEWER edit revives.
    await env.DB.prepare('UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .bind(nowIso, nowIso, id, userId).run();
    await markTombstone(env.DB, userId, id, nowIso);
    metrics.window.deletes += 1;
    return json({ message: 'Session deleted (undoable)', session: sessionOut(await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first()) });
  }

  return json({ error: 'Not found' }, 404);
}

/* ------------------------------------------------------------------ *
 * BILLING routes (B2) — Lemon Squeezy. Two seams, both provider-specific
 * and both replaceable: POST /checkout (hosted checkout URL) and
 * POST /webhook (signature-verified plan flips). Nothing else in the code
 * may write users.plan.
 * ------------------------------------------------------------------ */
async function handleBilling(request, url, env) {
  const cfg = lsConfig(env);
  const path = url.pathname.replace('/api/billing', '');

  // POST /webhook — public (signed, not authenticated). Reads the RAW bytes:
  // the HMAC must cover exactly what the provider sent. Scheme (LS docs):
  // X-Signature = hex( HMAC-SHA256( raw_body, signing_secret ) ).
  if (path === '/webhook' && request.method === 'POST') {
    if (!cfg.secret) return json({ error: 'Webhook secret not configured' }, 503);
    const raw = new Uint8Array(await request.arrayBuffer());
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(cfg.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, raw));
    const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (!sigMatches(String(request.headers.get('x-signature') || ''), expected)) {
      return json({ error: 'Invalid signature' }, 401);
    }
    const body = safeJsonParse(new TextDecoder().decode(raw), null);
    const evt = String(body?.event || '');
    const userId = String(body?.meta?.custom_data?.user_id || '');
    // Access ON for new/updated subscriptions (trials included), OFF only when
    // the provider says access actually ended (expired/refunded) — a
    // cancellation with a grace period keeps Pro until then, like the docs say.
    const ACTIVATE = new Set(['subscription_created', 'subscription_updated']);
    const REVOKE = new Set(['subscription_expired', 'subscription_refunded']);
    if (userId && (ACTIVATE.has(evt) || REVOKE.has(evt))) {
      const plan = ACTIVATE.has(evt) ? 'pro' : 'free';
      const user = await env.DB.prepare('SELECT id, email, plan FROM users WHERE id = ?').bind(userId).first();
      if (user && (user.plan || 'free') !== plan) {
        await env.DB.prepare('UPDATE users SET plan = ? WHERE id = ?').bind(plan, userId).run();
        metrics.window.billing += 1;
        console.log(JSON.stringify({ ev: 'orbitabs.plan-change', plan, event: evt })); // no PII
        await notifyPlanChange(env, user.email, plan).catch(() => {}); // best-effort (B6)
      }
    }
    return json({ received: true });
  }

  // POST /checkout (auth) — creates a HOSTED checkout and hands back its URL.
  if (path === '/checkout' && request.method === 'POST') {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    if (!billingConfigured(env)) {
      return json({ error: 'Online checkout is not configured yet — the extension stays fully usable.', code: 'billing-not-configured' }, 503);
    }
    const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(auth.userId).first();
    const base = String(env.APP_BASE_URL || '').replace(/\/+$/, '');
    const res = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      },
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              email: user?.email || undefined,
              // The webhook reads THIS back to know whose plan to flip.
              custom: { user_id: auth.userId },
            },
            ...(base ? { product_options: { redirect_url: `${base}/dashboard.html?billing=success` } } : {}),
          },
          relationships: {
            store: { data: { type: 'stores', id: cfg.storeId } },
            variant: { data: { type: 'variants', id: cfg.variantId } },
          },
        },
      }),
      signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    if (!res || !res.ok) return json({ error: 'Checkout could not be created — please try again shortly.' }, 502);
    const data = await res.json().catch(() => null);
    const checkoutUrl = data?.data?.attributes?.url;
    if (!checkoutUrl) return json({ error: 'Checkout unavailable — please try again shortly.' }, 502);
    return json({ url: checkoutUrl });
  }

  // GET /config — (auth) lets the Upgrade card say whether billing is live
  // BEFORE you click, and where the customer portal lives when it is.
  if (path === '/config' && request.method === 'GET') {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    return json({ configured: billingConfigured(env), portalUrl: cfg.portalUrl || null });
  }

  return json({ error: 'Not found' }, 404);
}

/* 📧 B6 — lifecycle email on a real plan change (Resend optional: without a
   key this resolves fast and silently; the plan flip itself never depends
   on email delivery). */
async function notifyPlanChange(env, email, plan) {
  if (plan === 'pro') {
    return sendEmail(env, email, 'Orbitabs Pro is active 🎉',
      `<h2 style="color:#4f46e5;">You're on Pro</h2>
       <p>Cloud sync is now unlimited — every saved session syncs across your devices, and version history keeps the last 20 states of each session.</p>
       <p style="color:#64748b;font-size:12px;">Manage or cancel any time from the link in your checkout receipt.</p>`);
  }
  return sendEmail(env, email, 'Your Orbitabs plan changed',
    `<h2 style="color:#4f46e5;">You're back on the Free plan</h2>
     <p>Your subscription ended. Cloud sync stays on for up to the free-plan limit; everything else (local sessions, restore, crash recovery) is unchanged and stays yours.</p>`);
}

/* ------------------------------------------------------------------ *
 * SHARED SESSIONS (B5) — GET /api/shares/:token previews (the dashboard
 * shows who shared what before importing), POST claims into the caller's
 * library with the SAME quota gate + dedupe rule as file import. The
 * snapshot is frozen at share time: claiming never mutates the sharer's
 * copy, and neither side sees the other's email.
 * ------------------------------------------------------------------ */
async function handleShares(request, url, env) {
  const auth = await requireUser(request, env);
  if (auth.error) return auth.error;
  const userId = auth.userId;
  const path = url.pathname.replace('/api/shares', '').replace(/\/+$/, '') || '/';
  const token = path.slice(1);
  if (!token || token.includes('/')) return json({ error: 'Not found' }, 404);
  const row = await env.DB.prepare(
    'SELECT * FROM shares WHERE token = ? AND expires_at > ?'
  ).bind(token, Date.now()).first();
  if (!row) return json({ error: 'Share link is invalid or expired' }, 404);
  const snap = safeJsonParse(row.snapshot, null);
  if (!snap) return json({ error: 'Share link is invalid' }, 500);

  if (request.method === 'GET') {
    const wins = Array.isArray(snap.windows) ? snap.windows : [];
    const tabs = wins.reduce((n, w) => n + (Array.isArray(w?.tabs) ? w.tabs.length : 0), 0)
      + (Array.isArray(snap.urls) ? snap.urls.length : 0);
    return json({
      name: snap.name || 'Shared session', windows: wins.length, tabs,
      tags: safeJsonParse(snap.tags, []), note: snap.note || '', folder: snap.folder || null,
      expiresAt: new Date(row.expires_at).toISOString(),
    });
  }

  if (request.method === 'POST') {
    // Dedupe by name+createdAt against the caller's LIVE library — the same
    // rule as file import, so re-claiming never piles up copies. Both sides
    // are normalized through new Date() so storage formats can't drift.
    const snapCreated = (snap.createdAt && !isNaN(new Date(snap.createdAt)))
      ? new Date(snap.createdAt).toISOString() : null;
    const sig = JSON.stringify([snap.name || null, snapCreated]);
    const { results } = await env.DB.prepare(
      'SELECT id, name, created_at FROM sessions WHERE user_id = ? AND deleted_at IS NULL AND is_auto_save = 0'
    ).bind(userId).all();
    for (const r of results) {
      if (JSON.stringify([r.name, new Date(r.created_at).toISOString()]) === sig) {
        return json({ deduped: true, sessionId: r.id, message: 'You already have this session' });
      }
    }
    // Quota gate — identical to POST /api/sessions (the claim IS a create)
    const planName = await planOf(env.DB, userId);
    const limit = tierFor(planName, env).maxSyncedSessions;
    if (limit >= 0 && results.length >= limit) {
      return json({ error: `Plan limit reached — the ${planName} plan syncs up to ${limit} sessions.`, code: 'quota-exceeded', plan: planName, limit }, 402);
    }
    const id = randHex(12);
    const nowIso = new Date().toISOString();
    const wins = Array.isArray(snap.windows) && snap.windows.length ? snap.windows : null;
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, name, windows, schema_version, urls, groups, tags, note, folder, is_auto_save, auto_key, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`
    ).bind(
      id, userId, snap.name || 'Shared session',
      wins ? JSON.stringify(wins) : null, wins ? 1 : null,
      wins ? null : JSON.stringify(Array.isArray(snap.urls) ? snap.urls : []),
      wins ? null : JSON.stringify(Array.isArray(snap.groups) ? snap.groups : []),
      JSON.stringify(sanitizeTags(snap.tags)), sanitizeNote(snap.note), sanitizeFolder(snap.folder),
      (snap.createdAt && !isNaN(new Date(snap.createdAt))) ? new Date(snap.createdAt).toISOString() : nowIso,
      (snap.updatedAt && !isNaN(new Date(snap.updatedAt))) ? new Date(snap.updatedAt).toISOString() : nowIso
    ).run();
    metrics.window.creates += 1;
    return json({ deduped: false, sessionId: id, session: sessionOut(await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first()) });
  }
  return json({ error: 'Not found' }, 404);
}

/* ------------------------------------------------------------------ *
 * PLAN route — A2/B1 entitlement read: the SERVER says what the account
 * may sync (never the reverse). Includes the tier's feature depths and the
 * billing config state so the popup can render an honest Upgrade CTA.
 * ------------------------------------------------------------------ */
async function handlePlan(request, env) {
  const auth = await requireUser(request, env);
  if (auth.error) return auth.error;
  const plan = await planOf(env.DB, auth.userId);
  const tier = tierFor(plan, env);
  const usage = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND deleted_at IS NULL AND is_auto_save = 0'
  ).bind(auth.userId).first();
  return json({
    plan,
    limits: { maxSyncedSessions: tier.maxSyncedSessions }, // -1 = unlimited
    features: { maxVersions: tier.maxVersions },
    usage: { syncedSessions: usage?.n || 0 },
    billing: {
      configured: billingConfigured(env),
      portalUrl: lsConfig(env).portalUrl || null,
    },
  });
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */
export default {
  async fetch(request, env, ctx) {
    const t0 = Date.now();
    const url = new URL(request.url);
    const route = routeName(url.pathname);
    // Early answers funnel through fail()/jsonOut so the aggregate metrics
    // see rate-limits, CORS blocks and config errors — not just happy paths.
    const fail = (data, status) => {
      recordRequest(route, status, Date.now() - t0);
      return json(data, status);
    };

    // CORS preflight first — never rate-limited (browser probe, not an API call)
    const cors = corsHeaders(request, env);
    if (cors.blocked) return fail({ error: 'Origin not allowed' }, 403);
    if (request.method === 'OPTIONS') {
      recordRequest(route, 204, Date.now() - t0);
      return new Response(null, { status: 204, headers: cors });
    }

    // Health — before the limiter so host health polls never eat user budget.
    // Carries an ops snapshot (uptime / in-window requests / errors / p95) so
    // an uptime probe can double as the metrics alarm channel.
    if (url.pathname === '/api/health') {
      recordRequest(route, 200, Date.now() - t0);
      return json({ ok: true, db: !!env.DB, ts: Date.now(), metrics: metricsSnapshot() }, 200, cors);
    }

    // Honest failures (JSON, never a runtime error page):
    // D1 must be bound and a JWT secret must be configured — a 0-length HMAC
    // key would otherwise crash the login path with a raw stack trace.
    if (!env.DB) return fail({ error: 'Database not bound (D1)' }, 500);
    if (url.pathname.startsWith('/api/') && String(env.JWT_SECRET || '').length < 8) {
      return fail({ error: 'JWT_SECRET not configured (min 8 chars)' }, 500);
    }
    try {
      await ensureSchema(env.DB);
    } catch (e) {
      return fail({ error: `Database bootstrap failed: ${e && e.message}` }, 500);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (url.pathname.startsWith('/api/auth/') && !rateOk(ip, 'auth', AUTH_LIMIT, AUTH_WINDOW_MS)) {
      recordRequest(route, 429, Date.now() - t0);
      return tooMany('Too many auth attempts — please wait 15 minutes and try again.');
    }
    if (url.pathname.startsWith('/api/') && !rateOk(ip, 'api', API_LIMIT, AUTH_WINDOW_MS)) {
      recordRequest(route, 429, Date.now() - t0);
      return tooMany('Too many requests — please slow down and try again in a few minutes.');
    }

    let out;
    if (url.pathname.startsWith('/api/auth/')) {
      out = await handleAuth(request, url, env, ctx);
    } else if (url.pathname.startsWith('/api/shares/')) {
      out = await handleShares(request, url, env);
    } else if (url.pathname.startsWith('/api/billing/')) {
      out = await handleBilling(request, url, env);
    } else if (url.pathname.startsWith('/api/sessions')) {
      out = await handleSessions(request, url, env);
    } else if (url.pathname === '/api/me/plan') {
      out = await handlePlan(request, env);
    } else {
      out = json({ error: 'Not found' }, 404);
    }

    // Re-apply CORS headers on the way out (Response headers are immutable)
    const finalHeaders = new Headers(out.headers);
    for (const [k, v] of Object.entries(cors)) finalHeaders.set(k, v);
    const res = new Response(out.body, { status: out.status, headers: finalHeaders });
    recordRequest(route, res.status, Date.now() - t0);
    return res;
  },
};
