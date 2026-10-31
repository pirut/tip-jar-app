import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import Stripe from "stripe";

process.env.STRIPE_MODE = "test";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.TIP_ORIGIN = "https://tips.example.com";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_connect";

const { crews, earnings, ops, payments, paymentsNode, settlement, tips, workers, world, HOUR, DAY, MINUTE } = await import("./harness.ts");
const { fakeStripe, FakeStripeError } = await import("./fakeStripe.ts");
const { ledgerTotals, entitlement, allocationTargets, tipAmounts, planReversal, applyOwed, splitTipAmongMembers } = await import("../convex/lib/paymentRules.ts");
const { keyMode, requireStripeConfig, supportEmail } = await import("../convex/lib/stripeEnv.ts");
const { eventTarget, accountStatus, accountStatusV1 } = await import("../convex/lib/stripeEvents.ts");

let f: ReturnType<typeof fakeStripe>;
let w: ReturnType<typeof world>;
let requestCounter = 0;

beforeEach(() => {
  f = fakeStripe();
  paymentsNode.useStripeForTests(f.client);
  w = world();
});

const on = () => w.call(ops.setControls, null, { chargesEnabled: true, transfersEnabled: true });

// A worker who has been enrolled and finished Stripe's onboarding.
async function pilot(token: string, handle: string) {
  await w.profile(token, handle);
  await w.call(ops.enrollWorker, null, { handle });
  await w.act(paymentsNode.startPayoutSetup, token);
  const payee = w.rows("payeeAccounts").find((p) => p.tokenIdentifier === token);
  f.activate(payee.stripeAccountId);
  await w.act(paymentsNode.refreshPayoutStatus, token);
  return w.rows("payeeAccounts").find((p) => p.tokenIdentifier === token);
}

const checkout = (handle: string, tipCents = 1000, coverFees = true, clientRequestId = `request-${++requestCounter}`) =>
  w.act(paymentsNode.createGuestCheckout, null, { handle, tipCents, coverFees, clientRequestId });

const lastTip = () => w.rows("tipPayments").at(-1);

// A guest tips and pays; the webhook's sync records it.
async function paidTip(handle: string, tipCents = 1000, coverFees = true) {
  await checkout(handle, tipCents, coverFees);
  const tip = lastTip();
  const paid = f.pay(tip.stripeCheckoutSessionId);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tip._id });
  return { tipId: tip._id, ...paid };
}

const tipRow = (id: string) => w.rows("tipPayments").find((t) => t._id === id);
const allocs = (tipId?: string) => w.rows("allocations").filter((a) => !tipId || a.tipPaymentId === tipId);
const books = () => ledgerTotals(w.rows("ledgerEntries"));

async function settle() {
  await w.act(paymentsNode.runDue);
  await w.runDueJobs();
}

// Rules

test("a guest covering fees pays on top, and fees otherwise come out of the tip", () => {
  assert.deepEqual(
    (({ chargedCents, netCents, feesCents }) => ({ chargedCents, netCents, feesCents }))(tipAmounts(1000, true)),
    { chargedCents: 1084, netCents: 1000, feesCents: 84 },
  );
  assert.deepEqual(
    (({ chargedCents, netCents }) => ({ chargedCents, netCents }))(tipAmounts(1000, false)),
    { chargedCents: 1000, netCents: 916 },
  );
});

test("refund math never loses a cent, across many amounts", () => {
  for (let charged = 100; charged < 3000; charged += 37) {
    for (const net of [charged, charged - 58, Math.floor(charged / 2)]) {
      for (const refunded of [0, 1, 33, Math.floor(charged / 2), charged - 1, charged, charged + 5]) {
        const e = entitlement({ netCents: net, chargedCents: charged, refundedCents: refunded, disputedCents: 0 });
        assert.equal(e.netTakenCents + e.entitledCents, net);
        assert.equal(e.netTakenCents + e.feesTakenCents, Math.min(charged, refunded));
        assert.ok(e.entitledCents >= 0 && e.feesTakenCents >= 0);
      }
    }
  }
});

test("allocation targets always add up to what's left, and a tip split among a crew adds to its net", () => {
  for (let entitled = 0; entitled < 500; entitled += 7) {
    const shares = [333, 333, 334];
    assert.equal(allocationTargets(entitled, shares).reduce((a, b) => a + b, 0), entitled);
  }
  for (let i = 0; i < 20; i++) assert.equal(splitTipAmongMembers(1001, [1, 1.5, 0.5], i).reduce((a, b) => a + b, 0), 1001);
});

test("leftover cents rotate from tip to tip", () => {
  const first = [0, 1, 2].map((i) => splitTipAmongMembers(100, [1, 1, 1], i));
  assert.deepEqual(first, [[34, 33, 33], [33, 34, 33], [33, 33, 34]]);
});

test("a reversal spreads over transfers, newest first, and reports what it can't cover", () => {
  const transfers = [{ id: "a", amountCents: 100, reversedCents: 40 }, { id: "b", amountCents: 50, reversedCents: 0 }];
  assert.deepEqual(planReversal(transfers, 70), { plan: [{ transferId: "b", amountCents: 50 }, { transferId: "a", amountCents: 20 }], uncoveredCents: 0 });
  assert.equal(planReversal(transfers, 200).uncoveredCents, 90);
  assert.deepEqual(applyOwed(100, 30), { transferCents: 70, offsetCents: 30 });
  assert.deepEqual(applyOwed(100, 300), { transferCents: 0, offsetCents: 100 });
});

test("test and live keys can't run on the wrong deployment", () => {
  assert.equal(keyMode("rk_test_x"), "test");
  assert.equal(keyMode("sk_live_x"), "live");
  assert.equal(keyMode("pk_test_x"), null);
  assert.throws(() => requireStripeConfig({ STRIPE_MODE: "test", STRIPE_SECRET_KEY: "sk_live_x" }), /doesn't match/);
  assert.throws(() => requireStripeConfig({ STRIPE_MODE: "live", STRIPE_SECRET_KEY: "rk_test_x" }), /doesn't match/);
  assert.throws(() => requireStripeConfig({ STRIPE_SECRET_KEY: "sk_test_x" }), /STRIPE_MODE/);
});

test("events only name what to re-read from Stripe", () => {
  assert.deepEqual(eventTarget({ type: "checkout.session.completed", data: { object: { id: "cs_1", metadata: { tipPaymentId: "t" }, payment_intent: "pi_1" } } }), { kind: "payment", tipPaymentId: "t", sessionId: "cs_1", paymentIntentId: "pi_1" });
  assert.deepEqual(eventTarget({ type: "charge.dispute.created", data: { object: { payment_intent: "pi_1" } } }), { kind: "payment", paymentIntentId: "pi_1", tipPaymentId: undefined });
  assert.deepEqual(eventTarget({ type: "account.updated", account: "acct_1", data: { object: {} } }), { kind: "account", stripeAccountId: "acct_1" });
  assert.deepEqual(eventTarget({ type: "payout.paid", account: "acct_1", data: { object: { id: "po_1" } } }), { kind: "payout", stripeAccountId: "acct_1", payoutId: "po_1" });
  assert.deepEqual(eventTarget({ type: "customer.created", data: { object: {} } }), { kind: "ignore" });
});

test("only an active recipient capability counts", () => {
  const account = { configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: "pending" } } } } }, requirements: { entries: [{ minimum_deadline: { status: "eventually_due" } }, { minimum_deadline: { status: "currently_due" } }] } };
  assert.deepEqual(accountStatus(account), { transfersStatus: "pending", payoutsStatus: "unknown", requirementsDue: 1 });
});

