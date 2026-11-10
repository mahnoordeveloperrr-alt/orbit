# Orbitabs — Privacy Policy

**Effective date:** October 17, 2026 · **Applies to:** the Orbitabs Chrome extension (Manifest V3) and its backend service (hosted Cloudflare Worker + D1; the Express + MongoDB build is the self-hosted alternative — both serve the same API and the same rules below).

Orbitabs is built **local-first**: your browsing sessions live in your own
browser, and everything works fully without an account. This policy lists
exactly what is stored, what (if anything) leaves your device, and how to
delete it. No marketing language — if it isn't true of the code, it isn't
here.

---

## 1. What stays ON your device (default — 100% of users)

Everything below is stored in **`chrome.storage.local` inside your browser**
and is **never transmitted anywhere** unless *you* sign in AND explicitly
turn on cloud sync (Section 3):

- **Sessions** you save: tab URLs, tab titles, window layout, tab-group
  names/colors/collapsed state, pinned/active flags.
- **Live Backup (auto-save) snapshots** and recovery points used for crash
  recovery.
- **Settings** (hotkeys preferences, retention window, toggles).
- **Markup annotations** (drawings, highlights, notes) keyed by page URL.
- **Trash** items — automatically and permanently purged after 30 days
  (configurable to 7 days in Settings).

Nothing here is readable by any website. Orbitabs never reads page content;
the markup overlay only stores annotation data and never modifies the pages
themselves.

## 2. Account data (optional — only if YOU create an account)

Signing in is never required. If you choose to create one:

| Data | Purpose | Where |
|---|---|---|
| Name, email address | Identify your account, send your verification link | Our backend database |
| Password | Stored **hashed** — bcrypt (self-host build) / PBKDF2-SHA256, 100k iterations (hosted service) — never in plain text | Our backend database |
| Verification token | Confirm you own the email (expires in 1 hour) | Our backend database, deleted after use |
| Password-reset token | Let you choose a new password (single-use, expires in 30 minutes) | Our backend database, deleted after use |
| Refresh token (one per device) | Keep you signed in without re-entering your password: 30-day sliding session, stored **hashed**, replaced on every use (a spent copy is rejected), removed at sign-out and when the account is deleted | Our backend database |

We send exactly three types of email: the account-verification message,
the password-reset message (only when you request it), and — only if you
buy or cancel a paid plan — the plan-change confirmation (§7). No
newsletters, no marketing, no tracking pixels.

## 3. Cloud sync data (optional — off by default)

Cloud sync is **off by default** and requires both an account and the toggle
in Settings → Privacy & Data. When enabled:

- **What is uploaded:** your **saved sessions and your Live Backup
  (auto-save) snapshot** — tab URLs, tab titles, and window/tab-group
  structure. *(Trashed session content is never uploaded.)*
- **Deletion marks only:** when you delete a session on one device, the
  other devices receive only its **id and deletion time** — a tombstone —
  so their copies move to their trash too. Restoring lifts the mark the
  same way. Session *content* of a deleted session never travels.
- **Version snapshots (optional feature):** before each synced edit, the
  server keeps that session's **previous state** so you can roll back from
  History… (last 3 states on Free, 20 on Pro). Snapshots live with your
  account and are deleted with the session or the account.
- **Share links (only when YOU create one):** sharing freezes a copy of
  **one** session (name, tabs, groups, tags, note) behind an unguessable
  link valid 30 days. Anyone holding the link can import that copy into
  their own account — nothing more. A share link never reveals your email
  or identity, can never change or delete anything of yours, dies when you
  re-share or delete the session, and carries a snapshot (later edits to
  your copy are not exposed).
- **Plan limit:** the free plan cloud-syncs up to **100 saved sessions**
  (enforced server-side; sessions beyond the limit stay on your device and
  keep working — local storage is never capped). The limit is visible in
  Settings → Account / Sync. No plan is sold today; see §7.
- **Why:** so your sessions are recoverable from your account on your other
  devices.
