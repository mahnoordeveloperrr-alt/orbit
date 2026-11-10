# Orbitabs — Completion Audit & Final Publish Report

**Date:** October 15, 2026 (rev. — **cloud round: hosted API live + zero-config store build**) · **Build:** v1.5.0 (`orbitabs-1.5.0-store.zip`)
**Method:** har checklist item ko source review + live test se verify kiya gaya. Jo complete tha usko dobara nahi banaya — sirf proof ke saath ✅ mark kiya. Jo incomplete tha wo **ab bana aur test hua**.

---

## Verification totals (sab dobara chala kar)

| Suite | Checks | Result |
|---|---|---|
| 16 extension suites (incl. `metadata-preview` 52 + `e2e-cloudsync` 25 + `cloudsync` 37) | **706** | ✅ 0 failures |
| E2E cloud API (real extension SW ↔ real Worker ↔ real D1) — local wrangler **+ live production origin** | **33 + 33** | ✅ 0 failures |
| Backend `launch-hardening` (rate limit, CORS, HTTPS, deletion, /api/health) | 28 | ✅ |
| Backend `sync-account` (PUT LWW + password-recovery lifecycle) | 17 | ✅ |
| Backend `realdb-proof` (durable on-disk mongod, restart-survives) | 12 | ✅ |
| Source audit (`audit-day2` day-2 statement) | 31 | ✅ |
| Live production probes: `/api/health` `{ok:true,db:true}` + CORS preflight 204 (ACAO `chrome-extension://`) + foreign origin 403 | 4 | ✅ |
| Popup origin resolution (real `api.js` axios interceptor × 3: store → baked, dev → localhost, Server URL override) | 3 | ✅ |
| **Total (automated checks)** | **867** | ✅ 0 failures |
| Lint (`--max-warnings 0`) / build | exit 0 / exit 0 | ✅ |
| Live browser pass (420×560, dark+light, Organize+Preview flows, folder chips — prior round; popup layout untouched this round) | 0 overflow, 0 console errors | ✅ |

---

## P0 — Core product (8/8 ✅ — verify kiya, dobara nahi banaya)

| Item | Status | Evidence |
|---|---|---|
| Save sessions (all/current window, order, names) | ✅ | dashboard-smoke 22, e2e suites |
| Restore sessions (multi-window, partial-failure feedback) | ✅ | e2e-production 46 (5 windows/200 tabs), e2e-commands 28 |
| Chrome tab groups (title/color/membership/collapsed) | ✅ | e2e-groups 38 |
| Pinned + active tabs per window | ✅ | e2e-production, e2e-commands |
| Auto-save + Live Backup (ON indicator, honest failures) | ✅ | settings A4–A6, reliability A4 |
| Crash recovery (candidate, restore, dismiss, no dupes) | ✅* | reliability A1–A3, crash-UX 19/19 (*onStartup delivery = manual drill, [CRASH_DRILL_RUNBOOK.md](CRASH_DRILL_RUNBOOK.md)) |
| Session management (rename/delete/trash/undo/purge/retention) | ✅ | dashboard-smoke, settings 57 |
| Search + organization | ✅ | search-smoke 17, organize-smoke 17 |

## P0 — Data safety (8/8 ✅ — ek gap tha, wo ab close)

| Item | Status | Evidence |
|---|---|---|
| Export downloads required session data | ✅ | backup-roundtrip 59 |
| Import accepts valid, rejects invalid/corrupt | ✅ | 13 rejected envelopes, store byte-identical |
| Duplicate imports predictable, no overwrites | ✅ | dedupe by name+createdAt; re-import = no-op |
| Unknown schema/version handled safely | ✅ | version 99 → rejected/normalized, never stored raw |
| Delete/undo leaves expected state | ✅ | soft-delete + 30-day retention suites |
| **Storage quota / full-disk → clear error** | ✅ **NEW** | `writeAll` now throws an actionable "storage is full — export then delete" message; quota + non-quota paths tested (cloudsync B1, 4 checks). Dashboard toast surfaces the real reason |
| Survives browser restart / update / reload | ✅ | chrome.storage.local by construction; settings B1b cold-restart proof |
| Recovery/backup options understandable | ✅ | Settings copy + privacy policy |