// Who can do what

test("no public mutation can touch real money", () => {
  const dir = new URL("../convex/", import.meta.url);
  const allowed = new Set([
    "crews:start", "crews:lookup", "crews:join", "crews:leave", "crews:removeMember", "crews:setSplitMode", "crews:setMemberWeights", "crews:close",
    "earnings:cashOutInstant", "tips:tipFromGuest", "tips:recordTap", "workers:saveProfile", "workers:deleteAccount",
  ]);
  const modules: Record<string, any> = { crews, earnings, ops, payments, settlement, tips, workers };
  const found: string[] = [];
  for (const [name, mod] of Object.entries(modules)) {
    for (const [key, fn] of Object.entries<any>(mod)) {
      if (fn?.isMutation && fn.isPublic) found.push(`${name}:${key}`);
    }
  }
  assert.deepEqual(found.sort(), [...allowed].sort());
  assert.ok(readdirSync(dir).includes("paymentsNode.ts"));
  for (const key of Object.keys(ops)) assert.ok(!(ops as any)[key]?.isPublic, `ops:${key} must be internal`);
  for (const key of Object.keys(settlement)) assert.ok(!(settlement as any)[key]?.isPublic, `settlement:${key} must be internal`);
});

test("a signed-in worker can't start payouts without being enrolled", async () => {
  await on();
  await w.profile("t", "ann-a");
  await assert.rejects(w.act(paymentsNode.startPayoutSetup, "t"), /aren't open/);
  assert.equal(f.calls.length, 0);
});

test("the action's caller can't name a different worker", async () => {
  await on();
  const annPayee = await pilot("ann", "ann-a");
  await w.profile("eve", "eve-e");
  await assert.rejects(w.act(paymentsNode.payoutDashboardLink, "eve"), /Set up payouts first/);
  assert.equal(annPayee.tokenIdentifier, "ann");
});

// Gates

test("every gate has to pass before a guest can be charged", async () => {
  await w.profile("t", "ann-a");
  // Not enrolled: demo only.
  await assert.rejects(checkout("ann-a"), /can't take tips/);
  await w.call(ops.enrollWorker, null, { handle: "ann-a" });
  // Enrolled, no account.
  await assert.rejects(checkout("ann-a"), /can't take tips/);
  await w.act(paymentsNode.startPayoutSetup, "t");
  // Account not active.
  await assert.rejects(checkout("ann-a"), /can't take tips/);
  const payee = w.rows("payeeAccounts")[0];
  f.activate(payee.stripeAccountId);
  await w.act(paymentsNode.refreshPayoutStatus, "t");
  // Master switch off (it's off until someone turns it on).
  await assert.rejects(checkout("ann-a"), /can't take tips/);
  await on();
  await checkout("ann-a");
  assert.equal(f.calls.filter((c) => c === "checkout.create").length, 1);
  // Suspended.
  await w.call(ops.suspendWorker, null, { handle: "ann-a" });
  await assert.rejects(checkout("ann-a"), /can't take tips/);
  assert.equal(f.calls.filter((c) => c === "checkout.create").length, 1);
});

test("Stripe is asked again before charging, not just our copy", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  w.advance(5 * MINUTE);
  f.restrict(payee.stripeAccountId);
  await assert.rejects(checkout("ann-a"), /can't take tips/);
  assert.equal(lastTip().status, "canceled");
  assert.equal(f.calls.filter((c) => c === "checkout.create").length, 0);
  assert.equal(w.rows("payeeAccounts")[0].transfersStatus, "restricted");
});

test("limits: per tip, per worker per day, and overall", async () => {
  await on();
  await pilot("t", "ann-a");
  await assert.rejects(checkout("ann-a", 10_100), /over the limit/);
  await w.call(ops.setControls, null, { workerDailyLimitCents: 2000 });
  await checkout("ann-a", 1000);
  await assert.rejects(checkout("ann-a", 1000), /today's tip limit/);
  w.advance(DAY + MINUTE);
  await checkout("ann-a", 1000);
  await w.call(ops.setControls, null, { workerDailyLimitCents: 50_000, globalDailyLimitCents: 1500 });
  await assert.rejects(checkout("ann-a", 1000), /paused/);
});

test("a flood of tips is rate limited per worker", async () => {
  await on();
  await pilot("t", "ann-a");
  for (let i = 0; i < 10; i++) await checkout("ann-a", 100);
  await assert.rejects(checkout("ann-a", 100), /Try again in a minute/);
});

test("amounts are worked out on the server, and a bad amount never reaches Stripe", async () => {
  await on();
  await pilot("t", "ann-a");
  for (const bad of [0, 50, 12.5, -100, 50_001]) await assert.rejects(checkout("ann-a", bad), /\$1 to \$500/);
  await checkout("ann-a", 1000, true);
  const session = f.client.checkout.sessions;
  const tip = lastTip();
  const made = await session.retrieve(tip.stripeCheckoutSessionId);
  assert.equal(made.total, 1084);
  assert.equal(made.metadata.tipPaymentId, tip._id);
  assert.equal(made.params.payment_method_types, undefined, "dynamic payment methods");
  assert.deepEqual(made.params.adaptive_pricing, { enabled: false }, "USD receipt must match checkout currency");
  assert.match(made.params.success_url, /^https:\/\/tips\.example\.com\/ann-a\?paid=/);
});

test("pressing Pay twice makes one payment", async () => {
  await on();
  await pilot("t", "ann-a");
  const a = await checkout("ann-a", 1000, true, "same-request-id");
  const b = await checkout("ann-a", 1000, true, "same-request-id");
  assert.equal(a.url, b.url);
  assert.equal(w.rows("tipPayments").length, 1);
  assert.equal(f.calls.filter((c) => c === "checkout.create").length, 1);
});

test("a crash after Stripe made the session is recovered by the webhook", async () => {
  await on();
  await pilot("t", "ann-a");
  const reserved = await w.call(payments.reservePayment, null, { workerId: w.rows("workers")[0]._id, tipCents: 1000, coverFees: true, clientRequestId: "crash-after-stripe" });
  const session = await f.client.checkout.sessions.create({ line_items: [{ quantity: 1, price_data: { unit_amount: 1084 } }], metadata: { tipPaymentId: reserved.tipPaymentId } }, { idempotencyKey: "x" });
  assert.equal(lastTip().stripeCheckoutSessionId, undefined);
  f.pay(session.id);
  await w.act(paymentsNode.processEvent, null, { eventId: await record({ kind: "payment", tipPaymentId: reserved.tipPaymentId, sessionId: session.id }) });
  assert.equal(lastTip().status, "succeeded");
  assert.equal(lastTip().stripeCheckoutSessionId, session.id);
});

// Webhooks

let eventCounter = 0;
async function record(target: any, overrides: any = {}) {
  const eventId = `evt_${++eventCounter}`;
  await w.call(payments.recordEvent, null, { eventId, type: "checkout.session.completed", livemode: false, source: "platform", created: 1, target: JSON.stringify(target), ...overrides });
  return eventId;
}

test("webhook signatures are verified", async () => {
  const body = JSON.stringify({ id: "evt_s", object: "event", type: "payment_intent.succeeded", livemode: false, created: 1, data: { object: { id: "pi_x", metadata: {} } } });
  const header = new Stripe("sk_test_x").webhooks.generateTestHeaderString({ payload: body, secret: "whsec_test" });
  const good = await w.act(paymentsNode.verifyWebhook, null, { body, signature: header, source: "platform" });
  assert.equal(good.eventId, "evt_s");
  assert.equal(await w.act(paymentsNode.verifyWebhook, null, { body, signature: "t=1,v1=bad", source: "platform" }), null);
  assert.equal(await w.act(paymentsNode.verifyWebhook, null, { body: body + " ", signature: header, source: "platform" }), null);
  // The platform secret doesn't verify the Connect endpoint.
  assert.equal(await w.act(paymentsNode.verifyWebhook, null, { body, signature: header, source: "connect" }), null);
});

test("the same event twice does nothing twice", async () => {
  const first = await w.call(payments.recordEvent, null, { eventId: "evt_dup", type: "x", livemode: false, source: "platform", created: 1, target: '{"kind":"account","stripeAccountId":"a"}' });
  const second = await w.call(payments.recordEvent, null, { eventId: "evt_dup", type: "x", livemode: false, source: "platform", created: 1, target: '{"kind":"account","stripeAccountId":"a"}' });
  assert.deepEqual([first.duplicate, second.duplicate], [false, true]);
  assert.equal(w.rows("stripeEvents").length, 1);
  assert.equal(w.jobs().filter((j) => j.name.endsWith("processEvent")).length, 1);
});

test("an event from the wrong mode is refused and raises an alarm", async () => {
  await record({ kind: "account", stripeAccountId: "a" }, { livemode: true });
  assert.equal(w.rows("stripeEvents")[0].status, "ignored");
  assert.equal(w.rows("opsAlerts")[0].kind, "event_wrong_mode");
  assert.equal(w.jobs().filter((j) => j.name.endsWith("processEvent")).length, 0);
});

test("a failed sync retries, then raises an alarm instead of vanishing", async () => {
  const eventId = await record({ kind: "transfer", transferId: "tr_missing" });
  f.client.transfers.retrieve = async () => { throw new Error("stripe is down"); };
  for (let i = 0; i < 8; i++) await w.act(paymentsNode.processEvent, null, { eventId });
  const row = w.rows("stripeEvents")[0];
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 8);
  assert.ok(w.rows("opsAlerts").some((a) => a.kind === "event_failed"));
});

// Recording a payment

test("the return page can't claim a payment Stripe hasn't confirmed", async () => {
  await on();
  await pilot("t", "ann-a");
  await checkout("ann-a");
  const tip = lastTip();
  await w.act(paymentsNode.refreshGuestReceipt, null, { sessionId: tip.stripeCheckoutSessionId });
  assert.equal(lastTip().status, "open");
  assert.equal(allocs().length, 0);
  assert.equal(w.rows("ledgerEntries").length, 0);
  assert.equal(await w.call(payments.guestReceipt, null, { sessionId: "cs_made_up" }), null);
});

test("a success records earnings once, however many times it's synced", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId } = await paidTip("ann-a");
  for (let i = 0; i < 3; i++) {
    w.advance(1000);
    await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  }
  assert.equal(allocs().length, 1);
  assert.equal(allocs()[0].targetCents, 1000);
  const b = books();
  assert.equal(b.workerLiabilityCents, 1000);
  assert.equal(b.feesCollectedCents, 84);
  assert.equal(b.processingCostCents, Math.round(1084 * 0.029) + 30);
});

test("money that doesn't match what we asked for is frozen and never paid out", async () => {
  await on();
  await pilot("t", "ann-a");
  for (const opts of [{ amount: 99 }, { currency: "eur" }, { metadata: { tipPaymentId: "tipPayments:999" } }]) {
    w.advance(2 * MINUTE);
    await checkout("ann-a");
    const tip = lastTip();
    f.pay(tip.stripeCheckoutSessionId, opts);
    await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tip._id });
    const after = lastTip();
    assert.ok(after.reviewReason, JSON.stringify(opts));
    assert.notEqual(after.status, "succeeded");
  }
  assert.equal(allocs().length, 0);
  assert.equal(w.rows("ledgerEntries").length, 0);
  assert.ok(w.rows("opsAlerts").some((a) => a.kind === "payment_mismatch" && a.severity === "critical"));
});

test("an old read can't overwrite a newer one", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId, piId } = await paidTip("ann-a");
  const stale = {
    fetchedFrom: Date.now() - 60_000, paymentIntentId: piId, piStatus: "processing", amountCents: 1084, currency: "usd", livemode: false,
    metadataTipPaymentId: tipId, refundedCents: 0, disputes: [],
  };
  const r = await w.call(payments.applyPaymentSnapshot, null, { tipPaymentId: tipId, snapshot: stale });
  assert.equal(r.reason, "stale");
  assert.equal(tipRow(tipId).status, "succeeded");
});

