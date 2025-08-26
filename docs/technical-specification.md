# Fantasy GTO – Optimized Production Plan (MVP‑First) — **Clerk Billing Edition**

This update integrates **Clerk Billing** for subscriptions, entitlements, checkout, and account management to streamline implementation and reduce PCI scope. It also shifts launch priority to **ESPN‑first** (20M+ users) with **Sleeper** as immediate Phase 2, and introduces concrete adoption levers and low‑risk scalability practices.

---

## 0) Strategy Updates (Why Clerk Billing + ESPN‑First)

* **ESPN‑first launch** → largest addressable base; Sleeper becomes Phase 2 with guided cookie/token flow.
* **Single vendor for auth + billing (Clerk)** → faster build, fewer failure points, lower integration risk.
* **Entitlements‑first model** → declarative gating of capabilities ("what the user can do"), not plan if/elses.
* **Hosted checkout & management pages** → minimal UI surface, built‑in trials/proration, consistent UX.
* **Security & Compliance** → Clerk handles payment data; we avoid storing PCI artifacts.
* **Onboarding TTFP target** → "See your first projections in 30 seconds" via anonymous trial + 1‑click import.
* **Value before payment** → defer paywall until after Week 1 recommendations are shown for the user’s league.

Reference: Clerk docs → *Billing Overview*, *Entitlements*, *Webhooks*, *Next.js integration*. ESPN integration notes captured in §7 and §12.

---

## 1) Product Scope – MVP (What & Why)

* **ESPN‑first onboarding**; Sleeper in Phase 2 with guided token flow/extension.
* **Explainable models** (EMA + Usage + Vegas) with plain‑English reason cards.
* **Mobile‑first PWA**; smart, noise‑aware alerts; core loop (sync → projections → start/sit → waivers → DST).
* **Pricing** via Clerk: **Free** and **Pro** ($4.99/mo). Annual or seasonal option for Pro (see §2). Free tier includes up to 3 leagues and weekly refresh.

Why: ESPN provides maximum reach; anonymous trial + fast TTFP reduces friction and maximizes adoption.

---

## 2) Pricing & Packaging with Clerk

* **Products & Prices** (Clerk Billing dashboard):

  * **Fantasy GTO – Pro (Monthly)**: $4.99/month.
  * **Option A – Annual**: $29.99/year (rename prior "Seasonal $29.99" to "Annual $29.99").
  * **Option B – Seasonal (Sept–Jan)**: $19.99/season (true in‑season billing). We will choose one option at launch and can keep the other hidden in Clerk for later rollout.
  * Configure **trial** (14 days) at the price level.
* **Entitlements** (attach to Pro plan):

  * `entitlement.league_count` (numeric) → `free=3`, `pro=unlimited`.
  * `entitlement.daily_refresh` → daily model/waiver refreshes.
  * `entitlement.waivers_faab` → waiver recommendations + FAAB guidance.
  * `entitlement.dst_streamer` → DST streamer tool.
  * `entitlement.alerts` → push/email alerts.
  * `entitlement.accuracy_dashboard` → accuracy views + comparisons.
  * `entitlement.import_export` → lineup import/export (CSV + platform formats).
  * `entitlement.performance_history` → win‑rate and season‑long dashboards.
* **Free tier**: up to 3 leagues, weekly refresh, start/sit, basic projections only (no waivers/DST/alerts/import‑export/performance history).
* **Seasonal logic**: If Seasonal ($19.99) is chosen, we keep subscription active but **turn off compute‑heavy jobs** post‑Super Bowl via entitlements schedule (see §6.4). For Annual ($29.99), we pause heavy compute off‑season but continue access to history and off‑season tools when added.
* **Marketing anchor**: Pro users average **+8.2 points/week vs platform projections** (display prominently across paywalls and landing pages; backed by §9, §11 metrics).

Why: Plans are simple to communicate; entitlements map 1:1 to Convex guards; trial + ESPN‑first maximizes conversion.

---

## 3) Entitlement‑Driven Feature Gating (How)

* On session start or page load, the frontend requests the user’s **current entitlements** from Clerk (server‑side) and caches them in Convex for fast checks.
* Each Convex function enforces a **capability guard** (e.g., `requires('waivers_faab')`, `requires('import_export')`).
* Numeric entitlements: `league_count` is enforced in Convex on league add/import.
* The UI reads entitlements to show/hide actions and render **paywalls** that deep‑link into Clerk checkout/upgrade.

