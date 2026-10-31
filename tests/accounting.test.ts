// The accounting failures an independent review reproduced, plus their neighbours. They run against the
// in-memory Convex harness and fake Stripe, which copies behaviour confirmed in the sandbox (see
// scripts/sandbox-probes.ts). Orderings are forced here; how often they'd happen live wasn't measured.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.STRIPE_MODE = "test";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.TIP_ORIGIN = "https://tips.example.com";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect";

const { crews, earnings, ops, payments, paymentsNode, settlement, world, workers, HOUR, DAY, MINUTE } = await import("./harness.ts");
const { fakeStripe, FakeStripeError } = await import("./fakeStripe.ts");
const { classifyBalanceTxn, guestHoldCents, ledgerTotals, obligationTotal, safeToWithdraw } = await import("../convex/lib/paymentRules.ts");
const { eventTarget } = await import("../convex/lib/stripeEvents.ts");

let f: ReturnType<typeof fakeStripe>;
let w: ReturnType<typeof world>;
let n = 0;
beforeEach(() => {
  f = fakeStripe();
  paymentsNode.useStripeForTests(f.client);
  w = world();
});

const on = () => w.call(ops.setControls, null, { chargesEnabled: true, transfersEnabled: true });
async function pilot(token: string, handle: string) {
  await w.profile(token, handle);
  await w.call(ops.enrollWorker, null, { handle });
  await w.act(paymentsNode.startPayoutSetup, token);
  const payee = w.rows("payeeAccounts").find((p) => p.tokenIdentifier === token);
  f.activate(payee.stripeAccountId);
  await w.act(paymentsNode.refreshPayoutStatus, token);
  return w.rows("payeeAccounts").find((p) => p.tokenIdentifier === token);
}
async function paidTip(handle: string, tipCents = 1000) {
  await w.act(paymentsNode.createGuestCheckout, null, { handle, tipCents, coverFees: true, clientRequestId: `request-${++n}` });
  const tip = w.rows("tipPayments").at(-1);
  const paid = f.pay(tip.stripeCheckoutSessionId);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tip._id });
  return { tipId: tip._id, ...paid };
}
const allocs = (id?: string) => w.rows("allocations").filter((a) => !id || a.tipPaymentId === id);
const books = () => ledgerTotals(w.rows("ledgerEntries"));
const settle = async () => { await w.act(paymentsNode.runDue); await w.runDueJobs(); };
const netSent = (acct: string) => [...f.transfers.values()].filter((t: any) => t.destination === acct).reduce((a: number, t: any) => a + t.amount - t.amount_reversed, 0);
const payeeOf = (token: string) => w.rows("payeeAccounts").find((p) => p.tokenIdentifier === token);
const criticals = () => w.rows("opsAlerts").filter((a) => a.severity === "critical" && a.resolvedAt === undefined);
const hasAlert = (kind: string, severity = "critical") => w.rows("opsAlerts").some((a) => a.kind === kind && a.severity === severity && a.resolvedAt === undefined);
let ev = 0;
const event = async (target: any, type = "transfer.reversed") => {
  const eventId = `evt_acct_${++ev}`;
  await w.call(payments.recordEvent, null, { eventId, type, livemode: false, source: "platform", created: 1, target: JSON.stringify(target) });
  await w.act(paymentsNode.processEvent, null, { eventId });
  return eventId;
};
const reconcile = async () => { await w.act(paymentsNode.reconcileBooks); return await w.call(ops.books); };

// B1: safe to withdraw

test("one worker's debt doesn't make another worker's money look safe (R3)", async () => {
  await on();
  await w.call(ops.setControls, null, { reserveCents: 0 });
  f.knobs.connectedReserves = false;
  const ann = await pilot("ann", "ann-a");
  await pilot("ben", "ben-b");
  const annTip = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  f.setBalance(ann.stripeAccountId, 0);
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: annTip.tipId });
  await settle();
  await w.runDueJobs();
  w.advance(8 * DAY);
  await settle(); // Ann now owes 1000 for real
  assert.equal(payeeOf("ann").owedCents, 1000);
  const benTip = await paidTip("ben-b");
  f.topup(5000); // the owner's working capital
  const b = await reconcile();
  assert.equal(b.workerLiabilityCents, 0, "net, the ledger still nets them. That's why it's not used here");
  assert.equal(b.obligations.workerDueCents, 1000, "Ben is owed in full");
  const available = b.lastReconciliation.availableCents;
  assert.equal(b.safeToWithdrawCents, available - 1000);
  // The owner takes exactly that. Ben can still be paid.
  const payout = f.ownerPayout(b.safeToWithdrawCents);
  await event({ kind: "platform_payout", payoutId: payout.id }, "payout.paid");
  assert.equal(hasAlert("withdrawal_above_safe"), false);
  w.advance(24 * HOUR);
  await settle();
  assert.equal(allocs(benTip.tipId)[0].state, "settled");
  const after = await f.client.balance.retrieve();
  assert.equal(after.available[0].amount, 0, "nothing short, nothing left");
});

test("a withdrawal that eats worker money raises an alarm straight away", async () => {
  await on();
  await pilot("ben", "ben-b");
  await paidTip("ben-b");
  const payout = f.ownerPayout(900);
  await event({ kind: "platform_payout", payoutId: payout.id }, "payout.paid");
  assert.ok(hasAlert("withdrawal_above_safe"));
});

test("workers owed more than Stripe holds is an alarm, even with one worker's debt netting it out (R3b)", async () => {
  await on();
  f.knobs.connectedReserves = false;
  const ann = await pilot("ann", "ann-a");
  await pilot("ben", "ben-b");
  const annTip = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  f.setBalance(ann.stripeAccountId, 0);
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: annTip.tipId });
  await settle();
  w.advance(8 * DAY);
  await settle();
  await paidTip("ben-b");
  f.topup(100);
  await w.act(paymentsNode.reconcileBooks);
  const last = w.rows("reconciliations").at(-1);
  assert.ok(last.availableCents < 1000, `balance ${last.availableCents} is below Ben's 1000`);
  assert.equal(last.workerLiabilityCents, 0, "net looks fine");
  assert.ok(last.problems.some((p: string) => p.includes("belongs to workers")));
  assert.ok(hasAlert("books_mismatch"));
  assert.equal((await w.call(ops.books)).safeToWithdrawCents, 0);
});