test("a succeeded payment never goes backward", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId, piId } = await paidTip("ann-a");
  w.advance(1000);
  await w.call(payments.applyPaymentSnapshot, null, { tipPaymentId: tipId, snapshot: {
    fetchedFrom: Date.now(), paymentIntentId: piId, piStatus: "canceled", amountCents: 1084, currency: "usd", livemode: false, metadataTipPaymentId: tipId, refundedCents: 0, disputes: [],
  } });
  assert.equal(tipRow(tipId).status, "succeeded");
});

test("a refund seen before the success still ends up correct", async () => {
  await on();
  await pilot("t", "ann-a");
  await checkout("ann-a");
  const tip = lastTip();
  const paid = f.pay(tip.stripeCheckoutSessionId);
  f.refund(paid.chargeId, 1084);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tip._id });
  assert.equal(allocs()[0].targetCents, 0);
  assert.equal(allocs()[0].state, "settled");
  assert.equal(books().workerLiabilityCents, 0);
});

test("a late success on an expired row is honored, because Stripe has the money", async () => {
  await on();
  await pilot("t", "ann-a");
  await checkout("ann-a");
  const tip = lastTip();
  await w.call(payments.closeUnpaid, null, { tipPaymentId: tip._id, status: "expired" });
  f.pay(tip.stripeCheckoutSessionId);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tip._id });
  assert.equal(lastTip().status, "succeeded");
  assert.equal(allocs().length, 1);
});

test("an abandoned checkout expires and earns nothing", async () => {
  await on();
  await pilot("t", "ann-a");
  await checkout("ann-a");
  const tip = lastTip();
  f.expire(tip.stripeCheckoutSessionId);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tip._id });
  assert.equal(lastTip().status, "expired");
  assert.equal(allocs().length, 0);
});

// Transfers

