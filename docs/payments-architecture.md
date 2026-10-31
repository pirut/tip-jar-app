# Payment architecture and pilot gates

Status: design for the real-money pilot. Checked against Stripe's docs and `stripe@23.1.0` (API `2026-10-28.endive`) on 2026-10-31. Not legal or tax advice. Nothing here has had legal review.

## The short answers

**Can Stripe temporarily hold the money?** Yes, in a practical sense, but it is not escrow. Stripe's docs say it "doesn't provide escrow services or support escrow accounts". What we use: tips are charged to the platform's own Stripe account and stay in its balance until we create a transfer to the worker. Stripe's "funds segregation", which would keep this money apart from the platform's own, is a private preview that needs an account manager's approval. Without it, worker money and our revenue sit in one Stripe balance, so **our books have to separate them.**

**How do you get paid?** We keep the difference between what the guest pays and what we transfer to workers. It builds up in the platform Stripe balance and you pay it out to your own bank. Most of that difference is not profit:

- Stripe's processing fee comes out of it first. The estimate charged to guests is close to the real fee but doesn't match exactly.
- Worker money that hasn't been transferred yet sits in the same balance. Withdraw only the "safe to withdraw" figure from `ops:books`, right after a fresh reconciliation. The platform's automatic payouts must be off, or Stripe will sweep worker money to your bank. The figure shows zero, with the reasons, whenever they aren't.
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
3. `syncPayment` claims a read with `beginPaymentRead`, fetches the PaymentIntent, charge, balance transaction, refunds and disputes from Stripe, then `applyPaymentSnapshot` applies them in one transaction.

Fetching the current state makes duplicates and out-of-order events harmless. **Overlapping reads are refused, not ordered.** Each read gets a number (`tipPayments.latestReadToken`), and only the newest one started can be applied. A read that gets overtaken starts again, up to four times, then throws so the event retries. So whatever gets applied began after any earlier applied read had finished. Clocks and arrival order play no part, and this doesn't clamp amounts, because refund and dispute totals can really go down.

Stripe's own reads are assumed to reflect anything Stripe finished before the read started. The sandbox was consistent with that; we have no guarantee of it from Stripe.

`applyPaymentSnapshot` checks metadata id, amount, currency, livemode and channel. **Any mismatch freezes the payment for review, creates an alert and allocates nothing.** Status never moves backward from `succeeded`. A late success on an expired row is still honored, because Stripe has the guest's money.

### Allocation and transfer

- `allocations` is one row per tip per recipient. Solo: one row on success. Crew: at close, each tip is split by the crew's weights with `splitCents`, and the starting member rotates per tip so leftover cents move around. The sum of rows for a tip always equals its net.
- Each row has `targetCents` (what this person should end up with from this tip) and `paidCents` (what Stripe has actually moved, net of reversals). Everything else follows from the difference: positive means transfer, negative means reverse.
- **Hold.** A transfer becomes eligible `transferHoldHours` after payment (default 24). After that, `source_transaction` ties it to the charge, so Stripe doesn't release the money to the worker's balance until the charge has settled, and sums can't exceed the charge.
- `paymentsNode.runDue` (a cron) claims rows in a transaction, re-checks the kill switch, tip state and capability, then transfers with idempotency key `alloc:<id>:<seq>:<amount>`. Crash between Stripe's success and our write: the row stays `in_flight`, and the retry first looks for the transfer by group and metadata, then uses the same idempotency key. Stripe's keys can expire after 24 hours, which is why the lookup comes first. A row with a failed attempt behind it isn't marked settled until that lookup has run, even if a refund has since brought what's due to zero.
- A claim sets aside any debt it uses (`inFlightOffsetCents`, already taken off `owedCents`), so two claims at once can't both spend it. It goes back if the transfer doesn't happen.
- `paidCents` never changes without a Stripe transfer or reversal.

### Crews

Real crews are a separate mode, fixed at creation (`crews.moneyMode`). Only enrolled workers with ready accounts can start or join one, and demo and real money never share a pool.

- A tip's crew is fixed when the payment is reserved, which is also what the guest was shown.
- If the crew has closed before the payment succeeds, the tip stays with the worker who took it. It is never lost, and the pool never changes after close.
- Only succeeded payments count toward the pool.
- Removal returns the removed member's tips to them. The removal is recorded by sign-in identity (`crewRemovals`), so deleting and recreating a profile can't get them back in.
- `crewMembers.payoutCents` is a snapshot at close. Later refunds change allocations and show up on the worker's records.

### Refunds and disputes

Refunds are operator-only, via `paymentsNode:refundTip`. Disputes come from Stripe. Both feed the same calculation, so any order of events gives the same result:

