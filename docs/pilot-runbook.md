# Real-money pilot runbook

How to set up, run and stop the pilot. The money model is in `docs/payments-architecture.md`. This isn't legal or tax advice.

Commands use `npx convex run` on the deployment you mean. Add `--prod` for production.

## Before anyone real pays: what only a person can do

Nothing in this list is done yet for live mode.

**In the Stripe Dashboard, live account**

1. Finish activating the account: business details, bank account, statement descriptor. Guests' statements will show this name, so use "TIP JAR" or similar.
2. Connect → Platform profile has to match this model. As of 2026-10-31 the sandbox's profile doesn't: it says sellers collect payments directly, Stripe carries negative-balance liability, and sellers get the full Stripe Dashboard, and its Accounts v2 request still reads "Requested". What this pilot needs:
   - Funds flow: the platform takes payments and pays sellers separately (separate charges and transfers).
   - Negative-balance liability: the platform. **This is the owner's decision.** It makes the platform pay for refunds, chargebacks and negative worker balances. Stripe says this setup suits platforms with experience in this area, and asks for an acknowledgement and possibly verification.
   - Dashboard for workers: Express.
   - Accounts v2: enabled, not just requested. Check by creating a test account, since "Requested" doesn't let it through.
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

A restricted key (`rk_`) with write access to: Checkout Sessions, PaymentIntents, Refunds, Transfers (including reversals), Accounts v2 and account links, login links, Balance Settings. Read access to: Balance, Balance transaction sources, Disputes, Charges, Events, Payouts, Top-ups. This list hasn't been tried as a real restricted key; the sandbox runs used the CLI's login. Try it in the sandbox first.

## Backend settings

`npx convex env set [--prod] NAME value`

| Name | Value |
|---|---|
| `STRIPE_MODE` | `test` on dev, `live` on production. Unset means no real money at all |
| `STRIPE_SECRET_KEY` | The restricted key. Its prefix has to match `STRIPE_MODE` or every call refuses |
| `STRIPE_WEBHOOK_SECRET` | From the platform endpoint below |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | From the Connect endpoint below |
| `SUPPORT_EMAIL` | `scottbussardjr@gmail.com`, the contact the owner chose. Shown on receipts, payment help and legal pages. Required before live charges can be enabled |
| `TIP_ORIGIN` | `https://tip-jar-dev.testing.jrbussard.com` on dev, `https://tip.jrbussard.com` on production |
| `STRIPE_CONNECT_API` | Leave unset for anything live. `v1` is a test-only fallback for a sandbox without Accounts v2. It pins an older API version, and Stripe's current one rejects it |
| `OPS_ALERT_WEBHOOK_URL` | Optional. Slack-style URL for alerts |

## Webhook endpoints

Replace `<site>` with the deployment's `.convex.site` address. The response to each command includes its signing secret. Add `--live` for production.

```bash
stripe webhook_endpoints create --url https://<site>/stripe/webhook \
  -d "enabled_events[]=checkout.session.completed" -d "enabled_events[]=checkout.session.expired" \
  -d "enabled_events[]=checkout.session.async_payment_succeeded" -d "enabled_events[]=checkout.session.async_payment_failed" \
  -d "enabled_events[]=payment_intent.succeeded" -d "enabled_events[]=payment_intent.processing" -d "enabled_events[]=payment_intent.payment_failed" -d "enabled_events[]=payment_intent.canceled" \
  -d "enabled_events[]=charge.succeeded" -d "enabled_events[]=charge.updated" -d "enabled_events[]=charge.refunded" -d "enabled_events[]=charge.refund.updated" \
  -d "enabled_events[]=refund.created" -d "enabled_events[]=refund.updated" -d "enabled_events[]=refund.failed" \
  -d "enabled_events[]=charge.dispute.created" -d "enabled_events[]=charge.dispute.updated" -d "enabled_events[]=charge.dispute.closed" -d "enabled_events[]=charge.dispute.funds_withdrawn" -d "enabled_events[]=charge.dispute.funds_reinstated" \
  -d "enabled_events[]=transfer.created" -d "enabled_events[]=transfer.updated" -d "enabled_events[]=transfer.reversed" \
  -d "enabled_events[]=payout.created" -d "enabled_events[]=payout.updated" -d "enabled_events[]=payout.paid" -d "enabled_events[]=payout.failed" -d "enabled_events[]=payout.canceled" -d "enabled_events[]=topup.succeeded"

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
npx convex run ops:books      # what's the workers', what's yours, what's safe to take out, and what's stopping it
```

`ops:status` also lists `unexplainedTransactions` and `payoutPauseUnconfirmed`. Critical alerts go to `OPS_ALERT_WEBHOOK_URL` if it's set, and if not, nothing tells you: check it daily.