test("money stays with the platform until the hold ends, then goes to the right account", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { chargeId } = await paidTip("ann-a");
  await settle();
  assert.equal(f.transfers.size, 0, "still on hold");
  w.advance(24 * HOUR);
  await settle();
  const [transfer] = [...f.transfers.values()];
  assert.equal(transfer.amount, 1000);
  assert.equal(transfer.destination, payee.stripeAccountId);
  assert.equal(transfer.source_transaction, chargeId);
  assert.equal(allocs()[0].state, "settled");
  assert.equal(books().workerLiabilityCents, 0);
  // Running again moves nothing.
  await settle();
  assert.equal(f.transfers.size, 1);
});

test("the transfer kill switch holds money, and turning it back on releases it", async () => {
  await on();
  await pilot("t", "ann-a");
  await paidTip("ann-a");
  await w.call(ops.setControls, null, { transfersEnabled: false });
  w.advance(24 * HOUR);
  await settle();
  assert.equal(f.transfers.size, 0);
  await w.call(ops.setControls, null, { transfersEnabled: true });
  w.advance(HOUR);
  await settle();
  assert.equal(f.transfers.size, 1);
});

test("the charge kill switch stops new tips but not money already earned", async () => {
  await on();
  await pilot("t", "ann-a");
  await paidTip("ann-a");
  await w.call(ops.setControls, null, { chargesEnabled: false });
  await assert.rejects(checkout("ann-a"), /can't take tips/);
  w.advance(24 * HOUR);
  await settle();
  assert.equal(f.transfers.size, 1);
});

test("an account Stripe has restricted gets no transfer, and catches up when it's fixed", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  await paidTip("ann-a");
  f.restrict(payee.stripeAccountId);
  w.advance(24 * HOUR);
  await settle();
  assert.equal(f.transfers.size, 0);
  assert.equal(allocs()[0].state, "due");
  f.activate(payee.stripeAccountId);
  await w.act(paymentsNode.refreshPayoutStatus, "t");
  w.advance(HOUR);
  await settle();
  assert.equal(f.transfers.size, 1);
});

test("a crash after Stripe made the transfer doesn't pay twice", async () => {
  await on();
  await pilot("t", "ann-a");
  await paidTip("ann-a");
  w.advance(24 * HOUR);
  f.knobs.crashAfterTransfer = true;
  await settle();
  assert.equal(f.transfers.size, 1);
  assert.equal(allocs()[0].paidCents, 0, "our record doesn't know yet");
  w.advance(HOUR);
  await settle();
  assert.equal(f.transfers.size, 1, "the retry found the first transfer");
  assert.equal(allocs()[0].paidCents, 1000);
  assert.equal(allocs()[0].state, "settled");
  assert.equal(w.rows("ledgerEntries").filter((e) => e.ref.startsWith("transfer:")).length, 1);
});

test("a crash, then a refund that changes the amount, still doesn't pay twice", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  f.knobs.crashAfterTransfer = true;
  await settle();
  assert.equal(f.transfers.size, 1);
  f.refund(chargeId, 542);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  assert.equal(allocs()[0].targetCents, 500);
  w.advance(HOUR);
  await settle();
  await settle();
  assert.equal(f.transfers.size, 1, "no second transfer");
  assert.equal(allocs()[0].paidCents, 500, "the extra came back");
  assert.equal(f.balances.get(payee.stripeAccountId).available, 500);
  assert.equal(books().workerLiabilityCents, 0);
});

test("a Stripe webhook about a transfer we never wrote down records it", async () => {
  await on();
  await pilot("t", "ann-a");
  await paidTip("ann-a");
  w.advance(24 * HOUR);
  f.knobs.crashAfterTransfer = true;
  await settle();
  const [transfer] = [...f.transfers.values()];
  await w.act(paymentsNode.processEvent, null, { eventId: await record({ kind: "transfer", transferId: transfer.id }) });
  assert.equal(allocs()[0].paidCents, 1000);
  w.advance(HOUR);
  await settle();
  assert.equal(f.transfers.size, 1);
});

test("a failure setting the payout schedule is fixed on the next visit", async () => {
  await on();
  await w.profile("t", "ann-a");
  await w.call(ops.enrollWorker, null, { handle: "ann-a" });
  const update = f.client.balanceSettings.update;
  f.client.balanceSettings.update = async () => { throw new Error("stripe is down"); };
  await assert.rejects(w.act(paymentsNode.startPayoutSetup, "t"), /down/);
  f.client.balanceSettings.update = update;
  await w.act(paymentsNode.startPayoutSetup, "t");
  assert.equal(w.rows("payeeAccounts").length, 1);
  assert.equal(f.payoutSchedules[w.rows("payeeAccounts")[0].stripeAccountId].interval, "weekly");
});

test("a run that dies mid-call is picked up after the timeout, without paying twice", async () => {
  await on();
  await pilot("t", "ann-a");
  await paidTip("ann-a");
  w.advance(24 * HOUR);
  await w.call(settlement.claimAllocation, null, { allocationId: allocs()[0]._id });
  assert.equal(allocs()[0].state, "in_flight");
  await settle();
  assert.equal(f.transfers.size, 0, "too soon to retry");
  w.advance(16 * MINUTE);
  await settle();
  assert.equal(f.transfers.size, 1);
  assert.equal(allocs()[0].state, "settled");
});

test("a transfer that keeps failing raises an alarm and stays owed", async () => {
  await on();
  await pilot("t", "ann-a");
  await paidTip("ann-a");
  w.advance(24 * HOUR);
  f.knobs.failTransfer = new Error("stripe is down");
  for (let i = 0; i < 7; i++) {
    await settle();
    w.advance(7 * HOUR);
  }
  assert.equal(allocs()[0].state, "due");
  assert.ok(w.rows("opsAlerts").some((a) => a.kind === "transfer_stuck"));
  f.knobs.failTransfer = null;
  await settle();
  assert.equal(f.transfers.size, 1);
});

test("a transfer to the wrong recipient is never recorded as paid", async () => {
  await on();
  await pilot("t", "ann-a");
  await paidTip("ann-a");
  await w.call(settlement.completeTransfer, null, { allocationId: allocs()[0]._id, transferId: "tr_x", amountCents: 1000, destination: "acct_someone_else" });
  assert.equal(allocs()[0].paidCents, 0);
  assert.ok(w.rows("opsAlerts").some((a) => a.kind === "transfer_wrong_recipient"));
});

// Refunds and disputes

test("a full refund before transfer: nothing moves, and platform loses only Stripe's kept fee", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId } = await paidTip("ann-a");
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: tipId });
  assert.equal(tipRow(tipId).refundedCents, 1084);
  w.advance(24 * HOUR);
  await settle();
  assert.equal(f.transfers.size, 0);
  const b = books();
  assert.equal(b.workerLiabilityCents, 0);
  assert.equal(b.feesCollectedCents, 0);
  assert.equal(b.platformRevenueCents, -b.processingCostCents);
});

test("a refund after transfer is reversed from the worker", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  assert.equal(f.balances.get(payee.stripeAccountId).available, 1000);
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: tipId });
  await settle();
  assert.equal(f.balances.get(payee.stripeAccountId).available, 0);
  assert.equal(allocs()[0].paidCents, 0);
  assert.equal(allocs()[0].state, "settled");
  assert.equal(books().workerLiabilityCents, 0);
});

