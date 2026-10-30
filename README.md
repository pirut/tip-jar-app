# Tip Jar

The fastest way to tip service workers (valets, golf cart attendants, bellhops) with tap to pay or a QR code, pool tips with today's crew, and cash out the same day.

- [PLAN.md](PLAN.md): product plan, decisions, roadmap
- [mockup/index.html](mockup/index.html): the clickable prototype from the planning stage

## Layout

| Path | What |
|---|---|
| `convex/` | Backend: schema, auth, tips, crews (pooling + splits), earnings |
| `apps/web` | Next.js web app on Vercel at tip.jrbussard.com: guest tip page (`/<handle>`) and worker dashboard (`/app`) |
| `apps/mobile` | Expo app for workers: accept tips (Tap to Pay), crew, earnings |
| `tests/` | Unit tests for the split math |

Payments are **simulated** (marked "Demo" everywhere) until Stripe is connected. Tap to Pay on the phone is simulated too; the real one needs Stripe Terminal, a development build, and Apple's Tap to Pay entitlement.

## Run it locally

```bash
npm install
npx convex dev                      # creates/links a Convex dev deployment, keep it running
node scripts/setup-convex-auth.mjs  # once per deployment: auth signing keys + SITE_URL
echo "NEXT_PUBLIC_CONVEX_URL=<url from .env.local>" > apps/web/.env.local
npm run dev -w apps/web             # http://localhost:3000
EXPO_PUBLIC_CONVEX_URL=<same url> npm start -w apps/mobile
npm test                            # split math tests
```

## Deploy

```bash
npx convex deploy                                                   # backend to the prod deployment
node scripts/setup-convex-auth.mjs --prod https://tip.jrbussard.com # once
```

The web app deploys on Vercel from `main` (project `tip-jar`, root `apps/web`) with `NEXT_PUBLIC_CONVEX_URL` set to the prod Convex URL. Mobile test builds: `cd apps/mobile && eas build --profile preview`.