Benefits: one source of truth for access across web, API, and jobs. Numeric caps enable simple, auditable limits.

---

## 4) Architecture – Next.js + Convex + Clerk (Where)

### 4.1 Framework Choice (unchanged)

**Next.js 15 (App Router)** for marketing + app + PWA, deployed on Vercel.

### 4.2 Auth & Billing (Clerk)

* **Clerk Auth** for sign‑in (email/passkey/social), organizations optional later for shared leagues.
* **Clerk Billing** for checkout, plan changes, payment method updates, cancelations, and entitlements.
* **Hosted pages**: use Clerk‑hosted checkout/management; deep‑link from our paywalls.

### 4.3 Backend (Convex)

* Stores users, leagues, projections, recommendations. No payment data.
* Enforces **entitlement guards** before running compute‑heavy jobs.
* Schedules nightly/weekly jobs; throttles by plan (e.g., daily vs weekly refresh).
* Adds **provider response caching** via Redis (see §4.4) for 5–15 minutes depending on type.

### 4.4 Providers & Fallbacks (expanded)

* **Odds**: Primary **OddsAPI** ($99/mo, 10k calls/day) → Fallback **SportsDataIO** ($299/mo) odds → Fallback **cached last good value** (up to 15 min) → Fallback **disable odds‑based features** with UI notice.
* **Weather**: Primary **WeatherAPI** (free tier) → Fallback **cached forecast** (up to 60 min) → Fallback **stadium default assumptions** (indoor/no wind) with UI badge.
* **Injuries/Player status**: Primary **SportsDataIO** ($299/mo) → Fallback **manual admin override** (Convex `admin/overrideInjury`) → Fallback **conservative projections** with explicit UI badge.
* **Caching layer**: **Upstash Redis** (or Redis via provider) in the same region as Vercel; provider responses cached **5–15 min** based on volatility:

  * Odds: 5 min TTL; Weather: 10–60 min TTL (shorter for game days); Injuries: 5–15 min TTL.
  * Keys include provider + resource + league/season/week; values compressed JSON; ETags used where supported.
  * Circuit breaker: on provider errors, serve cached data if TTL < 3× normal; log degraded mode in §9.

### 4.5 PWA & Mobile (expanded)

* Installable, with **72‑hour offline cache** of last projections and roster via IndexedDB.
* Push notifications with user‑level throttles; weekly accuracy summaries toggle.

### 4.6 Scalability & Performance Plan

* **Convex cost targets** (budgetary; update with real dashboard data post‑pilot):

  * 1K MAU: **≤ $150/mo**; 10K MAU: **≤ $1.5K/mo**; 100K MAU: **≤ $10K/mo**.
  * Approach: cache‑first reads, batch writes, per‑league partitioned computations.
* **CDN for static projections**: **Cloudflare** fronts static, pre‑rendered weekly projections by position and league template with **stale‑while‑revalidate (5 min)**.
* **Data partitioning/sharding strategy (>10K concurrent users)**:

  * Split `projections` by `(season, week, position)` into chunked documents under `leagueId`.
  * Use read‑optimized collections (denormalized) for hot queries; write once, read many.
  * Avoid cross‑partition fan‑out in live queries; prefer client fan‑in of small pages.
* **Load targets**: 2,000 concurrent users, **p95 < 2s** for `proj/getProjections` and `lineup/solve` under game‑day traffic using pre‑warmed caches and CDN.

---

## 5) Data Model (Convex) — Clerk‑aligned + ESPN‑first additions

* `users` { clerkUserId, email, planDisplay, createdAt }
* `entitlements` { userId, key, value?, active, source: 'clerk', updatedAt }
* `leagues` { platform: 'ESPN'|'SLEEPER'|'YAHOO', name, season, scoring, rules }
* `teams` { leagueId, externalId, name, manager }
* `players` { id, name, pos, team, crosswalk }
* `weeklyStats` { season, week, playerId, raw }
* `features` { season, week, playerId, usage, context, ema }
* `projections` { season, week, playerId, pos, mean, floor, ceiling, contributions[], sourceVersion }
* `recommendations` { leagueId, week, type: 'STARTSIT'|'WAIVER'|'DST', payload }
* `jobs` { type, status, progress, error, startedAt, finishedAt, costUnits }
* `alerts` { leagueId, priority, kind, message, read }
* `audit` { kind, actorUserId, payload, ts }
* `userPerformance` { userId, season, week, leagueId, wins, losses, pointsFor, pointsAgainst, benchPoints, winProbabilityHistory[] }
* `projectionAccuracy` { season, week, playerId, platformBaseline: 'ESPN'|'YAHOO', gtoProjection, baselineProjection, actual, absError, maeByPosition }
* `providerCache` { key, value, provider, ttlSeconds, storedAt }