test("a partial refund takes a fair part from the worker and the fee", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId } = await paidTip("ann-a");
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: tipId, amountCents: 542 });
  assert.equal(allocs()[0].targetCents, 500);
  assert.equal(books().workerLiabilityCents, 500);
  assert.equal(books().feesCollectedCents, 42);
});

test("a reversal Stripe can't do: the worker owes it, is frozen, and later tips pay it off", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const first = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();
  f.setBalance(payee.stripeAccountId, 0); // already paid out to their bank
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: first.tipId });
  await settle();
  let account = w.rows("payeeAccounts")[0];
  assert.equal(account.owedCents, 1000);
  assert.ok(account.frozenReason);
  assert.equal(f.payoutSchedules[payee.stripeAccountId].interval, "manual");
  assert.ok(w.rows("opsAlerts").some((a) => a.kind === "reversal_short" && a.severity === "critical"));
  assert.equal(books().workerLiabilityCents, -1000);

  // Frozen workers can't take new tips.
  await assert.rejects(checkout("ann-a"), /can't take tips/);

  await w.call(ops.unfreezeWorker, null, { handle: "ann-a" });
  await w.runDueJobs();
  assert.equal(f.payoutSchedules[payee.stripeAccountId].interval, "weekly");
  const second = await paidTip("ann-a", 1500);
  w.advance(24 * HOUR);
  await settle();
  account = w.rows("payeeAccounts")[0];
  assert.equal(account.owedCents, 0);
  const made = [...f.transfers.values()].at(-1);
  assert.equal(made.amount, 500, "1500 less the 1000 owed");
  assert.equal(allocs(second.tipId)[0].paidCents, 1500);
  assert.equal(books().workerLiabilityCents, 0);
});

test("a dispute takes the money back at once, and a win pays it out again", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  w.advance(24 * HOUR);
  await settle();

  f.dispute(chargeId, "needs_response", 1084);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  assert.equal(tipRow(tipId).disputeOpen, true);
  await settle();
  assert.equal(f.balances.get(payee.stripeAccountId).available, 0);
  assert.equal(books().disputeFeesCents, 1500);
  assert.equal(books().workerLiabilityCents, 0);

  w.advance(HOUR);
  f.setDisputeStatus(chargeId, "won");
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  assert.equal(allocs()[0].targetCents, 1000);
  assert.equal(books().workerLiabilityCents, 1000);
  await settle();
  const repay = [...f.transfers.values()].at(-1);
  assert.equal(repay.amount, 1000);
  assert.equal(repay.source_transaction, undefined, "reinstated money is in the platform's balance");
  assert.equal(f.balances.get(payee.stripeAccountId).available, 1000);
  assert.equal(books().workerLiabilityCents, 0);
});

test("a lost dispute stays taken back", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  f.dispute(chargeId, "needs_response", 1084);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  w.advance(HOUR);
  f.setDisputeStatus(chargeId, "lost");
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  assert.equal(tipRow(tipId).disputeOpen, false);
  w.advance(24 * HOUR);
  await settle();
  assert.equal(f.transfers.size, 0);
  assert.equal(allocs()[0].targetCents, 0);
});

test("an inquiry freezes the tip without taking money", async () => {
  await on();
  await pilot("t", "ann-a");
  const { tipId, chargeId } = await paidTip("ann-a");
  f.dispute(chargeId, "warning_needs_response", 1084);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  assert.equal(allocs()[0].targetCents, 1000);
  w.advance(24 * HOUR);
  await settle();
  assert.equal(f.transfers.size, 0, "frozen");
  w.advance(HOUR);
  f.setDisputeStatus(chargeId, "warning_closed");
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tipId });
  w.advance(HOUR);
  await settle();
  assert.equal(f.transfers.size, 1);
});

test("a negative Stripe balance freezes the worker and raises an alarm", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  f.setBalance(payee.stripeAccountId, -500);
  await w.act(paymentsNode.refreshBalance, "t");
  await w.runDueJobs();
  assert.ok(w.rows("payeeAccounts")[0].frozenReason);
  assert.ok(w.rows("opsAlerts").some((a) => a.kind === "negative_balance"));
});

// Crews

async function realCrew() {
  await on();
  const ann = await pilot("ann", "ann-a");
  const ben = await pilot("ben", "ben-b");
  const crewId = await w.call(crews.start, "ann", { name: "Valets", splitMode: "even", closesInHours: 8 });
  const code = w.rows("crews")[0].code;
  assert.equal((await w.call(crews.join, "ben", { code })).ok, true);
  return { ann, ben, crewId, code };
}

test("a pilot worker's crew is real, and only pays money Stripe has confirmed", async () => {
  const { crewId } = await realCrew();
  assert.equal(w.rows("crews")[0].moneyMode, "real");
  await checkout("ann-a"); // Started but not paid.
  await paidTip("ben-b", 2000);
  assert.equal(allocs().length, 0, "pool money isn't anyone's yet");
  const current = await w.call(crews.current, "ann");
  assert.equal(current.crew.real, true);
  assert.equal(current.crew.poolCents, 2000);
  assert.equal(w.rows("tipPayments").filter((t) => t.crewId === crewId).length, 2);
});

test("closing a real crew splits each tip, every cent is accounted for, and transfers follow the hold", async () => {
  const { ann, ben } = await realCrew();
  await paidTip("ann-a", 1001);
  await paidTip("ben-b", 2000);
  await w.call(crews.close, "ann");
  const rows = allocs();
  assert.equal(rows.reduce((a, r) => a + r.targetCents, 0), 3001);
  const totals = w.rows("crewMembers").map((m) => m.payoutCents);
  assert.equal(totals[0] + totals[1], 3001);
  assert.ok(w.rows("crewMembers").every((m) => m.realMoney));
  w.advance(24 * HOUR);
  await settle();
  const sent = [...f.transfers.values()];
  const to = (acct: string) => sent.filter((t) => t.destination === acct).reduce((a, t) => a + t.amount, 0);
  assert.equal(to(ann.stripeAccountId), totals[0]);
  assert.equal(to(ben.stripeAccountId), totals[1]);
  assert.equal(books().workerLiabilityCents, 0);
});

test("someone who left a real crew is still paid; someone removed isn't, and keeps their own tips", async () => {
  await on();
  const ann = await pilot("ann", "ann-a");
  const ben = await pilot("ben", "ben-b");
  const cat = await pilot("cat", "cat-c");
  await w.call(crews.start, "ann", { name: "Valets", splitMode: "even", closesInHours: 8 });
  const code = w.rows("crews")[0].code;
  await w.call(crews.join, "ben", { code });
  await w.call(crews.join, "cat", { code });
  await paidTip("ann-a", 900);
  const ben500 = await paidTip("ben-b", 500);
  await w.call(crews.leave, "ben");
  const catMember = w.rows("crewMembers").find((m) => m.workerId === w.rows("workers")[2]._id);
  const catTip = await paidTip("cat-c", 700);
  await w.call(crews.removeMember, "ann", { memberId: catMember._id });
  assert.equal(tipRow(catTip.tipId).crewId, undefined);
  assert.equal(allocs(catTip.tipId)[0].stripeAccountId, cat.stripeAccountId, "their tip goes back to them");
  await w.call(crews.close, "ann");
  const shareOf = (acct: string) => allocs().filter((a) => a.stripeAccountId === acct && a.crewId).reduce((s, a) => s + a.targetCents, 0);
  assert.equal(shareOf(ann.stripeAccountId) + shareOf(ben.stripeAccountId), 1400);
  assert.equal(shareOf(ben.stripeAccountId), 700, "left, but still owed");
  assert.equal(shareOf(cat.stripeAccountId), 0);
  assert.ok(ben500);
});