test("a refund not reversed yet doesn't cover anyone else (R10)", async () => {
  await on();
  await pilot("ann", "ann-a");
  await pilot("ben", "ben-b");
  const a = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  await paidTip("ben-b");
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: a.tipId });
  assert.equal(books().workerLiabilityCents, 0, "net looks like nothing is owed");
  const b = await reconcile();
  assert.equal(b.obligations.workerDueCents, 1000, "Ben's money, gross");
});

test("guest money held for review isn't safe to withdraw (R15)", async () => {
  await on();
  await pilot("t", "ann-a");
  await w.act(paymentsNode.createGuestCheckout, null, { handle: "ann-a", tipCents: 1000, coverFees: true, clientRequestId: "review-held-1" });
  const tip = w.rows("tipPayments").at(-1);
  f.pay(tip.stripeCheckoutSessionId, { amount: 1000 }); // collected, but not what we asked for
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tip._id });
  const b = await reconcile();
  assert.ok(w.rows("tipPayments")[0].reviewReason);
  assert.equal(b.obligations.reviewHeldCents, 1000);
  assert.equal(b.safeToWithdrawCents, 0);
  assert.equal(b.lastReconciliation.differenceCents, 0, "and the books still match Stripe");
});

test("a review-held refund releases the hold, and the booked hold follows Stripe", async () => {
  await on();
  await pilot("t", "ann-a");
  await w.act(paymentsNode.createGuestCheckout, null, { handle: "ann-a", tipCents: 1000, coverFees: true, clientRequestId: "review-held-2" });
  const tip = w.rows("tipPayments").at(-1);
  const { chargeId } = f.pay(tip.stripeCheckoutSessionId, { amount: 1000 });
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tip._id });
  f.refund(chargeId, 1000);
  w.advance(HOUR);
  const b = await reconcile();
  assert.equal(b.obligations.reviewHeldCents, 0);
  assert.equal(b.lastReconciliation.differenceCents, 0);
  assert.equal(b.withdrawalBlockers.filter((x: string) => x.includes("explained")).length, 0);
});

test("tips sitting in an open crew pool aren't safe to withdraw", async () => {
  await on();
  await pilot("ann", "ann-a");
  await pilot("ben", "ben-b");
  await w.call(crews.start, "ann", { name: "Valets", splitMode: "even", closesInHours: 8 });
  assert.equal((await w.call(crews.join, "ben", { code: w.rows("crews")[0].code })).ok, true);
  await paidTip("ann-a");
  const b = await reconcile();
  assert.equal(allocs().length, 0);
  assert.equal(b.obligations.unallocatedTipCents, 1000);
  assert.equal(b.safeToWithdrawCents, Math.max(0, b.lastReconciliation.availableCents - 1000));
  await w.call(crews.close, "ann");
  const closed = await reconcile();
  assert.equal(closed.obligations.unallocatedTipCents, 0);
  assert.equal(closed.obligations.workerDueCents, 1000);
});

test("a figure from an old balance, or with nothing to go on, is no figure", async () => {
  await on();
  await pilot("t", "ann-a");
  await paidTip("ann-a");
  assert.equal((await w.call(ops.books)).safeToWithdrawCents, 0, "no reconciliation yet");
  const fresh = await reconcile();
  assert.deepEqual(fresh.withdrawalBlockers, []);
  assert.ok(fresh.safeToWithdrawCents > -1);
  f.topup(5000);
  const topped = await reconcile();
  assert.equal(topped.safeToWithdrawCents, topped.lastReconciliation.availableCents - 1000);
  w.advance(3 * HOUR);
  const stale = await w.call(ops.books);
  assert.equal(stale.safeToWithdrawCents, 0);
  assert.ok(stale.withdrawalBlockers.some((x: string) => x.includes("two hours")));
});

test("the reserve comes off, a negative worker balance Stripe hasn't reserved comes off, and they're gross", () => {
  const obligations = { workerDueCents: 100, unallocatedTipCents: 200, reviewHeldCents: 300, guestHoldCents: 400, negativeWorkerCents: 500, reserveCents: 600 };
  assert.equal(obligationTotal(obligations), 2100);
  assert.equal(safeToWithdraw({ availableCents: 5000, obligations, blockers: [] }), 2900);
  assert.equal(safeToWithdraw({ availableCents: 1000, obligations, blockers: [] }), 0);
  assert.equal(safeToWithdraw({ availableCents: 5000, obligations, blockers: ["anything"] }), 0);
});

test("automatic platform payouts stop the figure, and a real one raises the alarm", async () => {
  await on();
  await pilot("t", "ann-a");
  f.topup(5000);
  f.payoutSchedules.platform = { interval: "daily" };
  const b = await reconcile();
  assert.equal(b.safeToWithdrawCents, 0);
  assert.ok(b.withdrawalBlockers.some((x: string) => x.includes("not manual")));
  assert.ok(hasAlert("books_mismatch"));
  const payout = f.ownerPayout(100, { automatic: true });
  await event({ kind: "platform_payout", payoutId: payout.id }, "payout.paid");
  assert.ok(hasAlert("platform_auto_payout"));
});

test("if the platform's payout schedule can't be read, nobody claims it's safe", async () => {
  await on();
  await pilot("t", "ann-a");
  f.topup(5000);
  const retrieve = f.client.balanceSettings.retrieve;
  f.client.balanceSettings.retrieve = async (p: any, o: any) => {
    if (!o?.stripeAccount) throw new Error("not allowed");
    return retrieve(p, o);
  };
  const b = await reconcile();
  assert.equal(b.safeToWithdrawCents, 0);
  assert.ok(b.withdrawalBlockers.some((x: string) => x.includes("unverified")));
});

test("a refund on its way and a failed refund belong to the guest", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  f.topup(5000);
  const pending = f.refund(chargeId, 542, "pending");
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  let b = await reconcile();
  assert.equal(b.obligations.guestHoldCents, 542);
  f.failRefund(pending.id);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  b = await reconcile();
  assert.equal(b.obligations.guestHoldCents, 542, "they still haven't got it back");
  await w.call(ops.resolveFailedRefund, null, { tipPaymentId: tipId, note: "paid back by bank transfer" });
  assert.equal((await w.call(ops.books)).obligations.guestHoldCents, 0);
  assert.equal(guestHoldCents({ refunds: [{ id: "r", amountCents: 5, status: "failed" }], failedRefundAckCents: 5, inquiryCents: 7 }), 7);
});

