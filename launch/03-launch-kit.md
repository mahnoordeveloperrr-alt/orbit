# Stage 3–5 — Launch Kit (paste-ready copy)

Store listing copy lives in [docs/STORE_LAUNCH.md](../docs/STORE_LAUNCH.md) §5 (name,
summary, description, permission justifications) — don't duplicate it here.
This file is everything else: site, Product Hunt, Show HN, Reddit, X, video,
outreach, FAQ.

Replace `CHROME_STORE_URL` everywhere once the listing is approved
(one edit point in `site/public/index.html`, see [TASKS.md](TASKS.md) T3).

## 1. Landing page

Built: `site/public/index.html` (hero + features + how-it-works + privacy +
FAQ). Copy on the page follows the pillars in [02-positioning.md](02-positioning.md).
Needs a Sites **Production deploy** before any link is shared.

## 2. Product Hunt (launch day, 12:01 a.m. PT)

- **Tagline (44 chars):** `Your whole browser, back in one keystroke.`
- **Description (2 lines):**
  > Orbitabs saves every window, tab group and pinned tab in your browser and
  > restores them exactly — even after Chrome crashes. Local-first: no
  > account, no analytics, no trackers.
- **Topics:** Productivity, Chrome Extension, Developer Tools, Remote Work
- **Gallery:** 240×240 thumbnail + ≥2 images at 1270×760 (crop the store
  screenshots to this size): (1) dashboard/restore, (2) crash-recovery banner,
  (3) markup overlay. Optional 30–60s demo video.
- **First comment (post immediately after publishing):**

```
Hey everyone — maker of Orbitabs here 👋

The problem: I keep 40+ tabs across a few windows as my working memory, and
Chrome kept wiping that memory — crash, update, "restore pages?" gone. The
tools I tried either flattened everything into a plain list (losing my tab
groups) or wanted a cloud account first.

What Orbitabs does:
• Save any window/tab-group layout with Alt+Shift+S, restore it exactly —
  order, groups (colors + collapsed state), pinned tabs, focused window.
• Live Backup: a continuously updated snapshot, so a crash shows a red badge
  and one click brings back the pre-crash state (with recovery points).
• Local-first: everything lives in your browser. No account, no analytics,
  no trackers. Cloud sync exists but is opt-in and off by default.
• Bonus: an overlay to draw/highlight/annotate any page, stored as data —
  the website itself is never modified.

What's different: nobody in this category bundles group-faithful restore +
crash recovery + hard local-first in one free package.

Honest limitations: Chrome 116+ for now (Firefox later), and marks don't
reflow with the page yet.

Would love feedback on: is "crash recovery" the headline, or is "restore your
groups exactly" the one that resonates? Thanks for taking a look — ask me
anything.
```

(Do not ask for upvotes — PH rule.)

## 3. Show HN (same day or +1 day)

**Title options:**

```
Show HN: Orbitabs – restore your whole Chrome session exactly, after a crash
Show HN: I built local-first session restore for Chrome (no account, no trackers)
```

**Body:**

```
I lost a 40-tab research session to a Chrome crash one too many times, so I
built Orbitabs: save every window, tab group and pinned tab; get it back
exactly, one keystroke (Alt+Shift+S / Alt+Shift+R).

Technical notes that matter here:
- Manifest V3, everything stored in chrome.storage.local — the extension
  works fully offline with zero accounts. No analytics, no trackers, no
  third-party SDKs (privacy policy is written from the code, not marketing).
- "Live Backup" keeps an auto-snapshot via chrome.alarms; after a crash the
  service worker offers the pre-crash state with a red badge.
- Restore is structural: window order, tab groups (name/color/collapsed),
  pinned flags and the focused window — not just a URL list.
- Optional cloud sync is off by default; the backend is a Cloudflare Worker
  + D1 with server-enforced quotas, JWT + rotating refresh tokens.
- On-page markup overlay stores annotations as data keyed by URL; pages are
  never modified.

Link: CHROME_STORE_URL
Curious what other people use for session persistence — is this a
"there's already a library for that" problem for most of you?
```

## 4. Reddit (read each sub's current self-promo rules first — TASKS T5)

**r/chrome_extensions (maker post allowed historically):**

```
Title: I built Orbitabs — session restore that keeps your tab groups intact,
plus crash recovery (free, local-first)

Body: Like a lot of you I live in 40+ tabs. Every tool I tried either turned
my groups into a flat list or wanted a cloud login first. Orbitabs saves the
whole layout (windows, groups with colors, pinned tabs, order) and restores
it exactly — and if Chrome dies, Live Backup shows a red badge on relaunch
with the pre-crash state ready.

Everything is local by default: no account needed, no analytics/trackers.
Cloud sync exists but is opt-in and off.

Would genuinely like feedback on the restore flow — what would you want it to
do that it doesn't? CHROME_STORE_URL
```

**r/SideProject:** shorter "what I learned building it" framing + honest ask
for feedback.