test("a removed member can't come back by recreating their profile", async () => {
  const { code } = await realCrew();
  const benMember = w.rows("crewMembers")[1];
  await w.call(crews.removeMember, "ann", { memberId: benMember._id });
  w.rows("payeeAccounts").forEach(() => {});
  // A fresh balance check, so the account can be deleted.
  await w.act(paymentsNode.refreshBalance, "ben");
  await w.call(workers.deleteAccount, "ben");
  await w.profile("ben", "ben-b");
  const rejoin = await w.call(crews.join, "ben", { code });
  assert.equal(rejoin.ok, false);
  assert.match(rejoin.error, /removed you/);
});

test("demo and real money can't share a crew", async () => {
  const { code } = await realCrew();
  await w.profile("dee", "dee-d");
  const demoJoin = await w.call(crews.join, "dee", { code });
  assert.equal(demoJoin.ok, false);
  assert.match(demoJoin.error, /isn't set up/);
  const demoCrew = await w.call(crews.start, "dee", { name: "Demo", splitMode: "even", closesInHours: 8 });
  const demoCode = w.rows("crews").find((c) => c._id === demoCrew).code;
  assert.equal(w.rows("crews").find((c) => c._id === demoCrew).moneyMode, "demo");
  await w.call(crews.close, "ann");
  const crossing = await w.call(crews.join, "ben", { code: demoCode });
  assert.equal(crossing.ok, false);
  assert.match(crossing.error, /demo tips/);
});

test("a pilot worker can't start a crew before payouts are set up", async () => {
  await on();
  await w.profile("t", "ann-a");
  await w.call(ops.enrollWorker, null, { handle: "ann-a" });
  await assert.rejects(w.call(crews.start, "t", { name: "X", splitMode: "even", closesInHours: 8 }), /Set up payouts/);
});

test("a tip paid after its crew closed stays with the worker who took it, and the pool doesn't change", async () => {
  const { ben } = await realCrew();
  await checkout("ben-b", 1000);
  const late = lastTip();
  assert.ok(late.crewId);
  await paidTip("ann-a", 2000);
  await w.call(crews.close, "ann");
  const before = allocs().reduce((a, r) => a + r.targetCents, 0);
  f.pay(late.stripeCheckoutSessionId);
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: late._id });
  assert.equal(tipRow(late._id).crewId, undefined);
  assert.equal(allocs(late._id)[0].stripeAccountId, ben.stripeAccountId);
  assert.equal(allocs(late._id)[0].targetCents, 1000);
  assert.equal(before, 2000);
});

test("a refund on a pooled tip after transfer is reversed from everyone who shared it", async () => {
  const { ann, ben } = await realCrew();
  const { tipId } = await paidTip("ann-a", 1000);
  await w.call(crews.close, "ann");
  w.advance(24 * HOUR);
  await settle();
  assert.equal(f.balances.get(ann.stripeAccountId).available, 500);
  assert.equal(f.balances.get(ben.stripeAccountId).available, 500);
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: tipId });
  await settle();
  assert.equal(f.balances.get(ann.stripeAccountId).available, 0);
  assert.equal(f.balances.get(ben.stripeAccountId).available, 0);
  assert.equal(books().workerLiabilityCents, 0);
});

test("a refund during an open crew shrinks the pool", async () => {
  await realCrew();
  const { tipId } = await paidTip("ann-a", 1000);
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: tipId, amountCents: 1084 });
  const current = await w.call(crews.current, "ann");
  assert.equal(current.crew.poolCents, 0);
});

test("a disputed pooled tip in one member's frozen account doesn't stop the other's money", async () => {
  const { ann, ben } = await realCrew();
  await paidTip("ann-a", 1000);
  await w.call(crews.close, "ann");
  await w.call(ops.freezeWorker, null, { handle: "ben-b", reason: "checking" });
  await w.runDueJobs();
  w.advance(24 * HOUR);
  await settle();
  assert.equal(f.balances.get(ann.stripeAccountId).available, 500);
  assert.equal(f.balances.get(ben.stripeAccountId)?.available ?? 0, 0);
  assert.equal(allocs().filter((a) => a.state === "due").length, 1);
});

// Accounts and links

test("an account can't be deleted while money is moving or owed", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  await w.act(paymentsNode.refreshBalance, "t");
  const { tipId } = await paidTip("ann-a");
  await assert.rejects(w.call(workers.deleteAccount, "t"), /haven't reached/);
  w.advance(24 * HOUR);
  await settle();
  await w.act(paymentsNode.refreshBalance, "t");
  await assert.rejects(w.call(workers.deleteAccount, "t"), /still have money/);
  f.setBalance(payee.stripeAccountId, 0, 300);
  await w.act(paymentsNode.refreshBalance, "t");
  await assert.rejects(w.call(workers.deleteAccount, "t"), /still have money/);
  f.setBalance(payee.stripeAccountId, 0, 0);
  w.advance(10 * MINUTE);
  await assert.rejects(w.call(workers.deleteAccount, "t"), /check your Stripe balance/, "a stale balance isn't good enough");
  await w.act(paymentsNode.refreshBalance, "t");
  await w.call(workers.deleteAccount, "t");

  // Everything that's money stays.
  assert.equal(w.rows("workers").length, 0);
  assert.equal(w.rows("tipPayments").length, 1);
  assert.equal(tipRow(tipId).status, "succeeded");
  assert.equal(w.rows("allocations").length, 1);
  assert.ok(w.rows("ledgerEntries").length > 0);
  assert.equal(w.rows("payeeAccounts").length, 1);
  assert.equal(w.rows("payeeAccounts")[0].workerId, undefined);
});

test("coming back after deleting finds the same Stripe account", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  await w.act(paymentsNode.refreshBalance, "t");
  await w.call(workers.deleteAccount, "t");
  await w.profile("t", "ann-a");
  await w.act(paymentsNode.startPayoutSetup, "t");
  assert.equal(w.rows("payeeAccounts").length, 1);
  assert.equal(w.rows("payeeAccounts")[0].stripeAccountId, payee.stripeAccountId);
  assert.equal(f.calls.filter((c) => c === "accounts.create").length, 1);
  assert.equal(await w.call(workers.byHandle, null, { handle: "ann-a" }).then((r: any) => r.payments), "real");
});