test("an open inquiry holds its amount, though Stripe hasn't taken it yet", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  f.dispute(chargeId, "warning_needs_response", 1084);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  const b = await reconcile();
  assert.equal(b.obligations.guestHoldCents, 1084);
  f.setDisputeStatus(chargeId, "warning_closed");
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  assert.equal((await w.call(ops.books)).obligations.guestHoldCents, 0);
});

// B2: one reversal, however many ways it's reported

test("a webhook that sees a reversal before the direct path counts once (R1)", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  const real = f.client.transfers.createReversal;
  f.client.transfers.createReversal = async (id: string, p: any, o: any) => {
    const out = await real(id, p, o);
    await event({ kind: "transfer", transferId: id, allocationId: allocs(tipId)[0]._id });
    return out;
  };
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: tipId });
  await settle();
  f.client.transfers.createReversal = real;
  const a = allocs(tipId)[0];
  assert.equal(a.paidCents, 0);
  assert.equal(a.state, "settled");
  assert.deepEqual(a.transfers.map((t: any) => t.reversedCents), [1000]);
  w.advance(HOUR);
  await settle();
  assert.equal(netSent(payee.stripeAccountId), 0, "a fully refunded tip isn't paid again");
  assert.equal(f.transfers.size, 1);
  assert.equal(books().workerLiabilityCents, 0);
  assert.equal((await f.client.balance.retrieve()).available[0].amount, books().expectedStripeBalanceCents);
});

test("the reversal reported every way, in any order, counts once (R11 and more)", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: tipId });
  await settle();
  const t = [...f.transfers.values()][0] as any;
  const allocationId = allocs(tipId)[0]._id;
  for (let i = 0; i < 3; i++) await event({ kind: "transfer", transferId: t.id, allocationId });
  // Reads can arrive late too: a total lower than the one on file changes nothing.
  await w.call(settlement.observeTransfer, null, { allocationId, transferId: t.id, amountCents: 1000, reversedCents: 400, destination: payee.stripeAccountId });
  await w.call(settlement.observeTransfer, null, { allocationId, transferId: t.id, amountCents: 1000, reversedCents: 1000, destination: payee.stripeAccountId });
  await settle();
  const a = allocs(tipId)[0];
  assert.equal(a.paidCents, 0);
  assert.equal(a.transfers[0].reversedCents, 1000);
  assert.equal(w.rows("ledgerEntries").filter((e) => e.ref.startsWith("reversal:")).length, 1);
  assert.equal(netSent(payee.stripeAccountId), 0);
});

test("two reversals of one transfer post their difference, and match Stripe's total", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  f.refund(chargeId, 542);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  await settle();
  f.refund(chargeId, 271);
  w.advance(MINUTE);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  await settle();
  const a = allocs(tipId)[0];
  assert.equal(netSent(payee.stripeAccountId), a.targetCents);
  assert.equal(a.paidCents, a.targetCents);
  assert.equal(a.transfers[0].reversedCents, (f.transfers.get(a.transfers[0].id) as any).amount_reversed);
  assert.equal(w.rows("ledgerEntries").filter((e) => e.ref.startsWith("reversal:")).reduce((x, e) => x + e.amountCents, 0), a.transfers[0].reversedCents);
});

test("a reversal made in the Dashboard is taken on, and the worker waits for a person", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  const t = [...f.transfers.values()][0] as any;
  await f.client.transfers.createReversal(t.id, { amount: 300 }, {});
  await event({ kind: "transfer", transferId: t.id, allocationId: allocs(tipId)[0]._id });
  assert.equal(allocs(tipId)[0].paidCents, 700);
  assert.ok(payeeOf("t").frozenReason);
  assert.ok(hasAlert("reversal_unexpected"));
  w.advance(HOUR);
  await settle();
  assert.equal(netSent(payee.stripeAccountId), 700, "not paid straight back");
});

// B3: reads and ledger references

test("an older read can't overwrite a newer one, whatever the clock says (R2)", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  const retrieve = f.client.paymentIntents.retrieve;
  const list = f.client.disputes.list;
  let releaseFirst!: () => void; const holdFirst = new Promise<void>((r) => (releaseFirst = r));
  let releaseSecond!: () => void; const holdSecond = new Promise<void>((r) => (releaseSecond = r));
  let secondAtDisputes!: () => void; const secondReady = new Promise<void>((r) => (secondAtDisputes = r));
  let stage = 0; let held = false;
  f.client.paymentIntents.retrieve = async (id: string, p: any) => {
    const me = ++stage;
    if (me === 1) await holdFirst; // started first, read last
    return retrieve(id, p);
  };
  f.client.disputes.list = async (q: any) => {
    if (stage === 2 && !held) { held = true; secondAtDisputes(); await holdSecond; } // started second, read early
    return list(q);
  };
  w.advance(1000);
  const first = w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  w.advance(1000);
  const second = w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  await secondReady;
  f.refund(chargeId, 1084); // a Dashboard refund lands between the two reads
  releaseFirst();
  await first;
  assert.equal(w.rows("tipPayments")[0].refundedCents, 1084);
  await settle();
  assert.equal(netSent(payee.stripeAccountId), 0);
  releaseSecond();
  await second; // the stale read is refused and starts again
  f.client.paymentIntents.retrieve = retrieve;
  f.client.disputes.list = list;
  assert.equal(w.rows("tipPayments")[0].refundedCents, 1084, "the old zero never lands");
  assert.equal(allocs(tipId)[0].targetCents, 0);
  await settle();
  assert.equal(netSent(payee.stripeAccountId), 0, "a refunded tip isn't paid again");
  assert.equal(f.transfers.size, 1);
  assert.equal((await f.client.balance.retrieve()).available[0].amount, books().expectedStripeBalanceCents);
});

test("reads that keep getting overtaken give up with an error, so the event retries", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId } = await paidTip("ann-a");
  const retrieve = f.client.paymentIntents.retrieve;
  // Something always starts a newer read while this one is out.
  f.client.paymentIntents.retrieve = async (id: string, p: any) => {
    await w.call(payments.beginPaymentRead, null, { tipPaymentId: tipId });
    return retrieve(id, p);
  };
  await assert.rejects(w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId }), /overtaken/);
  const eventId = await event({ kind: "payment", tipPaymentId: tipId }, "charge.refunded");
  const row = w.rows("stripeEvents").find((e) => e.eventId === eventId);
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 1);
  f.client.paymentIntents.retrieve = retrieve;
});

