# Stage 1 — Market Research (done, with sources)

**Date:** October 28, 2026 · Numbers below come from live store listings and
public sources (URLs in §6) — re-check prices/user counts before quoting them
in paid marketing.

## 1. Problem statement

> People run 20–80 tabs across several windows as their working memory. Chrome
> kills that memory — crash, update, forced restart, accidental close — and the
> existing tools that "save sessions" either **lose the structure** (groups,
> order, pinned tabs), **push data to the cloud**, or **move tabs behind your
> back**. Orbitabs restores the whole browser exactly as it was, locally, in
> one keystroke.

Emotional core (use this in copy): the moment of reopening Chrome after a
crash and seeing a blank window is a small, recurring loss of work. People
search for a fix *after* that moment — that's the exact intent we can rank for
and the exact pain every post should open with.

## 2. Target audience

**Primary — "The 40-tab researcher/knowledge worker" (25–45):**
runs a research/writing/consulting workflow across 3–6 windows, uses tab
groups by project, has lost work before, is privacy-sensitive (dislikes
accounts for utility tools). Found on: r/chrome_extensions, r/productivity
(read-only), HN, X build-in-public threads, YouTube "how I organize tabs"
videos.

**Secondary A — Developer with project contexts:** many repos/docs/staging
tabs, lives in keyboard shortcuts (`Alt+Shift+S/R` is a selling point),
skeptical of cloud, will read the privacy policy before installing.

**Secondary B — Student/writer:** exam season = 30 tabs; wants "bring back my
essay research" with zero setup; price-sensitive → free tier must fully work.

**Non-goals (do not market to):** enterprise teams (Workona's turf), users who
want tab *suspension/memory saving* (OneTab's turf), people who want a pretty
start page (Momentum/Toby's turf).

## 3. Competitor comparison (Oct 2026, live listing data)

| Extension | What it does | Pricing | ~Store users |
|---|---|---|---|
| **OneTab** | Tabs → flat list to free RAM; restore one/all | Free | 2M |
| **Session Buddy** | Save/organize/restore sessions, auto-save for recovery, local by default | Free (all features) | 1M |
| **Toby** | Visual collections/workspaces + sync | Free tier + paid plans | 300K |
| **Workona** | Cloud workspaces, autosave, suspension, sync | Free tier; **$9/mo** Pro | 200K |
| **Tab Session Manager** | Windows save/restore, interval autosave, tags, sync, tab groups | Free | 100K |
| **Save Tabs** | Save/restore with group + pinned state, optional password | Free | 3K |

**Closest competitors:** Session Buddy and Tab Session Manager.
**Orbitabs' position:** nobody in the table combines *group-faithful exact
restore + crash recovery with recovery points + hard local-first (no account,
no analytics) + page markup overlay*. Session Buddy is nearest on recovery and
local storage but has drawn redesign/data-loss complaints; Workona/Toby are
cloud-first and paid.

## 4. What users complain about (the gaps we answer)

- **Saved tabs/sessions disappear** after crashes or extension updates
  (OneTab/Session Buddy threads on r/chrome_extensions, r/chrome).
- **Redesigns make old tools confusing** — Session Buddy update backlash;
  complexity for a simple stash-and-restore need.
- **Flat lists lose project context** (OneTab) — structure matters.
- **Paywalls / plan changes anger free users** (Toby) → Orbitabs keeps core
  free forever and says so in the listing.
- **Cloud sync raises privacy concerns** (Workona) → local-first is our
  headline, not a footnote.
- **Workspaces feel like overkill** → Orbitabs is "save, restore, done".

**Implication:** lead every message with *exact restore + crash proof +
privacy*, never with feature count.

## 5. Where the audience lives (channels, ranked for us)

| Rank | Channel | Why | Notes |
|---|---|---|---|
| 1 | **r/chrome_extensions** | Topical, maker-friendly, self-promo historically allowed | Read current rules first; advice-first comment history before posting |
| 2 | **Chrome Web Store search** | Highest-intent: people already searching "session manager", "restore tabs" | Listing copy = the real landing page; keywords in name/summary/description |
| 3 | **Product Hunt** | Maker/tool audience, durable page + backlinks | Weekend launches get ~15% more visit clicks (PH data); launch 12:01am PT |
| 4 | **Show HN** | Dev-heavy, values local-first/no-tracking story | Needs genuinely interesting angle → crash-recovery demo + privacy stance |
| 5 | **r/SideProject, Indie Hackers** | Founder feedback, cross-postable | Follow self-promo rules |
| 6 | **X build-in-public thread** | Demo GIF travels; searchable | Secondary, not a primary driver |
| ✗ | r/productivity | **Self-promotion forbidden** | Read-only; answer questions generically, no links |

Alternatives worth listing in later: Edge Add-ons, Firefox (needs a port —
out of scope for v1), extension directories (optional, low volume).

## 6. Sources (retrieved Oct 28, 2026)

- Store listings (user counts/pricing): OneTab, Session Buddy, Toby, Workona,
  Tab Session Manager, Save Tabs — Chrome Web Store pages linked in the
  research pass; re-verify at https://chromewebstore.google.com before quoting.
- Workona $9/mo: https://zapier.com/blog/productivity-extensions-for-chrome/
- Product Hunt timing/assets: https://www.producthunt.com/launch/preparing-for-launch
- Realistic PH outcomes (solo launches median ~107 upvotes, featured-only
  sample): https://www.launchpact.io/research/product-hunt-launch-study
- Chrome Web Store registration/review: https://developer.chrome.com/docs/webstore/register ·
  https://developer.chrome.com/docs/webstore/review-process ·
  2026 policy update https://developer.chrome.com/blog/cws-policy-updates-2026
- Complaint threads: reddit.com/r/chrome_extensions, reddit.com/r/chrome (see
  §4 links from research pass)