test("a deleted worker's link can't be taken by someone else, or start paying them", async () => {
  await w.profile("t", "ann-a");
  await w.call(workers.deleteAccount, "t");
  assert.equal(await w.call(workers.byHandle, null, { handle: "ann-a" }), null);
  await w.profile("other", "other-o");
  await assert.rejects(w.call(workers.saveProfile, "other", { name: "x", handle: "ann-a", jobTitle: "", workplace: "" }), /taken/);
  await assert.rejects(w.call(tips.tipFromGuest, null, { handle: "ann-a", amountCents: 500, coverFees: true }), /couldn't find/);
  await w.profile("t", "ann-a");
  assert.ok(await w.call(workers.byHandle, null, { handle: "ann-a" }));
});

test("a renamed link keeps paying the same person, and nobody else can take it", async () => {
  await w.profile("t", "old-name");
  await w.call(workers.saveProfile, "t", { name: "Ann", handle: "new-name", jobTitle: "", workplace: "" });
  const viaOld = await w.call(workers.byHandle, null, { handle: "old-name" });
  assert.equal(viaOld.handle, "new-name");
  await w.call(tips.tipFromGuest, null, { handle: "old-name", amountCents: 500, coverFees: true });
  assert.equal(w.rows("tips")[0].workerId, w.rows("workers")[0]._id);
  await w.profile("other", "other-o");
  await assert.rejects(w.call(workers.saveProfile, "other", { name: "x", handle: "old-name", jobTitle: "", workplace: "" }), /taken/);
  // Taking your own old link back is fine.
  await w.call(workers.saveProfile, "t", { name: "Ann", handle: "old-name", jobTitle: "", workplace: "" });
});

test("the backfill claims links from before claims existed", async () => {
  const { migrations } = await import("./harness.ts");
  await w.db.insert("workers", { tokenIdentifier: "old", name: "Old", handle: "old-one", jobTitle: "", workplace: "" });
  await w.call(migrations.backfillHandleClaims, null, {});
  await w.profile("other", "other-o");
  assert.equal(w.rows("handleClaims").find((c) => c.handle === "old-one").tokenIdentifier, "old");
});

// Demo stays demo

test("a pilot worker can't get demo tips or cash out a demo balance", async () => {
  await on();
  await w.profile("t", "ann-a");
  await w.call(tips.tipFromGuest, null, { handle: "ann-a", amountCents: 1000, coverFees: true });
  await w.call(ops.enrollWorker, null, { handle: "ann-a" });
  await assert.rejects(w.call(tips.tipFromGuest, null, { handle: "ann-a", amountCents: 1000, coverFees: true }), /demo tips are turned off/);
  await assert.rejects(w.call(tips.recordTap, "t", { amountCents: 1000, coverFees: true }), /demo tips are turned off/);
  await assert.rejects(w.call(earnings.cashOutInstant, "t"), /can't be cashed out/);
});

test("real money never appears in the demo balance, and demo never appears in the real figures", async () => {
  await on();
  await w.profile("t", "ann-a");
  await w.call(tips.tipFromGuest, null, { handle: "ann-a", amountCents: 1000, coverFees: true });
  const demoBefore = (await w.call(earnings.summary, "t")).balanceCents;
  assert.equal(demoBefore, 1000);
  await w.call(ops.enrollWorker, null, { handle: "ann-a" });
  await w.act(paymentsNode.startPayoutSetup, "t");
  f.activate(w.rows("payeeAccounts")[0].stripeAccountId);
  await w.act(paymentsNode.refreshPayoutStatus, "t");
  await paidTip("ann-a", 2000);
  await w.call(crews.start, "t", { name: "X", splitMode: "even", closesInHours: 8 });
  await paidTip("ann-a", 3000);
  await w.call(crews.close, "t");
  assert.equal((await w.call(earnings.summary, "t")).balanceCents, demoBefore, "demo balance didn't move");
  const real = await w.call(earnings.real, "t", {});
  assert.equal(real.onHoldCents, 5000);
  assert.equal(real.testMode, true);
  const today = await w.call(tips.today, "t", {});
  assert.equal(today.totalCents, 5000);
  assert.ok(today.recent.every((t: any) => !t.demo && t.test));
  assert.equal(w.rows("tips").length, 1, "the old demo record is kept, apart");
});

test("a worker's real figures come from Stripe, not arithmetic", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  assert.equal((await w.call(earnings.real, "t", {})).availableCents, null);
  f.setBalance(payee.stripeAccountId, 777, 111);
  await w.act(paymentsNode.refreshBalance, "t");
  const real = await w.call(earnings.real, "t", {});
  assert.equal(real.availableCents, 777);
  assert.equal(real.stripePendingCents, 111);
  assert.equal(real.onHoldCents, 0);
});

test("payouts mirror Stripe, and a failed one raises an alarm", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  f.payouts.set("po_1", { id: "po_1", amount: 500, status: "in_transit", arrival_date: 1_800_000_000, failure_message: null, livemode: false });
  const run = async () => w.act(paymentsNode.processEvent, null, { eventId: await record({ kind: "payout", stripeAccountId: payee.stripeAccountId, payoutId: "po_1" }, { source: "connect" }) });
  await run();
  assert.equal((await w.call(earnings.real, "t", {})).payouts[0].status, "in_transit");
  f.payouts.set("po_1", { id: "po_1", amount: 500, status: "failed", arrival_date: 1_800_000_000, failure_message: "Bad account", livemode: false });
  await run();
  assert.equal(w.rows("payouts").length, 1);
  assert.equal((await w.call(earnings.real, "t", {})).payouts[0].failureMessage, "Bad account");
  assert.ok(w.rows("opsAlerts").some((a) => a.kind === "payout_failed"));
});

// Books and operations

test("new workers get weekly payouts, because daily ones cost more than a tip earns", async () => {
  await on();
  const payee = await pilot("t", "ann-a");
  assert.deepEqual(f.payoutSchedules[payee.stripeAccountId], { interval: "weekly", weekly_payout_days: ["monday"] });
});

test("the books separate worker money from platform money, and safe-to-withdraw excludes workers", async () => {
  await on();
  await pilot("t", "ann-a");
  await paidTip("ann-a", 1000);
  await w.act(paymentsNode.reconcileBooks);
  const b = await w.call(ops.books);
  assert.equal(b.workerLiabilityCents, 1000);
  assert.equal(b.feesCollectedCents, 84);
  const stripeFee = Math.round(1084 * 0.029) + 30;
  assert.equal(b.platformRevenueCents, 84 - stripeFee);
  assert.equal(b.lastReconciliation.availableCents, 1084 - stripeFee);
  assert.equal(b.safeToWithdrawCents, 84 - stripeFee, "the worker's 1000 isn't ours to take");
  assert.deepEqual(b.lastReconciliation.problems, []);
  assert.equal(b.lastReconciliation.differenceCents, 0);
});

test("the owner taking money out or adding it keeps the books matching Stripe", async () => {
  await on();
  await pilot("t", "ann-a");
  await paidTip("ann-a", 1000);
  f.extra.balance = -40;
  f.payouts.set("po_owner", { id: "po_owner", amount: 40, status: "paid", livemode: false });
  await w.act(paymentsNode.processEvent, null, { eventId: await record({ kind: "platform_payout", payoutId: "po_owner" }) });
  await w.act(paymentsNode.processEvent, null, { eventId: await record({ kind: "platform_payout", payoutId: "po_owner" }) });
  await w.act(paymentsNode.reconcileBooks);
  const b = await w.call(ops.books);
  assert.equal(b.ownerWithdrawalsCents, 40);
  assert.equal(b.lastReconciliation.differenceCents, 0);
  assert.equal(b.workerLiabilityCents, 1000, "taking money out doesn't change what workers are owed");
  f.payouts.set("po_owner", { id: "po_owner", amount: 40, status: "failed", livemode: false });
  await w.act(paymentsNode.processEvent, null, { eventId: await record({ kind: "platform_payout", payoutId: "po_owner" }) });
  assert.equal((await w.call(ops.books)).ownerWithdrawalsCents, 0);
});