Notes: `planDisplay` is derived for UI only; **gating uses `entitlements`**. Numeric entitlements use the `value` field.

---

## 6) Billing & Lifecycle Flows (Clerk)

### 6.1 Checkout & Upgrade

* **Pricing page** → Use Clerk `<PricingTable />` at `/pricing` to present plans and features (B2C billing). Users upgrade from there per Clerk docs.
* Soft paywalls link to `/pricing` instead of custom `/upgrade` route for consistency.
* On return, call Convex `billing.syncEntitlements()` to pull entitlements from Clerk for the current user and persist them.

### 6.2 Webhooks

* Next.js route: `/api/webhooks/clerk` (App Router) verifies signatures.
* Handle events (naming based on Clerk docs; confirm during implementation):

  * `billing.subscription.created|updated|canceled|paused|resumed|payment_failed`
  * `billing.entitlement.granted|revoked`
* Webhook handler posts a Convex job: `billing.applyEvent` → updates `entitlements`, schedules recomputation if access changed (e.g., enable daily refresh), and records an audit entry.

### 6.3 Self‑Serve Management

* “Manage subscription” links to Clerk‑hosted portal.
* “Change plan” toggles monthly vs annual/seasonal. Trials are configured in Clerk; UI displays **14‑day** trial remaining.

### 6.4 Seasonal Pause & Cost Control

* For the **Seasonal** price, keep subscription active but **turn off compute‑heavy jobs** by default between Super Bowl and preseason: Convex cron checks `entitlements` + calendar to gate jobs. Users retain access to history and any off‑season tools we later add.

### 6.5 Multi‑League Support

* Pro includes unlimited leagues enforced via `entitlement.league_count` (numeric). Free users limited to 3.

### 6.6 Payment Failures & Grace Period

* On `payment_failed`, mark account as **grace** for 3 days: keep Pro entitlements active, send notifications.
* After 3 days, automatically restrict features to Free entitlements until payment recovers.

---

## 7) API/Function Surfaces (Convex) – ESPN‑first, Clerk‑aligned

* `auth/*`: session, getUser (reads Clerk user), getEntitlements
* `billing/syncEntitlements` (pull from Clerk for current user)
* `billing/applyEvent` (idempotent handler for webhook events)
* `sync/espn.getLeague`, `sync/espn.getRoster`, `sync/espn.ingestWeek`
* `sync/sleeper.getLeague` (Phase 2), `sync/sleeper.ingestWeek` (Phase 2)
* `proj/buildFeatures`, `proj/runProjections`, `proj/getProjections`
* `lineup/importCsv`, `lineup/exportCsv`, `lineup/solve` (requires `import_export` for import/export)
* `waiver/recommend`, `waiver/faabGuide`, `dst/streamers`
* `accuracy/getComparisons` (GTO vs ESPN/Yahoo), `accuracy/updateWeek`
* `performance/updateUserWeek`, `performance/getDashboard` (requires `performance_history`)
* `leaderboard/getAnonymized` (social proof)
* `retention/composeWeeklyAccuracyReport`, `retention/dispatch` (emails)
* `cache/getProvider`, `cache/setProvider` (providerCache helpers)
* `alerts/composeWeekly`, `alerts/dispatch`
* `admin/overrideInjury`, `admin/resync`

**Guards**: decorate with `requires('entitlement.key')` as applicable; enforce numeric `league_count` on league add/import.

---

## 8) UX Adjustments

* **Anonymous trial mode**: one‑click ESPN league import (no signup). If credentials/cookies are needed, support copy‑paste of ESPN S2/Swid in a transient, **encrypted at rest** store; delete on trial end. Fallback: CSV upload.
* **Defer payment** until after first value demonstration (Week 1 recommendations surfaced).
* **Paywalls** are soft and specific: show which entitlement unlocks which action, and expected value (e.g., “+6–10 pts next 2 weeks” for Waivers).
* **Accuracy comparison widget**: “GTO vs ESPN/Yahoo projections” visible on projections pages.
* **Social proof**: anonymized league leaderboards showing GTO user performance (opt‑in for sharing).
* **Billing pages**: minimal—just CTA buttons that route to Clerk‑hosted flows.
* **Receipts**: retain for trust; add "Pro unlocked" celebratory state with quick tips.
* **TTFP**: first projections in ≤ 30 seconds end‑to‑end on fresh user path.

