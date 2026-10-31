# Tip Jar

Tipping app for service workers (valets, golf cart attendants). Guests tip by QR code or Tap to Pay on the worker's phone; workers can pool tips in a day "crew"; companies (later) run pools and tip payouts. Product decisions and roadmap: PLAN.md (section 7 lists decisions already made; don't re-ask them).

## Layout
- `convex/`: backend (Convex). Schema in `convex/schema.ts`, auth via Clerk (`convex/auth.config.ts`, workers keyed by `tokenIdentifier`), money helpers in `convex/lib/money.ts`, split math in `convex/lib/split.ts`. `convex/_generated` is committed; regenerate with `npx convex dev` after schema/function changes.
- `apps/web`: Next.js (App Router) on Vercel at tip.jrbussard.com. `/<handle>` is the public guest tip page, `/app` is the worker dashboard. Imports backend code via the `@convex/*` path alias.
- `apps/mobile`: Expo app (SDK 58) for workers, single `App.tsx` + `src/`. Imports backend code by relative path (`../../convex/...`). Install native deps with `npx expo install`.
- `tests/`: node:test unit tests (`npm test`).
- `mockup/`: the original clickable prototype (static HTML), kept for reference.

npm workspaces: run `npm install` at the repo root only.

## Rules that matter
- All money is integer cents. Fees: `feesCents()` in `convex/lib/money.ts` (card estimate + 25¢ platform fee). Guests cover fees by default.
- Crews: only the starter changes the split; tips received before joining stay with the worker; leftover cents rotate.
- Crew payouts cover everyone who was in the crew, including people who left; only members the starter removed are excluded (their own tips go back to them). Weights that add to nothing pay evenly so a pool is never lost.
- Wrong crew codes are limited per worker. Mutations that count a failure must return an error rather than throw, because a throw rolls the count back.
- Guests never load Clerk: it is only mounted under `/app`, and `proxy.ts` only matches `/app`.
- Payments and Tap to Pay are simulated (`demo: true` on records, "Demo" tags in UI) until Stripe Connect / Stripe Terminal are wired in. Never present demo money as real.
- US only. Tips only for companies for now (no wages).

## Commands
```bash
npx convex dev                       # dev backend, writes .env.local (gitignored)
npm run dev -w apps/web              # needs apps/web/.env.local with NEXT_PUBLIC_CONVEX_URL, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY
EXPO_PUBLIC_CONVEX_URL=... EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=... npm start -w apps/mobile
npm test                             # split math
npm run typecheck                    # convex + web + mobile
npx convex deploy                    # prod backend
npx convex env set [--prod] CLERK_JWT_ISSUER_DOMAIN <clerk frontend api url>   # once per deployment
```

## Deploy
- Web: Vercel project `tip-jar` (team "pirut's projects"), root `apps/web`, production branch `main`, env `NEXT_PUBLIC_CONVEX_URL` = prod Convex URL, plus `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`.
- Mobile: EAS (`apps/mobile/eas.json`, profiles `preview` and `production`), env `EXPO_PUBLIC_CONVEX_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`.
- Work on branches and open PRs into `main`.