test("a difference from Stripe is a warning, not an alarm", async () => {
  await on();
  await pilot("t", "ann-a");
  await paidTip("ann-a", 1000);
  f.extra.balance = -200; // A monthly Connect fee, say.
  await w.act(paymentsNode.reconcileBooks);
  const alert = w.rows("opsAlerts").find((a) => a.kind === "books_difference");
  assert.equal(alert.severity, "warning");
});

test("workers being owed more than Stripe holds is an alarm", async () => {
  await on();
  await pilot("t", "ann-a");
  await paidTip("ann-a", 1000);
  f.extra.balance = -1000;
  await w.act(paymentsNode.reconcileBooks);
  assert.ok(w.rows("opsAlerts").some((a) => a.kind === "books_mismatch" && a.severity === "critical"));
});

test("a charge on Stripe with no record here raises an alarm", async () => {
  await on();
  await pilot("t", "ann-a");
  await checkout("ann-a");
  const tip = lastTip();
  f.pay(tip.stripeCheckoutSessionId); // Paid, but our sync never ran.
  await w.act(paymentsNode.reconcileBooks);
  assert.ok(w.rows("opsAlerts").some((a) => a.kind === "books_mismatch" && a.message.includes("no record")));
});

test("hourly reconciliation picks up what a webhook missed", async () => {
  await on();
  await pilot("t", "ann-a");
  await checkout("ann-a");
  const tip = lastTip();
  f.pay(tip.stripeCheckoutSessionId);
  w.advance(11 * MINUTE);
  await w.act(paymentsNode.reconcile);
  assert.equal(lastTip().status, "succeeded");
  assert.equal(allocs().length, 1);
});

test("clearing a review re-checks with Stripe, so a real mismatch comes straight back", async () => {
  await on();
  await pilot("t", "ann-a");
  await checkout("ann-a");
  const tip = lastTip();
  f.pay(tip.stripeCheckoutSessionId, { amount: 1 });
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: tip._id });
  assert.equal((await w.call(ops.status)).alerts[0].kind, "payment_mismatch");
  await w.call(ops.clearReview, null, { tipPaymentId: tip._id });
  assert.equal(lastTip().reviewReason, undefined);
  await w.runDueJobs();
  assert.ok(lastTip().reviewReason);
  assert.equal(allocs().length, 0);
});

test("enrolling is refused while the worker is in an open demo crew", async () => {
  await on();
  await w.profile("t", "ann-a");
  await w.call(crews.start, "t", { name: "X", splitMode: "even", closesInHours: 8 });
  await assert.rejects(w.call(ops.enrollWorker, null, { handle: "ann-a" }), /open crew/);
});

test("the switches start off", async () => {
  await w.call(ops.setControls, null, { note: "first run" });
  const c = (await w.call(ops.status)).controls;
  assert.deepEqual([c.chargesEnabled, c.transfersEnabled, c.perTipLimitCents, c.workerDailyLimitCents, c.globalDailyLimitCents, c.transferHoldHours], [false, false, 10_000, 50_000, 250_000, 24]);
  await assert.rejects(w.call(ops.setControls, null, { perTipLimitCents: 1.5 }), /whole number/);
});

test("an unconfigured deployment stays demo", async () => {
  const saved = process.env.STRIPE_MODE;
  delete process.env.STRIPE_MODE;
  await w.profile("t", "ann-a");
  assert.equal((await w.call(workers.byHandle, null, { handle: "ann-a" })).payments, "demo");
  await assert.rejects(w.act(paymentsNode.startPayoutSetup, "t"), /aren't open/);
  // Enrolled with no Stripe config: never silently demo.
  await w.call(ops.enrollWorker, null, { handle: "ann-a" });
  assert.equal((await w.call(workers.byHandle, null, { handle: "ann-a" })).payments, "unavailable");
  process.env.STRIPE_MODE = saved;
});


test("Stripe-owned review requirements never send workers back through setup", () => {
  const result = accountStatus({ configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: "pending" } } } } }, requirements: { entries: [{ minimum_deadline: { status: "currently_due" }, awaiting_action_from: "stripe" }] } });
  assert.equal(result.requirementsDue, 0);
});

test("rejected v1 accounts and unresolvable v2 capabilities are terminal", () => {
  assert.equal(accountStatusV1({ capabilities: { transfers: "inactive" }, requirements: { disabled_reason: "rejected.fraud" } }).transfersStatus, "rejected");
  assert.equal(accountStatus({ configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: "restricted", status_details: [{ resolution: "no_resolution" }] } } } } } }).transfersStatus, "rejected");
});

test("first account rejection shows a rejected stage and alerts the operator", async () => {
  await on();
  await w.profile("rejected-worker", "rejected-worker");
  await w.call(ops.enrollWorker, null, { handle: "rejected-worker" });
  await w.act(paymentsNode.startPayoutSetup, "rejected-worker");
  const payee = w.rows("payeeAccounts")[0];
  await w.call(payments.applyAccountStatus, null, { stripeAccountId: payee.stripeAccountId, transfersStatus: "rejected", payoutsStatus: "restricted", requirementsDue: 0 });
  assert.equal((await w.call(payments.status, "rejected-worker")).stage, "rejected");
  assert.ok(w.rows("opsAlerts").some(a => a.kind === "account_restricted"));
  await assert.rejects(checkout("rejected-worker"), /can't take tips/);
});


test("live charges cannot be enabled without a monitored support contact", async () => {
  const oldMode = process.env.STRIPE_MODE;
  const oldEmail = process.env.SUPPORT_EMAIL;
  try {
    process.env.STRIPE_MODE = "live";
    delete process.env.SUPPORT_EMAIL;
    await assert.rejects(on(), /SUPPORT_EMAIL/);
    assert.equal(supportEmail("bad\r\nBcc: other@example.com"), null);
    process.env.SUPPORT_EMAIL = "help@example.com";
    await on();
    assert.equal((await w.call(payments.supportInfo, null)).email, "help@example.com");
  } finally {
    process.env.STRIPE_MODE = oldMode;
    if (oldEmail === undefined) delete process.env.SUPPORT_EMAIL; else process.env.SUPPORT_EMAIL = oldEmail;
  }
});

test("receipt reference is a full id that operators can look up", async () => {
  await on();
  await pilot("reference-worker", "reference-worker");
  await paidTip("reference-worker");
  const tip = lastTip();
  const receipt = await w.call(payments.guestReceipt, null, { sessionId: tip.stripeCheckoutSessionId });
  assert.equal(receipt.ticket, tip._id);
  assert.equal((await w.call(ops.findPayment, null, { reference: receipt.ticket }))._id, tip._id);
});
