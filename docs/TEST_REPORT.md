# Orbitabs Extension — Test & Feature Audit Report

_Branch: `feature/orbitabs-v1` · Date: 2026-10-12_

This report lists **everything that is verified working** across UI, UX, and all
functional layers of the extension. Every line item below was exercised by an
automated test suite, a live browser probe, or a manual in-browser check — not
assumed.

---

## 1. Verification Summary

| Layer              | Result                          | Exit |
| ------------------ | ------------------------------- | ----|
| Unit/E2E suites    | **12/12 PASS** (564 assertions) | 0 |
| `npm run build`    | **PASS** (popup 299 kB / 93 kB gzip) | 0 |
| `npm run lint`     | **PASS** (0 warnings, 0 errors) | 0 |
| Markup live probe  | **94/94 PASS**                  | 0 |
| Inner-scroll container harness (real Chromium) | **18/18 PASS** | 0 |
| Drag probe         | **11/11 PASS**                  | 0 |
| Rail-hover probe   | **all green**                   | 0 |
| Palette probe      | **PASS**                        | 0 |
| Live browser (vite)| 3 pages render, **0 console errors** | — |

### Test suites (each PASS, exit 0)

| Suite | Assertions | Covers |
| ----- | ---------- | ------ |
| `backup-roundtrip.test.mjs` | 31 | Export → re-import preserves every session |
| `dashboard-smoke.test.mjs`  | 22 | Dashboard render + controls |
| `e2e-commands.test.mjs`     | 28 | Command pipeline (quick-save, restore-last incl. Live-Backup shadowing guard, ok + counts) |
| `e2e-groups.test.mjs`       | 38 | Grouping + recovery restore from candidate |
| `e2e-production.test.mjs`   | 46 | Production reliability (5 windows / 200 tabs restore) |
| `e2e-stress.test.mjs`       | 65 | Multi-cycle stress restore |
| `error-boundary.test.mjs`   | 15 | UI crash containment (render bomb caught) |
| `markup.test.mjs`           | 210 | Markup engine incl. rub-out eraser + erase-ring cursor + page-scroll AND inner-container scroller-chain anchoring (capture, render, hit-test, erase, F5 path re-attach) |
| `organize-smoke.test.mjs`   | 17 | Organizer logic |
| `reliability.test.mjs`      | 18 | Local snapshot untouched by failed sync |
| `search-smoke.test.mjs`     | 17 | Session search |
| `settings.test.mjs`         | 57 | Settings contract |

---

## 2. UI / UX — Verified Working

- **Theme** — light ⇄ dark only (system mode removed on request; a stored
  legacy 'system' pref migrates once to the OS-matching theme), cycled from the
  header moon icon and from Settings. Persisted to `localStorage`. Verified live: dark mode
  screenshot (neon-green CTA, pink/blue session hue-glow, amber Trash) and light
  mode screenshot (white cards with tinted hue-glows, sage pill + mint CTA —
  mock-calibrated from ui/lightmode.png) both render correctly.
- **Design system** — near-black surfaces, neon-green primary as accent only
  (never large fills), semantic hue colors (purple/pink = session identity,
  blue = secondary, green = primary action, amber = recovery, red = destructive).
  Flat surfaces, thin borders, compact density, Inter font.
- **Session identity cards** — each saved session wears a per-hue left bar +
  inset glow + matching Restore button. Verified in both themes.
- **Dashboard layout** — header, Save-current-tabs CTA, scope (All windows) and
  Save buttons, Auto-save ON indicator, search field, SAVED SESSIONS list with
  count, per-card Show-links / More-actions / Restore controls, Trash strip.
- **Organizer page** — renders fully inside Chrome; in a plain browser it shows a
  graceful "needs Chrome extension APIs" fallback instead of crashing (verified).
- **Settings page** — Auto-save toggle, Auto-save frequency dropdown, Save scope
  (All windows / Current window) selector, Restore behavior; controls render and
  are interactive (verified).
- **Accessibility / rail** — hover probe confirms tool-pill labels ("move tool",
  "Erase tool"), focus visibility, and `a11yOk: true` with 0 page errors.