test("a refund that fails and is issued again leaves the books right (R4)", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  const sync = () => w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  const failed = f.refund(chargeId, 542);
  await sync();
  assert.equal(allocs(tipId)[0].targetCents, 500);
  f.failRefund(failed.id);
  await sync();
  assert.equal(w.rows("tipPayments")[0].refundedCents, 0);
  assert.equal(allocs(tipId)[0].targetCents, 1000);
  assert.ok(hasAlert("refund_failed"));
  f.refund(chargeId, 542);
  await sync();
  const b = books();
  assert.equal(b.expectedStripeBalanceCents, (await f.client.balance.retrieve()).available[0].amount);
  assert.equal(b.workerLiabilityCents, allocs(tipId)[0].targetCents);
  assert.equal(w.rows("tipPayments")[0].postedNetTakenCents, 500);
});

test("a failed refund doesn't send money back to the worker until a person has dealt with it", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  const { refundId } = await w.act(paymentsNode.refundTip, null, { tipPaymentId: tipId });
  await settle();
  assert.equal(netSent(payee.stripeAccountId), 0);
  f.failRefund(refundId);
  await event({ kind: "payment", paymentIntentId: w.rows("tipPayments")[0].stripePaymentIntentId }, "refund.failed");
  assert.ok(hasAlert("refund_failed"));
  assert.equal(allocs(tipId)[0].targetCents, 1000);
  w.advance(HOUR);
  await settle();
  assert.equal(netSent(payee.stripeAccountId), 0, "still with the platform");
  assert.match(allocs(tipId)[0].lastError ?? "", /refund failed/);
  await w.call(ops.resolveFailedRefund, null, { tipPaymentId: tipId, note: "guest asked to leave the tip after all" });
  w.advance(HOUR);
  await settle();
  assert.equal(netSent(payee.stripeAccountId), 1000);
  assert.equal(books().workerLiabilityCents, 0);
});

test("refund.failed and refund.updated reach the sync", () => {
  for (const type of ["refund.failed", "refund.updated", "refund.created"]) {
    assert.deepEqual(eventTarget({ type, data: { object: { id: "re_1", payment_intent: "pi_1", metadata: { tipPaymentId: "t" } } } }), { kind: "payment", paymentIntentId: "pi_1", tipPaymentId: "t" });
  }
});

test("a dispute reinstated and reopened leaves the books right (R13)", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  const sync = () => w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  f.dispute(chargeId, "needs_response", 1084);
  await sync();
  f.setDisputeStatus(chargeId, "won");
  await sync();
  f.setDisputeStatus(chargeId, "needs_response");
  await sync();
  const b = books();
  assert.equal(b.workerLiabilityCents, allocs(tipId)[0].targetCents);
  assert.equal(b.expectedStripeBalanceCents, (await f.client.balance.retrieve()).available[0].amount);
});

test("a second dispute fee posts only its difference", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  f.dispute(chargeId, "needs_response", 1084);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  assert.equal(books().disputeFeesCents, 1500);
  f.addDisputeFee(chargeId, 1000);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  assert.equal(books().disputeFeesCents, 2500, "2500 in all, not 1500 + 2500");
  assert.equal(books().expectedStripeBalanceCents, (await f.client.balance.retrieve()).available[0].amount);
});

test("Stripe's fee changing back and forth stays right", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId, piId } = await paidTip("ann-a");
  const fee = w.rows("tipPayments")[0].stripeFeeCents;
  for (const stripeFeeCents of [fee + 3, fee, fee + 3, fee]) {
    const readToken = await w.call(payments.beginPaymentRead, null, { tipPaymentId: tipId });
    await w.call(payments.applyPaymentSnapshot, null, { tipPaymentId: tipId, readToken, snapshot: { paymentIntentId: piId, piStatus: "succeeded", amountCents: 1084, currency: "usd", livemode: false, metadataTipPaymentId: tipId, stripeFeeCents, refunds: [], disputes: [] } });
  }
  assert.equal(books().processingCostCents, fee);
});

test("an appeal still counts as open: frozen, can't delete, and rechecked hourly (R12)", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  f.dispute(chargeId, "needs_response", 1084);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  await settle();
  f.setDisputeStatus(chargeId, "lost");
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  assert.equal(w.rows("tipPayments")[0].disputeOpen, false);
  f.setDisputeStatus(chargeId, "appeal_needs_response");
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  const tip = w.rows("tipPayments")[0];
  assert.equal(tip.disputeOpen, true);
  assert.equal(allocs(tipId)[0].targetCents, 0, "the money stays taken");
  w.advance(40 * DAY); // well outside the recent window, and still checked
  assert.ok((await w.call(payments.paymentsToRecheck)).includes(tipId));
  await assert.rejects(w.call(workers.deleteAccount, "t"), /being disputed/);
  f.setDisputeStatus(chargeId, "won");
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  await settle();
  assert.equal(netSent(payee.stripeAccountId), 1000);
});

test("a first transfer after any dispute doesn't lean on the charge", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  f.dispute(chargeId, "needs_response", 1084);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  f.setDisputeStatus(chargeId, "won");
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  w.advance(24 * HOUR);
  await settle();
  const t = [...f.transfers.values()][0] as any;
  assert.equal(t.source_transaction, undefined);
});

// B4: freezing

test("a freeze whose Stripe call fails stays unconfirmed, alerts, retries and gets there (R5)", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const update = f.client.balanceSettings.update;
  f.client.balanceSettings.update = async () => { throw new Error("stripe 500"); };
  await w.call(ops.freezeWorker, null, { handle: "ann-a", reason: "suspected fraud" });
  assert.ok(payeeOf("t").frozenReason, "transfers stop at once");
  assert.equal(payeeOf("t").payoutsPaused, false, "payouts aren't paused until Stripe says so");
  await w.runDueJobs(); // doesn't throw, because nothing would retry it if it did
  assert.equal(f.payoutSchedules[payee.stripeAccountId].interval, "weekly");
  assert.equal(payeeOf("t").payoutsPaused, false);
  assert.equal(payeeOf("t").payoutScheduleAttempts, 1);
  assert.ok(hasAlert("payout_schedule_failed"));
  assert.deepEqual((await w.call(ops.status)).payoutPauseUnconfirmed.map((p: any) => p.account), [payee.stripeAccountId]);

  // It keeps trying with a growing wait, and the alert isn't repeated.
  w.advance(2 * MINUTE);
  await w.runDueJobs();
  assert.equal(payeeOf("t").payoutScheduleAttempts, 2);
  assert.equal(w.rows("opsAlerts").filter((a) => a.kind === "payout_schedule_failed").length, 1);
  assert.ok(w.jobs().some((j) => j.name.endsWith("enforcePayoutSchedule") && j.at === Date.now() + 4 * MINUTE));

  f.client.balanceSettings.update = update;
  w.advance(5 * MINUTE);
  await w.runDueJobs();
  assert.equal(f.payoutSchedules[payee.stripeAccountId].interval, "manual");
  assert.equal(payeeOf("t").payoutsPaused, true);
  assert.equal(hasAlert("payout_schedule_failed"), false, "it clears when it worked");
  assert.deepEqual((await w.call(ops.status)).payoutPauseUnconfirmed, []);
});