## P0 — Cloud sync & account (✅ complete + **DEPLOYED** — live par E2E-proven, zero-config)

| Item | Status | Evidence |
|---|---|---|
| Local-first: everything works without account | ✅ | localOnly hard switch, cloud off by default (settings A3/A9) |
| **Full cloud session sync** (upload, download on other device, status, errors) | ✅ **NEW — BUILT** | `syncLibrary()` in [background.js](public/background.js): push (trash + Live Backup excluded), pull (additive, deduped by cloudId + signature), per-session **last-write-wins** both directions, honest `orbi_sync_status` (lastSyncAt/pushed/updated/pulled/lastError), "Sync now" + status card in Settings. **Unit: cloudsync 37/37. E2E (real worker ↔ real backend ↔ real MongoDB, 2 devices): e2e-cloudsync 25/25** — Device A push → rename → LWW PUT → Device B pull → B's newer edit wins → A picks it up → server-down skip with byte-identical local data. E2E ne ek asli bug pakda (rename ke baad apni hi purani copy double-pull) — fix ho chuka hai |
| **Production backend** (hosted API + production DB + real deployed env) | ✅ **DEPLOYED (NEW)** | Cloudflare Worker + D1 (Sites) live par: **Production** `https://site-8b67ef3788b2498f88d007d22c888375.freebuff.page` + isolated **Preview**, JWT secret set. `/api/health` → `{"ok":true,"db":true}` live. **Full E2E 33/33 — local wrangler aur live production dono par** (real extension SW ↔ real Worker ↔ real D1, public internet). CORS preflight live-proven (204 + ACAO `chrome-extension://`, foreign origin 403). Express+Mongo [render.yaml](tab-saver-backend/render.yaml) = self-host alternative (launch-hardening 28/28 + realdb 12/12). **Store build zero-config**: production origin baked in (cloudsync A2) |
| **Account lifecycle** (signup, login, verify, logout, expiry, **recovery**, deletion, cloud-data deletion) | ✅ **recovery NEW** | **Forgot/reset password** shipped: backend `POST /forgot-password` (no account enumeration, 30-min single-use token) + reset page + JSON path; Login UI "Forgot password?" flow. `sync-account` 17/17: old password dead, new works, token single-use, replay 400, expired 400, weak 400. **Expired-token handling NEW**: 401 interceptor clears token everywhere → UI honestly shows "Not connected" (was: zombie connected state) |

**Trash scope note (honest):** V1 sync = live sessions only. Trash stays on each device (never uploaded, never resurrected). Live Backup rides its own `/autosave` upsert. Deletion does not yet propagate across devices — flagged as P2 below.

## P1 — Settings & UX behavior (8/8 ✅)

| Item | Status | Evidence |
|---|---|---|
| Every toggle has real effect + persists | ✅ | settings suite 57 (worker wiring A1–A11, store B1–B5) |
| Theme consistent | ✅ | light/dark verified live (both themes) |
| Save/restore/import/export/delete messages clear | ✅ | saveFeedback toasts; **quota errors now actionable (NEW)** |
| "This window" vs "All windows" clear | ✅ | scope preselect + capture paths |
| Empty state, welcome, recovery banner actions | ✅ | dashboard-smoke, crash-UX 19/19 |
| Trash/undo/permanent-delete confirmations | ✅ | confirm-gated destructive actions |
| Cloud settings honestly represent sync | ✅ **upgraded** | ab real sync status dikhta hai: last-synced time, pushed/updated/pulled counts, failure reason, "Sync now" button (cloudsync suite) |
| Keyboard nav / focus / labels basic level | ✅ | a11y probe (labels, focus visibility, 0 page errors) |