- **Motion** — soft Google/Material-style motion system: Standard
  `cubic-bezier(0.2,0,0,1)` for state changes, decelerate
  `cubic-bezier(0,0,0,1)` for entrances, emphasized
  `cubic-bezier(0.05,0.7,0.1,1)` for dialogs/toasts. Staggered fade-up
  entrances (header 20ms → nav 70ms → CTA 130ms → session cards 280ms +
  55ms steps), 260ms page-view cross-fades, Material menu scale-in, dialog
  emphasized entrance, toast slide-up, auto-save dot ring-pulse, press
  states on leaf controls, `prefers-reduced-motion` honored. Verified live
  via computed styles (animationName/delays on the real DOM). Still no
  glassmorphism, no glow washes, no surface gradients (per design spec).

---

## 3. Functions — Verified Working

### Session management
- Save current tabs (all windows / current window scope)
- Auto-save snapshots (ON indicator + frequency setting)
- Restore a session (single click, returns tabs)
- Show saved links (expand a session)
- More-actions menu per session
- Rename, duplicate, delete sessions
- Trash: deleted sessions restorable for 30 days
- Search saved sessions (live filter)
- Export → import round-trip (31 assertions: nothing lost)

### Reliability & sync
- Production restore: 5 windows / 200 tabs restored intact
- Stress restore: repeated cycles (2 windows / 6 tabs per cycle) stable
- Failed cloud sync leaves the local snapshot untouched (no data loss)
- Error boundary catches UI crashes (render-bomb test) and shows a safe state

### Organizer & grouping
- Group windows/sessions into the organizer grid
- Recovery banner: restore from a recovery candidate

### Markup overlay (on-page drawing)
- **Full markup engine — 94/94 live checks**: pen, highlight, shapes, text
- **Rub-out eraser** — clips the touched segment of a pen stroke (split into
  pieces) and cuts a gap in a highlight band; whole-object delete for shapes/text.
  Verified visually (stroke split + band gap screenshot).
- **Bin / clear** — clears the canvas instantly, **no confirmation dialog**
  (intentional behavior change; test updated to match)
- **Undo** — one erase-stroke = one undo step
- **Drag** — 11/11 drag interactions pass
- **Color palette** — palette probe passes
- Tool rail hover/focus with accessible labels
- **Inner-scroll container anchoring — 18/18 real-Chromium checks** (the
  "site scrolled, mark stayed" class of bug, incl. the user-reported case):
  on an X/Gmail-style feed whose `#feed` div scrolls while `window.scrollY`
  stays 0 — a stroke/text-note captures the container anchor
  (`sx/sy` + re-resolvable `path`), ink follows the inner scroll 1:1 AND
  window scroll, marks leave the viewport together with their paragraph,
  dragging a mark moves it exactly under the pointer while neither the
  container nor the window scrolls, the text editor stays glued to its note,
  and after F5 both marks restore container-bound at the CURRENT container
  scroll (including when the container opens at a different offset than at
  creation). A container-free stroke keeps the classic window-space path
  (rides a 250px window scroll exactly). Root cause fixed: the overlay root
  had to be `pointer-events: none` + `elementUnderPage()` must skip
  overlay-owned elements, else every anchor walk returned an empty chain.

### Keyboard shortcuts (commands API) — e2e-commands, real `background.js` (28 checks)
- Manifest declares `quick-save` + `restore-last` with suggested keys
  **Alt+Shift+S / Alt+Shift+R**; the worker registers a `commands` listener
