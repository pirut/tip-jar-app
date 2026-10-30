# Tip Jar — Product Plan (draft v0.2)

The fastest way to tip someone who just parked your car, drove your golf cart, or carried your bags. Tap, pick an amount, done in under 5 seconds. Workers can pool tips with whoever they're working with today and split them fairly. Companies can run tip pools and pay their people through the same app.

> Status: v0.2, updated with JR's answers from 2026-10-30. Decisions are listed in section 7. US only at launch.

---

## 1. Who uses it

| Role | What they want | Where they use it |
|---|---|---|
| **Tipper** (guest/customer) | Tip in seconds without cash, without downloading anything | Taps their card or phone on the worker's phone, or taps/scans the worker's badge |
| **Worker** (valet, cart attendant, bellhop, caddie…) | Take tips with no hardware, see today's total, get paid out fast | Worker app (iOS + Android) |
| **Crew** (today's group) | Pool tips for the shift and split them fairly without arguments | A "today's crew" inside the worker app |
| **Company** (valet operator, golf club, hotel) | Set pool rules, see tip reports, pay out tips through one system (wages later) | Web dashboard |

## 2. Core flows

### 2a. Tipping (the 5-second flow)
Two ways in, both with no app download for the tipper:

1. **Tap to Pay on the worker's phone.** Worker opens the app, taps an amount (or lets the guest choose), guest taps card / Apple Pay / Google Pay on the worker's phone. This is the main path.
2. **Scan the worker's QR code.** At launch each worker gets a printable QR code (badge card, lanyard, stand sign). Scanning it opens a tiny web page: worker's name and photo, preset amounts ($5 / $10 / $20 / custom), one Apple Pay / Google Pay button. Works when the worker's hands are full or the guest prefers their own phone. Branded NFC badges and key tags come later, once the flow is proven.

Design rules for the tip screen: presets of $5 / $10 / $20 for every job type, one tap to pay, no account, no forms, receipt only if they ask for it. The guest always sees the individual worker they're tipping; if that worker is in a crew, a small line says tips are shared with their crew. A "cover the fees" switch is **on by default** so the worker gets the full tip.

### 2b. Worker
- Sign up with phone number, then a short identity + bank/debit card step (required by law for receiving payouts).
- Home screen is one big "Accept tip" button and today's total.
- After a tip lands (and at the start of a shift) the app offers: **"Join today's group?"**
- Earnings: today / this week, history, **Cash out now** (instant to debit card) or automatic daily/weekly payout.

### 2c. Crews (today's tip-sharing group)
- Any worker can **start a crew** for the day; others join by scanning the crew QR on the starter's phone or entering a 4-digit code.
- While you're in a crew, every tip you receive goes into the crew pool. Tips you got **before** joining stay yours. Everyone sees the pool total live.
- Crews auto-close at end of shift (time set by the starter, default midnight local). On close, the pool is split and each person's share is paid to their balance.
- **Split modes:**
  - **Even** — pool ÷ members.
  - **By hours** — each member's clocked time in the crew (join → leave, or clock in/out in the app).
  - **By shares/points** — e.g. lead = 1.5, attendant = 1.0, runner = 0.5.
  - **Custom %** — fixed percentages that must add to 100.
- **Only the crew starter** picks and changes the split mode. Members see the current mode before joining, and every member is notified when it changes. Crews set up by a company follow the company's rules instead.
- Rounding: work in cents; leftover pennies go one at a time to members in a rotating order so nobody always wins the extra cent.

### 2d. Companies
- Company creates an org, adds locations, invites workers (or workers request to join).
- **Standing pool rules** per location (e.g. "Valet stand A: split by hours, supervisors excluded"). Workers at that location join the company crew automatically when they clock in.
- **Tip payouts through the app:** pooled tips and company tip-outs or bonuses go straight to workers' Tip Jar balances. **Wages come later**, once companies ask for it (that means tax withholding and filings, a much bigger build).
- **Reports:** tips per worker per pay period as a **CSV export** that works with any payroll tool. We'll pick a payroll integration (Gusto, ADP, Paychex…) after seeing what the pilot company uses.

## 3. Payments approach

**Use Stripe for everything money-related** so we never hold funds ourselves (avoids becoming a money transmitter, and Stripe handles identity checks, 1099s, and payouts).

| Need | Stripe product |
|---|---|
| Tap to Pay on the worker's phone (iPhone + Android, no hardware) | **Stripe Terminal — Tap to Pay** (React Native SDK) |
| Badge / QR web tip page | **Payment Element / Express Checkout** (Apple Pay, Google Pay, cards) |
| Worker accounts, identity, payouts | **Stripe Connect** (Express accounts) |
| Fast cash-out | **Instant Payouts** to debit card |
| Group splits and company payroll | **Separate charges and transfers**: the tip is charged to the platform, then transferred to members when the group closes |
| 1099 tax forms for workers | Connect tax reporting |

Notes:
- Card fees hurt small tips (roughly 30–45¢ on a $5 tip depending on pricing). The cover-the-fees switch is on by default; track how many guests leave it on.

### How Tip Jar makes money
A **small platform fee on each tip**, on top of card fees, collected as a Connect application fee. With the cover-the-fees switch on, the guest pays it and the worker still gets the full tip. Fee size is still to be set; keep it small enough that the $5 tip total stays reasonable.
- Apple requires a business-level Tap to Pay entitlement for the app; apply early, approval can take weeks.
- Square and Adyen also do Tap to Pay. Stripe is the pick because Connect handles splitting and payouts to many people in one platform.

### Money ledger
Every cent moves through our own append-only ledger (Convex) that mirrors Stripe: `tip_received → pool → share_allocated → transfer → payout`. That gives us auditability, group dispute answers ("why did I get $41.12?"), and clean company reports.

## 4. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Worker app | **React Native (Expo)**, TypeScript | One codebase for iOS + Android; Stripe Terminal has a React Native SDK |
| Tip web page | **Next.js** on Vercel at tip.jrbussard.com | Loads instantly from an NFC tap; Apple Pay / Google Pay on the web |
| Company dashboard | Same Next.js app, `/company` routes | One web codebase |
| Backend + database | **Convex** | Transactional functions for the tip ledger, realtime pool totals, auth (Convex Auth), scheduled crew auto-close |
| Auth | Phone number + SMS code (workers), email (company admins) | Workers shouldn't need passwords |
| Payments | Stripe Terminal + Connect + webhooks | See above |
| Notifications | Expo push | "You got a $10 tip", "Group closed, you made $84" |

## 5. Roadmap

| Phase | Goal | Scope |
|---|---|---|
| **0. Validate** (now) | Know we're building the right thing | This mockup, find **one friendly pilot operator** (valet company or golf club), talk to their workers, apply for Apple Tap to Pay entitlement, open Stripe Connect platform account (US) |
| **1. Solo tipping MVP** | One worker can get tipped and cash out | Worker signup + Connect onboarding, Tap to Pay, printable QR tip page, platform fee, earnings, instant cash-out |
| **2. Crews** | A crew can pool for the day | Start/join crew, live pool, even / hours / shares / custom splits, auto-close and distribution, crew history |
| **3. Companies** | The pilot operator runs pools and tip payouts | Org + locations, roster, standing pool rules, tip payouts, tip reports, CSV export |
| **4. Growth** | Make it spread | Payroll integration, wages through Tip Jar, branded NFC badges and key tags, App Clip / Instant App for tippers, worker referral, Spanish language |

Go-to-market: run phases 1–3 with the pilot operator's staff while their workers also use Tip Jar on their own, so we prove both the company side and the worker side with one group of real users.

## 6. Risks to settle early
- **Tip pooling law.** US federal rules (FLSA) bar managers and supervisors from sharing in employee tip pools, and some states add their own rules. Company pool rules need an "excluded roles" setting and a legal review.
- **Tax reporting.** Tips are taxable income. Independent workers get 1099-Ks through Stripe; employees' tips must reach the employer's payroll. Recent federal changes around taxes on tips make clean per-worker tip records a selling point for companies.
- **Disputes and chargebacks** on tips that were already split. Plan: hold a small reserve per group, or claw back from the next pool.
- **Fraud.** A worker tipping themselves with stolen cards to cash out instantly. Plan: limits on instant payout for new accounts, Stripe Radar.

## 7. Decisions (JR, 2026-10-30)
| Question | Decision |
|---|---|
| Preset tip amounts | $5 / $10 / $20 for every job type |
| What the guest sees | The individual worker, with a small note that tips are shared with their crew |
| Cover-the-fees switch | On by default |
| Name for the day's group | Crew |
| Who changes a crew's split | Only the crew starter |
| Tips received before joining a crew | Stay with the worker |
| Wages through Tip Jar | Tips now, wages later |
| First payroll connection | CSV export first; pick an integration after talking to companies |
| Go-to-market | One pilot operator whose workers also use it on their own |
| Revenue | Small platform fee per tip |
| Physical NFC badge / key tag | Later; printable QR codes first |
| Launch market | US only |
