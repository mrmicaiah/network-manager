# Bethany Dashboard Deployment

The React dashboard is deployed on Cloudflare Pages.

## Setup (One-Time)

### 1. Create Cloudflare Pages Project

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → Pages → Create a project
2. Connect to Git → Select `mrmicaiah/network-manager`
3. Configure build settings:
   - **Project name:** `bethany-dashboard`
   - **Production branch:** `main`
   - **Root directory:** `dashboard`
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Node.js version:** 18 (set via Environment Variables: `NODE_VERSION` = `18`)

### 2. Set Environment Variables

In the Cloudflare Pages project settings → Environment variables:

| Variable | Production Value |
|----------|-----------------|
| `VITE_API_URL` | `https://network-manager.micaiah-tasks.workers.dev` |
| `NODE_VERSION` | `18` |

### 3. Deploy

Click "Save and Deploy". Cloudflare will:
1. Clone the repo
2. Install dependencies in `/dashboard`
3. Run `npm run build`
4. Deploy the `dist` folder

### 4. Access URL

After deployment, the dashboard will be available at:
- **Default:** `https://bethany-dashboard.pages.dev`
- **Custom domain (optional):** Can be configured later

## How Deploys Work

- **Auto-deploy:** Every push to `main` triggers a new deploy
- **Preview deploys:** PRs get preview URLs automatically
- **Build time:** ~1-2 minutes

## Verify Deployment

After deploy, test:

1. **Dashboard loads:** Visit `https://bethany-dashboard.pages.dev`
2. **Login page:** Navigate to `/login`
3. **API connection:** Enter phone number, verify code is sent
4. **Auth flow:** Complete login, verify redirect to `/overview`
5. **Session persistence:** Refresh page, verify still logged in

## Troubleshooting

### Build fails

Check that:
- `dashboard/package.json` has all dependencies
- TypeScript compiles without errors (`tsc`)
- No missing environment variables

### API calls fail (CORS)

The Worker's CORS is already configured in `shared/http.ts`:
```typescript
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': 'true',
  // ...
};
```

### Cookies not working

Session cookies use `SameSite=None; Secure` for cross-origin support.
Both the dashboard (Pages) and API (Workers) are on HTTPS.

## Local Development

```bash
cd dashboard
npm install
npm run dev
```

Local dev uses Vite's proxy to forward `/api/*` to `localhost:8787`.
Run the Worker locally with `wrangler dev` in the root directory.

## Related Files

- `dashboard/.env.example` — Environment variable template
- `dashboard/public/_redirects` — SPA routing for Cloudflare Pages
- `dashboard/src/context/AuthContext.tsx` — API URL configuration
- `shared/http.ts` — CORS headers
- `worker/services/auth-service.ts` — Session cookie settings
