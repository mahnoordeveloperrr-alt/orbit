# Stage 4–5 — 30-Day Launch Calendar

Product is already built and tested — so this calendar starts at "assets &
accounts", not "write code". **Pick your actual launch day first** (Day 15
slot below): Product Hunt's own guidance says there is no magic weekday, just
schedule for **12:01 a.m. Pacific** and be present; weekend launches get ~15%
more visit clicks, weekdays get more discussion. Pick the day you can babysit
comments for 16 hours.

---

## Week 1 (Days 1–7) — Foundation & assets

| Day | Task | Output | ~Time |
|---|---|---|---|
| 1 | Register Chrome Web Store developer account, pay **$5 one-time**; verify email | Dev console access | 30 min |
| 1 | Read current self-promo rules: r/chrome_extensions, r/SideProject, Indie Hackers; join, comment advice-only (no links) | Accounts warmed up | 45 min |
| 2 | Capture the 6 store screenshots (shot-list in [docs/STORE_LAUNCH.md](../docs/STORE_LAUNCH.md) §2), 1280×800, light theme | Store gallery | 2 h |
| 2 | Crop PH gallery: 1270×760 ×3 + 240×240 thumbnail | PH assets | 45 min |
| 3 | Record the 60s demo + 15s vertical cut (script in [03-launch-kit.md](03-launch-kit.md) §6) | Video files | 3 h |
| 4 | Deploy `site/` to **Production**; verify landing 200 **and** `/privacy.html` 200; fix anything broken | Live landing page | 1 h |
| 4 | Upload everything to CWS draft: zip, screenshots, listing copy, privacy URL, permission justifications ([docs/STORE_LAUNCH.md](../docs/STORE_LAUNCH.md) §8) → **Submit for review** | Review queue (days→weeks) | 1.5 h |
| 5 | Product Hunt: create account, draft launch page (title/tagline/gallery/first comment from the kit), save as draft | Draft ready | 1 h |
| 5 | Set up UTM links (convention in [05-metrics.md](05-metrics.md) §3) | Shareable links | 20 min |
| 6 | Show HN draft + X thread draft (from the kit); ask 2 friends to proofread | Copy locked | 45 min |
| 7 | **Weekly review:** assets complete? review ETA? adjust launch date if review is slow | Go/no-go | 30 min |

**If CWS review is slow:** launch the *audience* work anyway (Week 2 rows) —
a warm audience waits for you; a launch date does not wait for an audience.

## Week 2 (Days 8–14) — Pre-launch audience

| Day | Task | Output |
|---|---|---|
| 8 | Publish the extension as an **unlisted** CWS item (share-by-link) → send to 5–10 testers found in the Week-1 conversations | Real testers + early bug reports |
| 8 | First non-promotional post: a genuinely useful thread/comment about tab overload or session loss (value first, no link) | Trust + profile history |
| 9 | 5 × 20-min conversations with testers ("what did it get wrong?") — this is stage 4's real deliverable | Feedback log + 5 names for launch-day DMs |
| 9 | Fix any launch-blocking bug found (ask me — I'll implement) | Stable build |
| 10 | Teaser post with a GIF (crash → restore) in a community that allows it | First warm traffic |
| 11 | PH page fully assembled (gallery, first comment, topics); schedule for launch day | Ready to publish |
| 12 | Rebuild the store zip **only if code changed**; re-verify tests pass | Package integrity |
| 13 | Prepare "early access" replies: FAQ answers from the kit, URLs, UTM links — all one keystroke away | Reply kit |
| 14 | Rest / light engagement. Check CWS review status; **announce date** to testers + anyone who expressed interest | Launch locked |

## Day 15 — LAUNCH DAY runbook (all times Pacific)

| Time | Action |
|---|---|
| 00:01 | **Product Hunt goes live** → immediately post the first comment (kit §2) |
| 00:05 | X thread posted (kit §5) with store/landing link |
| 07:00 | Read + reply to every PH comment; thank each by name |
| 09:00 | **Show HN** submitted (kit §3) |
| 10:00 | r/chrome_extensions post (kit §4) → then r/SideProject variant |
| 10:30+ | Reply to *every* comment within 60 minutes, all channels (set a reminder loop) |
| 12:00 | Personal DMs to testers + people who showed interest (kit §7) |
| 14:00 | Indie Hackers post; check for "recommend a tab extension" threads and answer helpfully |
| 17:00 | Mid-day check: CWS dashboard impressions, site visits, installs; note numbers in the metrics log |
| 19:00 | PH: engage again (answer, thank) — never beg for upvotes |
| 21:00 | Shutdown: log the day's numbers + every piece of feedback into one file. Sleep. |

## Week 3 (Days 16–22) — Respond, measure, iterate

- **Daily (15 min ×2):** reply to all channels; record feedback verbatim.
- **Day 16:** first [weekly metrics review](05-metrics.md) — pull CWS
  impressions/installs, landing visits, PH totals.
- **Day 17–18:** fix the **top-reported** issue (tell me — I'll build it);
  ship v1.5.x if needed and note it publicly ("shipped your feedback").
- **Day 19:** ask your 5 testers for **store reviews** (the single highest
  conversion lever for organic traffic).
- **Day 20:** second useful content piece: a demo GIF thread or a write-up of
  the crash-recovery engineering.
- **Day 21:** conversation #6–7 (target: 5 total by day 30).
- **Day 22:** weekly review #2 — which channel produced installs per 100 visits?

## Week 4 (Days 23–30) — Double down + set up stage 6/7

- **Days 23–25:** put 80% of effort into the **best converting channel**;
  stop or reduce the zero-result ones (kill/scale rule).
- **Day 26:** "one week live" post with honest numbers (installs, what broke,
  what shipped).
- **Day 28:** weekly review #3 — retention (D7) is now visible; read reviews.
- **Day 29:** decide the v1.6 feature bet from feedback (top 3 asks) — bring
  them to me as a task list.
- **Day 30:** **retrospective** — hit/miss against the 30-day goals in
  [02-positioning.md](02-positioning.md) §6; decide monetization trigger
  ([05-metrics.md](05-metrics.md) §4) and next month's single focus.

---

**Rule for the whole month:** conversation before broadcast, proof before
promotion, measurement before spending. Zero paid budget until §4 triggers
fire.
