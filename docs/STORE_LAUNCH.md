# Orbitabs — Chrome Web Store Launch Checklist

**Audit date:** October 14, 2026 (rev. Oct 15) · **Build:** v1.5.0 (`dist/`, package `orbitabs-1.5.0-store.zip`)

---

## 1. Production package — READY ✅

| Check | Status |
|---|---|
| `npm run build` fresh | ✅ exit 0 (Vite, 10.4s) |
| Zip: `orbitabs-1.5.0-store.zip` (repo root) | ✅ 15 entries, **manifest.json at zip root**, **176 KB** (179,904 B), **no `host_permissions`**, no sourcemaps, forward-slash paths (**rebuilt this round — V1.6 strings verified inside the package**: tombstones endpoint, refresh endpoint, `/me/plan`, `quota-exceeded`; baked production origin + `update_url` absent both confirmed) |
| Sourcemaps / .env / secrets in package | ✅ none |
| Icons 16/32/48/128 present | ✅ `dist/icons/` |
| MV3 + `minimum_chrome_version: 116` | ✅ |
| Lint (`--max-warnings 0`) | ✅ exit 0 |
| Full test family (all suites) | ✅ **863 checks, 0 failures** — 16 extension suites (775: incl. cloudsync **47**, e2e-cloudsync **45**, e2e-cloud-api **66** with the new W8b–W8e sections) + backend 57 + source audit 31 · lint exit 0 · build exit 0 · **4 live production probes** (health 200 `{ok:true,db:true}`, preflight 204 + ACAO `chrome-extension://`, foreign origin 403, privacy page 200) |

## 2. Screenshots

| Asset | Status |
|---|---|
| `store-assets/01-dashboard-1280x800.png` | ✅ real Chrome, 1280×800 |
| `store-assets/02-crash-recovery-1280x800.png` | ✅ |
| `store-assets/03-organizer-1280x800.png` | ✅ |
| `store-assets/04-settings-1280x800.png` | ✅ |
| `store-assets/promotional-tile-440x280.png` | ✅ small promo tile (440×280 exact) |

Store accepts **1280×800 or 640×400** exactly; 1–5 allowed, so upload these four in this order. Regenerate all of them with `node scripts/make-store-screenshots.mjs`.

A markup-overlay shot was attempted and dropped: the overlay dims the page, so the annotations read poorly at listing size. Skip shot 5 below unless it is re-shot by hand.

### Screenshot shot-list (capture in order, 1280×800, light theme, real data)

| # | Screen | What must be visible | Steps to reproduce |
|---|---|---|---|
| 1 | Dashboard (hero) | ✅ already done — `ui/store-screenshot-1280x800.png` | — |
| 2 | Restore flow | 3–4 session cards with real names + folders/tags chips, one card mid-hover showing **Restore** | Save 3 sessions with names/tags first, open popup, hover a card |
| 3 | Organizer drag-drop | Tabs list with a Chrome-colored group (e.g. blue “Research”) and a card being dragged (ghost row visible) | Popup → Organize → drag one tab onto another / into a group |
| 4 | Crash recovery banner | Red **!** badge state: the recovery offer banner with “N tabs · M windows” and Restore/Dismiss buttons | Follow [CRASH_DRILL_RUNBOOK.md](CRASH_DRILL_RUNBOOK.md) step 1–4 (or trigger via dev profile kill), screenshot the popup |
| 5 | Markup overlay | A page with annotations: highlight + arrow + a sticky note with text, the overlay toolbar visible with the color palette open | Open any article → Orbitabs → pen icon → draw 2 marks + 1 sticky note → open palette |
| 6 | Preview / compare | Card ⋯ → **Preview**: window/group structure tree + the overlap line “1 of these 4 tabs are already open” + Restore CTA with count | Keep 1–2 tabs of a saved session open, open Preview on that card |
| 7 | Settings → Privacy | Cloud section showing **Server URL + Sign in**, and the plain-language local-first paragraph (“no analytics, no trackers”) | Popup → Settings → scroll to Privacy & Data |

Put the strongest three first (1, 4, 5) — the store shows the first image as the tile.

## 3. Privacy disclosures — READY ✅ (one decision left)

