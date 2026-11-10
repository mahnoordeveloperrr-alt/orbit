// ============================================================================
// SAAS SURFACE AUDIT (fast, no services) — the B1–B7 wiring contract across
// all four layers, checked in source: Worker (cloud-api), Express mirror
// (tab-saver-backend), popup (src/), web dashboard (site/).
//
// This suite cannot prove runtime behavior (e2e-cloud-api W11 and
// e2e-cloudsync D8 do that against real backends) — it proves the SEAMS
// exist everywhere they must and that the two backends can't drift on the
// numbers users are promised (tier depths, quota shape, webhook scheme).
//
// Run: node scripts/saas-surface.test.mjs
// ============================================================================

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};

const worker = read('cloud-api/worker.js');
const plans = read('tab-saver-backend/plans.js');
const server = read('tab-saver-backend/server.js');
const exSessions = read('tab-saver-backend/routes/sessions.js');
const exBilling = read('tab-saver-backend/routes/billing.js');
const exShares = read('tab-saver-backend/routes/shares.js');
const exAuth = read('tab-saver-backend/routes/auth.js');
const api = read('src/services/api.js');
const sessionList = read('src/popup/components/dashboard/SessionList.jsx');
const settings = read('src/popup/pages/Settings.jsx');
const dashboardJs = read('site/public/dashboard.js');

/* ---------------- S1 · Worker: tiers + entitlement ---------------- */
console.log('\n── S1. Worker tiers (B1) ──');
ok('TIERS table: free=3 versions, pro=20 versions',
  /free:\s*\{[^}]*maxVersions:\s*3/.test(worker) && /pro:\s*\{[^}]*maxVersions:\s*20/.test(worker));
ok('tierFor is the single tier resolver', /const tierFor = \(plan, env\)/.test(worker));
ok('/api/me/plan answers features.maxVersions + billing.configured',
  /features:\s*\{\s*maxVersions:\s*tier\.maxVersions\s*\}/.test(worker) &&
  /billing:\s*\{\s*configured:\s*billingConfigured\(env\)/.test(worker));
ok('quota gate is tier-driven (quota-exceeded +402)', /quota-exceeded/.test(worker) && /status:\s*402|,\s*402\)/.test(worker));

/* ---------------- S2 · Worker: billing (B2/B6) ---------------- */
console.log('\n── S2. Worker billing ──');
ok('checkout route exists and is auth-gated', /path === '\/checkout' && request\.method === 'POST'/.test(worker) && /billingConfigured\(env\)/.test(worker));
ok('webhook verifies raw-body HMAC over x-signature', /arrayBuffer\(\)/.test(worker) && /x-signature/.test(worker) && /createHmac|crypto\.subtle/.test(worker));
ok('webhook reads custom_data.user_id (its checkout writes it)', /custom_data\?\.user_id/.test(worker) && /custom:\s*\{\s*user_id:\s*auth\.userId\s*\}/.test(worker));
ok('webhook event sets: activate (created/updated) + revoke (expired/refunded)',
  /subscription_created/.test(worker) && /subscription_expired/.test(worker) && /subscription_refunded/.test(worker));
ok('plan-change email is best-effort (B6)', /notifyPlanChange\(env, user\.email, plan\)/.test(worker));
ok('GET /billing/config answers configured + portalUrl', /path === '\/config' && request\.method === 'GET'/.test(worker) && /portalUrl/.test(worker));
ok('nothing but the webhook writes users.plan', (worker.match(/UPDATE users SET plan/g) || []).length === 1);

