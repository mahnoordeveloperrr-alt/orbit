# Stage 6–7 — Measurement, Improvement, Monetization

## 1. The funnel (definitions — log exactly these words, no synonyms)

| Stage | Metric | Definition | Target (30 days) |
|---|---|---|---|
| Reach | **Listing impressions** | Times the CWS listing was shown | 10,000+ |
| Reach | **Listing views** | Detail page opened | 2,000+ |
| Intent | **Installs** | Extension added | **500+** |
| Activation | **First save** | ≥1 session saved after install (observe via "retention surveys"/support conversations; not tracked — no client analytics) | ~60% of installs |
| Retention | **D7 active** | Users still using it 7 days later (CWS "weekly active users" reporting) | **150** |
| Trust | **Reviews** | Store ratings, ≥4★ | **10** |
| Site | **Landing visits / CTA clicks** | Host analytics | per channel |
| Launch | **PH votes / comments** | Product Hunt page | tens of votes; comments = feedback gold |
| Business | **Paying signal** | Pro interest (waitlist hand-raises) | qualitative |

Numbers are **directional**, not vanity: installs per 100 landing visits and
D7 retention decide everything else.

## 2. Where each number comes from (zero new spend)

| Source | Gives you | Notes |
|---|---|---|
| **CWS Developer Dashboard** | impressions, views, installs, country, weekly actives, ratings | The primary scorecard; check daily during launch week, weekly after |
| **Sites / Cloudflare analytics** for the landing site | visits, referrers, CTA clicks | Built into the hosting; cookie-free |
| **API Worker aggregate metrics** | service health, error rates, p95 latency (already shipped, exposed on `/api/health`) | Watch during launch spikes |
| **Product Hunt / HN / Reddit page stats** | votes, comments, referral clicks (use UTMs) | Manual, 5 min/day |
| **Feedback log** (one file, verbatim quotes) | qualitative "why" behind every dip | The most valuable artifact of month 1 |

Privacy stance: **the extension itself never measures users** — all measurement
is store-side, server-side aggregates, or opt-in conversation. Do not add
client analytics to chase a chart.

## 3. UTM convention (bake into every shared link)

```
https://SITE/?utm_source=producthunt&utm_medium=launch&utm_campaign=launch1
https://SITE/?utm_source=reddit&utm_medium=rchrome_extensions&utm_campaign=launch1
https://SITE/?utm_source=hn&utm_medium=showhn&utm_campaign=launch1
https://SITE/?utm_source=x&utm_medium=thread&utm_campaign=launch1
```

Rules: lowercase source, campaign always `launch1` for this 30-day push,
anything after day 30 gets `launch2` etc. Keep a 5-row table of the exact links
in the feedback log file so nobody retypes them.

## 4. Weekly review template (paste every 7 days)

```markdown
## Week N review — <dates>
Installs: <n>  (prev: <n>)   Listing views: <n>   Impressions: <n>
Landing visits: <n>   Installs per 100 visits: <n>
D7 active: <n>   Reviews: <n> (avg <★>)
Channel yield: PH <n> | Reddit <n> | HN <n> | X <n> | store search <n>
Top 3 verbatim complaints:
1.
2.
3.
Shipped in response:
Channel decision (keep / cut / double down):
Next week's ONE focus:
```

**Kill/scale rule:** any channel giving ~0 installs per 100 visits after two
weeks gets cut; the winner gets 80% of effort.

## 5. Monetization triggers (stage 7 — do not start earlier)

Flip the Pro plan on (Lemon Squeezy secrets are already wired in the Worker —
see [docs/STORE_LAUNCH.md](../docs/STORE_LAUNCH.md) §6) **only when all hold:**

1. ≥1,000 installs **and** ≥30% D7 retention (product-retention proof),
2. ≥100 users have hit the free 100-session sync cap at least once (real
   demand for unlimited — visible as `402 quota-exceeded` on `/api/health`
   metrics or Settings "Plan: Free — N/100" reports),
3. ≥5 explicit "I'd pay for this" signals (comments, DMs, reviews).

**Price test:** launch Pro at **$4/mo or $36/yr** (benchmark range in
[01-market-research.md](01-market-research.md) §5; Workona is $9/mo). A/B the
annual price mention in the listing for 2 weeks. 14-day refund already
published. Core features stay free — publicly repeat that line.

**Then, in order:** email/announce Pro to capped users only → watch conversion
(2–5% of capped users is a normal result) → only after conversion proof,
consider paid ads and partnerships.

## 6. Growth loops to test (after month 1, still free)

1. **Share links** (30-day session links already shipped) → recipient imports
   → sees the brand; add a UTM'd landing note for imported sessions later.
2. **Reviews loop:** every "fixed your bug" reply → polite review ask.
3. **Search:** the store listing is the SEO — keep title/summary keyword-tight
   ("session manager", "restore tabs", "tab groups").
4. **Ports:** Edge Add-ons listing (same package, hours of work) doubles the
   surface; Firefox needs a real port — a v2 decision.
5. **Referrals:** only if usage data shows organic sharing is happening.