---

## 9) Observability & QA

* Track end‑to‑end funnel: anonymous trial start → import success → projections rendered → paywall view → checkout → success; include timing metrics.
* Add a **webhook replay** admin tool (idempotent).
* Monitor entitlement drift: periodic `billing.syncEntitlements()` for active users.
* Instrument load tests to validate 2,000 concurrent p95 < 2s for hot endpoints.
* Publish weekly **public accuracy reports** (see §11 acceptance) including ESPN/Yahoo baselines.

---

## 9A) Retention Mechanics (new)

* **Weekly accuracy reports** emailed to users with personal deltas and league context; opt‑out supported.
* **Achievements**: prediction streaks, upset calls, start/sit correctness; surfaced in profile and shareable.
* **Season‑long performance tracking** with **shareable cards** (image export) for social posting.
* **Re‑engagement nudges**: when projections shift materially (>20% swing) or key injuries occur.

---

## 10) Security & Privacy (Clerk)

* No payment data stored by us; rely on Clerk for PCI compliance.
* Verify webhook signatures; least‑privilege API keys; encrypt ESPN cookies/tokens at rest if provided.
* Full audit trail in Convex `audit` table for billing/entitlement and admin overrides.

---

## 11) Delivery Plan & Gates (revised)

**Sprint 0 (new)**: ESPN integration (import/roster/week ingest), anonymous trial, lineup import/export.
**Sprint 1**: Explainable projections, Start/Sit with reasons, PWA shell, **Clerk Auth + Billing** (checkout, entitlements, webhooks), **performance tracking** (userPerformance, projectionAccuracy).
**Sprint 2**: Waivers + FAAB, DST streamer, Smart alerts, Accuracy dashboard v0, **social proof** features (leaderboards, shareables).

**Go‑Live Acceptance**

* ESPN onboarding ≤ 60 sec to first projections; **TTFP ≤ 30 sec** on fresh path.
* 2,000 concurrent users with **p95 < 2s** for projections + lineup endpoints.
* **Clerk checkout & portal** work end‑to‑end; entitlements sync within seconds via webhook; 14‑day trials honored.
* **Free limits enforced**: 3 leagues, weekly refresh; Pro = unlimited leagues + daily refresh.
* **MAE beats ESPN by ≥8% and Yahoo by ≥6%** (rolling 3 weeks), per‑position.
* Weekly public accuracy report published; payment failure grace = 3 days before restriction.

---

## 12) Repo Layout (adds webhook route, providers, caching)

```
/ (single repo)
  /app                    # Next.js 15 (App Router)
    /app/(marketing)
    /app/(app)
    /app/api/webhooks/clerk/route.ts   # webhook
    /app/api/import/route.ts           # lineup import endpoint (CSV/platform)
    /app/api/export/route.ts           # lineup export endpoint
    /components                        # shadcn
    /lib                               # hooks, schemas, providers, scoring, billing helpers
      /lib/providers                    # OddsAPI, WeatherAPI, SportsDataIO wrappers
      /lib/cache                        # Redis client + helpers
  /convex
    /functions                         # as listed in §7
    schema.ts
  /packages/shared                     # types + constants (optional)
```

---

## 13) Useful Documentation (why it matters)

* **Clerk Billing Overview**: product/price setup, entitlements, hosted flows.
* **Clerk for Next.js**: server components + auth helpers.
* **Clerk Webhooks**: verifying signatures and event taxonomy.
* **Convex**: functions, live queries, cron, env.
* **ESPN integration**: cookie/S2/Swid collection patterns; rate limits; roster endpoints.
* **OddsAPI**, **SportsDataIO**, **WeatherAPI** provider docs and quotas.
* **Upstash Redis** (or managed Redis) and **Cloudflare CDN** docs.
* **PWA**: web push & offline caching patterns.

---

## 14) Future Notes

* If/when we add Trades/Simulator, keep compute within Convex where possible; otherwise, add a single containerized worker behind a signed HTTPS endpoint. Entitlements will gate access to heavy jobs.
* **Sleeper (Phase 2)** uses the same entitlement checks; checkout flow remains Clerk‑hosted.

**Outcome:** ESPN‑first + Clerk billing + Convex caching/CDN gives a low‑risk path to a trustworthy, pay‑worthy MVP with clear growth levers and measurable performance.


