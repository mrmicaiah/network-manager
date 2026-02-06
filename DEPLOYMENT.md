# Bethany Network Manager — Deployment Guide

Complete deployment documentation for the Network Manager system. Covers local development, Cloudflare configuration, third-party integrations, and production deployment.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local Development Setup](#local-development-setup)
3. [Cloudflare Configuration](#cloudflare-configuration)
4. [D1 Database Setup](#d1-database-setup)
5. [SendBlue Integration](#sendblue-integration)
6. [Stripe Subscription Setup](#stripe-subscription-setup)
7. [Environment Variables](#environment-variables)
8. [Deployment](#deployment)
9. [Post-Deployment Configuration](#post-deployment-configuration)
10. [Testing Checklist](#testing-checklist)
11. [Troubleshooting](#troubleshooting)
12. [Rollback Procedures](#rollback-procedures)

---

## Prerequisites

Before starting, ensure you have:

- **Node.js 18+** — [Download](https://nodejs.org/)
- **npm** or **pnpm** — Included with Node.js
- **Cloudflare account** — [Sign up](https://dash.cloudflare.com/sign-up)
- **Wrangler CLI** — `npm install -g wrangler`
- **SendBlue account** — [Sign up](https://sendblue.co/) (for SMS/iMessage)
- **Stripe account** — [Sign up](https://dashboard.stripe.com/register) (for subscriptions)
- **Anthropic API key** — [Get key](https://console.anthropic.com/) (for Claude)

### Account Tiers Required

| Service | Minimum Tier | Purpose |
|---------|--------------|---------|
| Cloudflare | Free | Workers, D1, R2 |
| SendBlue | Pay-as-you-go | SMS/iMessage delivery |
| Stripe | Standard | Subscription billing |
| Anthropic | Claude API access | AI responses |

---

## Local Development Setup

### 1. Clone and Install

```bash
# Clone the repository
git clone https://github.com/mrmicaiah/bethany.git
cd bethany/network-manager

# Install dependencies
npm install
```

### 2. Configure Wrangler

```bash
# Login to Cloudflare
wrangler login

# Verify authentication
wrangler whoami
```

### 3. Set Up Environment Variables

```bash
# Copy the template
cp .env.example .dev.vars

# Edit with your development values
nano .dev.vars
```

Required values for local development:

```env
# Claude API (required for braindump parsing, nudges)
ANTHROPIC_API_KEY=sk-ant-...

# SendBlue (optional for local - only if testing SMS)
SENDBLUE_API_KEY=your_key
SENDBLUE_API_SECRET=your_secret
SENDBLUE_PHONE_NUMBER=+1XXXXXXXXXX

# Security tokens (generate random strings)
PIN_SIGNING_SECRET=$(openssl rand -hex 32)
INTERNAL_API_KEY=$(openssl rand -hex 32)

# Stripe (optional for local - only if testing payments)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...

# Dashboard URL (for redirects)
DASHBOARD_URL=http://localhost:8787
```

### 4. Create Local Database

```bash
# Create the D1 database
npm run db:create
```

**Important:** Copy the `database_id` from the output and update `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "bethany-network-db"
database_id = "paste-your-id-here"
```

### 5. Run Migrations

```bash
# Apply schema to local database
npm run db:migrate:local

# (Optional) Seed with test data
npm run db:seed:local
```

### 6. Start Development Server

```bash
# Local development (uses local D1)
npm run dev

# Or use remote D1 database
npm run dev:remote
```

The worker runs at `http://localhost:8787`. Test it:

```bash
curl http://localhost:8787/health
# {"status":"ok","version":"0.7.0","codename":"proactive-nudges",...}
```

---

## Cloudflare Configuration

### Workers Configuration

The `wrangler.toml` file defines the worker configuration:

```toml
name = "bethany-network-manager"
main = "worker/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

# D1 Database
[[d1_databases]]
binding = "DB"
database_name = "bethany-network-db"
database_id = "your-database-id"

# R2 Storage (for exports, backups)
[[r2_buckets]]
binding = "STORAGE"
bucket_name = "bethany-network-storage"

# Durable Objects (for conversation state)
[[durable_objects.bindings]]
name = "ONBOARDING_DO"
class_name = "OnboardingDO"

[[migrations]]
tag = "v1"
new_classes = ["OnboardingDO"]

# Cron Triggers
[triggers]
crons = [
  "0 9 * * *",   # Daily nudge generation (3am Central)
  "0 9 * * 1",   # Weekly nudge generation (Monday only)
  "0 14 * * *",  # Nudge delivery (8am Central)
  "0 0 * * *",   # Midnight maintenance
  "0 0 * * 0",   # Weekly health recalc (Sunday)
]

[vars]
ENVIRONMENT = "production"
BETHANY_WORKER_URL = "https://bethany.mrmicaiah.workers.dev"
MAX_FREE_CONTACTS = "15"
TRIAL_DAYS = "14"
```

### Create R2 Bucket

```bash
wrangler r2 bucket create bethany-network-storage
```

### Custom Domain (Optional)

1. Go to **Cloudflare Dashboard** → **Workers & Pages**
2. Select your worker → **Triggers** → **Custom Domains**
3. Add your domain (e.g., `network.bethany.app`)
4. Cloudflare handles SSL automatically

---

## D1 Database Setup

### Create Production Database

```bash
# Create the D1 database
wrangler d1 create bethany-network-db
```

Output:
```
✅ Successfully created DB 'bethany-network-db' in region ENAM

[[d1_databases]]
binding = "DB"
database_name = "bethany-network-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**Copy the `database_id` to your `wrangler.toml`.**

### Apply Schema

```bash
# Run the schema migration
npm run db:migrate
# or: wrangler d1 execute bethany-network-db --file=./schema.sql
```

### Verify Tables

```bash
wrangler d1 execute bethany-network-db --command="SELECT name FROM sqlite_master WHERE type='table'"
```

Expected tables:
- users
- contacts
- circles
- contact_circles
- interactions
- pending_signups
- usage_tracking
- nudges

### Database Backups

D1 supports point-in-time recovery. For manual backups:

```bash
# Export database
wrangler d1 export bethany-network-db --output=backup.sql

# Import to new database (disaster recovery)
wrangler d1 execute new-db-name --file=backup.sql
```

---

## SendBlue Integration

SendBlue provides SMS and iMessage delivery. This is Bethany's primary communication channel.

### 1. Get API Credentials

1. Log in to [SendBlue Dashboard](https://app.sendblue.co/)
2. Go to **Settings** → **API Keys**
3. Copy your **API Key ID** and **API Secret**
4. Note your **SendBlue Phone Number** (the number Bethany texts from)

### 2. Configure Webhook

SendBlue sends inbound messages to your webhook endpoint.

1. Go to **SendBlue Dashboard** → **Webhooks**
2. Add a new webhook:
   - **URL**: `https://your-worker.workers.dev/webhook/sms`
   - **Events**: Check all message events
3. Save and test with SendBlue's test tool

### 3. Set Secrets

```bash
wrangler secret put SENDBLUE_API_KEY
# Paste your API Key ID

wrangler secret put SENDBLUE_API_SECRET
# Paste your API Secret

wrangler secret put SENDBLUE_PHONE_NUMBER
# Enter: +1XXXXXXXXXX (E.164 format)
```

### 4. Test the Integration

Send a test message to your SendBlue number. Check worker logs:

```bash
wrangler tail
# Look for [sms] logs
```

### Webhook Payload Format

SendBlue sends this payload for inbound messages:

```json
{
  "number": "+15551234567",
  "content": "Hey Bethany!",
  "media_urls": [],
  "is_outbound": false,
  "date": "2026-02-05T12:00:00Z",
  "message_handle": "msg_xxx"
}
```

---

## Stripe Subscription Setup

Stripe handles premium subscription billing.

### 1. Create Stripe Account

1. Sign up at [stripe.com](https://dashboard.stripe.com/register)
2. Complete account verification (for live mode)

### 2. Create Product and Price

**In Stripe Dashboard:**

1. Go to **Products** → **Add Product**
2. Create your product:
   - **Name**: "Bethany Premium"
   - **Description**: "Unlimited contacts, daily personalized nudges, priority support"
3. Add a price:
   - **Pricing model**: Standard pricing
   - **Price**: $9.99/month (or your chosen price)
   - **Billing period**: Monthly
4. Copy the **Price ID** (starts with `price_`)

**Or via API:**

```bash
curl https://api.stripe.com/v1/products \
  -u sk_test_xxx: \
  -d name="Bethany Premium" \
  -d description="Unlimited contacts, daily personalized nudges"

curl https://api.stripe.com/v1/prices \
  -u sk_test_xxx: \
  -d product=prod_xxx \
  -d unit_amount=999 \
  -d currency=usd \
  -d "recurring[interval]"=month
```

### 3. Configure Customer Portal

1. Go to **Settings** → **Billing** → **Customer Portal**
2. Enable the customer portal
3. Configure allowed actions:
   - ✅ Update payment method
   - ✅ Cancel subscription
   - ✅ View invoices

### 4. Set Up Webhook

1. Go to **Developers** → **Webhooks** → **Add endpoint**
2. Configure:
   - **Endpoint URL**: `https://your-worker.workers.dev/api/stripe/webhook`
   - **Events to send**:
     - `checkout.session.completed`
     - `customer.subscription.deleted`
     - `customer.subscription.updated`
     - `invoice.payment_failed`
3. Copy the **Signing secret** (starts with `whsec_`)

### 5. Set Secrets

```bash
wrangler secret put STRIPE_SECRET_KEY
# Enter: sk_live_xxx (or sk_test_xxx for testing)

wrangler secret put STRIPE_WEBHOOK_SECRET
# Enter: whsec_xxx

wrangler secret put STRIPE_PRICE_ID
# Enter: price_xxx
```

### 6. Test the Flow

1. Use [Stripe CLI](https://stripe.com/docs/stripe-cli) for local testing:
   ```bash
   stripe listen --forward-to localhost:8787/api/stripe/webhook
   ```
2. Trigger a test event:
   ```bash
   stripe trigger checkout.session.completed
   ```

---

## Environment Variables

### Complete Variable Reference

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key | `sk-ant-...` |
| `SENDBLUE_API_KEY` | Yes | SendBlue API Key ID | `xxx` |
| `SENDBLUE_API_SECRET` | Yes | SendBlue API Secret | `xxx` |
| `SENDBLUE_PHONE_NUMBER` | Yes | Bethany's phone number | `+15551234567` |
| `PIN_SIGNING_SECRET` | Yes | HMAC secret for PIN tokens | 64-char hex |
| `INTERNAL_API_KEY` | Yes | Auth between workers | 64-char hex |
| `STRIPE_SECRET_KEY` | Yes | Stripe API secret key | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook signing secret | `whsec_...` |
| `STRIPE_PRICE_ID` | Yes | Monthly subscription price ID | `price_...` |
| `DASHBOARD_URL` | Yes | Dashboard URL for redirects | `https://network.bethany.app` |

### Set All Secrets

```bash
# Generate secure random secrets
PIN_SECRET=$(openssl rand -hex 32)
INTERNAL_KEY=$(openssl rand -hex 32)

# Set each secret
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put SENDBLUE_API_KEY
wrangler secret put SENDBLUE_API_SECRET
wrangler secret put SENDBLUE_PHONE_NUMBER
wrangler secret put PIN_SIGNING_SECRET
wrangler secret put INTERNAL_API_KEY
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put STRIPE_PRICE_ID
```

### View Configured Secrets

```bash
wrangler secret list
```

---

## Deployment

### Pre-Deployment Checklist

- [ ] `wrangler.toml` has correct `database_id`
- [ ] All secrets are set (run `wrangler secret list`)
- [ ] R2 bucket created
- [ ] Database schema applied
- [ ] SendBlue webhook configured
- [ ] Stripe webhook configured
- [ ] TypeScript compiles (`npm run typecheck`)

### Deploy to Production

```bash
# Dry run (see what will be deployed)
npm run deploy:dry

# Deploy
npm run deploy
```

### Verify Deployment

```bash
# Check health endpoint
curl https://your-worker.workers.dev/health

# Check version
curl https://your-worker.workers.dev/version

# Stream logs
npm run tail
```

### Deploy to Staging (Optional)

Create a staging environment:

```bash
# Deploy to staging
wrangler deploy --env staging
```

Add to `wrangler.toml`:

```toml
[env.staging]
name = "bethany-network-manager-staging"
vars = { ENVIRONMENT = "staging" }

[[env.staging.d1_databases]]
binding = "DB"
database_name = "bethany-network-db-staging"
database_id = "staging-db-id"
```

---

## Post-Deployment Configuration

### 1. Verify Cron Jobs

Cron jobs should be running automatically. Verify in Cloudflare Dashboard:

1. Go to **Workers & Pages** → your worker → **Triggers**
2. Check the **Cron Triggers** section
3. View execution history in **Logs**

### 2. Monitor First Cron Run

```bash
# Watch for cron execution
wrangler tail --format=pretty | grep cron
```

Expected output at scheduled times:
```
[cron] Triggered: 0 14 * * * at 2026-02-05T14:00:00.000Z
[cron] ✓ nudgeDelivery (234ms) {"pending":0,"delivered":0,"failed":0}
```

### 3. Verify Webhook Connectivity

**SendBlue:**
- Send a test message to your SendBlue number
- Check worker logs for `[sms]` entries

**Stripe:**
- Go to Stripe Dashboard → Webhooks → Your endpoint
- Check for successful deliveries (green checkmarks)

### 4. Create Test User

```bash
# Insert a test user via D1
wrangler d1 execute bethany-network-db --command="
  INSERT INTO users (id, phone, name, subscription_tier, created_at, updated_at)
  VALUES ('test-user-1', '+15551234567', 'Test User', 'trial', datetime('now'), datetime('now'))
"
```

---

## Testing Checklist

### Local Development Tests

- [ ] `npm run dev` starts without errors
- [ ] `/health` returns 200 with version info
- [ ] Database migrations apply cleanly
- [ ] TypeScript compiles without errors

### API Endpoint Tests

| Endpoint | Test | Expected |
|----------|------|----------|
| `GET /health` | `curl /health` | 200, JSON with version |
| `GET /version` | `curl /version` | 200, version string |
| `GET /signup?token=xxx` | Visit in browser | Signup page renders |
| `POST /webhook/sms` | Send SMS to number | 200, message processed |
| `POST /api/auth/request-code` | Request PIN code | 200, code sent via SMS |

### SMS Flow Tests

1. **New user signup:**
   - Text "Hi" to Bethany's number
   - Should receive onboarding message
   - Complete signup flow

2. **Authenticated command:**
   - Say "add contact John Smith"
   - Bethany should acknowledge

3. **Nudge delivery:**
   - Create a contact with old last_contact_date
   - Wait for nudge delivery cron (or trigger manually)
   - Should receive nudge SMS

### Stripe Flow Tests

1. **Checkout flow:**
   - Click upgrade button
   - Complete test checkout (card: 4242 4242 4242 4242)
   - Verify user upgraded to premium

2. **Portal access:**
   - Access customer portal
   - Verify subscription details visible

3. **Cancellation:**
   - Cancel via portal
   - Verify downgrade webhook fires

### Cron Job Tests

```bash
# Manually trigger cron (for testing)
curl -X POST https://your-worker.workers.dev/internal/trigger-cron \
  -H "X-API-Key: your-internal-key" \
  -H "Content-Type: application/json" \
  -d '{"cron": "0 14 * * *"}'
```

---

## Troubleshooting

### Common Issues

#### "Database not found"

```
Error: D1 database not found
```

**Solution:** Verify `database_id` in `wrangler.toml` matches your D1 database.

```bash
wrangler d1 list
# Find your database ID and update wrangler.toml
```

#### "Secret not set"

```
Error: SENDBLUE_API_KEY is not defined
```

**Solution:** Set the missing secret:

```bash
wrangler secret put SENDBLUE_API_KEY
```

#### SMS not being received

1. Check SendBlue Dashboard for delivery status
2. Verify webhook URL is correct
3. Check worker logs for errors:
   ```bash
   wrangler tail --format=pretty | grep -E "(sms|sendblue|error)"
   ```

#### Stripe webhook failures

1. Check Stripe Dashboard → Webhooks for failed events
2. Verify `STRIPE_WEBHOOK_SECRET` is correct
3. Check worker logs:
   ```bash
   wrangler tail --format=pretty | grep stripe
   ```

#### Cron jobs not running

1. Verify triggers in `wrangler.toml`
2. Check Cloudflare Dashboard → Workers → Triggers
3. View cron execution history in Logs

### Debug Commands

```bash
# View live logs
wrangler tail --format=pretty

# Filter to errors only
wrangler tail --format=pretty | grep -i error

# Check database contents
wrangler d1 execute bethany-network-db --command="SELECT * FROM users LIMIT 5"

# List all secrets
wrangler secret list

# Check worker status
curl https://your-worker.workers.dev/health | jq
```

---

## Rollback Procedures

### Rollback to Previous Version

1. Find the previous deployment:
   ```bash
   wrangler deployments list
   ```

2. Rollback:
   ```bash
   wrangler rollback <deployment-id>
   ```

### Database Rollback

D1 supports point-in-time recovery:

1. Go to Cloudflare Dashboard → D1 → Your database
2. Click **Time Travel**
3. Select a restore point
4. Create a new database from that point

### Emergency Procedures

**Disable worker entirely:**
```bash
# In Cloudflare Dashboard: Workers → Your worker → Settings → Disable
```

**Redirect to maintenance page:**
1. Add a route for maintenance in `index.ts`
2. Deploy the change

**Contact support:**
- Cloudflare: [support.cloudflare.com](https://support.cloudflare.com)
- SendBlue: support@sendblue.co
- Stripe: [support.stripe.com](https://support.stripe.com)

---

## Maintenance

### Regular Tasks

| Task | Frequency | Command/Action |
|------|-----------|----------------|
| Check worker logs | Daily | `wrangler tail` |
| Review Stripe webhook failures | Weekly | Stripe Dashboard |
| Database backup | Weekly | `wrangler d1 export` |
| Review usage metrics | Weekly | Cloudflare Dashboard |
| Update dependencies | Monthly | `npm update` |

### Monitoring Recommendations

1. **Set up Cloudflare notifications** for worker errors
2. **Configure Stripe alerts** for failed payments
3. **Monitor D1 usage** to stay within limits
4. **Set up uptime monitoring** (e.g., UptimeRobot) for `/health`

---

## Quick Reference

### Common Commands

```bash
# Development
npm run dev                    # Start local dev server
npm run dev:remote             # Dev with remote D1
npm run typecheck              # Check TypeScript

# Database
npm run db:migrate             # Apply schema (production)
npm run db:migrate:local       # Apply schema (local)
npm run db:seed                # Seed data (production)

# Deployment
npm run deploy                 # Deploy to production
npm run deploy:dry             # Dry run
npm run tail                   # Stream logs

# Secrets
wrangler secret put <NAME>     # Set a secret
wrangler secret list           # List all secrets
wrangler secret delete <NAME>  # Remove a secret
```

### Key URLs

| Purpose | URL |
|---------|-----|
| Worker health | `https://your-worker.workers.dev/health` |
| Web signup | `https://your-worker.workers.dev/signup` |
| SMS webhook | `https://your-worker.workers.dev/webhook/sms` |
| Stripe webhook | `https://your-worker.workers.dev/api/stripe/webhook` |
| Dashboard API | `https://your-worker.workers.dev/api/*` |

---

*Last updated: February 2026 — v0.7.0 (proactive-nudges)*