```
refunded  = sum of the charge's refunds that haven't failed or been canceled
adverse   = min(charged, refunded + amount in open, lost or appealed disputes)
entitled  = net − round(net × adverse / charged)     // the rest of adverse comes off platform fees
```

`refunded` comes from listing the charge's refunds, because a refund can fail after looking finished. In the sandbox, a refund that later failed read `succeeded` for about two to four minutes. Then `charge.amount_refunded` dropped back and a `refund_failure` balance transaction returned the money, with `refund.failed` and no new `charge.refunded`. Stripe's docs say this can take up to 30 days from the post date in real use, so hourly reconciliation keeps rechecking refunded tips for 40 days.

`rebalanceTip` splits `entitled` across the tip's allocations in proportion to their original shares and sets each `targetCents`.

| Case | What happens |
|---|---|
| Money not transferred yet | Target drops. No Stripe call. |
| Already transferred | Reversal of the difference, on the specific transfers. Stripe's running totals are read first, so what's already reversed isn't reversed again. |
| Worker's funds still pending on Stripe | The reversal works and comes out of their pending balance (seen in the sandbox with a 4242 card). |
| Worker has nothing left (already paid out) | The reversal **still succeeds on our accounts**, and their Stripe balance goes negative (seen in the sandbox). Stripe then reserves that amount from the platform's available balance. We check their balance after every reversal: negative freezes them, pauses payouts and raises `negative_balance`. No `owedCents`: Stripe's balance already holds it, and their next transfers clear it first. |
| Stripe refuses for lack of balance | Not seen with these accounts, but Stripe's docs describe it for accounts without connected reserves. Not a debt yet: the worker is frozen, `reversal_short` goes up, and it retries every 6 hours. After 7 days of refusals it becomes `owedCents` with `reversal_debt`, and later transfers are reduced by it. Other errors are ordinary retries. |
| Reversed in the Dashboard, more than the tip called for | Taken on from Stripe's total. The worker is frozen and `reversal_unexpected` goes up, rather than paying it straight back. |
| Refund pending | Counts as refunded, and its amount stays held for the guest. Stripe took the money when it was created (seen in the sandbox), so that hold is cautious by double counting. |
| Refund failed or canceled | Stops counting, so the worker's entitlement goes back up. The money stays on the platform, and `refund_failed` goes up, because the guest still hasn't been paid back. Nothing goes to the worker until `ops:resolveFailedRefund`. A reissued refund lowers the entitlement again on its own. |
| Inquiry (`warning_*`), no money withdrawn yet | Tip frozen: no further transfers, no reversal. Its amount is held out of the safe figure. |
| Appeal (`appeal_*`) | Still open: tip frozen, deletion blocked, rechecked hourly. The money stays taken. |
| Dispute won | Entitled goes back up. New transfers without `source_transaction`, since the reinstated money is in the platform balance. That also applies to a first transfer after any dispute. |
| Dispute lost | Stays reduced. |

Stripe keeps its processing fee on refunds and charges a dispute fee. Both are booked as platform cost.

### Ledger

`ledgerEntries` is append-only double entry, one row per debit/credit pair, with a unique `ref` so a posting can't happen twice. Amounts can repeat (a refund fails and is reissued), so a tip's adjustment refs carry a per-tip sequence (`ledgerSeq`) rather than amounts. A reversal's ref is the transfer and Stripe's running total, `reversal:<transfer>:<amount_reversed>`, which is the same however it's seen: the direct call, a retry, a webhook or reconciliation.

| Event | Debit | Credit |
|---|---|---|
| Payment succeeded | `stripe_balance` | `worker_liability` (net), `platform_fees` (rest) |
| Stripe fee known or changed | `processing_cost` | `stripe_balance` |
| Adverse increases (refund/dispute) | `worker_liability`, `platform_fees` | `stripe_balance` |
| Adverse decreases (dispute won, refund failed) | `stripe_balance` | `worker_liability`, `platform_fees` |
| Dispute fee, by the change in the total | `dispute_fees` | `stripe_balance` |
| Transfer to worker | `worker_liability` | `stripe_balance` |
| Reversal | `stripe_balance` | `worker_liability` |
| Payment under review | `stripe_balance` | `review_held` |
| Connect and other Stripe charges | `stripe_costs` | `stripe_balance` |
| Stripe's reserve for a negative worker balance | `connect_reserve` | `stripe_balance` |
| Stripe activity nobody can explain | `unclassified` | `stripe_balance` |
| Owner payout / top-up | `owner_withdrawals` / `stripe_balance` | `stripe_balance` / `owner_capital` |

