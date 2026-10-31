# Real-money pilot runbook

How to set up, run and stop the pilot. The money model is in `docs/payments-architecture.md`. This isn't legal or tax advice.

Commands use `npx convex run` on the deployment you mean. Add `--prod` for production.

## Before anyone real pays: what only a person can do

Nothing in this list is done yet for live mode.

**In the Stripe Dashboard, live account**

1. Finish activating the account: business details, bank account, statement descriptor. Guests' statements will show this name, so use "TIP JAR" or similar.
2. Connect → Platform profile: **complete the loss-liability acknowledgement and enable Accounts v2.** Stripe's current API refuses to create workers without this. Be sure about it: it makes the platform responsible for refunds, chargebacks and negative worker balances. Stripe says this setup suits platforms with experience in this area, so it may ask questions.
3. Settings → Payouts: **set the platform's own payouts to manual.** On automatic, Stripe would sweep worker money to your bank.
4. Settings → Payment methods: cards, Apple Pay and Google Pay only. The code excludes Klarna, Affirm and Afterpay; other bank or delayed methods stay off.
5. Connect → Tax reporting: set up 1099 reporting for the year.
6. Connect → Branding: name, color and icon for the Express dashboard and onboarding.
7. Add a restricted API key with only what's listed below. Don't use a CLI login as a backend key.

**Not software**

- A lawyer should look at: fee-covering disclosures and surcharge rules, money transmission, tip-pool rules (FLSA and state), the final Terms and Privacy. They are drafts.
- Tell Stripe what the business does, if asked. Confirm tipping with separate transfers fits your account.
- Keep a working-capital buffer in the Stripe balance for refunds and disputes. Set it as `reserveCents` below.

## Stripe key permissions

A restricted key (`rk_`) with write access to: Checkout Sessions, PaymentIntents, Refunds, Transfers (including reversals), Accounts v2 and account links, login links, Balance Settings. Read access to: Balance, Disputes, Charges, Events, Payouts, Top-ups.

## Backend settings

`npx convex env set [--prod] NAME value`

| Name | Value |
|---|---|
| `STRIPE_MODE` | `test` on dev, `live` on production. Unset means no real money at all |
| `STRIPE_SECRET_KEY` | The restricted key. Its prefix has to match `STRIPE_MODE` or every call refuses |
| `STRIPE_WEBHOOK_SECRET` | From the platform endpoint below |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | From the Connect endpoint below |
| `TIP_ORIGIN` | `https://tip-jar-dev.testing.jrbussard.com` on dev, `https://tip.jrbussard.com` on production |
| `STRIPE_CONNECT_API` | Leave unset. `v1` is a fallback for a sandbox without Accounts v2; Stripe's newer API rejects it for new accounts |
| `OPS_ALERT_WEBHOOK_URL` | Optional. Slack-style URL for alerts |

## Webhook endpoints

Replace `<site>` with the deployment's `.convex.site` address. The response to each command includes its signing secret. Add `--live` for production.

```bash
stripe webhook_endpoints create --url https://<site>/stripe/webhook \
  -d "enabled_events[]=checkout.session.completed" -d "enabled_events[]=checkout.session.expired" \
  -d "enabled_events[]=checkout.session.async_payment_succeeded" -d "enabled_events[]=checkout.session.async_payment_failed" \
  -d "enabled_events[]=payment_intent.succeeded" -d "enabled_events[]=payment_intent.processing" -d "enabled_events[]=payment_intent.payment_failed" -d "enabled_events[]=payment_intent.canceled" \
  -d "enabled_events[]=charge.succeeded" -d "enabled_events[]=charge.updated" -d "enabled_events[]=charge.refunded" -d "enabled_events[]=charge.refund.updated" \
  -d "enabled_events[]=charge.dispute.created" -d "enabled_events[]=charge.dispute.updated" -d "enabled_events[]=charge.dispute.closed" -d "enabled_events[]=charge.dispute.funds_withdrawn" -d "enabled_events[]=charge.dispute.funds_reinstated" \
  -d "enabled_events[]=transfer.created" -d "enabled_events[]=transfer.updated" -d "enabled_events[]=transfer.reversed" \
  -d "enabled_events[]=payout.paid" -d "enabled_events[]=payout.failed" -d "enabled_events[]=payout.canceled" -d "enabled_events[]=topup.succeeded"

stripe webhook_endpoints create --url https://<site>/stripe/connect-webhook -d connect=true \
  -d "enabled_events[]=account.updated" -d "enabled_events[]=capability.updated" \
  -d "enabled_events[]=payout.created" -d "enabled_events[]=payout.updated" -d "enabled_events[]=payout.paid" -d "enabled_events[]=payout.failed" -d "enabled_events[]=payout.canceled" \
  -d "enabled_events[]=balance.available"
```

## Deploying

The order matters, because the web app calls functions that have to exist first.

1. `npx convex deploy`, then `npx convex run --prod migrations:backfillHandleClaims`. Everything stays off: no `STRIPE_MODE` or controls yet means demo.
2. Set the backend settings and webhooks.
3. Deploy the web app.
4. A new mobile build is needed for the new screens. No new native dependencies; ordinary EAS profiles work.

## Turning it on

```bash
npx convex run ops:setControls '{"chargesEnabled":true,"transfersEnabled":true,"reserveCents":50000}'
npx convex run ops:enrollWorker '{"handle":"marcus","note":"pilot operator, Harbor Hotel"}'
```