## P1 — Engineering & production readiness (9/9 ✅ — Atlas/Render = optional self-host step only)

| Item | Status | Evidence |
|---|---|---|
| Permissions audit | ✅ | no `host_permissions`; CORS allow-list; real-browser proof 10/10 |
| **Dev/prod API separation; no localhost in production** | ✅ **NEW** | Store-installed builds (Chrome adds `update_url`) get the **baked hosted production origin** (`STORED_API_ORIGIN` in `background.js` + `api.js`) — cloud sync zero-config, aur localhost kabhi touch nahi hota. Settings → Server URL ab sirf self-host override hai; dev/unpacked loads keep `127.0.0.1:5000`. Both branches tested in cloudsync A2 |
| **Database: real hosted + restart persistence** | ✅ **hosted LIVE** | Production cloud DB = **D1 (Cloudflare)** — live aur E2E-proven (33/33 local + production). Express alternative ka durability proof bhi green: on-disk mongod 12/12 (WiredTiger, full restart). Self-host chahiye to [render.yaml](tab-saver-backend/render.yaml): Atlas M0 cluster banana (free, no card) → SRV string `MONGO_URI` me paste — same code path |
| Security (auth, authz, rate limit, CORS, HTTPS, logs, secrets) | ✅ | 28/28 incl. new endpoints under the same auth + limiter |
| Account deletion → cloud data removed | ✅ | user + all sessions wiped; stale token 401 (verified live) |
| **Error handling** (network down, 500, timeout, expired login, storage) | ✅ **upgraded** | 15s abort on every sync fetch; dead backend = honest skip + retry; **401 → auto sign-out (NEW)**; **quota → actionable message (NEW)**; suites pin all paths |
| Build/package (correct manifest, icons, no secrets/maps) | ✅ | v1.5.0 zip **rebuilt this round**: 15 entries, manifest at root, 173 KB, no maps/secrets/host_permissions, **baked production origin present in SW + popup bundle, `update_url` NOT in packaged manifest** |
| Resource issues (disk space) | ✅ **mitigated this round** | Project already on **D:** (`D:/desktop/Extension/tab-saver-extension`); **npm cache repointed to `D:/npm-cache`** + old 1.1 GB C: cache deleted (C: 4.1→4.9 GB free). Baqi: C: par user ke baaki apps — user ki side |
| Privacy disclosures match actual behavior | ✅ **updated** | Policy + live page updated: full sync + password-reset email. **New stable production URL: https://site-0f71d0986fe640a0b93af1d196f6b56b.freebuff.page** (200/text/html, verified contains the new text, zero stale "not live yet"). Purani URL (`site-512379db…`) abhi bhi stale content serve kar rahi hai lekin **is workspace mein accessible nahi** — Store listing me **nayi URL** use karein |

## P2 — Future features (recommendation, per your own table)

| Feature | Status now | Recommendation |
|---|---|---|
| Full cross-device sync | ✅ **live (deployed) — incl. V1.5 metadata** | Hosted API deployed + zero-config store build → usable right now; then it can back a subscription |
| Conflict resolution | ✅ basic LWW shipped | Deletion-propagation + richer merge = later |
| Scheduled cloud backups | ✅ rides the 30-min alarm | — |
| ~~Session notes/tags/folders~~ | ✅ **SHIPPED this round (V1.5)** | Tags (chips, max 20), folder (single label, chip-filter row in Dashboard), note (500-char) — card ⋯ → **Organize…** dialog with prefilled values + folder datalist. Schema `sanitizeTags` locked in sessionSchema.js (server normalizer mirrors it); survives export→import, search (tags/note/folder all searchable), AND cloud sync both ways (POST/PUT carry, pull + both LWW branches adopt). **Unit: metadata-preview 52/52. E2E (real worker ↔ real server ↔ real mongo, 2 devices): tags/note/folder byte-identical on device B; B's LWW edit updates server metadata; A adopts it** |
| ~~Compare / restore preview~~ | ✅ **SHIPPED this round (V1.5)** | Card ⋯ → **Preview**: window/group/tab structure + pinned markers + honest overlap compare against LIVE windows ("1 of these 2 tabs are already open — Chrome never closes your current tabs"); Restore CTA counts new tabs. No live capture (fresh profile/dev) → compare silently skipped, restore unaffected. metadata-preview 52/52 incl. trailing-slash URL normalization + compare-unavailable path |
| Markup/annotation | ✅ already in the build (V1.1) | — |
| Payments/billing portal | not built | Hosted sync service **ab usable hai** — your rule satisfied; billing ab pricing decision + real users ke baad |
| Analytics/onboarding experiments | not built | Later, and against the no-analytics privacy stance — needs a policy decision |

