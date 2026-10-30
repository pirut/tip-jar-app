# Tip Jar — Product Plan (draft v0.1)

The fastest way to tip someone who just parked your car, drove your golf cart, or carried your bags. Tap, pick an amount, done in under 5 seconds. Workers can pool tips with whoever they're working with today and split them fairly. Companies can run tip pools and pay their people through the same app.

> Status: draft for feedback. Nothing here is final. Open questions are at the bottom.

---

## 1. Who uses it

| Role | What they want | Where they use it |
|---|---|---|
| **Tipper** (guest/customer) | Tip in seconds without cash, without downloading anything | Taps their card or phone on the worker's phone, or taps/scans the worker's badge |
| **Worker** (valet, cart attendant, bellhop, caddie…) | Take tips with no hardware, see today's total, get paid out fast | Worker app (iOS + Android) |
| **Group** (today's crew) | Pool tips for the shift and split them fairly without arguments | A "today's group" inside the worker app |
| **Company** (valet operator, golf club, hotel) | Set pool rules, see tip reports, pay workers through one system | Web dashboard |

## 2. Core flows

### 2a. Tipping (the 5-second flow)
Two ways in, both with no app download for the tipper:

1. **Tap to Pay on the worker's phone.** Worker opens the app, taps an amount (or lets the guest choose), guest taps card / Apple Pay / Google Pay on the worker's phone. This is the main path.
2. **Tap or scan the worker's badge.** Each worker gets an NFC sticker + QR code (badge, lanyard, key tag). Tapping it opens a tiny web page: worker's name and photo, preset amounts ($5 / $10 / $20 / custom), one Apple Pay / Google Pay button. Works when the worker's hands are full or the guest prefers their own phone.

Design rules for the tip screen: presets in big buttons, one tap to pay, no account, no forms, optional "cover the card fee" toggle, receipt only if they ask for it.

### 2b. Worker
- Sign up with phone number, then a short identity + bank/debit card step (required by law for receiving payouts).
- Home screen is one big "Accept tip" button and today's total.
- After a tip lands (and at the start of a shift) the app offers: **"Join today's group?"**
- Earnings: today / this week, history, **Cash out now** (instant to debit card) or automatic daily/weekly payout.

### 2c. Groups ("today's crew")
- Any worker can **start a group** for the day; others join by scanning the group QR on the starter's phone or entering a 4-digit code.
- While you're in a group, every tip you receive goes into the group pool. Everyone sees the pool total live.
- Groups auto-close at end of shift (time set by the starter, default midnight local). On close, the pool is split and each person's share is paid to their balance.
- **Split modes:**
  - **Even** — pool ÷ members.
  - **By hours** — each member's clocked time in the group (join → leave, or clock in/out in the app).
  - **By shares/points** — e.g. lead = 1.5, attendant = 1.0, runner = 0.5.
  - **Custom %** — fixed percentages that must add to 100.
- The starter picks the mode; members see it before joining. Changing the mode mid-day requires every member to approve (or is locked if a company owns the group).
- Rounding: work in cents; leftover pennies go one at a time to members in a rotating order so nobody always wins the extra cent.

### 2d. Companies
- Company creates an org, adds locations, invites workers (or workers request to join).
- **Standing pool rules** per location (e.g. "Valet stand A: split by hours, supervisors excluded"). Workers at that location join the company group automatically when they clock in.
- **Pay people through the app:** company funds its balance (bank transfer) and pays wages, bonuses, or tip-outs straight to workers' Tip Jar balances.
- **Reports:** tips per worker per pay period, exportable to payroll (CSV first, then Gusto / ADP / QuickBooks integrations) so tips get reported correctly.

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
- Card fees hurt small tips (roughly 30–45¢ on a $5 tip depending on pricing). Default the tipper-pays-fee toggle on and test how many guests leave it on.
- Apple requires a business-level Tap to Pay entitlement for the app; apply early, approval can take weeks.
- Square and Adyen also do Tap to Pay. Stripe is the pick because Connect handles splitting and payouts to many people in one platform.

### Money ledger
Every cent moves through our own append-only ledger (Postgres) that mirrors Stripe: `tip_received → pool → share_allocated → transfer → payout`. That gives us auditability, group dispute answers ("why did I get $41.12?"), and clean company reports.

## 4. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Worker app | **React Native (Expo)**, TypeScript | One codebase for iOS + Android; Stripe Terminal has a React Native SDK |
| Tip web page | **Next.js** on Vercel | Loads instantly from an NFC tap; Apple Pay / Google Pay on the web |
| Company dashboard | Same Next.js app, `/company` routes | One web codebase |
| API | Next.js API routes or a small Node/TypeScript service | Same language end to end |
| Database | **Postgres** (Supabase or Neon) | Ledger needs real transactions; Supabase adds auth + realtime for live pool totals |
| Auth | Phone number + SMS code (workers), email (company admins) | Workers shouldn't need passwords |
| Payments | Stripe Terminal + Connect + webhooks | See above |
| Notifications | Expo push | "You got a $10 tip", "Group closed, you made $84" |

## 5. Roadmap

| Phase | Goal | Scope |
|---|---|---|
| **0. Validate** (now) | Know we're building the right thing | This mockup, talk to 5–10 valets / cart attendants and 1–2 operators, apply for Apple Tap to Pay entitlement, open Stripe Connect platform account |
| **1. Solo tipping MVP** | One worker can get tipped and cash out | Worker signup + Connect onboarding, Tap to Pay, badge QR/NFC tip page, earnings, instant cash-out |
| **2. Groups** | A crew can pool for the day | Start/join group, live pool, even / hours / shares / custom splits, auto-close and distribution, group history |
| **3. Companies** | Operators run pools and pay staff | Org + locations, roster, standing pool rules, company-funded payouts, tip reports, CSV export, then payroll integrations |
| **4. Growth** | Make it spread | App Clip / Instant App for tippers, worker referral, custom badges, Spanish language, analytics for operators |

## 6. Risks to settle early
- **Tip pooling law.** US federal rules (FLSA) bar managers and supervisors from sharing in employee tip pools, and some states add their own rules. Company pool rules need an "excluded roles" setting and a legal review.
- **Tax reporting.** Tips are taxable income. Independent workers get 1099-Ks through Stripe; employees' tips must reach the employer's payroll. Recent federal changes around taxes on tips make clean per-worker tip records a selling point for companies.
- **Disputes and chargebacks** on tips that were already split. Plan: hold a small reserve per group, or claw back from the next pool.
- **Fraud.** A worker tipping themselves with stolen cards to cash out instantly. Plan: limits on instant payout for new accounts, Stripe Radar.

## 7. Open questions for JR
1. Who's first: independent workers (grow bottom-up) or companies (sell top-down)? This decides whether Phase 3 moves up.
2. Should the tipper ever see the group (e.g. "Tipping the Valet Stand crew") or always the individual worker?
3. Who pays card fees by default: tipper, worker, or company?
4. Revenue model: small fee per tip, company subscription, fee on instant cash-out, or a mix?
5. Do you want a physical badge/key tag product (NFC + QR) as part of the brand?
6. US only at launch?
