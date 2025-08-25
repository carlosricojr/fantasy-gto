# Fantasy GTO - Project Context for Claude

## Project Overview
Fantasy GTO is a fantasy football optimization platform providing data-driven recommendations for lineup decisions, waivers, and trades. Built as a mobile-first PWA with explainable AI models. **ESPN-first launch** strategy with 20M+ addressable users.

## Tech Stack
- **Frontend**: Next.js 15.5.0 (App Router), React 19, Tailwind CSS 4
- **Backend**: Convex (real-time database)
- **Auth & Billing**: Clerk (unified auth + billing with entitlements)
- **Caching**: Upstash Redis (5-15 min TTL for provider responses)
- **CDN**: Cloudflare (static projections)
- **Deployment**: Vercel
- **Package Manager**: pnpm (ALWAYS use pnpm, never npm or yarn)

## Key Architecture Decisions
1. **ESPN-first launch** → Sleeper as Phase 2
2. **Entitlement-based feature gating** via Clerk
3. **Mobile-first PWA** with 72-hour offline cache
4. **Explainable AI models** (EMA + Usage + Vegas)
5. **Anonymous trial mode** → 1-click ESPN import (no signup)
6. **Value before payment** → defer paywall until after Week 1

## Development Commands
```bash
pnpm dev          # Run frontend + backend (with Turbopack)
pnpm build        # Build for production
pnpm lint         # Run linting
pnpm typecheck    # Run TypeScript checks (if configured)
pnpm convex dev   # Start Convex dev server
pnpm convex deploy # Deploy Convex to production
```

## Project Structure
```
/app                    # Next.js 15 App Router
  /(marketing)          # Public pages
  /(app)                # Protected app pages
  /api/webhooks/clerk   # Clerk webhook handlers
  /api/import           # Lineup import endpoint
  /api/export           # Lineup export endpoint
/components             # Shared UI components (shadcn/ui)
/convex
  /functions            # Backend functions (see §7 in spec)
  schema.ts
/lib
  /providers            # OddsAPI, WeatherAPI, SportsDataIO
  /cache                # Redis client + helpers
/docs                   # Technical specifications
```

## Critical Features for MVP

### Sprint 0 (NEW - Current)
- ESPN integration (import/roster/week ingest)
- Anonymous trial mode
- Lineup import/export (CSV + platform formats)

### Sprint 1
- Explainable projections with reasons
- Start/Sit recommendations
- PWA shell
- Clerk Auth + Billing (checkout, entitlements, webhooks)
- Performance tracking (win-rate, accuracy vs ESPN/Yahoo)

### Sprint 2
- Waivers + FAAB guidance
- DST streamer
- Smart alerts
- Social proof (leaderboards, shareable cards)

## Pricing & Entitlements

### Plans
- **Free**: 3 leagues max, weekly refresh, start/sit only
- **Pro**: $4.99/mo with 14-day trial
- **Annual/Seasonal**: $29.99/year OR $19.99/season (Sept-Jan)

### Entitlements (Pro)
- `league_count`: unlimited (free=3)
- `daily_refresh`: daily model updates
- `waivers_faab`: waiver recommendations
- `dst_streamer`: DST streaming tool
- `alerts`: push/email notifications
- `accuracy_dashboard`: performance comparisons
- `import_export`: lineup import/export
- `performance_history`: win-rate tracking

## External Providers & Fallbacks
1. **OddsAPI** ($99/mo, 10k calls/day) → SportsDataIO → Cache → Disable
2. **WeatherAPI** (free tier) → Cache (60m) → Stadium defaults
3. **SportsDataIO** ($299/mo) → Admin override → Conservative projections
4. **Cache TTLs**: Odds 5m, Weather 10-60m, Injuries 5-15m

## Performance Targets
- **TTFP**: ≤30 seconds to first projections
- **Onboarding**: ≤60 seconds ESPN import
- **Load**: 2,000 concurrent users, p95 <2s
- **Accuracy**: MAE beats ESPN by ≥8%, Yahoo by ≥6%
- **Offline**: 72-hour projection cache
- **Cost**: 1K MAU ≤$150, 10K ≤$1.5K, 100K ≤$10K

## Security & Compliance
- No payment data stored (Clerk handles PCI)
- ESPN S2/SWID encrypted at rest, deleted after trial
- Webhook signatures verified
- Full audit trail for billing/admin actions
- 3-day grace period for payment failures

## Common Tasks

### Adding a new feature
1. Check entitlement requirements
2. Add Convex function with `requires('entitlement.key')`
3. Implement UI with soft paywall showing expected value
4. Test with free, trial, and pro accounts

### Working with providers
1. Check Redis cache first (5-15 min TTL)
2. Fall back through provider chain
3. Log degraded mode if using fallbacks
4. Show UI badges for degraded data

### Updating dependencies
```bash
pnpm update          # Update all dependencies
pnpm add <package>   # Add new dependency
```

## Important Notes
- ALWAYS use pnpm as package manager
- ESPN-first is CONFIRMED strategy (not Sleeper)
- Anonymous trial is CRITICAL for adoption
- Value demonstration BEFORE payment request
- Public accuracy reports weekly for trust
- Marketing anchor: "+8.2 points/week vs platform projections"

## Current Sprint
**Sprint 0**: ESPN integration, anonymous trial, lineup import/export

## Resolved Issues (from initial review)
✅ ESPN-first launch (was Sleeper-first)
✅ 14-day trial (was 7-day)
✅ Free tier expanded to 3 leagues (was 1)
✅ Added lineup import/export
✅ Added performance history tracking
✅ Anonymous trial mode (no signup required)
✅ Concrete provider details with fallbacks
✅ Clear seasonal vs annual pricing options