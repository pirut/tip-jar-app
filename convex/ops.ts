// Operator controls. All internal, so only someone with deploy access can run them:
//   npx convex run ops:status
// docs/pilot-runbook.md says when to use each.
import { configuredMode, supportEmail } from "./lib/stripeEnv";
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { currentObligations, raiseAlert, requestPayoutSchedule, resolveAlertByKey, withdrawalPosition } from "./lib/paymentsDb";
import { activeMembership, resolveWorkerByHandle } from "./helpers";
import { enrollmentFor, freezePayee, getControls, payeeFor, rebalanceTip, allocateSolo } from "./lib/paymentsDb";
import { failedRefundCents, guestHoldCents, ledgerTotals, obligationTotal, type LedgerRow } from "./lib/paymentRules";

const DEFAULTS = {
  chargesEnabled: false,
  transfersEnabled: false,
  perTipLimitCents: 10_000,
  workerDailyLimitCents: 50_000,
  globalDailyLimitCents: 250_000,
  transferHoldHours: 24,
  reserveCents: 0,
};

// The kill switches and limits. Omitted fields stay as they are; the first run starts with everything off.
export const setControls = internalMutation({
  args: {
    chargesEnabled: v.optional(v.boolean()),
    transfersEnabled: v.optional(v.boolean()),
    perTipLimitCents: v.optional(v.number()),
    workerDailyLimitCents: v.optional(v.number()),
    globalDailyLimitCents: v.optional(v.number()),
    transferHoldHours: v.optional(v.number()),
    reserveCents: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "number" && !(Number.isInteger(value) && value >= 0)) throw new ConvexError(`${key} must be a whole number, zero or more.`);
    }
    if (args.chargesEnabled && configuredMode() === "live" && !supportEmail()) throw new ConvexError("Configure a valid SUPPORT_EMAIL before enabling live payments.");
    const existing = await getControls(ctx);
    const fields = { ...args, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("paymentControls", { key: "global", ...DEFAULTS, ...fields });
    return await getControls(ctx);
  },
});

