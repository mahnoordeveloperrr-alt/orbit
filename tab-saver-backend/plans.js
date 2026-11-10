// 💰 PLAN / QUOTA CONSTANTS — shared by the API surface (/api/me/plan) and
// the enforcement point (routes/sessions.js POST /). ONE definition so
// "what the extension is told" can never drift from "what the server
// enforces" — the same seam the Worker keeps in TIERS/tierFor.
//
// FREE_SESSION_LIMIT — live, non-autosave sessions a 'free' account may
// keep in cloud sync. -1 disables the cap (self-hosters who don't want a
// quota set FREE_SESSION_LIMIT=-1). Billing flips users to 'pro' (unlimited)
// without touching this file.
const FREE_SESSION_LIMIT = (() => {
  const raw = process.env.FREE_SESSION_LIMIT;
  if (raw === undefined || raw === null || raw === '') return 100;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 100;
})();

// TIERS (B1) — free: capped sync + short version history; pro: unlimited
// sync + deep history. maxSyncedSessions -1 = unlimited. Only the billing
// webhook may ever set users.plan = 'pro'.
const TIERS = {
  free: { maxSyncedSessions: () => FREE_SESSION_LIMIT, maxVersions: 3 },
  pro: { maxSyncedSessions: () => -1, maxVersions: 20 },
};
function tierFor(plan) {
  const t = TIERS[plan] || TIERS.free;
  return { maxSyncedSessions: t.maxSyncedSessions(), maxVersions: t.maxVersions };
}

/** Entitlement for one account: plan + limit (-1 = unlimited) + usage. */
function planFor(plan) {
  const p = plan === 'pro' ? 'pro' : 'free';
  return { plan: p, limit: tierFor(p).maxSyncedSessions };
}

// 🛑 BILLING (B2) — Lemon Squeezy credentials present? Without them
// /api/billing/checkout answers an honest 503 and NOTHING about plans
// changes; the webhook is the only thing that can ever set plan='pro'.
const billingConfigured = () =>
  !!(process.env.LEMONSQUEEZY_API_KEY && process.env.LEMONSQUEEZY_STORE_ID && process.env.LEMONSQUEEZY_VARIANT_ID);

module.exports = { FREE_SESSION_LIMIT, planFor, tierFor, billingConfigured };