test("every hour puts a frozen worker's schedule right, and says so if someone changed it", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  await w.call(ops.freezeWorker, null, { handle: "ann-a", reason: "checking" });
  await w.runDueJobs();
  assert.equal(payeeOf("t").payoutsPaused, true);
  f.payoutSchedules[payee.stripeAccountId] = { interval: "daily" }; // changed in the Dashboard
  await w.act(paymentsNode.reconcile);
  assert.equal(f.payoutSchedules[payee.stripeAccountId].interval, "manual");
  assert.ok(hasAlert("payout_schedule_drift"));
  assert.equal(payeeOf("t").payoutsPaused, true);
});

test("setup on a frozen worker keeps payouts paused and repairs a failed pause", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const update = f.client.balanceSettings.update;
  f.client.balanceSettings.update = async () => { throw new Error("stripe 500"); };
  await w.call(ops.freezeWorker, null, { handle: "ann-a", reason: "checking" });
  await w.runDueJobs();
  f.client.balanceSettings.update = update;
  await w.act(paymentsNode.startPayoutSetup, "t");
  assert.equal(f.payoutSchedules[payee.stripeAccountId].interval, "manual");
  assert.equal(payeeOf("t").payoutsPaused, true);
});

test("a freeze and an unfreeze racing can't leave the wrong schedule recorded", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  await w.call(ops.freezeWorker, null, { handle: "ann-a", reason: "checking" });
  const update = f.client.balanceSettings.update;
  // The freeze's Stripe call lands, and before it's recorded the worker is unfrozen.
  let raced = false;
  f.client.balanceSettings.update = async (p: any, o: any) => {
    const out = await update(p, o);
    if (!raced) {
      raced = true;
      await w.call(ops.unfreezeWorker, null, { handle: "ann-a" });
    }
    return out;
  };
  await w.runDueJobs();
  assert.equal(f.payoutSchedules[payee.stripeAccountId].interval, "weekly");
  assert.equal(payeeOf("t").payoutsPaused, false);
  assert.equal(payeeOf("t").payoutScheduleConfirmed, "weekly");
});

test("an unfreeze whose Stripe call fails doesn't pretend payouts are back", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  await w.call(ops.freezeWorker, null, { handle: "ann-a", reason: "checking" });
  await w.runDueJobs();
  const update = f.client.balanceSettings.update;
  f.client.balanceSettings.update = async () => { throw new Error("stripe 500"); };
  await w.call(ops.unfreezeWorker, null, { handle: "ann-a" });
  await w.runDueJobs();
  assert.equal(payeeOf("t").payoutsPaused, true, "still what Stripe last confirmed");
  assert.equal(f.payoutSchedules[payee.stripeAccountId].interval, "manual");
  assert.ok(hasAlert("payout_schedule_failed", "warning"));
  f.client.balanceSettings.update = update;
  w.advance(5 * MINUTE);
  await w.runDueJobs();
  assert.equal(f.payoutSchedules[payee.stripeAccountId].interval, "weekly");
  assert.equal(payeeOf("t").payoutsPaused, false);
});

// B5: every Stripe movement explained

test("a transfer nothing here made is an emergency: alarm, transfers off, withdrawals blocked (R7)", async () => {
  await on();
  await pilot("t", "ann-a");
  await paidTip("ann-a");
  await f.client.transfers.create({ amount: 700, currency: "usd", destination: "acct_stranger", metadata: {} }, {});
  f.stripeFee(200); // an ordinary Connect fee alongside it
  const b = await reconcile();
  const alert = w.rows("opsAlerts").find((a) => a.kind === "txn_unexplained");
  assert.equal(alert.severity, "critical");
  assert.match(alert.message, /acct_stranger/);
  assert.equal((await w.call(ops.status)).controls.transfersEnabled, false);
  assert.ok(hasAlert("transfers_stopped"));
  assert.ok(b.lastReconciliation.problems.some((p: string) => p.includes("acct_stranger")));
  assert.equal(b.safeToWithdrawCents, 0);
  assert.ok(b.withdrawalBlockers.some((x: string) => x.includes("explained")));
  assert.equal(b.stripeCostsCents, 200);
  w.advance(24 * HOUR);
  await settle();
  assert.equal(allocs()[0].paidCents, 0, "nothing more goes out");
});

test("a transfer naming an allocation that doesn't exist is treated like any other stranger", async () => {
  await on();
  await pilot("t", "ann-a");
  await f.client.transfers.create({ amount: 700, currency: "usd", destination: "acct_stranger", metadata: { allocationId: "allocations:nope" } }, {});
  await w.act(paymentsNode.reconcileBooks);
  assert.equal((await w.call(ops.status)).controls.transfersEnabled, false);
});

test("a Stripe outage during repair leaves the row open without raising a false alarm", async () => {
  await on();
  await pilot("t", "ann-a");
  await w.act(paymentsNode.createGuestCheckout, null, { handle: "ann-a", tipCents: 1000, coverFees: true, clientRequestId: "outage-1" });
  const tip = w.rows("tipPayments").at(-1);
  f.pay(tip.stripeCheckoutSessionId);
  const retrieve = f.client.paymentIntents.retrieve;
  f.client.paymentIntents.retrieve = async () => { throw new Error("stripe is down"); };
  const b = await reconcile();
  assert.equal(hasAlert("txn_unexplained"), false);
  assert.equal(b.safeToWithdrawCents, 0);
  f.client.paymentIntents.retrieve = retrieve;
  w.advance(MINUTE);
  const after = await reconcile();
  assert.equal(w.rows("tipPayments")[0].status, "succeeded");
  assert.deepEqual(after.withdrawalBlockers, []);
});