`worker_liability` is a **net** figure. One worker's negative can hide another's positive, so it's for the books only and never decides what's safe.

### Safe to withdraw

`ops:books` works out `safeToWithdrawCents = Stripe available − obligations`, where each obligation is gross:

| Obligation | Comes from |
|---|---|
| `workerDueCents` | Every due or in-flight allocation's positive amount. A worker's debt or pending reversal never counts as cash for someone else |
| `unallocatedTipCents` | Succeeded tips not split yet, like those in open crew pools |
| `reviewHeldCents` | What Stripe collected on payments under review |
| `guestHoldCents` | Refunds pending, failed refunds nobody has resolved, open inquiries |
| `negativeWorkerCents` | Negative worker balances beyond what Stripe has reserved so far. In the sandbox the reserve showed up within about a minute |
| `reserveCents` | The owner's own buffer, from `ops:setControls` |

**It's zero, with `withdrawalBlockers` saying why,** when: there's no reconciliation or it's over two hours old; the balance-transaction scan hasn't finished; a transaction is unexplained; the books and Stripe differ; the last reconciliation had problems; the platform's own payouts aren't confirmed manual; or open records are too many to add up.

**What this doesn't promise.** It's a snapshot. A dispute, refund or fee after it can still make a withdrawal too much, and the balance can fall short of what's owed. Stripe won't check our figure before paying out. When an owner payout leaves less than what's owed, `withdrawal_above_safe` goes up afterwards. Money in `pending` isn't counted as available. Transfers that have gone out can still come back as losses, which is what the reserve is for.

### Reconciliation

`paymentsNode.reconcileBooks` runs hourly. It reads every balance transaction since the last run, newest first in pages of 100 with a saved position (`balanceScan`), so a run that's cut off picks up where it stopped. Each pass overlaps the last by a day, and each transaction is one `balanceTxns` row, so nothing posts twice. The first pass starts from our first payment, and whatever was already in the balance becomes `openingCents`.

| Stripe says | Handled as |
|---|---|
| `charge`, `payment` | Must match a tip's charge and fee. If not, the tip is re-read from Stripe first |
| `refund`, `refund_failure` | Must be on the tip, with the right status. This is how a refund no webhook mentioned gets found, however old |
| `adjustment` with category `dispute` or `dispute_reversal` | Must be on the tip |
| `transfer`, `transfer_refund` | Must match an allocation, recipient and amount. Stripe's running total is applied. Its source is the transfer, not the reversal |
| `transfer_cancel`, `transfer_failure` | Raises an alert; nothing here handles these by itself |
| `payout*`, `topup*` | Booked as the owner's, through the same idempotent refs as their webhooks |
| `stripe_fee`, `tax_fee`, `stripe_fx_fee` | Booked to `stripe_costs`. No alert, so ordinary Connect fees don't bury real ones |
| `reserve_transaction`, `connect_collection_transfer` | Booked to `connect_reserve`. A collection also raises an alert |
| Anything else, other currencies, other `adjustment`s | Booked to `unclassified`, `txn_unexplained` (critical), blocks withdrawals until `ops:acknowledgeTxn` |

A transfer with no allocation behind it is treated as an emergency: `transfers_stopped`, `transfersEnabled` off, and the recipient frozen if it's one of our workers. Reversals still run.

Since every known movement is booked, a remaining difference between Stripe's balance and `opening + ledger` is real money unaccounted for: `books_difference`, critical, unless a transfer is mid-flight or the scan hasn't finished. Stripe's own list has to add up to its balance as well.

`reconcile` (also hourly) retries events, rechecks recent payments, every open dispute and recently refunded tips, syncs workers' accounts and balances, and verifies each payout schedule.

### Freezing a worker

Freezing stops transfers immediately (`frozenReason`) and records what we want Stripe's payout schedule to be (`payoutScheduleDesired`). `payoutsPaused` means **Stripe has confirmed manual payouts** and is never set before that. A failed Stripe call raises `payout_schedule_failed`, critical for a freeze, and retries after 2, 4, 8 minutes and so on up to hourly. A scheduled action that throws isn't retried by Convex, so this one records its failure instead of throwing. `reconcile` also compares the real schedule hourly, puts it back and raises `payout_schedule_drift` if it was changed behind us. A generation number stops an older run recording success after the desire has changed. `ops:status` lists anyone unconfirmed under `payoutPauseUnconfirmed`.

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

- **Blocked** while there's an open crew, an unsettled allocation, a payment in progress, an open or appealed dispute, a frozen account, or a non-zero Stripe balance (checked within the last few minutes).
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
