# Payment architecture and pilot gates

Status: design for the real-money pilot. Checked against Stripe's docs and `stripe@23.1.0` (API `2026-10-28.endive`) on 2026-10-31. Not legal or tax advice. Nothing here has had legal review.

## The short answers

**Can Stripe temporarily hold the money?** Yes, in a practical sense, but it is not escrow. Stripe's docs say it "doesn't provide escrow services or support escrow accounts". What we use: tips are charged to the platform's own Stripe account and stay in its balance until we create a transfer to the worker. Stripe's "funds segregation", which would keep this money apart from the platform's own, is a private preview that needs an account manager's approval. Without it, worker money and our revenue sit in one Stripe balance, so **our books have to separate them.**

**How do you get paid?** We keep the difference between what the guest pays and what we transfer to workers. It builds up in the platform Stripe balance and you pay it out to your own bank. Most of that difference is not profit:

- Stripe's processing fee comes out of it first. The estimate charged to guests is close to the real fee but doesn't match exactly.
- Worker money that hasn't been transferred yet sits in the same balance. Withdraw only the "safe to withdraw" figure from `ops:books`. The platform's automatic payouts must be off, or Stripe will sweep worker money to your bank.
- Connect charges the platform $2 per month per worker who gets a payout, plus 0.25% + 25¢ per payout, and $2.99 per 1099 e-filed (plus state and mail fees). See "Unit economics" below: **at 25¢ per tip, a light-use worker can lose money.**

## Charge model: one model for everything

Separate charges and transfers, for solo workers and crews alike. Not destination charges, because crew shares aren't known until the crew closes.

- The platform is merchant of record. Guests see Tip Jar on their statement.
- Connected accounts use Accounts v2 with only the recipient configuration. Workers just see "Set up payouts"; the account is created behind the scenes and Stripe collects identity and bank details on its own pages. Settings: `dashboard: "express"`, `fees_collector` and `losses_collector` both `application`, `stripe_balance.stripe_transfers` requested. Stripe requires exactly this for recipient-only accounts.
- `on_behalf_of` is not used. Recipient accounts can't take it. No `application_fee_amount`: our fee is what we don't transfer.
- **Not available yet.** The platform profile has to agree: Accounts v2 enabled, platform-held negative-balance liability acknowledged, Express for workers. The sandbox profile currently says the opposite on each, and its v2 request is only "Requested". Stripe's current API rejects these accounts, so this model can't go live until the owner decides on that liability and Stripe accepts it. Sandbox tests use `STRIPE_CONNECT_API=v1`, the same setup as v1 controller properties on an API version pinned to `2026-07-29.dahlia`. That fallback isn't a route to live.
- **The platform carries the risk.** Refunds, chargebacks, dispute fees and any negative worker balance debit the platform. Keep working capital in the Stripe balance and don't withdraw everything.

### Where a tip's money goes

| | Guest covers fees (default) | Fees from the tip |
|---|---|---|
| Guest pays (`chargedCents`) | tip + fees | tip |
| Owed to workers (`netCents`) | tip | tip − fees |
| Kept by platform | fees | fees |

`fees = cardFeeCents(tip) + 25¢`, unchanged from `convex/lib/money.ts`. The card part is an estimate of 2.9% + 30¢ of the *tip*. Stripe charges on the grossed-up total, so online tips run a few cents short (a $5 tip: 45¢ estimated, 47¢ actual, so 23¢ kept rather than 25¢). Each charge's real fee comes from its balance transaction and is booked separately. I kept the formula because no change is required for safety, and the difference is visible in the books.

### Unit economics, to decide before scaling

A worker with one payout in a month, on 20 $10 tips: 20 × ~25¢ = ~$5.00 kept, minus $2.00 active-account fee, minus 25¢ + 0.25% × $200 = 75¢ per payout. A worker paid out daily for 20 days: ~$5 kept, minus $2 minus 20 × ~26¢ = **−$2.20.** Daily automatic payouts are what make this bad. Pilot default: **weekly payouts** (set per account through Balance Settings), which also gives more time to catch fraud. Instant payouts stay off (Stripe charges 1%).

## Flows

### QR, on the web (Stripe-hosted Checkout)

1. The guest presses Pay. Public action `paymentsNode.createGuestCheckout` calls `payments.reservePayment`, a transaction that enforces the kill switch, enrollment, account readiness, limits and rate limits and creates a `tipPayments` row with server-computed amounts. The client sends only handle, tip amount, cover-fees and a request id.
2. The action re-checks the worker's Stripe capability and creates a Checkout Session with idempotency key `checkout:<rowId>` and `metadata.tipPaymentId`. No `payment_method_types`, so Apple Pay and Google Pay appear according to Dashboard settings.
3. The browser goes to Stripe's hosted page, so card data never reaches our code or database. We store card brand only. On return, the page shows state from our database and asks the server to re-fetch from Stripe. **The return URL never marks anything paid.**
4. Stripe's signed webhook triggers the sync below.