---

## Final percentages

| Scope | % | Kya baqi hai |
|---|---|---|
| **Chrome Web Store publish (the extension)** | **≈ 95%** (was 93%) | Code/package/policy sab done + re-verified (**867 checks**: 772 across 17 extension suites + 57 backend + 31 source audit + 4 live production probes + 3 popup-origin probe, 0 failures; V1.5 metadata + preview bhi included; cloud E2E ab **live production par 33/33**). Baqi sirf user actions: $5 developer registration → upload `orbitabs-1.5.0-store.zip` → listing paste ([STORE_LAUNCH.md](STORE_LAUNCH.md) §5/§8, **nayi privacy URL ke saath**) → review wait + 10-min manual crash drill |
| **Full SaaS (usable cloud service)** | **≈ 90%** (was 80%) | **Hosted API ab LIVE hai** — Sites Production + isolated D1, `/api/health` 200 `{ok:true,db:true}`, E2E 33/33 public internet par (local + production dono), CORS preflight proven, aur **Store build me origin baked → zero config** (Server URL set karne ki zarurat nahi; woh sirf self-host override). Baaki: real-Chrome me ek manual sign-in/sync smoke pass (E2E Node se chalta hai — Chrome ka final smoke 10-min runbook ka part hai), phir subscription billing (P2, sirf tab jab real users hon). Express/Render+Atlas path = self-host alternative |

**Bottom line:** ab tak **4 checklist items genuinely complete hue** — ① **Session notes/tags/folders** (Organize dialog, chips, folder filter row, search + export/import + **cross-device sync** dono taraf), ② **Compare/restore preview** (honest overlap compare + structure view), ③ **production-backend deploy path**, ④ **this round: hosted production API LIVE + zero-config Store build** (Sites Production + D1 deployed, JWT secret, E2E 33/33 local + live, CORS preflight proof, production origin baked into `background.js` + `api.js`, zip rebuilt) — sab tests ke saath (**867 checks total, 0 failures**) + live browser pass (Organize/Preview flows click karke verify). Disk item bhi mitigated (project already on D:, npm cache D: par, C: se 1.1 GB free). Product Store par ek user action door hai; cloud service usable hai — bass real-Chrome smoke + billing baqi.

**Honest limitations:** ① `onStartup` delivery automation se prove nahi ho sakta → [CRASH_DRILL_RUNBOOK.md](CRASH_DRILL_RUNBOOK.md) (10-min manual drill). ② Atlas/Render accounts aapke (billing-free dono) — sirf self-host path ke liye; hosted D1 ke liye zarurat nahi. ③ C: drive ab bhi 97% full — Orbitabs-related caches hataye (baaki apps aapki side). ④ ~~Cross-device **deletion** propagation V1 me nahi~~ → **FIXED in V1.6 addendum below**. ⑤ Cloud E2E Node/workerd se chalta hai — **real-Chrome sign-in/sync smoke** abhi manual hai (runbook me).

---

## V1.6 ADDENDUM — SaaS hardening round (Oct 16, 2026)

Scope: the six "charge karne se pehle kar lo" items (A1–A6). Method: implement → unit + two-backend E2E proof → docs. **Deploy intentionally NOT done (user authorization needed) — everything below is code-complete and locally verified.**