**Never post links in r/productivity** (self-promo banned). In threads asking
for tab-manager recommendations, answer generically and mention Orbitabs only
if the sub rules allow and you disclose you built it.

**Reply template for recommendation threads:**

```
Full disclosure: I built one called Orbitabs because I wanted group-faithful
restore + crash recovery without an account. Happy to suggest alternatives
too — Session Buddy is solid for pure save/restore, OneTab if you only want
to dump tabs to a list.
```

(Being generous about competitors gets better reception than link-dropping.)

## 5. X / Twitter thread (launch day)

```
1/ Chrome crashed and took 40 tabs of work with it. So I built Orbitabs —
   your whole browser back in one keystroke. Live on the Chrome Web Store 🚀
   CHROME_STORE_URL

2/ The bug that started it: session "restorers" that give you back a flat list
   of URLs and lose your tab groups, pinned tabs, and window order. That's not
   a restore, that's a bookmarks export.

3/ Orbitabs restores structure: windows, tab groups (names, colors, collapsed
   state), pinned tabs, focused window — exactly as it was. Alt+Shift+S to
   save, Alt+Shift+R to restore.

4/ And if Chrome dies without warning: Live Backup shows a red badge on
   relaunch and offers your pre-crash state back. Recovery points, not just
   "restore last".

5/ Local-first, on purpose: no account, no analytics, no trackers. Cloud sync
   exists but it's opt-in and off by default. Privacy policy written from the
   actual code.

6/ Bonus: draw/highlight/annotate any page with an overlay — annotations are
   data keyed to the URL, the site itself is never modified.

7/ Free while it's small. Feedback welcome — especially from people drowning
   in tabs. What does your session tool get wrong?
```

## 6. Demo video (60s, screen recording — matches the store shot-list)

| Sec | Visual | Voiceover / caption |
|---|---|---|
| 0–5s | 40 tabs across 3 windows, groups visible | "This is my work. One Chrome crash and it's gone." |
| 5–10s | Force-quit Chrome (Task Manager) | *(sound)* |
| 10–16s | Relaunch → red badge → popup recovery offer → Restore | "Orbitabs brings back every window, group and pinned tab — exactly." |
| 16–26s | Normal use: Alt+Shift+S on a project window set | "Save any layout with one keystroke." |
| 26–34s | Reorder/rename groups, then restore | "Restore keeps order, group colors, collapsed state — not just URLs." |
| 34–44s | Settings → Privacy: local-first paragraph + sync toggle OFF | "No account. No analytics. Sync stays off until you turn it on." |
| 44–54s | Markup: draw + highlight + sticky note on an article | "Bonus: annotate any page — the site itself is never touched." |
| 54–60s | Logo + store link + "Free" | "Orbitabs — free on the Chrome Web Store." |

Export at 1280×720 or larger; also cut a 15s vertical version for X/TikTok/Shorts.

## 7. Outreach DM (for people who showed interest pre-launch)

```
Hi {name} — you mentioned {their words about tab chaos / the tool you use}.
I built Orbitabs: it saves your exact Chrome layout (windows, tab groups,
pinned tabs) and restores it after a crash or restart, fully local — no
account. It's free during launch.

Would you try it and tell me the one thing it gets wrong?
{CHROME_STORE_URL} — takes ~30 seconds to install.
```

Personalize every send. Never mass-DM; never DM people who didn't signal
interest.

## 8. FAQ (answer comments with these — copy verbatim)

**Is it really free?**
Yes — save, restore, crash recovery, organizer, import/export are free with
no account. Optional cloud sync is free up to 100 sessions. A paid "Pro"
(unlimited sync) may come later; core features will never be paywalled.

**What data leaves my device?**
Nothing by default. Everything is in `chrome.storage.local`. Cloud sync is
opt-in and off by default; when on, it uploads your saved sessions (URLs,
titles, structure) — never page content, never trash. Details:
CHROME_STORE_URL/privacy equivalent → landing page `/privacy.html`.

**How is this different from Session Buddy / Tab Session Manager?**
Both are good for saving sessions. Orbitabs' differences: guaranteed structural
restore (groups + pinned + window focus), crash recovery with recovery points,
a published local-first privacy policy, and an annotation overlay. Free forever
for core features.

**Does it close, reorder or group my tabs by itself?**
Never. You act, Orbitabs follows. Destructive actions are confirmed, soft-deleted
and restorable for 30 days.

**Firefox / Edge / Safari?**
Chrome 116+ for now. Firefox is the most-requested port — say "noted" and log
it, don't promise a date.

**Is it open source?**
"Not yet — happy to walk through how any part works" (adjust honestly if the
repo goes public).

**How is this different from Chrome's own "continue where you left off"?**
Chrome restores only its last session, flattens/can keep only one group set,
gives no named sessions, no recovery points, and loses everything on a
profile-level crash. Orbitabs is named, multi-session, manual + auto, and
survives a hard kill.