### Sync: how money facts enter our database

Every webhook is treated as a nudge rather than a source of data:

1. `http.ts` hands the raw body and signature to a Node action that verifies them. Invalid signature: 400. Wrong livemode: recorded, alerted, ignored.
2. `recordEvent` stores the event id, unique. A duplicate does nothing. A new one schedules a sync and returns 200, so an outage in our processing doesn't lose it; a cron retries unprocessed events.
3. `syncPayment` fetches the PaymentIntent, charge, balance transaction and disputes from Stripe, then `applyPaymentSnapshot` applies them in one transaction.

Fetching the current state makes duplicates and out-of-order events harmless: applying a snapshot twice changes nothing, and a snapshot read earlier than the last one applied is ignored.

`applyPaymentSnapshot` checks metadata id, amount, currency, livemode and channel. **Any mismatch freezes the payment for review, creates an alert and allocates nothing.** Status never moves backward from `succeeded`. A late success on an expired row is still honored, because Stripe has the guest's money.

### Allocation and transfer

- `allocations` is one row per tip per recipient. Solo: one row on success. Crew: at close, each tip is split by the crew's weights with `splitCents`, and the starting member rotates per tip so leftover cents move around. The sum of rows for a tip always equals its net.
- Each row has `targetCents` (what this person should end up with from this tip) and `paidCents` (what Stripe has actually moved, net of reversals). Everything else follows from the difference: positive means transfer, negative means reverse.
- **Hold.** A transfer becomes eligible `transferHoldHours` after payment (default 24). After that, `source_transaction` ties it to the charge, so Stripe doesn't release the money to the worker's balance until the charge has settled, and sums can't exceed the charge.
- `settlement.runDue` (a cron) claims rows in a transaction, re-checks the kill switch, tip state and capability, then transfers with idempotency key `alloc:<id>:<seq>`. Crash between Stripe's success and our write: the row stays `in_flight`, and the retry first looks for the transfer by group and metadata, then uses the same idempotency key. Stripe's keys can expire after 24 hours, which is why the lookup comes first.
- `paidCents` never changes without a Stripe transfer or reversal id.

### Crews

Real crews are a separate mode, fixed at creation (`crews.moneyMode`). Only enrolled workers with ready accounts can start or join one, and demo and real money never share a pool.

- A tip's crew is fixed when the payment is reserved, which is also what the guest was shown.
- If the crew has closed before the payment succeeds, the tip stays with the worker who took it. It is never lost, and the pool never changes after close.
- Only succeeded payments count toward the pool.
- Removal returns the removed member's tips to them. The removal is recorded by sign-in identity (`crewRemovals`), so deleting and recreating a profile can't get them back in.
- `crewMembers.payoutCents` is a snapshot at close. Later refunds change allocations and show up on the worker's records.

### Refunds and disputes

Refunds are operator-only, via `ops:refundTip`. Disputes come from Stripe. Both feed the same calculation, so any order of events gives the same result:

```
adverse   = min(charged, refunded + amount in open or lost disputes)
entitled  = net − round(net × adverse / charged)     // the rest of adverse comes off platform fees
```

`rebalanceTip` splits `entitled` across the tip's allocations in proportion to their original shares and sets each `targetCents`.