| Alert | Means | Do |
|---|---|---|
| `payment_mismatch` (critical) | Stripe's record doesn't match what we asked to collect. Nothing is paid out on it, and what was collected is held out of the safe figure | Look it up in Stripe. Usually refund it in the Dashboard. `ops:clearReview` re-checks with Stripe |
| `negative_balance` (critical) | A worker's Stripe balance is below zero. Usually a refund after they were paid out. It's our liability, Stripe reserves it from the platform, and they're frozen | Talk to them. New transfers to them clear it first. `ops:unfreezeWorker` when resolved |
| `reversal_short` (critical) | Stripe refused a reversal for lack of balance. Not a debt yet. They're frozen and it retries every 6 hours | Find out why, since these accounts normally go negative instead |
| `reversal_debt` (critical) | A reversal was refused for a week, or nothing is left to reverse. The worker owes it, and later transfers are reduced by it | Talk to them. `ops:unfreezeWorker` when resolved. The platform carries the loss until then |
| `reversal_unexpected` (critical) | A transfer was reversed outside Tip Jar, by more than the tip called for. They're frozen so it isn't paid straight back | Check who did it. `ops:unfreezeWorker` pays what's left |
| `refund_failed` (critical) | A refund failed after looking finished. The money came back, the guest hasn't got it, and the worker's share is on hold | Pay the guest another way or refund again, then `ops:resolveFailedRefund '{"tipPaymentId":"...","note":"..."}'` |
| `payout_schedule_failed` (critical for a freeze) | Stripe hasn't accepted the payout schedule. **A frozen worker's bank payouts may still be running.** It retries by itself | Check Stripe if it stays open. It closes when Stripe confirms |
| `payout_schedule_drift` (critical) | The schedule on Stripe was changed behind us. It's been put back | Check who changed it |
| `transfer_stuck` (critical) | A transfer failed 5+ times. Usually means the platform balance is too low | Add funds to the Stripe balance. It retries on its own |
| `txn_unexplained` (critical) | A Stripe movement nothing here accounts for. Withdrawals are blocked | Look it up. If it's fine, `ops:acknowledgeTxn '{"txnId":"...","note":"..."}'` |
| `transfers_stopped` (critical) | A transfer went out with nothing here behind it, so transfers were switched off. **Treat as a possible compromise** | Rotate keys if unexplained. Turn transfers back on with `ops:setControls` once understood |
| `books_mismatch` (critical) | Money owed to workers and guests is more than Stripe holds, the platform's payouts aren't manual, or transactions are unexplained | Don't withdraw. Find out why before anything else |
| `books_difference` (critical; a warning during a transfer or scan) | Stripe's balance differs from the books after every known movement. Ordinary fees no longer cause this | Don't withdraw until it's explained |
| `withdrawal_above_safe` (critical) | An owner payout left less than what's owed | Add funds before transfers fail |
| `platform_auto_payout` (critical) | Stripe automatically paid out the platform's balance | Set platform payouts to manual now. It may include worker money |
| `connect_collection` (critical) | Stripe took money from the platform for a balance negative for 180 days | The worker's debt is now a real loss |
| `event_failed` (critical) | A webhook kept failing to process | Read the error; the hourly reconcile also re-checks recent payments |
| `event_wrong_mode` (critical) | A test event reached a live deployment or the reverse | Check webhook settings and `STRIPE_MODE` |
| `dispute` (warning) | A guest disputed a charge. Their share is already frozen or taken back | Respond in the Stripe Dashboard before the deadline |
| `account_restricted`, `payout_failed` (warning) | Stripe needs something from the worker | Tell them to open Earnings in the app |

Close an alert with `ops:resolveAlert '{"alertId":"..."}'`.

## Stopping things

```bash
npx convex run ops:setControls '{"chargesEnabled":false}'    # no new tips. Earned money still moves
npx convex run ops:setControls '{"transfersEnabled":false}'  # money stays on the platform. New tips still work
npx convex run ops:suspendWorker '{"handle":"marcus"}'       # no new tips for one person
npx convex run ops:freezeWorker '{"handle":"marcus","reason":"investigating"}'  # no transfers at once. Stripe's payouts stop when it confirms
```

After a freeze, check that `ops:status` no longer shows them under `payoutPauseUnconfirmed`. Until it does, money that already reached their Stripe balance can still pay out to their bank.

Suspected fraud: freeze the worker first, then stop charges if it's wider. Reversals keep working with every switch off, so money can always be recovered. Stopping everything: both `setControls` lines. Setting `STRIPE_MODE` empty stops all Stripe calls but also stops refund and dispute processing, so it's a last resort.

## Refunds

Guests contact support. Workers can't issue refunds.