| # | Item | Status | Proof |
|---|---|---|---|
| **A1** | Cross-device **deletion propagation** | ✅ **SHIPPED** | Tombstones on BOTH backends (Worker `tombstones` table + `GET /api/sessions/tombstones`; Express `Tombstone` model). Soft-delete / bulk-delete / purge / restore all funnel through mark/clear helpers — **purge keeps its mark for the 30-day retention**, delete bumps `updated_at` (a delete is a write). Client (`syncLibrary`) applies cloud tombstones → local trash, pushes local deletes, lifts marks on restore, un-trashes when the cloud copy comes back newer; **LWW everywhere**: a local edit newer than the delete REVIVES instead of dying, and a purged row (404 on revive) is recreated under a fresh id — no data loss, no endless loops. Proof: `cloudsync` A9 **10** · `e2e-cloudsync` D7 **20** (real Express + real Mongo, 2 devices) · `e2e-cloud-api` W8b/W8c **14** (real Worker + real D1, 2 devices) |
| **A2** | **Server-side entitlement + quota** | ✅ **SHIPPED** | `users.plan` (default `free`) on both backends; `GET /api/me/plan` (same path on both) answers plan + limit + usage; `POST /api/sessions` enforces `FREE_SESSION_LIMIT` (**default 100**, `-1` disables) → honest **402 `code:'quota-exceeded'`**. Client stops hammering on 402 and records `lastError:'quota-exceeded'`; Settings shows **"Plan: Free — N/100 sessions synced"** + a plain-language limit message; local storage never capped. Proof: `e2e-cloud-api` W8e **8** (incl. `.dev.vars` override reaching the worker + over-cap device keeps its data) · `e2e-cloudsync` D7 quota **5** |
| **A3** | **Token lifecycle — refresh / sliding session** | ✅ **SHIPPED** | Login now returns a **30-day rotating refresh token** (stored SHA-256-hashed, one row per device, rotation → replay = 401, logout spends it, account deletion wipes them) on both backends. Client: `authedFetch` in the SW refreshes **once** on 401 and retries; the popup axios interceptor does the same, and only a DEAD refresh signs you out (honest "Not connected"). Proof: `e2e-cloud-api` W8d **7** — including REAL `background.js` handed an **expired** JWT recovering silently via refresh, rotated pair persisted · `e2e-cloudsync` D7 refresh **5** |
| **A4** | **Server-side ops metrics (no client analytics)** | ✅ **SHIPPED** | Worker keeps aggregate per-isolate counters (requests, errors, 4xx/5xx, route mix, auth/login/refresh/create/delete/quota, p95 over a 500-sample ring), flushed as **ONE PII-free structured log line** every 60s/500 requests; `/api/health` exposes `{uptimeMs, requests, errors, p95Ms}` so an uptime probe doubles as the alert channel. No client analytics added — the "no analytics, no trackers" promise stands (now spelled out in the policy: aggregate server logs only). Proof: W8e health-metrics check |
| **A5** | Production deploy + real-Chrome smoke | ⚠️ **PENDING (authorization/manual)** | New backend verified in **workerd locally (66/66)** and Express (45/45); live probes still green (health 200 `{ok:true,db:true}`, preflight 204 + ACAO `chrome-extension://`, foreign 403, privacy page 200). **Deploying the Worker (new endpoints) + the updated privacy page needs your go-ahead**; the 10-min real-Chrome sign-in/sync drill stays manual ([CRASH_DRILL_RUNBOOK.md](CRASH_DRILL_RUNBOOK.md) pattern) |
| **A6** | **Legal/listing — seller, terms, refund** | ✅ **DONE (1 fill-in)** | [PRIVACY_POLICY.md](PRIVACY_POLICY.md) (eff. Oct 16): refresh-token row, dual password-hashing truth, deletion-marks + free-plan-limit disclosures, server-diagnostics paragraph, new **§7 Payments & plans** (nothing sold today; Pro will be sold by the developer NOT Google; standing **14-day refund**; `[SELLER LEGAL NAME]` placeholder). [STORE_LAUNCH.md](STORE_LAUNCH.md): CWS "Accepting Payment From Users" **paste-block** + data-use row updated. Live policy page source [site/public/index.html](site/public/index.html) updated to match (**needs a Production deploy to show**) |

