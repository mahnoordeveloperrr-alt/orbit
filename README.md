# Orbitabs — save & restore your browser sessions

Orbitabs is a Chrome extension (Manifest V3) that saves your open windows, tab
groups, pinned tabs, and the tabs' order as **sessions** — and puts everything
back exactly the way it was, even after Chrome crashes.

> **The one-sentence promise:** kill Chrome from Task Manager, relaunch, and
> Orbitabs offers your tabs back — windows, groups (names/colors/collapsed
> state), pinned tabs, and order included.

---

## Where files live

- `src/` � extension interface and behavior
- `public/` � Chrome manifest, icons, background worker, and markup UI
- `scripts/` � project verification and maintenance scripts
- `cloud-api/`, `tab-saver-backend/`, `site/` � service and website code
- `ui/`, `store-assets/` � screenshots, design references, and promotional art
- `docs/` � specs, launch guide, privacy policy, audits, and reports
- `releases/` � packaged extension ZIPs
- `dist/` and `node_modules/` � generated build output and installed dependencies

## Install (unpacked, 60 seconds)

1. Download / clone this project.
2. `npm install && npm run build`
3. Open `chrome://extensions`, enable **Developer mode** (top-right).
4. Click **Load unpacked** → select the **`dist/`** folder.
5. Pin **Orbitabs** to the toolbar.

Requires Chrome 116+ (`minimum_chrome_version` is declared in the manifest).

## What it does

| Feature | How |
|---|---|
| **Save a session** | Popup → *Save* (name optional; auto-names like “Session — Sep 8, 2026 — 10:32 PM”). Scope: all windows or just the current one. |
| **Quick Save hotkey** | **Alt+Shift+S** — saves a named session instantly; green ✓ pulses on the toolbar icon. |
| **Restore** | Popup → *Restore* on any session card — rebuilds windows, tab order, groups (title/color/collapsed), pinned tabs, and the focused window. |
| **Restore-last hotkey** | **Alt+Shift+R** — reopens your most recent saved session without touching the mouse. |
| **Markup this page** 🖊 | Popup → pen icon — a transparent annotation overlay opens right on the current page: pen, highlight, rectangle, circle, arrow, text notes, and **sticky-note cards** (draw to size, type inside, resize from the corner, switch rect/circle shape), with a 14-color fill palette + any-color picker, a **separate text-ink palette** (recolor text after typing or live while typing), **S/M/L text sizes** for notes and labels (set before, live during, or after typing), selection recolor, move/resize, undo/redo, clear, and save. Marks are stored as **data** keyed to the page URL and the website itself is never modified. Reopen the same page and a toast shows how many marks are waiting. (See `docs/MARKUP_SPEC.md` — V1.1 MVP + v1.4 sticky notes + v1.4.1 ink + v1.4.3 text sizes.) |
| **Auto-save (Live Backup)** | Watches every tab/window/group change and keeps a continuously updated “Auto-save — Live Backup” session. Toggle in Settings. |
| **Crash recovery** | If Chrome dies without a clean exit, a red **!** badge appears on relaunch and the popup offers the pre-crash state back. |
| **Recovery points** | The last several snapshots are kept (Settings → Diagnostics) so you can restore a *historical* state, not just the latest. |
| **Trash** | Deleting is soft — 7-second Undo, 30-day Trash, restore or purge anytime. |
| **Organize** | Manual tab manager: drag & drop, multi-select (Ctrl/Cmd+click, Shift+click range), group/ungroup/reorder, group rename + 9 Chrome colors. Nothing is grouped automatically. |
| **Search** | Filter sessions by name or any saved tab's URL/title. |
| **Export / Import** | Settings → Backup & Share — one JSON file of all sessions (trash excluded) for backup or sharing. Imports are additive; nothing is overwritten. |

Shortcuts are user-remappable at `chrome://extensions/shortcuts`.

## Why you can trust it