- **Alt+Shift+S**: writes one session named `Quick Save — <date> (N tabs)`,
  `isAutoSave=false`, full v1 `windows[]` carrying both groups; green ✓
  badge pulse (#16a34a) on silent success, then auto-clears
- **Alt+Shift+R**: reopens 2 windows; W1's 4 tabs in saved order; the pinned
  tab is re-pinned; Work group rebuilt (blue, membership by id); Research
  rebuilt collapsed; focus lands on the saved focused window
- Restore-last skips trashed sessions and picks the newest NON-deleted one
- **Live-Backup shadowing guard**: the auto-save doc is re-stamped every ~30s
  (always newest by `createdAt`) — restore-last prefers the user's own saves
  and only falls back to the Live Backup when nothing else exists
- Legacy pre-v1 docs (`{urls[], groups[].urlIndices}`) restore inline (the
  hotkey reads raw storage — no popup lazy-upgrade on that path)
- Restore-last pulses the same green ✓ badge as quick-save (auto-clears);
  error path pulses red ✗
- Nothing restorable → silent no-op (no windows opened, no badge, no crash)
- `QUICK_SAVE` runtime message (popup path — same worker pipeline) responds
  ok with counts and lands in the store
- Suite verdict line: "KEYBOARD SHORTCUTS LOCKED" (exit 0)
- Remapping UI itself lives in chrome://extensions/shortcuts (Chrome-owned,
  manual); auto-save-OFF still saving and double-press behavior = Test L manual

### Import edge cases — backup-roundtrip (31 checks)
- Envelope contract: `app: orbitabs`, `kind: orbitabs-backup`, `version: 1`,
  count + exportedAt; **trash excluded from export**; dated filename
  `orbitabs-backup-YYYY-MM-DD.json`; UI export shows "Exported 2 sessions"
- Rejections with exact user-facing messages: wrong `kind` → "not an Orbitabs
  backup file"; wrong `app` → "Unknown backup origin"; missing `sessions`
  array; **`version: 99` → rejected** "Unsupported backup version";
  `version: 2` → "NEWER version of Orbitabs" update guidance
- Duplicate handling: partial overlap → imported=1/duplicates=1; re-importing
  the same file again is a **full no-op** (imported=0 — nothing piles up)
- Garbage entries (`null`, `42`, `"str"`, `[]`, `{}`) skipped **without
  crashing** and counted (imported=1, skipped=5); the one valid entry still
  lands with its data; empty `sessions[]` imports nothing cleanly
- Imports are additive with **fresh ids** (source ids never reused; originals
  untouched — a RecentTrash doc stays in trash with its original id); names
  + createdAt preserved; imported docs marked `isAutoSave=false`; legacy
  `{urls[]}` docs accepted via normalizeSession
- UI path: Settings → Privacy & Data renders Export/Import and the export
  produces the same envelope (trash excluded)

### Recovery points / crash recovery — settings (57), dashboard-smoke (22), e2e-groups (38), e2e-production (46)
- Crash recovery OFF → **zero** recovery points collected, no candidate
  queued, no `!` badge; default ON → a recovery point is collected
- `maxRecoveryPoints=3` → ring trimmed to ≤3 after 5 spaced captures; the
  hard cap clamps 999 → 10; the setting persists via SET_SETTINGS
- Crash detected → `recoveryCandidate` queued; **restore from the candidate
  rebuilds 2 windows**; state + badge cleared after restore
- Dashboard renders the recovery history from storage; the banner shows with
  a candidate; **Dismiss** sends DISMISS_RECOVERY and removes the banner