test("a pending top-up stays open until Stripe says it succeeded", async () => {
  await on();
  await pilot("t", "ann-a");
  await w.act(paymentsNode.reconcileBooks);
  const t = f.topup(5000);
  f.topups.get(t.id).status = "pending";
  let b = await reconcile();
  assert.equal(b.ownerCapitalCents, 0);
  assert.equal(b.safeToWithdrawCents, 0);
  f.topups.get(t.id).status = "succeeded";
  w.advance(MINUTE);
  b = await reconcile();
  assert.equal(b.ownerCapitalCents, 5000);
  assert.equal(b.lastReconciliation.differenceCents, 0);
  assert.equal(hasAlert("txn_unexplained"), false);
  assert.deepEqual(b.withdrawalBlockers, []);
});

test("a frozen worker is told payouts are on hold, even before Stripe confirms", async () => {
  await on();
  await pilot("t", "ann-a");
  const update = f.client.balanceSettings.update;
  f.client.balanceSettings.update = async () => { throw new Error("stripe 500"); };
  await w.call(ops.freezeWorker, null, { handle: "ann-a", reason: "checking" });
  await w.runDueJobs();
  assert.equal(payeeOf("t").payoutsPaused, false);
  assert.equal((await w.call(earnings.real, "t", {})).payoutsPaused, true);
  f.client.balanceSettings.update = update;
});

test("a transfer nothing here made, to a worker we know, freezes that worker too", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  await f.client.transfers.create({ amount: 700, currency: "usd", destination: payee.stripeAccountId, metadata: {} }, {});
  await w.act(paymentsNode.reconcileBooks);
  assert.ok(payeeOf("t").frozenReason);
});

test("a refund no webhook ever told us about is found and reversed, however old (R6)", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  w.advance(4 * DAY);
  await w.act(paymentsNode.reconcile); // outside the recheck window now
  f.topup(5000);
  await w.act(paymentsNode.reconcileBooks);
  f.refund(chargeId, 1084);
  w.advance(HOUR);
  await w.act(paymentsNode.reconcile);
  assert.equal(w.rows("tipPayments")[0].refundedCents, 0, "hourly recheck doesn't look this far back");
  const b = await reconcile();
  assert.equal(w.rows("tipPayments")[0].refundedCents, 1084, "the balance transaction led to it");
  assert.deepEqual(b.lastReconciliation.problems, []);
  assert.equal(b.lastReconciliation.differenceCents, 0);
  await settle();
  assert.equal(netSent(payee.stripeAccountId), 0);
  assert.equal(allocs(tipId)[0].paidCents, 0);
});

test("a fee and a credit that net to zero can't hide each other (R6b)", async () => {
  await on();
  await pilot("t", "ann-a");
  await paidTip("ann-a");
  await w.act(paymentsNode.reconcileBooks);
  f.adjustment(-1084);
  f.adjustment(1084);
  const b = await reconcile();
  assert.equal(w.rows("opsAlerts").filter((a) => a.kind === "txn_unexplained").length, 2);
  assert.equal(b.unclassifiedCents, 0, "they do cancel in the totals");
  assert.equal(b.safeToWithdrawCents, 0);
});

test("ordinary Stripe costs are booked as costs and raise nothing", async () => {
  await on();
  await pilot("t", "ann-a");
  await paidTip("ann-a");
  f.topup(5000); // the fees below would otherwise eat into the worker's money, which is an alarm
  await w.act(paymentsNode.reconcileBooks);
  f.stripeFee(200);
  f.stripeFee(75);
  const b = await reconcile();
  assert.equal(b.stripeCostsCents, 275);
  assert.equal(b.platformRevenueCents, b.feesCollectedCents - b.processingCostCents - 275);
  assert.equal(criticals().length, 0);
  assert.equal(b.lastReconciliation.differenceCents, 0);
  assert.deepEqual(b.withdrawalBlockers, []);
});

test("money that moved outside Stripe's own list is a critical difference", async () => {
  await on();
  await pilot("t", "ann-a");
  await paidTip("ann-a");
  await w.act(paymentsNode.reconcileBooks);
  f.extra.balance = -200;
  const b = await reconcile();
  assert.equal(b.lastReconciliation.differenceCents, -200);
  assert.ok(hasAlert("books_difference"));
  assert.ok(b.lastReconciliation.problems.some((p: string) => p.includes("add up")));
  assert.equal(b.safeToWithdrawCents, 0);
});

test("an unexplained movement can be acknowledged, and stays booked as unclassified", async () => {
  await on();
  await pilot("t", "ann-a");
  await w.act(paymentsNode.reconcileBooks);
  const odd = f.adjustment(-300);
  f.topup(5000);
  let b = await reconcile();
  assert.ok(hasAlert("txn_unexplained"));
  assert.equal(b.unclassifiedCents, 300);
  assert.equal(b.safeToWithdrawCents, 0);
  await w.call(ops.acknowledgeTxn, null, { txnId: odd.id, note: "Stripe confirmed a correction" });
  w.advance(MINUTE);
  b = await reconcile();
  assert.equal(hasAlert("txn_unexplained"), false);
  assert.deepEqual(b.withdrawalBlockers, []);
  assert.equal(b.unclassifiedCents, 300);
  assert.equal(b.safeToWithdrawCents, b.lastReconciliation.availableCents);
});

test("the scan pages through everything, carries on after being cut off, and posts nothing twice", async () => {
  await on();
  await pilot("t", "ann-a");
  await w.act(paymentsNode.reconcileBooks);
  f.topup(5000);
  for (let i = 0; i < 249; i++) f.stripeFee(1);
  const list = f.client.balanceTransactions.list;
  let calls = 0;
  f.client.balanceTransactions.list = async (p: any) => {
    if (++calls === 2) throw new Error("connection lost");
    return list(p);
  };
  await assert.rejects(w.act(paymentsNode.reconcileBooks), /connection lost/);
  const scan = () => w.rows("balanceScan")[0];
  assert.ok(scan().startingAfter, "its place is saved");
  assert.equal(w.rows("balanceTxns").length, 100);
  await w.act(paymentsNode.reconcileBooks);
  assert.equal(calls, 4, "the failed second page again, then the last");
  assert.equal(scan().startingAfter, undefined);
  assert.equal(w.rows("balanceTxns").length, 250);
  assert.equal(books().stripeCostsCents, 249);
  const b = await reconcile();
  assert.equal(b.stripeCostsCents, 249, "overlap costs nothing");
  assert.equal(b.lastReconciliation.differenceCents, 0);
  assert.deepEqual(b.withdrawalBlockers, []);
});

