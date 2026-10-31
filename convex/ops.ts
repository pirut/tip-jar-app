// Operator controls. All internal, so only someone with deploy access can run them:
//   npx convex run ops:status
// docs/pilot-runbook.md says when to use each.
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { raiseAlert } from "./lib/paymentsDb";
import { activeMembership, resolveWorkerByHandle } from "./helpers";
import { enrollmentFor, getControls, payeeFor, rebalanceTip, allocateSolo } from "./lib/paymentsDb";
import { ledgerTotals, safeToWithdraw, type LedgerRow } from "./lib/paymentRules";

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

// Stops transfers to this worker and tells Stripe to stop their payouts.
export const freezeWorker = internalMutation({
  args: { handle: v.string(), reason: v.string() },
  handler: async (ctx, { handle, reason }) => {
    const worker = await resolveWorkerByHandle(ctx, handle);
    if (!worker) throw new ConvexError("No worker with that handle.");
    const payee = await payeeFor(ctx, worker.tokenIdentifier);
    if (!payee) throw new ConvexError("That worker has no Stripe account.");
    await ctx.db.patch(payee._id, { frozenReason: reason, payoutsPaused: true });
    await ctx.scheduler.runAfter(0, internal.paymentsNode.setPayoutsPaused, { payeeAccountId: payee._id, paused: true });
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
    await ctx.scheduler.runAfter(0, internal.paymentsNode.setPayoutsPaused, { payeeAccountId: payee._id, paused: false });
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
    return {
      ...totals,
      lastReconciliation: last,
      safeToWithdrawCents: last
        ? safeToWithdraw({ availableCents: last.availableCents, workerLiabilityCents: totals.workerLiabilityCents, reserveCents: controls?.reserveCents ?? 0 })
        : null,
      note: last ? "Based on the last reconciliation's Stripe balance. Run paymentsNode:reconcileBooks for a fresh figure." : "Run paymentsNode:reconcileBooks to get a Stripe balance.",
    };
  },
});

export const saveReconciliation = internalMutation({
  args: {
    livemode: v.boolean(),
    availableCents: v.number(),
    pendingCents: v.number(),
    expectedStripeBalanceCents: v.number(),
    workerLiabilityCents: v.number(),
    platformRevenueCents: v.number(),
    safeToWithdrawCents: v.number(),
    differenceCents: v.number(),
    problems: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("reconciliations", { ...args, at: Date.now() });
    const ref = new Date().toISOString().slice(0, 10);
    if (args.problems.length > 0) {
      await raiseAlert(ctx, { kind: "books_mismatch", severity: "critical", message: args.problems.join(" "), ref });
    }
    if (args.differenceCents !== 0) {
      await raiseAlert(ctx, { kind: "books_difference", severity: "warning", message: `Stripe's balance differs from the books by ${args.differenceCents} cents. Check for Connect fees or manual activity.`, ref });
    }
  },
});