- **Privacy policy URL (paste in listing): `https://site-0f71d0986fe640a0b93af1d196f6b56b.freebuff.page/privacy.html`**
  ⚠️ **Oct 28 change:** the site root (`index.html`) is now the **landing page** (stage 3 of [launch/](launch/README.md)); the policy moved to **`/privacy.html`** (same content, verified source: `PRIVACY_POLICY.md`). The old root URL still serves the policy **until the next Production deploy** — so: **deploy `site/` first, curl `/privacy.html` → 200, only then paste the URL in the listing form.**

**Data-use declarations to fill in the form (draft):**

| Store field | Declaration |
|---|---|
| Personal info | Email address, name — **only if user creates an account** (verification + sign-in) |
| Website content | **None collected.** Markup overlay stores annotation data locally; page content is never read or transmitted |
| Browsing activity | Tab URLs/titles — **local only by default**; uploaded *only* with explicit opt-in cloud sync (saved sessions + Live Backup snapshot; trash never leaves the device) |
| Misc | No analytics, no trackers, no ads, no third-party SDKs; single-purpose: session save/restore. Server-side only: aggregate service diagnostics (request/error counts, latency) — no identifiers, no tab URLs |

### 💰 Payments disclosure — status & ready-to-paste block

**Honest status today:** nothing is sold — the extension ships no payment functionality, so the listing needs **no payment disclosure right now** (CWS requires that only when payment is required for *basic functionality*; save/restore is and stays free; the cloud-sync cap never blocks local use).

**When the Pro plan launches, paste into the listing (Chrome Web Store "Accepting Payment From Users" policy):**

```
• Basic functionality (save, restore, import/export, crash recovery) is free forever. The optional "Pro" plan only lifts the 100-session cloud-sync limit.
• Sold by the developer of Orbitabs — [SELLER LEGAL NAME] — not by Google or the Chrome Web Store. Checkout happens on our own website; Google does not process the payment.
• Terms of sale and refunds: 14-day no-questions-asked refund on request (orbitabsnoreply@gmail.com); terms published at https://site-0f71d0986fe640a0b93af1d196f6b56b.freebuff.page/privacy.html
• Price and renewal terms are shown before checkout, in the same currency, with no trial that converts silently.
```

**User action before that launch:** replace `[SELLER LEGAL NAME]` with the legal/trading name on the developer account — it is a legal statement, so the code cannot know it. Until then, `PRIVACY_POLICY.md` §7 carries the same terms in the published policy.

## 4. Permission justifications (paste-ready)

- **tabs** — "Reads and restores your open tabs (URL, order, pinned/active state) to save and rebuild browser sessions."
- **storage** — "Stores saved sessions, settings and markup annotations locally in your browser."
- **tabGroups** — "Reads and recreates your tab groups (title, color, collapsed state) when restoring a session."
- **alarms** — "Schedules the periodic Auto-save (Live Backup) snapshot and heartbeat."
- **activeTab + scripting** — "Injects the annotation overlay on the current page when you click Orbitabs → Markup (install-time fallback for tabs open before install)."
- **content_scripts (http/https)** — "Runs the annotation overlay UI on pages you annotate; stores annotation data only, never page content."
- **host_permissions** — ✅ **none declared** (removed for the store build). Cross-origin calls to an optional backend are governed by the server's CORS allow-list (it explicitly allows `chrome-extension://` origins); verified in a real browser 10/10 (popup + service-worker fetch, preflight, ACAO). Nothing to justify in the form.

## 5. Listing copy (paste-ready)

- **Name (≤45):** `Orbitabs — Session Save & Restore`
- **Summary (≤132):** `Save every window, tab group and pinned tab — restore them exactly, even after a crash. Local-first, no account.`
- **Category:** Productivity → Tabs
- **Single-purpose statement:** "Orbitabs saves and restores browser sessions (tabs, windows, tab groups) and provides optional page annotation for saved pages."

### Description (paste into the Description field — plain text, no markdown)