export const enrollWorker = internalMutation({
  args: { handle: v.string(), perTipLimitCents: v.optional(v.number()), dailyLimitCents: v.optional(v.number()), note: v.optional(v.string()) },
  handler: async (ctx, { handle, ...rest }) => {
    const worker = await resolveWorkerByHandle(ctx, handle);
    if (!worker) throw new ConvexError("No worker with that handle.");
    // Their open crew is a demo pool, and real tips can't go into one.
    if (await activeMembership(ctx, worker._id)) throw new ConvexError(`${worker.handle} is in an open crew. It has to close first.`);
    const existing = await enrollmentFor(ctx, worker.tokenIdentifier);
    const fields = { ...rest, status: "active" as const, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("pilotEnrollments", { tokenIdentifier: worker.tokenIdentifier, ...fields });
    return { workerId: worker._id, handle: worker.handle };
  },
});

// Stops new tips for this worker. Money already allocated to them still moves unless they're frozen too.
export const suspendWorker = internalMutation({
  args: { handle: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, { handle, note }) => {
    const worker = await resolveWorkerByHandle(ctx, handle);
    if (!worker) throw new ConvexError("No worker with that handle.");
    const existing = await enrollmentFor(ctx, worker.tokenIdentifier);
    if (!existing) throw new ConvexError("That worker isn't enrolled.");
    await ctx.db.patch(existing._id, { status: "suspended", note, updatedAt: Date.now() });
  },
});

// Stops transfers to this worker at once and tells Stripe to stop their payouts. Payouts count as paused
// only when Stripe confirms; ops:status shows any that haven't been, and it retries until they are.
export const freezeWorker = internalMutation({
  args: { handle: v.string(), reason: v.string() },
  handler: async (ctx, { handle, reason }) => {
    const worker = await resolveWorkerByHandle(ctx, handle);
    if (!worker) throw new ConvexError("No worker with that handle.");
    const payee = await payeeFor(ctx, worker.tokenIdentifier);
    if (!payee) throw new ConvexError("That worker has no Stripe account.");
    await freezePayee(ctx, payee, reason);
  },
});

export const unfreezeWorker = internalMutation({
  args: { handle: v.string() },
  handler: async (ctx, { handle }) => {
    const worker = await resolveWorkerByHandle(ctx, handle);
    if (!worker) throw new ConvexError("No worker with that handle.");
    const payee = await payeeFor(ctx, worker.tokenIdentifier);
    if (!payee) throw new ConvexError("That worker has no Stripe account.");
    await ctx.db.patch(payee._id, { frozenReason: undefined });
    await requestPayoutSchedule(ctx, payee, "weekly");
  },
});

// After a person has checked a payment whose details didn't match. Allocates it if it's real money.
export const clearReview = internalMutation({
  args: { tipPaymentId: v.id("tipPayments") },
  handler: async (ctx, { tipPaymentId }) => {
    const tip = await ctx.db.get(tipPaymentId);
    if (!tip) throw new ConvexError("No such payment.");
    await ctx.db.patch(tip._id, { reviewReason: undefined, crewId: undefined });
    if (tip.status === "succeeded") {
      await allocateSolo(ctx, { ...tip, reviewReason: undefined, crewId: undefined });
      await rebalanceTip(ctx, tip._id);
    }
    await ctx.scheduler.runAfter(0, internal.paymentsNode.syncPaymentById, { tipPaymentId });
  },
});

// A refund failed and a person has dealt with it, usually by paying the guest back another way. Lets
// the tip's money go to the worker if it's still theirs. A reissued refund lowers that by itself.
export const resolveFailedRefund = internalMutation({
  args: { tipPaymentId: v.id("tipPayments"), note: v.string() },
  handler: async (ctx, { tipPaymentId, note }) => {
    const tip = await ctx.db.get(tipPaymentId);
    if (!tip) throw new ConvexError("No such payment.");
    const failed = failedRefundCents(tip.refunds);
    if (failed === 0) throw new ConvexError("That payment has no failed refund.");
    const hold = guestHoldCents({ refunds: tip.refunds, failedRefundAckCents: failed, inquiryCents: tip.inquiryCents });
    await ctx.db.patch(tip._id, { failedRefundAckCents: failed, guestHoldCents: hold, hasGuestHold: hold > 0 });
    await resolveAlertByKey(ctx, `refund_failed:${tip._id}:${failed}`);
    console.log(`Failed refund on ${tip._id} resolved: ${note}`);
  },
});

// A person has looked at a Stripe transaction reconciliation couldn't explain. It stays booked as
// `unclassified`; this just stops it blocking withdrawals.
export const acknowledgeTxn = internalMutation({
  args: { txnId: v.string(), note: v.string() },
  handler: async (ctx, { txnId, note }) => {
    const row = await ctx.db.query("balanceTxns").withIndex("by_txn", (q) => q.eq("txnId", txnId)).unique();
    if (!row) throw new ConvexError("No such transaction.");
    await ctx.db.patch(row._id, { state: "acknowledged", note });
    await resolveAlertByKey(ctx, `txn_unexplained:${txnId}`);
  },
});

export const resolveAlert = internalMutation({
  args: { alertId: v.id("opsAlerts") },
  handler: async (ctx, { alertId }) => {
    await ctx.db.patch(alertId, { resolvedAt: Date.now() });
  },
});

// Are the switches on, and is anything wrong?
export const status = internalQuery({
  args: {},
  handler: async (ctx) => {
    const alerts = await ctx.db.query("opsAlerts").withIndex("by_resolved", (q) => q.eq("resolvedAt", undefined)).collect();
    const due = await ctx.db.query("allocations").withIndex("by_state_eligible", (q) => q.eq("state", "due")).take(500);
    const inFlight = await ctx.db.query("allocations").withIndex("by_state_eligible", (q) => q.eq("state", "in_flight")).take(100);
    const review = (await ctx.db.query("tipPayments").withIndex("by_status", (q) => q.eq("status", "succeeded")).order("desc").take(1000)).filter((t) => t.reviewReason);
    const failedEvents = await ctx.db.query("stripeEvents").withIndex("by_status_next", (q) => q.eq("status", "failed")).take(50);
    const unexplained = await ctx.db.query("balanceTxns").withIndex("by_state", (q) => q.eq("state", "open")).take(50);
    const payees = await ctx.db.query("payeeAccounts").take(500);
    const now = Date.now();
    return {
      controls: await getControls(ctx),
      alerts: alerts.map((a) => ({ id: a._id, severity: a.severity, kind: a.kind, message: a.message, at: new Date(a.at).toISOString() })),
      allocations: {
        due: due.length,
        pastHold: due.filter((a) => a.eligibleAt <= now).length,
        blocked: due.filter((a) => a.lastError).map((a) => ({ id: a._id, error: a.lastError })).slice(0, 20),
        inFlight: inFlight.length,
      },
      paymentsInReview: review.map((t) => ({ id: t._id, reason: t.reviewReason })),
      failedEvents: failedEvents.map((e) => ({ id: e.eventId, type: e.type, error: e.lastError })),
      unexplainedTransactions: unexplained.map((t) => ({ id: t.txnId, type: t.type, netCents: t.netCents, problem: t.problem })),
      // Frozen, but Stripe hasn't confirmed manual payouts yet. Their bank payouts may still be running.
      payoutPauseUnconfirmed: payees
        .filter((p) => p.payoutScheduleDesired === "manual" && !p.payoutsPaused)
        .map((p) => ({ account: p.stripeAccountId, attempts: p.payoutScheduleAttempts, error: p.payoutScheduleError })),
    };
  },
});

// Reads the whole ledger. Fine at pilot volume; move to running totals well before Convex's
// per-query document limit.
export const ledgerRows = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("ledgerEntries").collect();
    const controls = await getControls(ctx);
    return {
      rows: rows.map((r) => ({ debit: r.debit, credit: r.credit, amountCents: r.amountCents })) as LedgerRow[],
      reserveCents: controls?.reserveCents ?? 0,
    };
  },
});