- **Where:** our own backend (hosted: Cloudflare Worker + database D1;
  self-hosted option: Express + MongoDB), tied to your account id.
- **Controls:** `Local-only mode` in Settings hard-disables **all** network
  calls, including sync. Sign out any time from Settings → Account.

## 4. What we NEVER do

- **No analytics, no trackers, no advertising, no third-party SDKs.**
  Nothing in the extension measures you, your tabs, or your browsing.
- **No selling, sharing, or renting of data** — to anyone, for any purpose.
- **No cookies or fingerprinting** on extension pages.
- **No reading of your page content** for any purpose.
- **No changes to tabs you didn't act on** — Orbitabs never reorders,
  groups, or closes tabs by itself.

The only network connections the extension ever makes are to its own
backend, and only when an account feature you enabled requires it.

**Server-side diagnostics (the one measurement that exists):** the backend
logs aggregate service health — request counts, response codes, latency and
error rates, flushed as one summary line — so outages and sync failures can
be detected and fixed. These are ordinary server operational logs: no page
content, no tab URLs, no analytics identifiers, and nothing that follows you
across sites. The extension itself performs no analytics of any kind.

## 5. How to delete everything

- **Local data (instant, no account):** Settings → Privacy & Data →
  **Delete all local data**. This wipes sessions, snapshots, settings and
  annotations from this browser and restores defaults.
- **Cloud account + cloud data:** Settings → Account / Sync →
  **Delete account & cloud data** (password confirmation required). This
  permanently removes your account and every session stored in the cloud.
- **Trash:** deleted sessions are held for 30 days (or 7, if configured),
  then purged automatically; you can purge earlier from Settings.
- **Uninstalling the extension** removes all local data from Chrome.

## 6. Security

- Passwords: bcrypt hashing (cost factor 10) on the self-host build;
  PBKDF2-SHA256 with 100,000 iterations on the hosted service.
- API access: signed JWTs (7-day expiry) plus **rotating refresh tokens**
  (30 days, one per device, stored hashed; a replayed spent token is
  rejected), rate-limited authentication (25 requests / 15 minutes / IP),
  explicit CORS origin allow-list, baseline security headers (nosniff,
  Referrer-Policy), HTTPS support with optional HTTP→HTTPS enforcement and
  HSTS.
- Free-plan sync limits and every write rule are enforced **on the
  server** — the extension never decides its own permissions.
- Deleted accounts are invalid immediately: a deleted account's tokens are
  rejected and all of its cloud rows are removed — sessions, deletion marks
  and refresh tokens alike.

## 7. Payments & plans

- **Today nothing is sold.** Every feature — including cloud sync within
  the free-plan limit above — is free. Orbitabs contains no payment form,
  no tracking, and never asks for card details.
- **A paid "Pro" plan (unlimited sync) is planned, not launched.** When it
  launches, the purchase will be completed on our own checkout page (never
  inside the extension), **sold by the developer of Orbitabs —
  **[SELLER LEGAL NAME — fill in before launch]** — not by Google or the
  Chrome Web Store**, with the price, the renewal terms, and a refund policy
  published here and disclosed in the Chrome Web Store listing before any
  purchase. Core save/restore functionality will never be placed behind a
  paywall.
- **Refund policy (standing commitment):** full refund on request within
  **14 days** of any payment, no questions asked — email
  **orbitabsnoreply@gmail.com** from the account email.

## 8. Children

Orbitabs is a general-purpose productivity tool and is not directed at
children under 13. We do not knowingly collect data from children.

## 9. Changes to this policy

Any change is published at this same address and reflected in the Chrome
Web Store listing at the time of the corresponding extension release. The
effective date at the top always reflects the current version.

## 10. Contact

Questions or data requests: **orbitabsnoreply@gmail.com** — we can delete
your account and associated cloud data on request.

---
*Version 1.0 · Source: [`PRIVACY_POLICY.md`](./PRIVACY_POLICY.md) in the Orbitabs repository.*