- **Local-first.** Sessions and snapshots live in `chrome.storage.local` —
  your browser, your disk. Everything works offline with no account.
- **The account is optional.** Signing in only enables cloud backup of the
  Live Backup + your saved sessions to the hosted Orbitabs API (`cloud-api/`,
  a Cloudflare Worker + D1) — or to *your own* backend (`tab-saver-backend/`)
  if you set Settings → Server URL. No analytics, no
  tracking, no third-party calls — the popup's Settings → Privacy section
  says the same thing in plain words.
- **Destructive actions are never instant.** Deletes are confirm-gated,
  soft, undoable for 30 days, and purge only on an explicit second confirm.
- **Recovery never lies.** A crashed-session prompt only appears when the
  snapshot actually contains tabs — an empty state is never offered as
  “recovery”.
- **Explicit actions are explicit.** Quick Save (keyboard/popup) always saves,
  regardless of the auto-save setting; the auto-save gate only governs the
  passive background backup.
- **Nothing happens behind your back.** Orbitabs never reorders, groups, or
  closes tabs you didn't act on. Chrome's golden rule is stated and enforced
  in the Organize view.
- **A crash can't blank the popup.** A root error boundary catches any
  component failure and renders a static emergency screen — which still
  offers crash recovery, guarded by its own boundary. Your saved sessions
  stay safe in Chrome's local storage either way.

## Verifying it yourself (recommended)

Automated suites (no test runner needed — plain Node):

```bash
node scripts/verify-schema.mjs        # locked v1 session schema (27 checks)
node scripts/e2e-groups.test.mjs      # save→close→restore structure (38)
node scripts/e2e-stress.test.mjs      # 10/50/120 tabs, 5 windows, 9 groups,
                                      # pinned edges, weird URLs, 3 restore cycles (65)
node scripts/e2e-production.test.mjs  # latency budgets, concurrent auto-save,
                                      # MV3 cold start, crash at scale, quota (46)
node scripts/e2e-commands.test.mjs    # keyboard shortcuts (28)
node scripts/reliability.test.mjs     # crash-guard, 12h window, quick-save
                                      # gate, dead-backend sync, URL schemes (17)
node scripts/backup-roundtrip.test.mjs# export→file→import round-trip (25)
node scripts/search-smoke.test.mjs    # search UI (17)
node scripts/error-boundary.test.mjs  # popup can never go blank (15)
```

For the manual checklist (including kill-Chrome crash drills), see
**[docs/TEST_PLAN.md](docs/TEST_PLAN.md)**; measured latency/scale/concurrency numbers
are in **[docs/PRODUCTION_TEST_REPORT.md](docs/PRODUCTION_TEST_REPORT.md)**.

## Architecture (short version)

- `public/background.js` — MV3 service worker: debounced snapshot capture
  (tabs/windows/tabGroups events), 30-second heartbeat, crash detection
  (clean-exit flag + heartbeat freshness), restore engine, keyboard commands.
  All event listeners register at top level per MV3 rules.
- `src/services/sessionSchema.js` — the **locked v1 session schema**
  (`windows[].tabs[]` + `groups[]`, membership by id). Legacy documents are
  normalized on read and lazily upgraded on write.
- `src/services/store.js` — local-first data layer over `chrome.storage.local`
  (sessions, trash, settings, import). Cloud sync is a separate, optional layer.
- `src/popup/` — React 18 + Vite + Tailwind popup: Sessions / Organize /
  Settings views.
- `cloud-api/` — the **hosted Orbitabs API** (Cloudflare Worker + D1, one
  small `worker.js`): auth (register/verify/login, password recovery), full
  cloud sync of sessions + Live Backup, soft-delete trash, account deletion,
  `/api/health`. Deployed via the Sites platform; its production origin is
  **baked in as the Store build's default** (`STORED_API_ORIGIN`), so cloud
  sync is zero-config. E2E-proven: `scripts/e2e-cloud-api.test.mjs` (33 checks)
  runs the real extension service worker against the real Worker + D1.