The worker then opens the app, chooses **Set up payouts**, and finishes Stripe's form. Once Stripe activates them, their QR page starts charging real cards. Until then guests see "can't take tips here right now".

An enrolled worker can't be in an open demo crew; have them close it first. Their old demo records stay, marked Demo, but no longer show as a balance.

Default limits: $100 a tip, $500 per worker per day, $2,500 overall per day, held 24 hours before transfer. To change them: `ops:setControls '{"transferHoldHours":48}'`, or per worker with `perTipLimitCents` and `dailyLimitCents` on `ops:enrollWorker`.

**First live test:** tip yourself $1 with your own card, watch it through to your bank, refund a second one. Do this before any real guest.

## Every day

```bash
npx convex run ops:status     # switches, open alerts, stuck money, payments in review
npx convex run ops:books      # what's the workers', what's yours, what's safe to take out
```

| Alert | Means | Do |
|---|---|---|
| `payment_mismatch` (critical) | Stripe's record doesn't match what we asked to collect. Nothing is paid out on it | Look it up in Stripe. Usually refund it in the Dashboard. `ops:clearReview` re-checks with Stripe |
| `reversal_short` (critical) | Couldn't take a refund back; the worker has already been paid out. They're frozen and owe it | Talk to them. Their later tips pay it off. `ops:unfreezeWorker` when resolved. The platform carries the loss until then |
| `negative_balance` (critical) | A worker's Stripe balance is below zero, and it's our liability | Same as above |
| `transfer_stuck` (critical) | A transfer failed 5+ times. Usually means the platform balance is too low | Add funds to the Stripe balance. It retries on its own |
| `books_mismatch` (critical) | Workers are owed more than Stripe holds, or a charge has no record | Don't withdraw. Find out why before anything else |
| `event_failed` (critical) | A webhook kept failing to process | Read the error; the hourly reconcile also re-checks recent payments |
| `event_wrong_mode` (critical) | A test event reached a live deployment or the reverse | Check webhook settings and `STRIPE_MODE` |
| `dispute` (warning) | A guest disputed a charge. Their share is already frozen or taken back | Respond in the Stripe Dashboard before the deadline |
| `account_restricted`, `payout_failed` (warning) | Stripe needs something from the worker | Tell them to open Earnings in the app |
| `books_difference` (warning) | Stripe's balance differs from the books. Usually monthly Connect fees | Check it adds up. Not a problem by itself |

Close an alert with `ops:resolveAlert '{"alertId":"..."}'`.

## Stopping things

```bash
npx convex run ops:setControls '{"chargesEnabled":false}'    # no new tips. Earned money still moves
npx convex run ops:setControls '{"transfersEnabled":false}'  # money stays on the platform. New tips still work
npx convex run ops:suspendWorker '{"handle":"marcus"}'       # no new tips for one person
npx convex run ops:freezeWorker '{"handle":"marcus","reason":"investigating"}'  # no transfers, and Stripe stops their payouts
```

Suspected fraud: freeze the worker first, then stop charges if it's wider. Reversals keep working with every switch off, so money can always be recovered. Stopping everything: both `setControls` lines. Setting `STRIPE_MODE` empty stops all Stripe calls but also stops refund and dispute processing, so it's a last resort.

## Refunds

Guests contact support. Workers can't issue refunds.

```bash
npx convex run paymentsNode:refundTip '{"tipPaymentId":"..."}'                       # full
npx convex run paymentsNode:refundTip '{"tipPaymentId":"...","amountCents":500}'     # partial, of what the guest paid
```

Find the payment in the Dashboard (its metadata has `tipPaymentId`) or from the guest's reference, which is the last 6 characters of that id. A refund made in the Dashboard works the same way: the webhook picks it up. Worker shares reduce automatically, and money already transferred is reversed. Stripe keeps its processing fee on a refund, so a full refund costs the platform about 60¢.

## Getting your money out

1. `paymentsNode:reconcileBooks`, then `ops:books`. Take no more than `safeToWithdrawCents`.
2. Create a payout to your bank in the Stripe Dashboard.

`platformRevenueCents` is fees kept, less Stripe's charges and dispute fees. It doesn't include Connect's bills ($2 per active worker per month, 0.25% + 25¢ per payout, tax forms), which Stripe debits separately. `ownerWithdrawalsCents` is what you've taken so far. Tax on this income is yours to handle.

## Worker support answers

- **When do I get my money?** About a day on hold with us, then Stripe's settlement time, then the next Monday's payout. Roughly a week at worst. Earnings shows each stage.
- **Change my bank?** Earnings → Bank and tax details.
- **Why did my tip go down?** A guest got a refund or disputed the charge.
- **Delete my account?** Crews closed, tips delivered, Stripe balance at zero. Payment records are kept; demo records go.

## Known limits

- A QR tip is reserved against limits while its Checkout page is open, so someone opening many pages without paying can use up a worker's daily limit for about half an hour.
- `ops:books` and `reconcileBooks` read the whole ledger, which works for pilot volume. Move to running totals before it reaches tens of thousands of rows.
- Only `ops:status` and the optional webhook report alerts. Nothing emails you. Check it daily or set `OPS_ALERT_WEBHOOK_URL`.
- Refunds are command-line only. There's no admin screen.
- Connected accounts stay open at Stripe after a worker deletes their profile, for tax records. Close them from the Dashboard if needed.
- Instant payouts and company features aren't built.
- A dispute after a tip was transferred was tested against the fake Stripe only. In the sandbox, test disputes open before the transfer.
