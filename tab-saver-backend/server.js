const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const { rateLimit } = require('express-rate-limit');

dotenv.config();
const app = express();

/* ------------------------------------------------------------------ *
 * CORS — explicit allow-list. NEVER origin:'*' (launch blocker fix).
 *  • chrome-extension://<id> — allowed: the popup/background call this API
 *    with their host permission. CORS is not an auth boundary anyway —
 *    every route still requires a valid JWT.
 *  • Web origins come from ALLOWED_ORIGINS (comma separated). When unset we
 *    allow ONLY the local dev popup, so a forgotten env var can never
 *    silently re-open the API to every website on the internet.
 * ------------------------------------------------------------------ */
const devOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const configuredOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const originList = configuredOrigins.length ? configuredOrigins : devOrigins;

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / server-to-server (no Origin header)
    if (origin.startsWith('chrome-extension://')) return cb(null, true);
    cb(null, originList.includes(origin));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));

/* 🛑 WEBHOOK RAW BODY (B2) — the Lemon Squeezy HMAC is computed over the
   EXACT bytes we received, so this path must bypass express.json() (which
   would re-serialize and break the signature). Mounted first, scoped to the
   webhook path only; everything else keeps the normal JSON parser. */
app.use('/api/billing/webhook', express.raw({ type: () => true, limit: '256kb' }));

app.use(express.json());
// The password-reset page posts a classic HTML form (urlencoded).
app.use(express.urlencoded({ extended: true }));

/* Behind a reverse proxy in production set TRUST_PROXY=1 (or 'true' for one
   hop) so rate limiting keys on X-Forwarded-For instead of the proxy IP.
   Off by default: trusting XFF without a proxy lets clients spoof their IP. */
if (process.env.TRUST_PROXY) {
  const v = process.env.TRUST_PROXY;
  app.set('trust proxy', v === 'true' ? 1 : (Number.isFinite(Number(v)) ? Number(v) : v));
}

// Baseline security headers (no helmet dependency needed for these three)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // HSTS only means anything (and is only accepted by browsers) over HTTPS;
  // emit it whenever we know the deployment terminates TLS.
  if (process.env.FORCE_HTTPS === '1') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Global Request Logger (✅ next() zaroori hai)
app.use((req, res, next) => {
  console.log(`📥 [${new Date().toISOString()}] ${req.method} ${req.url}`);
  next(); // ✅ Request ko aage bhejo
});

/* ------------------------------------------------------------------ *
 * RATE LIMITING — launch blocker fix (auth had zero protection).
 *  • /api/auth  → 25 requests / 15 min / IP  (login brute-force, register spam)
 *  • /api       → 300 requests / 15 min / IP (everything else)
 * Preflight OPTIONS never reaches these (cors answers it first), so the
 * limits count real API calls only.
 * ------------------------------------------------------------------ */
const tooMany = (error) => ({ error });
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooMany('Too many requests — please slow down and try again in a few minutes.'),
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 25,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooMany('Too many auth attempts — please wait 15 minutes and try again.'),
});
app.use('/api', apiLimiter);
app.use('/api/auth', authLimiter);

// Database connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected successfully');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  }
};

// 🆕 HEALTH — unauthenticated liveness probe for the deploy host's
// healthCheckPath (Render/Railway ping this; also handy for curl checks).
// Sits under the general /api limiter (300 req/15 min/IP — a host polling
// every 30s uses ~30 of that budget, far from the ceiling) and reveals
// nothing beyond "the process is up".
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// 💰 PLAN / QUOTA (A2) — entitlement read for the extension. The PATH matches
// the Worker exactly (/api/me/plan) so the store build can talk to either
// backend unchanged. Answer comes from plans.js — the SAME constant the
// enforcement in routes/sessions.js uses.
const auth = require('./middleware/auth');
const User = require('./models/User');
const Session = require('./models/Session');
const { planFor, tierFor, billingConfigured } = require('./plans');
app.get('/api/me/plan', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('plan').lean();
    const { plan, limit } = planFor(user && user.plan);
    const used = await Session.countDocuments({ userId: req.user.id, deletedAt: null, isAutoSave: false });
    res.json({
      plan,
      limits: { maxSyncedSessions: limit },
      features: { maxVersions: tierFor(plan).maxVersions }, // B7 depth
      usage: { syncedSessions: used },
      billing: { configured: billingConfigured() }, // Upgrade CTA honesty
    });
  } catch (err) {
    console.error('❌ Plan GET Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/shares', require('./routes/shares'));

/* ------------------------------------------------------------------ *
 * HTTPS — optional, verified by tab-saver-backend/tests/launch-hardening.test.mjs
 *  • SSL_CERT + SSL_KEY set → serve TLS on SSL_PORT (default 5443).
 *  • FORCE_HTTPS=1 (requires certs) → plain HTTP listener answers 301 to
 *    https://<host>:<SSL_PORT>… and HSTS header turns on (see above).
 * In production the recommended shape is TLS at the proxy (Render/Railway/
 * nginx) — this covers deployments where Node terminates TLS itself.
 * ------------------------------------------------------------------ */
const PORT = Number(process.env.PORT) || 5000;
const sslCertPath = process.env.SSL_CERT;
const sslKeyPath = process.env.SSL_KEY;
const SSL_PORT = Number(process.env.SSL_PORT) || 5443;
const forceHttps = process.env.FORCE_HTTPS === '1' && !!(sslCertPath && sslKeyPath);

connectDB().then(() => {
  if (sslCertPath && sslKeyPath) {
    const tlsServer = https.createServer({
      cert: fs.readFileSync(sslCertPath),
      key: fs.readFileSync(sslKeyPath),
    }, app);
    tlsServer.listen(SSL_PORT, () => console.log(`🔒 HTTPS server running on port ${SSL_PORT}`));
  } else if (process.env.FORCE_HTTPS === '1') {
    console.warn('⚠️  FORCE_HTTPS=1 ignored: SSL_CERT/SSL_KEY not provided.');
  }

  if (forceHttps) {
    http.createServer((req, res) => {
      const host = (req.headers.host || 'localhost').split(':')[0];
      res.writeHead(301, { Location: `https://${host}:${SSL_PORT}${req.url}` });
      res.end();
    }).listen(PORT, () => console.log(`↪️  HTTP→HTTPS redirect on port ${PORT}`));
  } else {
    http.createServer(app).listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  }
});