- `tab-saver-backend/` — optional Express + MongoDB backend for the account
  layer: sign-in/verification, **password recovery**, and **full cloud sync**
  of saved sessions + the Live Backup (opt-in, off by default). Stays as the
  self-host alternative — point Settings → Server URL at it.
- `public/markup-*.js` — **Orbitabs Markup** (V1.1 MVP):
  `markup-core.js` is the pure annotation engine (URL keying, sanitize,
  undo/redo, caps); `markup-overlay.js` + `markup-overlay.css` are the
  in-page overlay app, registered as an isolated-world content script on
  http/https — the popup's pen button just messages it open (`activeTab` +
  `scripting` exist only as an install-time fallback for pre-existing tabs;
  no broad host permissions are requested). Annotations live in
  `chrome.storage.local` (`orbi_annotations`) keyed by canonical URL —
  data, not pixels.

## SaaS surface (V1.7)

The account layer is a real (still env-gated) subscription product, identical
on both backends:

- **Tiers** — one `TIERS` table per backend (`cloud-api/worker.js` /
  `tab-saver-backend/plans.js`): Free = sync capped at `FREE_SESSION_LIMIT`
  (default 100) + 3 version snapshots; Pro = unlimited sync + 20 snapshots.
  `/api/me/plan` reports it, `POST /api/sessions` enforces it (402
  `quota-exceeded`).
- **Billing (Lemon Squeezy, Merchant of Record)** — `POST /api/billing/checkout`
  (auth) starts a hosted checkout; `POST /api/billing/webhook` verifies the
  `x-signature` HMAC over the **raw body** and is the only writer of
  `users.plan`. Without `LEMONSQUEEZY_{API_KEY,STORE_ID,VARIANT_ID,WEBHOOK_SECRET}`
  it answers 503 `billing-not-configured` and nothing changes.
- **Web dashboard** — `site/public/dashboard.html` (+ css/js, vanilla): sign in,
  browse/search/export sessions, import share links, plan card. Served by the
  privacy-site Worker; talks to the API worker cross-origin (CORS allows
  `*.freebuff.page`, every call carries the user's JWT).
- **Shared sessions** — `POST /api/sessions/:id/share` mints a 30-day snapshot
  link; `GET/POST /api/shares/:token` preview/claim (claim runs the same quota
  + name/createdAt dedupe as file import).
- **Version history** — every content write archives the previous state
  (`session_versions`), pruned to the tier depth; restore is itself a write so
  other devices LWW-adopt it.

Verify any of it with `node scripts/saas-surface.test.mjs` (fast static drift
guard), `node scripts/e2e-cloud-api.test.mjs` (Worker + D1), or
`node scripts/e2e-cloudsync.test.mjs` (Express + Mongo).

## Development

```bash
npm run dev      # vite dev server (popup UI outside Chrome)
npm run build    # production build → dist/
Icons live in `public/icons/`; the current supplied mark is based on `logo/O-removebg-preview.png`.
```

After changing `public/background.js` or the manifest, run `npm run build` and
reload the extension at `chrome://extensions`.

## Known limitations

- Tab **titles** are saved but cannot be re-applied on restore — Chrome
  derives them from page loads (URLs, order, groups, pins, and focus are exact).
- Restores are **additive**: restoring twice opens the session twice, by
  design (same semantics as Chrome's own session restore).
- Minimized windows restore best-effort; Chrome controls final window state.
- If another extension owns Alt+Shift+S / Alt+Shift+R, Chrome leaves ours
  unbound — pick new keys in `chrome://extensions/shortcuts`.

## License / status

v1.1.0 — works fully without an account; cloud sync is optional and points at
the hosted Orbitabs API by default (Store builds) or your own locally-run
backend in dev.
