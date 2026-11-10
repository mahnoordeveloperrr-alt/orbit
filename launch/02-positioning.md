# Stage 2 — Positioning & Offer

## 1. Positioning sentence

> **Orbitabs gives heavy Chrome users their whole browser back — every window,
> tab group and pinned tab, exactly as it was, one keystroke after a crash —
> without an account or anyone else's cloud.**

Shorter variant (bios, meta descriptions, sub-lines):

> "Your tabs, exactly as you left them — local-first, no account."

Use the long sentence verbatim in: landing hero sub-line, PH description,
X bio, launch emails. The short one in meta tags and card previews.

## 2. Tagline options (≤60 chars — Product Hunt limit)

| Tagline | Chars | Notes |
|---|---:|---|
| **Your whole browser, back in one keystroke.** | 44 | ✅ **Recommended** — benefit + the shortcut story |
| Kill Chrome. Get every tab back — exactly. | 42 | Bold, dev-friendly; slightly aggressive for store |
| Your tabs, exactly as you left them. | 36 | Safest, most shareable |
| Save your browser. Restore it exactly. | 38 | Verb-first, matches app voice |
| 60 tabs, zero anxiety. | 22 | Memorable but vague on mechanism |

**Decision (updated Oct 28 — matches the store promo graphic):**

- **Landing H1:** **"Kill Chrome. Get your tabs back."** (gradient on "tabs
  back." — verbatim from the approved promo art) + the promo subline "Save
  entire sessions — windows, tab groups, pinned tabs and order — and restore
  them exactly, even after a crash."
- **Product Hunt tagline:** **"Your whole browser, back in one keystroke."**
  (44 chars — softer for a directory audience).
- **Store summary** stays the functional one in
  [docs/STORE_LAUNCH.md](../docs/STORE_LAUNCH.md) §5.

## 3. Message pillars (every piece of copy uses 1–2, in this order)

1. **Exact restore** — not a list of URLs: windows, order, tab groups (name,
   color, collapsed), pinned tabs, focused window. Proof: test suite (863
   checks), screenshot 2/6.
2. **Crash-proof** — Live Backup auto-snapshot + red-badge recovery offer +
   recovery points. Proof: CRASH_DRILL_RUNBOOK, store screenshot 4.
3. **Local-first, no account** — works fully offline; no analytics, trackers,
   ads or SDKs; cloud sync is opt-in. Proof: published privacy policy.
4. **Nothing moves without you** — Orbitabs never reorders/closes tabs on its
   own; destructive actions are soft + 30-day undo. This is the trust line.
5. **Markup (differentiator)** — draw/highlight/annotate any page, stored as
   data keyed to the URL; the site is never modified. Use as the demo/"wow"
   beat, never as the headline (core = sessions).

## 4. Differentiation table (use in PH/Show HN comments if asked)

| | Orbitabs | Session Buddy | Tab Session Mgr | OneTab | Workona/Toby |
|---|---|---|---|---|---|
| Exact restore incl. groups/pinned/order | ✅ | partial | ✅ | ❌ flat list | ✅ |
| Crash recovery w/ recovery points | ✅ | ✅ auto-save | partial | ❌ | ✅ |
| Works with zero account, fully local | ✅ | ✅ | ✅ | ✅ | ❌ cloud-first |
| No analytics / no trackers | ✅ stated in policy | — | — | — | — |
| Page markup overlay | ✅ | ❌ | ❌ | ❌ | ❌ |
| Core free forever | ✅ (stated in policy §7) | ✅ | ✅ | ✅ | ❌ paid tiers |

## 5. Offer & business model

- **Today: everything free.** No payment form exists in the extension
  (verified — privacy policy §7). Say this plainly: "Free while we're small."
- **Later: Pro = unlimited cloud sync** (free = 100 synced sessions,
  server-enforced), ~**$3–5/mo or $30–40/yr** (2026 freemium benchmark;
  Workona sits at $9/mo). Checkout on our own page via the already-wired
  Lemon Squeezy integration — **never through Google**, 14-day no-questions
  refund (already published).
- **Never paywall:** save / restore / crash recovery / import-export.
  Core stays free — stated publicly so the Toby-style backlash never lands.
- **Launch offer:** none needed (free product). Optional: "early supporter"
  badge in dashboard if Pro ships within 90 days.

## 6. First-30-days success goals

| Goal | Target | Why this number |
|---|---|---|
| Store installs | **500+** | Launch channels (PH + HN + Reddit) realistically deliver hundreds of visits; ~15–25% install intent on a store listing |
| D7 active users | **150** | ~30% of installs should save/restore at least once |
| Store reviews | **10 (≥4★)** | Early reviews set conversion for organic search traffic |
| Real conversations | **5** (20 min each) | Stage-4 purpose: learn, not broadcast |
| Returning users | **≥50** weekly in week 4 | Retention is the only signal that beats a launch spike |
| Revenue | **$0 expected** | Monetization trigger is in [05-metrics.md](05-metrics.md) §4 — do not chase it in month 1 |

Kill/scale rule: if after 30 days a channel gives 0 installs per 100 visits,
stop posting there and double down on the best converting one.

## 7. Honesty guardrails (do not cross)

- Don't claim layout-reflow anchoring (marks move with reflow) — it is a
  documented V1.2-era limitation ([docs/MARKUP_SPEC.md](../docs/MARKUP_SPEC.md) §3).
- Don't claim Firefox/Edge support — Chrome 116+ only, for now.
- Don't invent numbers (user counts, "trusted by X") — every figure must come
  from the store dashboard or the test suite.
- Don't promise sync "across all devices" without saying it needs an opt-in
  account and is capped at 100 sessions on free.