**Round totals:** **863 automated checks, 0 failures** — 16 extension suites **775** (incl. cloudsync 47, e2e-cloudsync 45, e2e-cloud-api 66) + backend **57** + source audit **31** · `lint` exit 0 · `build` exit 0 · **4 live production probes** · zip rebuilt (**15 entries, 176 KB**, tombstone/refresh/plan/quota strings verified inside the package, `update_url` absent, baked origin present).

**Backward compatibility (important):** the NEW client against the CURRENT (old) production Worker stays correct — tombstones / plan / refresh answer 404 → the client degrades to today's behavior (no propagation, no quota, sign-out on JWT expiry as before). Every A1–A4 benefit switches on the moment the Worker is redeployed; no client downgrade path is needed.

**Open items (none are code):** ① deploy Worker + privacy page to Production (your call); ② real-Chrome sign-in/sync smoke (runbook); ③ fill `[SELLER LEGAL NAME]` before any paid plan; ④ `FREE_SESSION_LIMIT` default 100 — change the constant/env if you want a different free cap.

---

## V1.7 ADDENDUM — SaaS product round (Oct 17, 2026)

Scope: your priority table (B1–B7) — Free/Pro tiers, hosted billing, paywall UX, web dashboard, shared sessions, lifecycle email, version history. Method: same as before — implement on BOTH backends, prove with real-HTTP E2E, then docs. **Deploy intentionally NOT done (needs your authorization); billing stays honestly inert until Lemon Squeezy credentials are set.**