- Reset Orbitabs clears `recoveryPoints`, `recoveryCandidate` and the token
- Manual-only (Test K + Day-5 drill #3): restoring an OLDER point from
  Diagnostics (additive) and the corrupted-latest fallback

### Session sorting & pinning — dashboard-smoke (22), settings (57), e2e-production (46), e2e-commands
- **Pin beats recency**: an older pinned session still renders above a newer
  unpinned one; the pin indicator renders on the card; store-level pin sort
  is re-asserted in the settings suite
- ⋯ menu offers "Pin to top"/"Unpin"; the storage writes carry
  `pinned:true`/`pinned:false`
- **Pinned tabs round-trip**: restore-last re-pins the pinned tab; the
  production restore (5 windows/200 tabs) preserves each window's pinned
  block and the unpinned order (Chrome pin-block semantics)

### Settings & account
- Full settings contract (57 assertions): theme, auto-save, frequency, scope,
  restore behavior all persisted and respected
- Login / cloud-sync opt-in (nothing uploaded unless sign-in + sync enabled)
- Local-only mode is the hard guarantee (sync reports `skipped: local-only`)

### Not covered by automation (manual matrix in TEST_PLAN.md, real Chrome only)
- Welcome-card copy + "Saved successfully — N tabs" toast wording (Test P)
- Real Chrome lifecycle: Task-Manager crash → `!` badge → recovery banner,
  clean-exit = no banner, MV3 worker kill-and-cold-start (Day-5 drill)
- Live end-to-end tab reopen on a real profile (suites prove the logic with
  mocked chrome APIs, not a live browser)
- Diagnostics → restore an OLDER recovery point, additive (Test K);
  corrupted-latest recovery-point fallback (Day-5 drill #3)
- Quick-save with auto-save OFF + Alt+Shift+R double-press (Test L)

### Privacy (stated in Settings, enforced in code)
- Sessions, snapshots, and settings live in local browser storage; work offline
- No analytics, no tracking, no ads; only network call is the user's own backend
  when cloud sync is on

---

## 4. Known Limitations

- **Organizer UI** needs real Chrome extension APIs — in a plain browser tab it
  shows a fallback message (by design). Full visual behavior must be checked
  loaded as an extension in Chrome.
- **Markup eraser cursor** has no live ring preview (hit-box is a fixed square).
- **Highlight eraser cut** is axis-aligned only (round nib produces a straight
  gap; the rect shape has no other representable cut geometry).
- New CSS/JS requires a `chrome://extensions` reload to appear when loaded as a
  real extension.

---

## 5. Evidence

- Live screenshots (this session): Dashboard dark, Dashboard light, Organizer
  fallback, Settings — captured from `http://localhost:5173/`.
- Visual artifacts in `ui/`: `session-hue-verify.png`, `inner-glow-verify.png`,
  `lightmode.png`, `save-btn-verify.png`, `rubout-erase.png`, `organizer-preview.png`.

---

## 6. V1.7 SaaS round addendum (Oct 17, 2026) — billing, dashboard, shares, history

Full matrix rerun after the B1–B7 build. **980 automated checks, 0 failures.**

| Layer | Result | Exit |
| --- | --- | ----|
| 15 extension suites | **691 passed, 0 failed** | 0 |
| `saas-surface.test.mjs` (new static parity audit) | **54 passed, 0 failed** | 0 |
| `e2e-cloud-api` (real SW ↔ real Worker ↔ real D1, wrangler dev) | **84 passed, 0 failed** | 0 |
| `e2e-cloudsync` (real SW ↔ real Express ↔ real MongoDB) | **63 passed, 0 failed** | 0 |
| Backend suites (launch-hardening 28 / sync-account 17 / realdb-proof 12) | **57 passed, 0 failed** | 0 |
| Source audit (`audit-day2`) | 31 of 31 | 0 |
| `npm run lint` (`--max-warnings 0`) / `npm run build` | 0 / 0 | 0 |
| Store zip `orbitabs-1.5.0-store.zip` | 15 entries, byte-identical to `dist/` | — |

New coverage this round:

- **W11** (Worker + D1): free→pro→free webhook flips (wrong signature 401, signed
  `subscription_created`/`subscription_expired`, replay idempotent), checkout 503
  when unconfigured, version archive → list → restore round-trip (append-only),
  share mint → preview → cross-account claim → dedupe, purge kills history + links.
- **D8** (Express + real Mongo): same matrix, plus quota lifting past the free cap
  after the pro flip, DB-level purge/account-deletion cascades, and the claimer's
  copy surviving the sharer's account deletion.
- **S1–S7** static drift guard: both backends keep the same tier numbers (3/20),
  the same `quota-exceeded` contract, the same raw-body HMAC webhook scheme; the
  web dashboard never touches `chrome.*`.

Bugs these tests caught (fixed at the cause): Express share-mint missing `crypto`
require; Worker share snapshot missing `createdAt` (dedupe never matched →
duplicates); `ShareModal` effect-loop risk (busy state in effect deps — replaced
with a ref guard); one lint `exhaustive-deps` (effect split, not suppressed).

Not covered by automation (manual, see TEST_PLAN V1.7 matrix): a real Lemon
Squeezy checkout with live credentials, and the real-Chrome dashboard/share
walkthrough.