```
Kill Chrome from Task Manager, relaunch, and Orbitabs hands your tabs back — every window, tab group (names, colors, collapsed state), pinned tabs and their exact order.

SAVE IN ONE KEYSTROKE
• Quick Save — Alt+Shift+S saves the current state as a named session (a green check pulses on the toolbar icon).
• Save from the popup — all windows or just the current one, named or auto-named.
• Auto-save (Live Backup) — a continuously updated snapshot of your browsing state, always ready.

RESTORE EXACTLY
• Restore rebuilds windows, tab order, groups, pinned tabs and the focused window — not just a list of URLs.
• Restore-last — Alt+Shift+R reopens your most recent session without touching the mouse.
• Crash recovery — if Chrome dies without a clean exit, a red badge appears on relaunch and the popup offers your pre-crash state back.
• Recovery points — the last several snapshots are kept, so you can go back to an earlier state, not only the latest.

ORGANIZE WITHOUT SURPRISES
• Manual tab manager with drag & drop, multi-select, group/ungroup, reorder, and group rename with Chrome's 9 colors.
• Nothing is ever grouped, reordered or closed behind your back — you act, Orbitabs follows.
• Search sessions by name or by any saved tab's URL or title.
• Trash is soft: 7-second undo, 30-day retention, restore or permanently purge when you choose.

ANNOTATE ANY PAGE (optional)
• A transparent overlay draws pen marks, highlights, rectangles, circles, arrows, text and sticky notes right on the page.
• Marks are stored as data keyed to the page URL — the website itself is never modified.

YOUR DATA STAYS YOURS
• Local-first: everything lives in your browser's storage and works fully offline with no account.
• No analytics, no trackers, no ads, no third-party SDKs.
• Export/import a single JSON file for backup or sharing — imports are additive and never overwrite.
• An account is optional; cloud backup of your sessions is an explicit opt-in you turn on in Settings.
• Optional extras with an account: browse your sessions in any browser (web dashboard), share a session via a 30-day link, and roll a session back through its version history.
• Destructive actions are always confirmed, soft and undoable for 30 days.

Requires Chrome 116 or newer. Shortcuts are remappable at chrome://extensions/shortcuts.
```

## 6. BLOCKERS before Submit-for-review

1. ~~**`host_permissions: localhost`**~~ ✅ **RESOLVED** — host_permissions removed from the manifest entirely; CORS-governed access verified in real Chrome (corsqa 10/10). Cloud features stay off by default (`cloudSync: false`, `localOnly` hard-switch).
2. ~~**Backend production URL hardcoded**~~ ✅ **RESOLVED** — API origin is now configurable: Settings → Privacy & Data → **Server URL** (`orbi_settings.apiBaseUrl`, consumed by both `api.js` and `background.js`), and the hosted production API is **baked in as the Store-build default**, so the shipped package needs zero configuration. Email verification link honours `APP_BASE_URL` env. Server URL is only needed to self-host.
3. ~~**Stable privacy-policy URL**~~ ✅ **RESOLVED** (updated Oct 28) — policy now lives at `/privacy.html` on the Production site; root serves the new landing page. **Redeploy `site/` before using the URL** (see §3).
4. **Developer account** — $5 one-time registration (**user action**, see §8 runbook).
5. **More screenshots** (recommended, §2).

