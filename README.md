# Bethany Network Manager

Dunbar-based contact relationship manager powered by Bethany. Helps users maintain meaningful relationships through SMS-first interaction with a web dashboard for deeper management.

## Architecture

```
bethany-network-manager/
├── worker/              # Cloudflare Worker (API + cron jobs)
│   ├── index.ts         # Entry point — routing, webhooks, crons
│   ├── routes/          # API route handlers
│   └── services/        # Business logic (contacts, circles, nudges, etc.)
├── dashboard/           # Web dashboard (served by Worker or Pages)
├── shared/              # Shared between worker & dashboard
│   ├── types.ts         # Env bindings, API response types
│   ├── http.ts          # CORS headers, JSON response helpers
│   ├── models.ts        # Data models (Contact, Circle, User, etc.)
│   └── intent-config.ts # Intent types, cadence defaults, health calc
├── schema.sql           # D1 database schema
├── seed.sql             # Test/development seed data
├── wrangler.toml        # Cloudflare Worker config
├── package.json         # Dependencies & scripts
├── tsconfig.json        # TypeScript config
└── .env.example         # Environment variables template
```

## Quick Start

### 1. Install dependencies

```bash
cd network-manager
npm install
```

### 2. Create the D1 database

```bash
npm run db:create
```

Copy the `database_id` from the output and paste it into `wrangler.toml`.

### 3. Set up environment variables

```bash
cp .env.example .dev.vars
# Edit .dev.vars with your local dev values
```

### 4. Run the database migration

```bash
npm run db:migrate:local
```

### 5. Start local development

```bash
npm run dev
```

### 6. Deploy to production

```bash
# Set secrets first (one time)
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put SENDBLUE_API_KEY
wrangler secret put SENDBLUE_API_SECRET
wrangler secret put SENDBLUE_PHONE_NUMBER
wrangler secret put PIN_SIGNING_SECRET
wrangler secret put INTERNAL_API_KEY

# Deploy
npm run deploy
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check + version info |
| GET | `/version` | Version string |
| POST | `/webhook/sms` | SendBlue inbound SMS webhook |
| GET | `/signup?token=xxx` | Web signup page |
| * | `/api/*` | Dashboard API (authenticated) |
| * | `/internal/*` | Internal API (Bethany worker ↔ Network Manager) |

## Cron Jobs

| Schedule | UTC | Central | Purpose |
|----------|-----|---------|----------|
| `0 9 * * *` | 9am | 3am | Daily nudge generation |
| `0 14 * * *` | 2pm | 8am | Morning nudge delivery |
| `0 0 * * 0` | Sun 12am | Sat 6pm | Weekly health recalculation |

## Key Concepts

- **Intent Types**: inner_circle, nurture, maintain, transactional, dormant, new
- **Health Status**: green (on track), yellow (slipping), red (overdue)
- **Cadence**: How often you intend to connect with someone (per intent type)
- **Nudges**: Bethany-generated reminders to reach out, delivered via SMS
- **Trust Window**: PIN-verified session for sensitive operations

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Local development server |
| `npm run dev:remote` | Dev against remote D1 |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run deploy:dry` | Dry run deploy |
| `npm run tail` | Stream production logs |
| `npm run db:create` | Create D1 database |
| `npm run db:migrate` | Run schema (remote) |
| `npm run db:migrate:local` | Run schema (local) |
| `npm run db:seed` | Seed data (remote) |
| `npm run db:seed:local` | Seed data (local) |
| `npm run typecheck` | TypeScript type check |

## Related

- [Bethany Worker](../README.md) — Bethany's core AI companion worker
- Bethany communicates with Network Manager via the `/internal/*` API using `INTERNAL_API_KEY`