```bash
npx convex run paymentsNode:refundTip '{"tipPaymentId":"..."}'                       # full
npx convex run paymentsNode:refundTip '{"tipPaymentId":"...","amountCents":500}'     # partial, of what the guest paid
```

Find the payment in the Dashboard (its metadata has `tipPaymentId`) or from the guest's reference, which is the full, case-sensitive payment id. Look up a reference with `npx convex run ops:findPayment '{"reference":"FULL_PAYMENT_ID"}'` (add `--prod` for production). The support link includes it in the email subject.

A refund made in the Dashboard works the same way: the webhook picks it up, or reconciliation does if the webhook never comes. Worker shares reduce automatically, and money already transferred is reversed. Stripe keeps its processing fee on a refund, so a full refund costs the platform about 60¢.

A refund can fail later, up to 30 days per Stripe. `refund_failed` tells you. The money comes back to the balance, but the guest hasn't had it. Stripe says to arrange another way to pay them. If you refund the charge again, the worker's share drops by itself; either way, finish with `ops:resolveFailedRefund`.

## Getting your money out

1. `npx convex run paymentsNode:reconcileBooks`, then `npx convex run ops:books`. Read `withdrawalBlockers`. Take no more than `safeToWithdrawCents`, which is zero while anything is blocking it.
2. Create a payout to your bank in the Stripe Dashboard straight after. The figure goes stale after two hours, and Stripe doesn't check it, so an over-withdrawal only raises `withdrawal_above_safe` afterwards.

It's a snapshot, not a guarantee. Refunds and disputes after it come out of the same balance, so keep `reserveCents` high enough to cover them. It only says what isn't known to be someone else's.

`platformRevenueCents` is fees kept, less Stripe's charges, dispute fees, and any Connect, tax or other costs (`stripeCostsCents`) that have been debited from the balance. Connect's bills only appear here once Stripe has debited them. `connectReserveCents` is what Stripe holds back for negative worker balances. `ownerWithdrawalsCents` is what you've taken so far. Tax on this income is yours to handle.

## Worker support answers

- **When do I get my money?** About a day on hold with us, then Stripe's settlement time, then the next Monday's payout. Roughly a week at worst. Earnings shows each stage.
- **Change my bank?** Earnings → Bank and tax details.
- **Why did my tip go down?** A guest got a refund or disputed the charge.
- **Delete my account?** Crews closed, tips delivered, Stripe balance at zero. Payment records are kept; demo records go.

## Known limits

- A QR tip is reserved against limits while its Checkout page is open, so someone opening many pages without paying can use up a worker's daily limit for about half an hour.
- `ops:books` and `reconcileBooks` read the whole ledger, which works for pilot volume. Move to running totals before it reaches tens of thousands of rows. Hourly checks also make about three Stripe calls per worker, which is only suited to pilot numbers.
- The worker's balance is checked right after reversals and hourly, so a payout can start between a reversal going negative and the freeze. Stripe stops payouts on a negative balance by itself; that wasn't tested.
- Only `ops:status` and the optional webhook report alerts. Nothing emails you. Check it daily or set `OPS_ALERT_WEBHOOK_URL`.
- Refunds are command-line only. There's no admin screen.
- Connected accounts stay open at Stripe after a worker deletes their profile, for tax records. Close them from the Dashboard if needed.
- Instant payouts and company features aren't built.
- A dispute after a tip was transferred was tested against the fake Stripe only. In the sandbox, test disputes open before the transfer.

## Checks that have only been done in the sandbox, or not at all

The sandbox runs (`npm run test:sandbox`, `npm run test:probes`) use real Stripe objects with an in-memory database, and worker accounts created through the v1 fallback. Before real money:

| Gate | Why it's open |
|---|---|
| Run the same flows on a deployed Convex dev backend | Everything here is in-memory: real concurrency and action limits weren't exercised |
| Repeat reversals on real Accounts v2 recipient accounts | The sandbox can't create them yet. Going negative was seen on v1 accounts set up the same way (`losses: application`). If v2 refuses instead, the `reversal_short` path runs, and its error text is a guess from Stripe's docs |
| Live behaviour of a refund when the platform balance is short | Stripe's docs say a card refund waits as pending. Not simulated, because it would mean emptying a shared sandbox |
| Timing of real refund failures | The test card fails in minutes. Real ones can take up to 30 days and might post differently |
| Timing of Stripe's reserve for a negative balance | About a minute in the sandbox. Live could differ. `negativeWorkerCents` covers the gap |
| A restricted key with the permissions listed above | Sandbox runs used the CLI's login |
| Platform profile, Accounts v2 and the negative-balance decision | Owner and Stripe; see "Before anyone real pays" |