### ☁️ Cloud / database status (honest)
- **Full cloud session sync is now shipped in code** (opt-in, off by default): saved sessions + Live Backup upload/download with last-write-wins conflict handling, sync status in Settings, and a "Sync now" button (`scripts/cloudsync.test.mjs` → **47/47**). Password recovery (forgot/reset) is also shipped (`tests/sync-account.test.mjs` → 17/17).
- **V1.6 SaaS-hardening round (Oct 16) shipped and E2E-proven:** ① **deletions & restores sync across devices** (tombstones: a trash on device A lands in device B's trash; restore lifts it; purge keeps its mark for 30 days) — `e2e-cloudsync` **45/45**, `e2e-cloud-api` **66/66**, unit `cloudsync` 47/47; ② **sliding sessions** — login now returns a 30-day rotating refresh token (hashed, replay-rejected); the extension refreshes silently when the 7-day JWT expires instead of signing the user out; ③ **server-enforced free-plan quota** — `GET /api/me/plan` (free = 100 synced sessions, `FREE_SESSION_LIMIT=-1` to disable), over-cap creates answer an honest `402 quota-exceeded` that Settings shows as "Plan: Free — N/100"; ④ **aggregate server metrics** (request/error counts + p95, flushed as one log line, exposed on `/api/health`) — no client analytics, privacy stance unchanged.
- **A production API backend is now DEPLOYED** — Cloudflare Worker + D1 (site `orbitabs-api`): **Production** `https://site-8b67ef3788b2498f88d007d22c888375.freebuff.page` (+ isolated **Preview** `https://site-5ccd66b044ff49e48db62f35a0467ead.freebuff.page`). It serves the exact REST contract the extension speaks, and the full suite (real extension service worker ↔ real Worker ↔ real D1, 2 devices) passes **33/33 live over the public internet against *both* environments** (`E2E_BASE_URL=… node scripts/e2e-cloud-api.test.mjs`). `GET /api/health` → `{"ok":true,"db":true}`.
- The production origin is **baked into the Store build as its default** (`STORED_API_ORIGIN` in `background.js` + `api.js`) — sign-in and sync are **zero-config**: no Server URL needed. A Store build never silently targets localhost (cloudsync A2 proves both: baked origin used, Server URL overrides). Settings → Server URL remains only for self-hosting.
- The Express + MongoDB backend stays as the self-host alternative (`render.yaml` blueprint + `realdb-proof.mjs` → 12/12).
- **V1.7 SaaS round (Oct 17) shipped and E2E-proven (needs a Worker + site redeploy to switch on live):** ① **Free/Pro tiers** — one tier table per backend (free = 100-sync cap + 3-version history; Pro = unlimited + 20), served by `/api/me/plan` and enforced at create time; ② **hosted billing** — Lemon Squeezy checkout + HMAC-verified webhook (the ONLY writer of `users.plan`); **without credentials it answers an honest 503 and nothing changes** — to go live paste `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_ID`, `LEMONSQUEEZY_WEBHOOK_SECRET` (+ optional `BILLING_PORTAL_URL`) as Worker secrets and point the LS webhook at `/api/billing/webhook`; ③ **web dashboard** — `dashboard.html` on the privacy-site deployment (sign in, browse/search/export sessions, import share links, plan card); ④ **share links** — 30-day snapshot links per session (claim runs the same quota+dedupe rules); ⑤ **version history** — server snapshots before every synced edit (3 free / 20 Pro), restorable from the popup and adopted by every device via LWW; ⑥ **plan-change emails**. Proof: `e2e-cloud-api` **84/84** (W11), `e2e-cloudsync` **63/63** (D8), `saas-surface` **54/54** drift guard.

## 8. Submission runbook (Dashboard, in order)

1. **Register:** https://chrome.google.com/webstore/devconsole → pay **$5 one-time** developer registration fee.
2. **New item** → upload `releases/orbitabs-1.5.0-store.zip` (16 files, `manifest.json` at the zip root — rebuild with `node scripts/pack-store-release.mjs`).
3. **Listing tab** — paste from §5: name, summary, description; upload the four `store-assets/*-1280x800.png` shots (§2) and the 440×280 tile.
4. **Privacy tab** —
   - Privacy policy URL: `https://site-0f71d0986fe640a0b93af1d196f6b56b.freebuff.page/privacy.html` (only after the `site/` redeploy verifies 200)
   - Single purpose: session save/restore statement (§5).
   - Permission justifications: paste §4 verbatim.
   - Data-use disclosures: use the §3 table (User data → "No", except the two opt-in rows).
5. **Distribution** — Public + all regions (default). Unpublish later keeps the listing private.
6. **Submit for review** — typical review hours→days. Keep `dist/` and the zip untouched until approved; if rejected, address, rebuild, re-upload.

### After approval (field checks)
- Install from the Store (NOT unpacked) → repeat the crash drill: **[CRASH_DRILL_RUNBOOK.md](CRASH_DRILL_RUNBOOK.md)** (Startup check must show `(entered)`).
- Sign-in/verification link in email uses the production `APP_BASE_URL` once the backend is deployed.

## 7. Already handled in this audit

- Auth rate limiting (25/15min/IP), CORS allow-list (no wildcard), HTTPS + HSTS support — **verified live** (`tab-saver-backend` `npm test` → 28/28).
- Account deletion endpoint + Settings UI (password-confirmed, GDPR) — verified live.
- Cloud-sync copy now honest ("saved sessions + Live Backup only when you sign in AND opt in; trash stays local") — verified in UI test.
- Privacy policy written from code reality + published.
