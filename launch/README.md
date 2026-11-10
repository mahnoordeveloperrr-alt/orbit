# Orbitabs — Launch Kit

**Goal:** take Orbitabs from "built and tested" to "public, measured, and growing"
without wasting money before the offer is validated.

Everything here is grounded in this repo's actual state (v1.5.0, 863 checks
passing, production API deployed, privacy policy published). Files that already
exist elsewhere are linked, not duplicated — [docs/STORE_LAUNCH.md](../docs/STORE_LAUNCH.md)
owns the Chrome Web Store submission copy, this kit owns the rest.

## Files

| File | What it answers |
|---|---|
| [01-market-research.md](01-market-research.md) | Stage 1 — who buys, what hurts, who we compete with, what they charge |
| [02-positioning.md](02-positioning.md) | Stage 2 — positioning sentence, tagline, message pillars, offer, 30-day goals |
| [03-launch-kit.md](03-launch-kit.md) | Stages 3–5 — paste-ready copy for Product Hunt, Show HN, Reddit, X, video script, outreach DMs, FAQ |
| [04-calendar.md](04-calendar.md) | Stages 4–5 — day-by-day 30-day calendar + launch-day runbook (hour by hour) |
| [05-metrics.md](05-metrics.md) | Stages 6–7 — which numbers, where they come from, weekly review, monetization triggers |
| [TASKS.md](TASKS.md) | **Your** checklist — everything only a human can do, in order, with time estimates |

## The 7-stage roadmap → Orbitabs status

| # | Stage | Status | Where |
|---|---|---|---|
| 1 | Market research | ✅ **Done** — audience, problem, 6 competitors compared, pricing benchmark | [01-market-research.md](01-market-research.md) |
| 2 | Positioning & offer | ✅ **Done** — sentence, tagline options, pillars, free/Pro model, 30-day targets | [02-positioning.md](02-positioning.md) |
| 3 | Launch presence | 🟡 **Built, needs deploy** — landing page written (`site/public/index.html`), privacy policy live, store listing copy ready; remaining: deploy site + capture screenshots | [docs/STORE_LAUNCH.md](../docs/STORE_LAUNCH.md) §2, §5 · [TASKS.md](TASKS.md) T3 |
| 4 | Pre-launch audience | ⬜ **Human work** — community accounts, 5 real conversations, teaser posts, early testers | [04-calendar.md](04-calendar.md) Week 1–2 |
| 5 | Public launch | ⬜ **Blocked on CWS review** — all copy drafted and paste-ready | [03-launch-kit.md](03-launch-kit.md) |
| 6 | Measurement | 🟡 **Plan ready, data starts after launch** — funnel table, sources, weekly review template | [05-metrics.md](05-metrics.md) |
| 7 | Growth & monetization | 🟡 **Code shipped, decision later** — Pro tier + Lemon Squeezy wired; flip on only after validation triggers | [05-metrics.md](05-metrics.md) §4 |

## Foundation (the 5 things marketing money must not be spent before)

| Question | Answer (detail in [02-positioning.md](02-positioning.md)) |
|---|---|
| Target customer | Heavy Chrome users (40+ tabs): researchers, developers, students, writers — people who have lost a work session and felt it |
| Main problem | Tabs/groups/pinned layout vanish on crash, update or accident, and existing restore tools either lose group structure or push data to the cloud |
| Unique benefit | **Exact restore** (windows, groups, colors, order, pinned) + **crash auto-recovery** + **local-first, no account** + page markup — one bundle no competitor has |
| Business model | Free now (whole product, sync ≤100 sessions). Pro later: unlimited sync, ~$3–5/mo or $30–40/yr, sold on our own checkout (never Google) |
| Success goal (first 30 days) | 500+ store installs · 150 D7-active users · 10 reviews ≥4★ · 5 user conversations · 1 paying-customer signal — see [05-metrics.md](05-metrics.md) |

## Rules of engagement

1. **Nothing paid until stage 6 shows a converting channel.** Zero-budget organic
   first (user's budget principle + repo reality: no revenue yet).
2. **Every claim must be provable from the code.** Store/PH copy was written
   against the test suite; do not add adjectives the tests don't back.
3. **Post in communities advice-first.** r/productivity forbids self-promo;
   r/chrome_extensions tolerates maker posts — read current rules before posting
   ([TASKS.md](TASKS.md) T5).
