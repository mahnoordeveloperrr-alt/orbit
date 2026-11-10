const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const User = require('../models/User');
const Session = require('../models/Session');
const auth = require('../middleware/auth');
const { planFor, tierFor, billingConfigured } = require('../plans');
const nodemailer = require('nodemailer');

/* 🛒 BILLING (B2) — Lemon Squeezy, Merchant of Record (handles global VAT
   for a solo dev worldwide). Mirrors the Worker's /api/billing exactly:
   POST /checkout hands back a HOSTED checkout URL; POST /webhook is the
   ONLY code path that may write users.plan. Secrets are OPTIONAL env —
   without them /checkout answers an honest 503 and nothing changes. */

const lsConfig = () => ({
  apiKey: process.env.LEMONSQUEEZY_API_KEY || '',
  storeId: process.env.LEMONSQUEEZY_STORE_ID || '',
  variantId: process.env.LEMONSQUEEZY_VARIANT_ID || '',
  secret: process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '',
  portalUrl: process.env.BILLING_PORTAL_URL || '',
});

// Timing-safe hex compare (webhook signature) — no early-out on first byte.
function sigMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* 📧 B6 — lifecycle email on a REAL plan change (gmail transport shared
   shape with routes/auth.js). Never blocks or fails the flip itself. */
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  tls: { rejectUnauthorized: false },
});
async function notifyPlanChange(email, plan) {
  const html = plan === 'pro'
    ? `<h2 style="color:#4f46e5;">You're on Pro</h2>
       <p>Cloud sync is now unlimited — every saved session syncs across your devices, and version history keeps the last 20 states of each session.</p>
       <p style="color:#64748b;font-size:12px;">Manage or cancel any time from the link in your checkout receipt.</p>`
    : `<h2 style="color:#4f46e5;">You're back on the Free plan</h2>
       <p>Your subscription ended. Cloud sync stays on for up to the free-plan limit; everything else (local sessions, restore, crash recovery) is unchanged and stays yours.</p>`;
  try {
    await transporter.sendMail({
      from: `"Orbitabs" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: plan === 'pro' ? 'Orbitabs Pro is active 🎉' : 'Your Orbitabs plan changed',
      html,
    });
  } catch (err) {
    console.error('Plan-change email failed:', err.message);
  }
}

// POST /api/billing/checkout (auth) — hosted checkout URL for the Pro
// variant. custom_data.userId is the webhook's ONLY join key back to us.
router.post('/checkout', auth, async (req, res) => {
  try {
    const c = lsConfig();
    if (!billingConfigured()) {
      return res.status(503).json({ error: 'Billing is not configured on this backend yet.', code: 'billing-not-configured' });
    }
    const user = await User.findById(req.user.id).lean();
    if (!user) return res.status(401).json({ error: 'Account no longer exists' });

    const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
    const r = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.apiKey}`,
        'Content-Type': 'application/vnd.api+json',
        Accept: 'application/vnd.api+json',
      },
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              email: user.email,
              custom: { userId: String(user._id) },
            },
            product_options: base ? { redirect_url: `${base}/dashboard.html?upgraded=1` } : undefined,
          },
          relationships: {
            store: { data: { type: 'stores', id: String(c.storeId) } },
            variant: { data: { type: 'variants', id: String(c.variantId) } },
          },
        },
      }),
    });
    const json = await r.json().catch(() => null);
    const url = json && json.data && json.data.attributes && json.data.attributes.url;
    if (!r.ok || !url) {
      console.error('Lemon Squeezy checkout error:', r.status, JSON.stringify(json || {}));
      return res.status(502).json({ error: 'Could not start checkout — try again in a minute.' });
    }
    res.json({ url });
  } catch (err) {
    console.error('Checkout Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/webhook — HMAC-verified plan flips. Body is a raw
// Buffer (mounted in server.js BEFORE express.json) because the signature
// covers the exact received bytes. Idempotent: same-plan events no-op.
router.post('/webhook', async (req, res) => {
  try {
    const c = lsConfig();
    if (!c.secret) return res.status(500).json({ error: 'Webhook secret not configured' });

    const signature = req.header('x-signature') || '';
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const expected = crypto.createHmac('sha256', c.secret).update(raw).digest('hex');
    if (!sigMatches(String(signature).toLowerCase(), expected)) {
      // 401 — same status the Worker answers for a bad signature (parity).
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = JSON.parse(raw.toString('utf8'));
    const event = payload && payload.meta && payload.meta.event_name;
    const userId = payload && payload.meta && payload.meta.custom_data && payload.meta.custom_data.userId;
    if (!userId) return res.json({ received: true, ignored: 'no custom_data.userId' });

    const ACTIVATE = new Set(['subscription_created', 'subscription_updated', 'subscription_resumed']);
    const DEACTIVATE = new Set(['subscription_cancelled', 'subscription_expired']);
    let plan = null;
    if (ACTIVATE.has(event)) plan = 'pro';
    else if (DEACTIVATE.has(event)) plan = 'free';
    else return res.json({ received: true, ignored: event || 'unknown-event' });

    const user = await User.findById(userId);
    if (!user) return res.json({ received: true, ignored: 'unknown-user' });
    if (user.plan === plan) return res.json({ received: true, unchanged: true });

    user.plan = plan;
    await user.save();
    console.log(`💰 Webhook: user ${userId} → ${plan} (${event})`);
    notifyPlanChange(user.email, plan); // best-effort, B6
    res.json({ received: true, plan });
  } catch (err) {
    console.error('Webhook Error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// GET /api/billing/config — public-ish (still behind auth middleware): lets
// the Upgrade card say whether billing is actually live before you click.
router.get('/config', auth, (req, res) => {
  const c = lsConfig();
  res.json({ configured: billingConfigured(), portalUrl: c.portalUrl || null });
});

module.exports = router;