| # | Item | Status | Proof |
|---|---|---|---|
| **B1** | **Free vs Pro tier definitions + entitlement gate** | ✅ **SHIPPED** | ONE `TIERS` table per backend (free: sync cap (`FREE_SESSION_LIMIT`, default 100) + **3** versions; pro: unlimited + **20** versions), resolved through `tierFor()`; `/api/me/plan` now answers `features.maxVersions` + `billing.configured` on both; Settings shows the tier card. Proof: `saas-surface` drift-guard (both backends same numbers) · `e2e-cloud-api` W11 · `e2e-cloudsync` D8 |
| **B2** | **Billing: hosted checkout + signature-verified webhook** | ✅ **SHIPPED (env-gated)** | Lemon Squeezy (MoR — worldwide VAT for a solo dev): `POST /api/billing/checkout` (auth) creates a hosted checkout carrying the internal user id in `custom_data`; `POST /api/billing/webhook` verifies **HMAC-SHA256 over the RAW request body** (`x-signature`, timing-safe compare) and is the **only** code path that writes `users.plan`. No credentials → checkout answers honest **503 `billing-not-configured`** and nothing about plans changes. Wrong signature → 401; replays idempotent. Proof: W11 (wrong sig 401, signed event flips to pro, expired→free) · D8 (same on Express, incl. quota lifting past the free cap) |
| **B3** | **Paywall UX in popup** | ✅ **SHIPPED** | Settings plan card: Free shows `N/M synced` + Upgrade (hosted checkout opens in a NEW tab; honest "Payments are not live on this server yet" when unconfigured); Pro shows badge + **Manage billing** portal link. Server still enforces — the UI only mirrors it. Proof: `saas-surface` S5 · lint/build · popup live pass |
| **B4** | **Web dashboard (site/)** | ✅ **SHIPPED** | [site/public/dashboard.html](site/public/dashboard.html) + `dashboard.css` + `dashboard.js` — vanilla, no build step, served by the privacy-site Worker. Sign-in (refresh-rotating), session browse, search (name/tags/note/URLs), folder chips, per-tab links, Copy-all, CSV/JSON export, plan card + upgrade. Cross-origin to the API worker — CORS already allowed `*.freebuff.page`; every call still carries the user's own JWT. Proof: `saas-surface` S6 (incl. "never touches chrome.*") |
| **B5** | **Shared sessions** | ✅ **SHIPPED** | `POST /api/sessions/:id/share` mints a **30-day token** (one live link per session — re-share rotates); snapshot frozen at mint; claim (`POST /api/shares/:token`) runs the **same quota gate + name/createdAt dedupe** as file import; neither side ever sees the other's email. Popup: card ⋯ → **Share…** (copy link + expiry + rotation). Dashboard: `?share=TOKEN` → sign in → preview → Import. Purge/account-deletion kill the link + snapshot rows. Proof: W11 + D8 (mint/preview/claim/dedupe/purge-dead) · **2 real bugs caught by these tests and fixed** (missing `crypto` require in Express share route; Worker snapshot missing `createdAt` which broke dedupe) |
| **B6** | **Lifecycle email on plan change** | ✅ **SHIPPED** | `notifyPlanChange` on both backends (Resend on Worker, the existing gmail transport on Express): "You're on Pro" / "You're back on Free" — best-effort, never blocks or fails the plan flip itself. Proof: W11/D8 flips (email path exercised without a key = resolves silently, the documented no-provider mode) |
| **B7** | **Version history (+ trash sync documented as already shipped)** | ✅ **SHIPPED** | Both backends archive the **PREVIOUS state** right before every content write (`session_versions` table / `SessionVersion` model), pruned to the tier depth (3/20) at write time; `GET /api/sessions/:id/versions` + `POST .../versions/:vid/restore`; restore re-archives current state and **bumps `updated_at`** → every other device LWW-adopts the restored content on its next sync (the popup triggers `SYNC_NOW` immediately). Purge + account deletion cascade the snapshots. Popup: card ⋯ → **History…**. Trash-sync was already shipped in A1 (tombstones) — documented, not rebuilt. Proof: W11 + D8 (archive → list → restore round-trip → purge kills history) |

**Round totals:** **980 automated checks, 0 failures** — 15 extension suites **691** + new `saas-surface` audit **54** + source audit **31** + `e2e-cloud-api` **84** (W11 added 18) + `e2e-cloudsync` **63** (D8 added 18) + backend **57** · `lint` 0 · `build` 0 · store zip **rebuilt** (`orbitabs-1.5.0-store.zip`, 15 entries, byte-identical to `dist/`).

**Bugs the new E2E caught (and fixed, not suppressed):** ① Express share-mint crashed (`crypto.randomBytes is not a function` — missing require); ② Worker share-dedupe never matched (snapshot lacked `createdAt`, so claimed copies got "now" and re-claims duplicated); ③ `ShareModal` effect-loop risk (effect keyed on a callback whose identity moved with busy state — replaced with a ref guard); ④ lint `exhaustive-deps` on the Settings billing effect — fixed by splitting effects, not suppressed.

**Deploy surface (needs your go-ahead, same as A-round):** Worker gets `/api/billing/*`, `/api/shares/*`, `/sessions/:id/versions*`, `/sessions/:id/share`, new tables auto-bootstrap; the privacy site gets `dashboard.html/css/js` + policy link; `APP_BASE_URL` should point at the **dashboard host** so share links open the claim page. New client against the OLD live worker degrades exactly like the A-round (404s → current behavior). Billing needs `LEMONSQUEEZY_{API_KEY,STORE_ID,VARIANT_ID,WEBHOOK_SECRET}` (+ optional `BILLING_PORTAL_URL`) — until then checkout says so honestly and nothing breaks.

**Still manual/you:** ① deploy (Worker + site) ; ② real-Chrome sign-in/sync + dashboard walkthrough smoke; ③ create the LS store/variant + paste the 4 secrets; ④ `[SELLER LEGAL NAME]` before taking money.