test("a very long history finishes across runs, and isn't called complete until then", async () => {
  await on();
  await pilot("t", "ann-a");
  await w.act(paymentsNode.reconcileBooks);
  f.topup(50_000);
  for (let i = 0; i < 2100; i++) f.stripeFee(1);
  w.advance(MINUTE);
  await w.act(paymentsNode.reconcileBooks);
  assert.ok(w.rows("balanceScan")[0].startingAfter);
  const partial = await w.call(ops.books);
  assert.equal(partial.safeToWithdrawCents, 0);
  assert.ok(partial.withdrawalBlockers.some((x: string) => x.includes("finished")));
  assert.ok(w.jobs().some((j) => j.name.endsWith("reconcileBooks")), "the next run is already scheduled");
  await w.runDueJobs();
  assert.equal(w.rows("balanceScan")[0].startingAfter, undefined);
  assert.equal(books().stripeCostsCents, 2100);
});

test("a transfer Stripe says failed or was canceled needs a person", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  const t = [...f.transfers.values()][0] as any;
  f.txns.push({ id: "txn_cancel", object: "balance_transaction", type: "transfer_cancel", reporting_category: "transfer", amount: 1000, fee: 0, net: 1000, currency: "usd", source: t.id, created: Math.floor(Date.now() / 1000), status: "available" });
  await w.act(paymentsNode.reconcileBooks);
  assert.ok(allocs(tipId).length === 1);
  assert.ok(w.rows("opsAlerts").some((a) => a.kind === "txn_unexplained" && a.message.includes("failed or was canceled")));
});

test("Stripe's reserve for a negative worker balance is itemized, and the money isn't counted as ours", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  f.topup(5000);
  f.setBalance(payee.stripeAccountId, 0); // already paid out to their bank
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: tipId });
  await settle();
  await w.runDueJobs();
  // As in the sandbox: Stripe allows it, and the worker's balance goes negative.
  assert.equal(allocs(tipId)[0].paidCents, 0);
  assert.equal(payeeOf("t").owedCents, 0);
  assert.equal(payeeOf("t").balanceAvailableCents, -1000);
  assert.ok(payeeOf("t").frozenReason);
  assert.equal(f.payoutSchedules[payee.stripeAccountId].interval, "manual");
  assert.ok(hasAlert("negative_balance"));
  const b = await reconcile();
  assert.equal(b.connectReserveCents, 1000);
  assert.equal(b.lastReconciliation.differenceCents, 0);
  assert.equal(b.obligations.negativeWorkerCents, 0, "Stripe has already taken it from what's available");
  assert.equal(b.lastReconciliation.connectReservedCents, 1000);
});

test("before Stripe reserves for a negative balance, it still comes off the safe figure", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  f.topup(5000);
  f.setBalance(payee.stripeAccountId, 0);
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: tipId });
  await settle();
  // In the sandbox, the reserve showed up within about a minute of the reversal.
  const retrieve = f.client.balance.retrieve;
  f.client.balance.retrieve = async (p: any, o: any) => {
    const b = await retrieve(p, o);
    if (o?.stripeAccount) return b;
    return { ...b, connect_reserved: [{ amount: 0, currency: "usd" }] };
  };
  const b = await reconcile();
  assert.equal(b.obligations.negativeWorkerCents, 1000);
  f.client.balance.retrieve = retrieve;
});

test("balance transactions are classified by what they mean", () => {
  const c = (type: string, reporting_category?: string, currency = "usd") => classifyBalanceTxn({ type, reporting_category, currency });
  assert.equal(c("adjustment", "dispute"), "dispute");
  assert.equal(c("adjustment", "dispute_reversal"), "dispute");
  assert.equal(c("adjustment", "refund_failure"), "refund_failure");
  assert.equal(c("adjustment", "other_adjustment"), "unknown");
  assert.equal(c("refund_failure", "refund_failure"), "refund_failure");
  assert.equal(c("stripe_fee", "fee"), "stripe_cost");
  assert.equal(c("transfer_refund", "transfer_reversal"), "transfer_reversal");
  assert.equal(c("reserve_transaction", "connect_reserved_funds"), "connect_reserve");
  assert.equal(c("charge", "charge", "eur"), "unknown");
  assert.equal(c("something_new"), "unknown");
});

test("a charge in another currency is flagged, and doesn't touch the dollar books", async () => {
  await on();
  await pilot("t", "ann-a");
  f.outsideCharge(500, "eur");
  const b = await reconcile();
  assert.ok(hasAlert("txn_unexplained"));
  assert.equal(b.unclassifiedCents, 0);
  assert.equal(b.lastReconciliation.differenceCents, 0);
  assert.equal(b.safeToWithdrawCents, 0);
});

// Reversal retries and debts

test("a crash during a reversal, then a smaller refund change, doesn't over-reverse (R8, R8b)", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  f.refund(chargeId, 542);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  const real = f.client.transfers.createReversal;
  f.client.transfers.createReversal = async (id: string, p: any, o: any) => { await real(id, p, o); throw new Error("connection lost"); };
  await settle();
  f.client.transfers.createReversal = real;
  assert.equal(netSent(payee.stripeAccountId), 500, "Stripe did it, and we didn't hear");
  f.refund(chargeId, 271);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  f.setBalance(payee.stripeAccountId, 5000);
  w.advance(HOUR);
  await settle();
  const a = allocs(tipId)[0];
  assert.equal(a.targetCents, 250);
  assert.equal(netSent(payee.stripeAccountId), 250, "exactly what's still due");
  assert.equal(a.paidCents, 250);
  assert.equal(a.transfers[0].reversedCents, 750);
  assert.equal(a.state, "settled");
  assert.equal(f.transfers.size, 1);
  assert.equal(books().workerLiabilityCents, 0);
});

test("a crash during a reversal with nothing else changed: the retry sees it and does nothing more", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  f.refund(chargeId, 542);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  const real = f.client.transfers.createReversal;
  let lost = 0;
  f.client.transfers.createReversal = async (id: string, p: any, o: any) => { await real(id, p, o); lost++; throw new Error("connection lost"); };
  await settle();
  w.advance(HOUR);
  await settle();
  f.client.transfers.createReversal = real;
  assert.equal(lost, 1);
  assert.equal(netSent(payee.stripeAccountId), 500);
  assert.equal(allocs(tipId)[0].paidCents, 500);
  assert.equal(allocs(tipId)[0].state, "settled");
});