| Case | What happens |
|---|---|
| Money not transferred yet | Target drops. No Stripe call. |
| Already transferred | Reversal of the difference, on the specific transfers. |
| Reversal fails (worker's balance is short) | Added to `payeeAccounts.owedCents`, alert raised, worker's account frozen with payouts paused. Later transfers to them are reduced by what they owe, which Stripe's docs explicitly allow. The platform carries the loss until then. |
| Inquiry (`warning_*`), no money withdrawn yet | Tip frozen: no further transfers, no reversal. |
| Dispute won | Entitled goes back up. New transfers without `source_transaction`, since the reinstated money is in the platform balance. |
| Dispute lost | Stays reduced. |

Stripe keeps its processing fee on refunds and charges a dispute fee. Both are booked as platform cost.

### Ledger

`ledgerEntries` is append-only double entry, one row per debit/credit pair, with a unique `ref` so a posting can't happen twice.

| Event | Debit | Credit |
|---|---|---|
| Payment succeeded | `stripe_balance` | `worker_liability` (net), `platform_fees` (rest) |
| Stripe fee known | `processing_cost` | `stripe_balance` |
| Adverse increases (refund/dispute) | `worker_liability`, `platform_fees` | `stripe_balance` |
| Adverse decreases (dispute won) | `stripe_balance` | `worker_liability`, `platform_fees` |
| Dispute fee | `dispute_fees` | `stripe_balance` |
| Transfer to worker | `worker_liability` | `stripe_balance` |
| Reversal | `stripe_balance` | `worker_liability` |

A negative `worker_liability` means workers owe the platform (an unrecovered reversal).

`ops:books` reports platform revenue (`platform_fees − processing_cost − dispute_fees`) apart from worker liabilities, and `safeToWithdraw = Stripe available − worker liabilities − reserve`.

### Worker money screens

| Figure | Source |
|---|---|
| Available and pending | Connected account's Stripe balance (webhook-driven, cached on `payeeAccounts`, refreshable) |
| Payouts and failures | Stripe payout objects, synced by webhook |
| On hold before transfer, in a crew pool | Our allocations and tips, labelled as ours |
| Legacy demo balance | `tips` and `cashouts` only, shown separately with a Demo tag, never added to real money |

Test-mode money carries a "Test" tag everywhere. Banking and tax details stay in Stripe's Express Dashboard, reached through a login link.

## Modes and gates

Nothing real happens unless every gate passes, and all are checked on the server.

| Gate | Where | Default |
|---|---|---|
| `STRIPE_MODE` set and the key prefix matches it (`test`: `sk_test_`/`rk_test_`; `live`: `sk_live_`/`rk_live_`) | `lib/stripeEnv.ts`, every Stripe call | Unset: demo only |
| Global controls: `chargesEnabled`, `transfersEnabled`, limits | `paymentControls` | No row: everything off |
| Worker enrolled | `pilotEnrollments`, internal functions only | Not enrolled: demo |
| Platform profile allows recipient accounts (see above) | Stripe, at account creation | Currently refused on the current API |
| Worker's `stripe_transfers` capability `active`, not frozen | `payeeAccounts`, re-checked with Stripe before charging and transferring | Not ready: guest sees "can't take tips yet" |
| Limits | per tip $100, per worker $500/day, all workers $2,500/day | Can be tightened per worker |

No public mutation writes to `tipPayments`, `allocations`, `ledgerEntries`, `payeeAccounts`, `pilotEnrollments` or `paymentControls`. A test enforces the list of public mutations. `tipFromGuest`, `recordTap` and `cashOutInstant` still exist for demo users, write only `demo: true`, and reject enrolled workers.

## Records that outlive an account

Deleting an account:

- **Blocked** while there's an open crew, an unsettled allocation, a payment in progress, an open dispute, a frozen account, or a non-zero Stripe balance (checked within the last few minutes).
- **Kept:** `tipPayments`, `allocations`, `ledgerEntries`, `payouts`, `payeeAccounts`, the Stripe account. Needed for tax, disputes and accounting.
- **Deleted:** the profile and demo records.

**Handle ownership is permanent.** `handleClaims` keeps one row per handle ever used, tied to the sign-in identity. A printed QR can never start paying a different person: old handles keep resolving to the same worker after a rename, deleted handles show "not found" and can only be taken back by the same identity.

## Tap to Pay: deferred

The owner decided on 2026-10-31 to hold off. The pilot has no Terminal SDK, native dependency, entitlement or Apple requirement. Real pilot workers see "Tap to Pay: coming later" and take tips by QR. The simulated tap still exists for demo accounts, writes only `tips` with `demo: true`, and is refused for anyone enrolled.

For when it comes back:

- Apple's entitlement form requires an organization Developer account and its Account Holder. The current team is individual.
- Terminal fits this model: PaymentIntents and locations on the platform, the same reservation, sync and allocation path as Checkout.
- A sandbox PaymentIntent created with `allowed_payment_method_types: ["card_present"]` was accepted. Nothing further was tested.

## Decisions I made that you can overrule

| Decision | Why |
|---|---|
| 24-hour hold, then transfer | Time to catch fraud and refunds while money is still ours, and worth less than the risk of waiting days more |
| Weekly worker payouts in the pilot | See Unit economics. Plan says daily or instant; that is a cost and fraud decision worth making deliberately |
| No instant payouts | 1% cost, and the plan's own fraud risk section |
| No worker-initiated refunds | Keeps a stolen-card-and-refund loop out of the pilot |
| Keep the fee formula | No change needed for safety; the shortfall is a few cents and is booked |

## What needs a person, not code

- A lawyer: fee-covering disclosure and surcharge rules, money transmission, the FLSA tip-pool rules in PLAN.md section 6, Terms and Privacy final text.
- A tax adviser and Stripe's 1099 settings. Connect tax reporting has to be configured in the Dashboard for the year.
- Stripe: platform profile and acceptance of responsibility for negative balances; approval of this business model during review.