// The owner's view: what's ours, what's workers', and what's safe to take out.
export const books = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = (await ctx.db.query("ledgerEntries").collect()) as unknown as LedgerRow[];
    const totals = ledgerTotals(rows);
    const last = await ctx.db.query("reconciliations").withIndex("by_at").order("desc").first();
    const controls = await getControls(ctx);
    const position = await withdrawalPosition(ctx, last, rows, controls?.reserveCents ?? 0);
    return {
      ...totals,
      lastReconciliation: last,
      obligations: position.obligations,
      obligationsCents: position.obligationsCents,
      withdrawalBlockers: position.blockers,
      // Obligations are read now, but the balance is from the last reconciliation. Zero whenever anything
      // above blocks it. Later refunds, disputes and tips can still change it, so keep a reserve.
      safeToWithdrawCents: position.safeToWithdrawCents,
      note: last ? `Stripe's balance as of ${new Date(last.at).toISOString()}. Run paymentsNode:reconcileBooks for a fresh figure.` : "Run paymentsNode:reconcileBooks to get a Stripe balance.",
    };
  },
});

export const saveReconciliation = internalMutation({
  args: {
    livemode: v.boolean(),
    availableCents: v.number(),
    pendingCents: v.number(),
    connectReservedCents: v.number(),
    expectedStripeBalanceCents: v.number(),
    openingBalanceCents: v.number(),
    workerLiabilityCents: v.number(),
    platformRevenueCents: v.number(),
    differenceCents: v.number(),
    platformPayoutInterval: v.optional(v.string()),
    scanComplete: v.boolean(),
    problems: v.array(v.string()),
  },
  handler: async (ctx, { scanComplete, ...args }) => {
    const rows = (await ctx.db.query("ledgerEntries").collect()) as unknown as LedgerRow[];
    const controls = await getControls(ctx);
    const reserveCents = controls?.reserveCents ?? 0;
    const { obligations } = await currentObligations(ctx, args.connectReservedCents, rows, reserveCents);
    const problems = [...args.problems];
    // Checked gross, so one worker's debt can't hide another worker's money.
    const owedOut = obligationTotal({ ...obligations, reserveCents: 0 });
    if (args.availableCents + args.pendingCents < owedOut) {
      problems.push(`Stripe holds ${args.availableCents + args.pendingCents}, but ${owedOut} belongs to workers, guests or payments under review.`);
    }
    // Reconciliation's own list, so a person reading the row sees what's wrong without digging.
    const unexplained = await ctx.db.query("balanceTxns").withIndex("by_state", (q) => q.eq("state", "open")).take(5);
    for (const row of unexplained) problems.push(row.problem ?? `Stripe transaction ${row.txnId} isn't explained.`);
    if (args.platformPayoutInterval !== "manual") {
      problems.push(`The platform's own payouts are ${args.platformPayoutInterval ?? "unverified"}, not manual. Stripe could sweep worker money to the bank.`);
    }
    const id = await ctx.db.insert("reconciliations", { ...args, problems, obligationsCents: obligationTotal(obligations), safeToWithdrawCents: 0, at: Date.now() });
    const position = await withdrawalPosition(ctx, (await ctx.db.get(id))!, rows, reserveCents);
    await ctx.db.patch(id, { safeToWithdrawCents: position.safeToWithdrawCents });
    const ref = new Date().toISOString().slice(0, 10);
    if (problems.length > 0) {
      await raiseAlert(ctx, { kind: "books_mismatch", severity: "critical", message: problems.join(" "), ref });
    }
    if (args.differenceCents !== 0) {
      // A difference while a transfer is mid-flight can just be timing. Otherwise every known movement has
      // been booked, so it's money we can't account for.
      const inFlight = await ctx.db.query("allocations").withIndex("by_state_eligible", (q) => q.eq("state", "in_flight")).take(1);
      await raiseAlert(ctx, { kind: "books_difference", severity: inFlight.length > 0 || !scanComplete ? "warning" : "critical", message: `Stripe's balance differs from the books by ${args.differenceCents} cents, after every known movement.`, ref });
    }
    return { problems, safeToWithdrawCents: position.safeToWithdrawCents, blockers: position.blockers };
  },
});

// Receipts retain the full, case-sensitive payment id. Never guess a truncated reference.
export const findPayment = internalQuery({
  args: { reference: v.string() },
  handler: async (ctx, { reference }) => {
    const id = ctx.db.normalizeId("tipPayments", reference.trim());
    return id ? await ctx.db.get(id) : null;
  },
});