/* ---------------- S3 · Worker: versions + shares + cascades (B5/B7) ------- */
console.log('\n── S3. Worker versions/shares ──');
ok('session_versions table bootstrapped', /CREATE TABLE IF NOT EXISTS session_versions/.test(worker));
ok('shares table bootstrapped', /CREATE TABLE IF NOT EXISTS shares/.test(worker));
ok('PUT archives the pre-write state through archiveVersion', /archiveVersion\(env\.DB, userId, row,/.test(worker));
ok('GET /:id/versions + POST /:id/versions/:vid/restore routes exist',
  worker.includes('/^\\/[^/]+\\/versions$/.test(path) && request.method === ' + "'") &&
  worker.includes('/^\\/[^/]+\\/versions\\/[^/]+\\/restore$/.test(path) && request.method === ' + "'"));
ok('restore re-archives current state then bumps updated_at (LWW propagation)',
  (worker.match(/archiveVersion\(env\.DB, userId, row, tierFor\(await planOf\(env\.DB, userId\), env\)\.maxVersions\)/g) || []).length >= 2 &&
  /new Date\(\)\.toISOString\(\), id, userId\s*\)\s*\.run\(\);\s*return json\(sessionOut/.test(worker));
ok('share mint route rotates per session + returns 30-day expiry', /\/share\$\/\.test\(path\) && request\.method === 'POST'/.test(worker) && /30 \* 24 \* 60 \* 60 \* 1000/.test(worker));
ok('share claim applies the same quota gate as POST /sessions', /quota-exceeded/.test(worker.slice(worker.indexOf('async function handleShares'))) || /handleShares[\s\S]*quota-exceeded/.test(worker));
ok('purge cascades versions + shares of the row', /DELETE FROM session_versions WHERE user_id = \? AND session_id = \?/.test(worker) && /DELETE FROM shares WHERE user_id = \? AND session_id = \?/.test(worker));
ok('account deletion wipes versions + shares (privacy commitment)',
  /DELETE FROM session_versions WHERE user_id = \?'\)\.bind\(auth\.userId\)/.test(worker) &&
  /DELETE FROM shares WHERE user_id = \?'\)\.bind\(auth\.userId\)/.test(worker));
ok('orphan sweep runs on trash purge + 30-day expiry', /sweepOrphans\(env\.DB, userId\)/.test(worker));

/* ---------------- S4 · Express mirror parity ---------------- */
console.log('\n── S4. Express parity ──');
ok('plans.js: same tier numbers (3/20) + tierFor + billingConfigured',
  /free:\s*\{[^}]*maxVersions:\s*3/.test(plans) && /pro:\s*\{[^}]*maxVersions:\s*20/.test(plans) &&
  /function tierFor/.test(plans) && /billingConfigured\s*=\s*\(\)\s*=>/.test(plans));
ok('server.js mounts raw body for /webhook BEFORE express.json',
  server.indexOf("app.use('/api/billing/webhook', express.raw(") < server.indexOf('app.use(express.json())'));
ok('server.js mounts /api/billing + /api/shares routers',
  /app\.use\('\/api\/billing', require\('\.\/routes\/billing'\)\)/.test(server) &&
  /app\.use\('\/api\/shares', require\('\.\/routes\/shares'\)\)/.test(server));
ok('/api/me/plan answers features.maxVersions + billing.configured',
  /features:\s*\{\s*maxVersions:\s*tierFor\(plan\)\.maxVersions\s*\}/.test(server) &&
  /billing:\s*\{\s*configured:\s*billingConfigured\(\)\s*\}/.test(server));
ok('sessions.js archives pre-write state (B7) + prunes to tier depth',
  /archiveVersion\(req\.user\.id, session, ent\.maxVersions\)/.test(exSessions));
ok('sessions.js has versions list + restore + share mint routes',
  /'\/:id\/versions'/.test(exSessions) && /'\/:id\/versions\/:vid\/restore'/.test(exSessions) && /'\/:id\/share'/.test(exSessions));
ok('sessions.js purge + account cascade helpers present',
  /SessionVersion\.deleteMany\(\{ userId: req\.user\.id, sessionId: String\(session\._id\) \}\)/.test(exSessions) &&
  /sweepOrphans\(req\.user\.id\)/.test(exSessions));
ok('Express billing: raw-buffer HMAC + event_name + custom_data.userId',
  /Buffer\.isBuffer\(req\.body\)/.test(exBilling) && /x-signature/.test(exBilling) &&
  /event_name/.test(exBilling) && /custom_data && payload\.meta\.custom_data\.userId/.test(exBilling));
ok('Express billing: same activation/revocation events + plan-change email',
  /subscription_created/.test(exBilling) && /subscription_expired/.test(exBilling) && /notifyPlanChange/.test(exBilling));
ok('Express shares: dedupe by name+createdAt + quota gate',
  /snap\.name \|\| null, snapCreated/.test(exShares) && /quota-exceeded/.test(exShares));
ok('Express account deletion wipes versions + shares',
  /SessionVersion\.deleteMany\(\{ userId: req\.user\.id \}\)/.test(exAuth) && /Share\.deleteMany\(\{ userId: req\.user\.id \}\)/.test(exAuth));
ok('models SessionVersion + Share exist', existsSync(join(root, 'tab-saver-backend/models/SessionVersion.js')) && existsSync(join(root, 'tab-saver-backend/models/Share.js')));

/* ---------------- S5 · Popup client wiring (B3/B5/B7) ---------------- */
console.log('\n── S5. Popup wiring ──');
ok('api.js exposes versions/share/billing endpoints',
  /getVersions/.test(api) && /restoreVersion/.test(api) && /shareSession/.test(api) &&
  /startCheckout/.test(api) && /getBillingConfig/.test(api));
ok('SessionList menu: History… + Share… entries gated on cloudId',
  /setHistoryFor\(session\)/.test(sessionList) && /setShareFor\(session\)/.test(sessionList) &&
  /session\.cloudId && !session\.isAutoSave/.test(sessionList) && /session\.cloudId && \(/.test(sessionList));
ok('modals rendered + onRestored wired to reload',
  /<ShareModal/.test(sessionList) && /<VersionHistoryModal/.test(sessionList) && /onRestored\?\.\(\)/.test(sessionList) &&
  /onRestored=\{loadSessions\}/.test(read('src/popup/pages/Dashboard.jsx')));
ok('version restore triggers an immediate SYNC_NOW pull', /SYNC_NOW/.test(read('src/popup/components/dashboard/VersionHistoryModal.jsx')));
ok('Settings: Upgrade card → hosted checkout, Pro card → manage billing',
  /handleUpgrade/.test(settings) && /startCheckout/.test(settings) && /Manage billing/.test(settings) &&
  /billing-not-configured/.test(settings));
ok('checkout opens in a NEW TAB (never in the popup frame)', /chrome\.tabs\.create\(\{ url \}\)/.test(settings));

/* ---------------- S6 · Web dashboard (B4/B5) ---------------- */
console.log('\n── S6. Web dashboard (site/) ──');
for (const f of ['dashboard.html', 'dashboard.css', 'dashboard.js']) {
  ok(`site/public/${f} exists`, existsSync(join(root, 'site/public', f)));
}
ok('dashboard.js never touches chrome.* (it is a WEB page)', !/chrome\./.test(dashboardJs));
ok('dashboard.js resolves the API worker origin (same as Store build)',
  dashboardJs.includes('site-8b67ef3788b2498f88d007d22c888375.freebuff.page'));
ok('dashboard: sign-in → sessions → search/folders/export', /auth\/login/.test(dashboardJs) && /\/sessions/.test(dashboardJs) && /toCsv/.test(dashboardJs));
ok('dashboard: ?share= claim flow (preview + import + dedupe message)', /SHARE_TOKEN/.test(dashboardJs) && /\/shares\//.test(dashboardJs) && /deduped/.test(dashboardJs));
ok('dashboard: 401 → refresh once → retry (sliding session on web)', /auth\/refresh/.test(dashboardJs));
ok('dashboard: plan card + upgrade via hosted checkout', /\/me\/plan/.test(dashboardJs) && /billing\/checkout/.test(dashboardJs));
ok('landing page links the dashboard', /dashboard\.html/.test(read('site/public/index.html')));

/* ---------------- S7 · Cross-backend drift guard ---------------- */
console.log('\n── S7. Drift guard (both backends promise the same thing) ──');
const same = (re, files) => files.every((f) => re.test(f));
ok('both backends answer the same quota-exceeded contract', same(/quota-exceeded/, [worker, exSessions, exShares]));
ok('both backends keep the same tier depths (3/20)', same(/maxVersions:\s*3/, [worker, plans]) && same(/maxVersions:\s*20/, [worker, plans]));
ok('both backends verify the webhook with HMAC-SHA256 over the raw body',
  /HMAC/.test(worker) && /createHmac\('sha256'/.test(exBilling));
ok('both backends expose share claim with dedupe', /deduped/.test(worker) && /deduped/.test(exShares));
ok('both backends cascade versions+shares on purge and account deletion',
  /session_versions/.test(worker) && /SessionVersion\.deleteMany/.test(exSessions) &&
  /Share\.deleteMany\(\{ userId: req\.user\.id \}\)/.test(exAuth));

console.log(`\n════════════════════════════════════════════════`);
console.log(`  SAAS SURFACE AUDIT: ${pass} passed, ${fail} failed`);
console.log(`════════════════════════════════════════════════\n`);
process.exit(fail > 0 ? 1 : 0);
