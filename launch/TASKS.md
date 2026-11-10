# TASKS — everything only YOU can do

Ordered, with time estimates and dependencies. Anything in this repo is already
done; nothing here can be done by the code. Work top to bottom — later items
are blocked by earlier ones.

**Source of truth for store copy:** [docs/STORE_LAUNCH.md](../docs/STORE_LAUNCH.md).
**Daily plan:** [04-calendar.md](04-calendar.md) · **What to measure:** [05-metrics.md](05-metrics.md)

> Note: [docs/LAUNCH_QA_REPORT.md](../docs/LAUNCH_QA_REPORT.md) and
> [docs/COMPLETION_AUDIT.md](../docs/COMPLETION_AUDIT.md) still show the **old** root
> privacy URL — they are historical audit records. Use this kit +
> docs/STORE_LAUNCH.md for anything current.

---

## T1 — Accounts & money (Day 1 · 30 min · blocks everything)

- [ ] Register Chrome Web Store developer account and pay the **$5 one-time**
      fee: https://chrome.google.com/webstore/devconsole
      (fee confirmed by Google's registration docs; confirm amount in-dashboard)
- [ ] Verify the developer email; enable 2-step verification on that Google
      account (required by Google for developer accounts)
- [ ] Create the Product Hunt maker account + profile (free)
- [ ] Warm-up accounts you'll post from: Reddit (r/chrome_extensions,
      r/SideProject), X, Indie Hackers — read each community's **current**
      self-promo rules before your first post

## T2 — Assets (Days 2–3 · ~4 h · blocks store submission + PH)

- [ ] Capture the 6 screenshots, 1280×800, light theme, real data — shot-list
      with exact steps in [docs/STORE_LAUNCH.md](../docs/STORE_LAUNCH.md) §2
      (#1 dashboard already exists as `ui/store-screenshot-1280x800.png`)
- [ ] Crop PH gallery: 3 × 1270×760 + 1 × 240×240 thumbnail
- [ ] Record the 60s demo video from the script in
      [03-launch-kit.md](03-launch-kit.md) §6 (+ a 15s vertical cut)
- [ ] Proofread all launch copy once (kit §2–§5) — you own every word posted

## T3 — Website (Day 4 · 1 h · blocks privacy URL + all sharing)

- [ ] **Review the new landing page** (`site/public/index.html`) — open it,
      check copy/screenshots/CTA read the way you want; tell me any edits
- [ ] **Deploy `site/` to Production** (ask me — I'll do the deploy with your
      go-ahead; nothing is deployed without you)
- [ ] Verify after deploy: `/` → landing page 200 · `/privacy.html` → policy 200 ·
      `/dashboard.html` → 200
- [ ] Only then: use `…freebuff.page/privacy.html` as the store's privacy URL
      (this is now documented in [docs/STORE_LAUNCH.md](../docs/STORE_LAUNCH.md) §3/§8)

## T4 — Store submission (Day 4–5 · 1.5 h · blocked by T1–T3)

- [ ] CWS → New item → upload `releases/orbitabs-1.5.0-store.zip` (repo root)
- [ ] Listing tab: paste name/summary/description from STORE_LAUNCH §5;
      upload screenshots (T2)
- [ ] Privacy tab: privacy URL (T3), single-purpose statement, permission
      justifications (§4), data-use declarations (§3 table)
- [ ] Distribution: Public + all regions → **Submit for review**
- [ ] Track review: new developers can take **days to weeks** (2026 policy
      update enforced since Aug 1 — expect extra scrutiny on permissions)
- [ ] While waiting: run the pre-launch work (T5) — don't sit idle

## T5 — Pre-launch audience (Days 8–14 · 30–45 min/day · blocks nothing)

- [ ] Publish the extension as an **unlisted** CWS item → send the link to
      5–10 testers you met in conversations
- [ ] Have 5 × 20-min conversations (questions in [04-calendar.md](04-calendar.md)
      Week 2) — log every verbatim quote
- [ ] Post value-first content (no links) 2–3 times in your target communities
- [ ] Draft PH launch page with gallery + first comment (paste from kit §2)
- [ ] Set up UTM links ([05-metrics.md](05-metrics.md) §3)
- [ ] **Pick the launch date** and lock it

## T6 — Launch day (Day 15 · ~16 h presence)

- [ ] Run the hour-by-hour runbook in [04-calendar.md](04-calendar.md)
- [ ] Reply to every comment within 60 minutes; send the personal DMs
      (kit §7) to testers and interested people
- [ ] Log end-of-day numbers + all feedback in one file

## T7 — Weeks 3–4 recurring (15 min ×2 daily + one 45-min weekly review)

- [ ] Weekly metrics review from the template in
      [05-metrics.md](05-metrics.md) §4 — every Sunday
- [ ] Ask your testers/users for **store reviews** (day 19)
- [ ] Bring me the top 3 user-requested fixes → I'll implement them
- [ ] Day-30 retrospective against the goals in
      [02-positioning.md](02-positioning.md) §6

## T8 — Decisions only you can make

- [ ] **Seller legal name** for the store/payment disclosures — fill the
      `[SELLER LEGAL NAME]` placeholder in `docs/PRIVACY_POLICY.md` §7 +
      STORE_LAUNCH §3 (it's a legal statement; I can't invent it)
- [ ] **Launch date/time** (PH: schedule 12:01 a.m. PT; weekends get more
      clicks, weekdays more discussion — pick the day you can be present)
- [ ] **Custom domain** for the site (optional; current `*.freebuff.page`
      URLs work and are already wired into docs/builds)
- [ ] **Store link** once approved: replace the placeholder in
      `site/public/index.html` (`CHROME_STORE_URL`, one line) — I'll do this
      if you paste the URL to me
- [ ] **Pro pricing go/no-go** — only after the 3 triggers in
      [05-metrics.md](05-metrics.md) §4; then create the Lemon Squeezy
      credentials and I'll set them as Worker secrets (never paste keys in chat —
      use Sites → Secrets)

## Optional later (not launch-blocking)

- [ ] Edge Add-ons listing (same package)
- [ ] Newsletter/email tool if a list actually forms (free tier)
- [ ] Firefox port decision (larger build — separate project)