test("a reversal that fails before reaching Stripe retries with the same request", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: tipId });
  f.knobs.failReversal = new Error("network");
  await settle();
  assert.match(allocs(tipId)[0].lastError ?? "", /network/);
  f.knobs.failReversal = null;
  w.advance(HOUR);
  await settle();
  assert.equal(netSent(payee.stripeAccountId), 0);
  assert.equal(allocs(tipId)[0].state, "settled");
});

test("only a real lack of balance counts as short: no debt, freeze or short alert for other errors", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: tipId });
  f.knobs.failReversal = new FakeStripeError("This transfer only has ($6.00) remaining to reverse.");
  await settle();
  const payee = payeeOf("t");
  assert.equal(payee.owedCents, 0);
  assert.equal(payee.frozenReason, undefined);
  assert.equal(hasAlert("reversal_short"), false);
  assert.equal(allocs(tipId)[0].state, "due");
  assert.match(allocs(tipId)[0].lastError ?? "", /remaining to reverse/);
});

test("Stripe refusing for lack of balance, then having the money: no debt is ever recorded", async () => {
  await on();
  f.knobs.connectedReserves = false;
  const payee = await pilot("t", "ann-a");
  const { tipId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  f.setBalance(payee.stripeAccountId, 0);
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: tipId });
  await settle();
  await w.runDueJobs();
  assert.ok(hasAlert("reversal_short"));
  assert.equal(payeeOf("t").owedCents, 0);
  const a = allocs(tipId)[0];
  assert.equal(a.state, "due");
  assert.equal(a.eligibleAt, Date.now() + 6 * HOUR, "not retried every ten minutes");
  await settle();
  assert.equal(f.calls.filter((c) => c === "transfers.reverse").length, 0);
  f.setBalance(payee.stripeAccountId, 2000); // settlement caught up, or a payout failed and came back
  w.advance(7 * HOUR);
  await settle();
  const after = allocs(tipId)[0];
  assert.equal(after.state, "settled");
  assert.equal(after.paidCents, 0);
  assert.equal(after.shortSince, undefined);
  assert.equal(after.unrecoveredCents, 0);
  assert.equal(payeeOf("t").owedCents, 0);
  assert.equal(hasAlert("reversal_debt"), false);
});

test("two claims at once can't take the same debt twice (R9)", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const first = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  f.knobs.connectedReserves = false;
  f.setBalance(payee.stripeAccountId, 0);
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: first.tipId, amountCents: 108 });
  await settle();
  w.advance(8 * DAY);
  await settle();
  await w.call(ops.unfreezeWorker, null, { handle: "ann-a" });
  await w.runDueJobs();
  const owed = payeeOf("t").owedCents;
  assert.equal(owed, 100);
  const t2 = await paidTip("ann-a");
  w.advance(MINUTE);
  const t3 = await paidTip("ann-a");
  w.advance(24 * HOUR);
  const c2 = await w.call(settlement.claimAllocation, null, { allocationId: allocs(t2.tipId)[0]._id });
  const c3 = await w.call(settlement.claimAllocation, null, { allocationId: allocs(t3.tipId)[0]._id });
  assert.equal(c2.offsetCents + c3.offsetCents, owed, "only what's owed, once");
  assert.equal(payeeOf("t").owedCents, 0);
  // The first one's transfer never happens: its share of the debt goes back.
  await w.call(settlement.releaseClaim, null, { allocationId: allocs(t2.tipId)[0]._id, error: "stripe is down" });
  assert.equal(payeeOf("t").owedCents, c2.offsetCents);
});

test("a stuck claim gives its reserved debt back when it's released", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const first = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  f.knobs.connectedReserves = false;
  f.setBalance(payee.stripeAccountId, 0);
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: first.tipId, amountCents: 108 });
  await settle();
  w.advance(8 * DAY);
  await settle();
  await w.call(ops.unfreezeWorker, null, { handle: "ann-a" });
  await w.runDueJobs();
  const t2 = await paidTip("ann-a");
  w.advance(24 * HOUR);
  const claim = await w.call(settlement.claimAllocation, null, { allocationId: allocs(t2.tipId)[0]._id });
  assert.equal(claim.offsetCents, 100);
  assert.equal(payeeOf("t").owedCents, 0);
  w.advance(16 * MINUTE);
  await settle(); // releases the old claim, claims again, transfers
  assert.equal(payeeOf("t").owedCents, 0);
  const a = allocs(t2.tipId)[0];
  assert.equal(a.state, "settled");
  assert.equal(a.paidCents, 1000);
  assert.equal(f.transfers.size, 2);
  assert.equal(([...f.transfers.values()].at(-1) as any).amount, 900, "the debt came off once");
  assert.equal(netSent(payee.stripeAccountId), 1900);
});

test("a crashed transfer later fully refunded is found, not forgotten", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  f.knobs.crashAfterTransfer = true;
  await settle();
  assert.equal(f.transfers.size, 1);
  assert.equal(allocs(tipId)[0].transfers.length, 0, "we never heard");
  f.refund(chargeId, 1084);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  assert.equal(allocs(tipId)[0].targetCents, 0);
  w.advance(HOUR);
  await settle(); // nothing looks due, but an attempt was outstanding: it looks and finds the transfer
  await settle(); // and takes it back
  await settle();
  assert.equal(allocs(tipId)[0].transfers.length, 1);
  assert.equal(netSent(payee.stripeAccountId), 0);
  assert.equal(allocs(tipId)[0].state, "settled");
  assert.equal(books().workerLiabilityCents, 0);
});

test("crash recovery asks Stripe for this tip's transfers only", async () => {
  await on();
  await pilot("ann", "ann-a");
  await pilot("ben", "ben-b");
  await paidTip("ann-a");
  await paidTip("ben-b");
  w.advance(24 * HOUR);
  f.knobs.crashAfterTransfer = true;
  await settle(); // Ann's crashes; Ben's goes through
  const list = f.client.transfers.list;
  const groups: string[] = [];
  f.client.transfers.list = async (p: any) => { groups.push(p.transfer_group); return list(p); };
  w.advance(HOUR);
  await settle();
  f.client.transfers.list = list;
  assert.ok(groups.length > 0 && groups.every((g) => g.startsWith("tip_tipPayments:")));
  assert.equal(f.transfers.size, 2, "no second transfer to anyone");
  assert.ok(allocs().every((a) => a.state === "settled" && a.paidCents === 1000));
});
