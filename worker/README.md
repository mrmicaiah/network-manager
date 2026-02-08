# Network Manager Worker

Cloudflare Worker for the Bethany relationship assistant.

## Deployment

Auto-deploys to Cloudflare Workers on push to `main`.

## Local Development

```bash
npm install
npx wrangler dev
```

## Endpoints

- `GET /health` — Health check
- `POST /signup` — User registration
- `POST /webhook/sms` — SendBlue inbound webhook
- `/api/*` — Dashboard API routes
