// Real money: what clients may read, and the internal steps Stripe actions run in transactions.
// No public mutation lives here. Client requests go through paymentsNode, and money facts only
// enter through applyPaymentSnapshot after being read back from Stripe.
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { activeMembership, currentWorker, resolveWorkerByHandle } from "./helpers";
import { MAX_TIP_CENTS, MIN_TIP_CENTS } from "./lib/money";
import { allocateSolo, currentObligations, enrollmentFor, freezePayee, getControls, payeeFor, post, raiseAlert, rebalanceTip, resolveAlertByKey, workerStage } from "./lib/paymentsDb";
import {
  activeRefundCents,
  CHARGE_WINDOW_MS,
  disputeFeeCents,
  disputeOpen,
  disputedCents,
  failedRefundCents,
  guestHoldCents,
  inquiryCents,
  limitProblem,
  nextPaymentStatus,
  obligationTotal,
  snapshotProblems,
  tipAmounts,
  type LedgerRow,
  type PaymentSnapshot,
} from "./lib/paymentRules";
import { configuredMode, isLive, supportEmail } from "./lib/stripeEnv";

export const supportInfo = query({
  args: {},
  handler: async () => ({ email: supportEmail() }),
});

const PAYMENTS_PER_MINUTE = 10;
const MIN = 60 * 1000;

// Where the signed-in worker stands, for every money screen on web and mobile.
export const status = query({
  args: {},
  handler: async (ctx) => {
    const worker = await currentWorker(ctx);
    if (!worker) return null;
    const { stage, payee, enrollment } = await workerStage(ctx, worker.tokenIdentifier);
    const mode = configuredMode();
    const controls = await getControls(ctx);
    return {
      stage,
      testMode: mode === "test",
      hasAccount: payee !== null,
      requirementsDue: payee?.requirementsDue ?? 0,
      payoutsStatus: payee?.payoutsStatus ?? null,
      limits: enrollment && controls ? {
        perTipCents: Math.min(controls.perTipLimitCents, enrollment.perTipLimitCents ?? Infinity),
        dailyCents: Math.min(controls.workerDailyLimitCents, enrollment.dailyLimitCents ?? Infinity),
      } : null,
    };
  },
});

// What a guest sees after paying. The session id came to them from Stripe's redirect and can't be guessed.
export const guestReceipt = query({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    const tip = await ctx.db.query("tipPayments").withIndex("by_session", (q) => q.eq("stripeCheckoutSessionId", sessionId)).unique();
    if (!tip) return null;
    return {
      status: tip.status,
      tipCents: tip.tipCents,
      feesCents: tip.feesCents,
      chargedCents: tip.chargedCents,
      coveredFees: tip.coveredFees,
      refundedCents: tip.refundedCents,
      testMode: !tip.livemode,
      ticket: tip._id,
    };
  },
});

export const getTip = internalQuery({
  args: { tipPaymentId: v.string() },
  handler: async (ctx, { tipPaymentId }) => {
    const id = ctx.db.normalizeId("tipPayments", tipPaymentId);
    return id ? await ctx.db.get(id) : null;
  },
});

export const tipByIntent = internalQuery({
  args: { paymentIntentId: v.string() },
  handler: async (ctx, { paymentIntentId }) =>
    await ctx.db.query("tipPayments").withIndex("by_intent", (q) => q.eq("stripePaymentIntentId", paymentIntentId)).first(),
});

export const tipByCharge = internalQuery({
  args: { chargeId: v.string() },
  handler: async (ctx, { chargeId }) =>
    await ctx.db.query("tipPayments").withIndex("by_charge", (q) => q.eq("stripeChargeId", chargeId)).first(),
});

export const tipBySession = internalQuery({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) =>
    await ctx.db.query("tipPayments").withIndex("by_session", (q) => q.eq("stripeCheckoutSessionId", sessionId)).first(),
});

// Who a guest's handle pays, for the checkout action.
export const guestTarget = internalQuery({
  args: { handle: v.string() },
  handler: async (ctx, { handle }) => {
    const worker = await resolveWorkerByHandle(ctx, handle);
    if (!worker) return null;
    return { workerId: worker._id, handle: worker.handle, firstName: worker.name.split(" ")[0] };
  },
});

// The signed-in worker, as an action sees them.
export const workerContext = internalQuery({
  args: { tokenIdentifier: v.string() },
  handler: async (ctx, { tokenIdentifier }) => {
    const worker = await ctx.db.query("workers").withIndex("by_token", (q) => q.eq("tokenIdentifier", tokenIdentifier)).unique();
    if (!worker) return null;
    const { stage, payee } = await workerStage(ctx, tokenIdentifier);
    return { worker, stage, payee };
  },
});

export const payeeById = internalQuery({
  args: { payeeAccountId: v.id("payeeAccounts") },
  handler: async (ctx, { payeeAccountId }) => await ctx.db.get(payeeAccountId),
});

export const payeeByStripeId = internalQuery({
  args: { stripeAccountId: v.string() },
  handler: async (ctx, { stripeAccountId }) =>
    await ctx.db.query("payeeAccounts").withIndex("by_stripe_account", (q) => q.eq("stripeAccountId", stripeAccountId)).unique(),
});

// Every check before a charge, in one transaction. A throw here means Stripe is never called.
// The amounts come from the server's own calculation, never the client.
export const reservePayment = internalMutation({
  args: {
    workerId: v.id("workers"),
    tipCents: v.number(),
    coverFees: v.boolean(),
    clientRequestId: v.string(),
  },
  handler: async (ctx, { workerId, tipCents, coverFees, clientRequestId }) => {
    const worker = await ctx.db.get(workerId);
    if (!worker) throw new ConvexError("We couldn't find that person.");
    if (!Number.isInteger(tipCents) || tipCents < MIN_TIP_CENTS || tipCents > MAX_TIP_CENTS) {
      throw new ConvexError("Tips can be $1 to $500.");
    }
    if (clientRequestId.length < 8 || clientRequestId.length > 64) throw new ConvexError("Please try again.");

    // A repeat of the same press gets the same payment, so nobody is charged twice.
    const repeat = await ctx.db
      .query("tipPayments")
      .withIndex("by_worker_request", (q) => q.eq("workerId", workerId).eq("clientRequestId", clientRequestId))
      .unique();
    if (repeat) return { tipPaymentId: repeat._id, repeat: true as const, status: repeat.status, checkoutUrl: repeat.checkoutUrl, paymentIntentId: repeat.stripePaymentIntentId, stripeAccountId: "", needsAccountCheck: false, tipCents: repeat.tipCents, feesCents: repeat.feesCents, chargedCents: repeat.chargedCents };

    const { stage, payee, enrollment } = await workerStage(ctx, worker.tokenIdentifier);
    if (stage !== "ready" || !payee || !enrollment) throw new ConvexError(`${worker.name.split(" ")[0]} can't take tips through Tip Jar right now.`);
    const controls = await getControls(ctx);
    if (!controls?.chargesEnabled) throw new ConvexError("Tips are paused for now. Try again later.");

    const now = Date.now();
    const mine = await ctx.db.query("tipPayments").withIndex("by_worker", (q) => q.eq("workerId", workerId)).order("desc").take(500);
    if (mine.filter((p) => p._creationTime > now - MIN).length >= PAYMENTS_PER_MINUTE) {
      throw new ConvexError("Lots of tips just came in. Try again in a minute.");
    }
    const counts = (p: Doc<"tipPayments">) => p._creationTime > now - CHARGE_WINDOW_MS && !["failed", "expired", "canceled"].includes(p.status);
    const everyone = await ctx.db.query("tipPayments").order("desc").take(2000);
    const amounts = tipAmounts(tipCents, coverFees);
    if (amounts.netCents <= 0) throw new ConvexError("That tip is too small to cover its fees.");
    const problem = limitProblem({
      tipCents,
      chargedCents: amounts.chargedCents,
      perTipLimitCents: Math.min(controls.perTipLimitCents, enrollment.perTipLimitCents ?? Infinity),
      workerDailyLimitCents: Math.min(controls.workerDailyLimitCents, enrollment.dailyLimitCents ?? Infinity),
      globalDailyLimitCents: controls.globalDailyLimitCents,
      workerRecentCents: mine.filter(counts).reduce((a, p) => a + p.chargedCents, 0),
      globalRecentCents: everyone.filter(counts).reduce((a, p) => a + p.chargedCents, 0),
    });
    if (problem) throw new ConvexError(problem);

    const membership = await activeMembership(ctx, workerId);
    const tipPaymentId = await ctx.db.insert("tipPayments", {
      workerId,
      payeeAccountId: payee._id,
      channel: "checkout",
      livemode: payee.livemode,
      status: "creating",
      ...amounts,
      crewId: membership?.crew.moneyMode === "real" ? membership.crew._id : undefined,
      clientRequestId,
      latestReadToken: 0,
      allocated: false,
      refundedCents: 0,
      refunds: [],
      failedRefundAckCents: 0,
      disputedCents: 0,
      disputeFeeCents: 0,
      disputeOpen: false,
      disputeIds: [],
      inquiryCents: 0,
      guestHoldCents: 0,
      hasGuestHold: false,
      ledgerSeq: 0,
      postedNetTakenCents: 0,
      postedFeesTakenCents: 0,
      postedDisputeFeeCents: 0,
      postedReviewHeldCents: 0,
    });
    return {
      tipPaymentId,
      repeat: false as const,
      status: "creating" as const,
      checkoutUrl: undefined,
      paymentIntentId: undefined,
      stripeAccountId: payee.stripeAccountId,
      needsAccountCheck: now - payee.syncedAt > MIN,
      tipCents,
      feesCents: amounts.feesCents,
      chargedCents: amounts.chargedCents,
    };
  },
});

export const attachCheckout = internalMutation({
  args: { tipPaymentId: v.id("tipPayments"), sessionId: v.string(), url: v.optional(v.string()) },
  handler: async (ctx, { tipPaymentId, sessionId, url }) => {
    const tip = await ctx.db.get(tipPaymentId);
    if (!tip) return;
    await ctx.db.patch(tip._id, {
      stripeCheckoutSessionId: sessionId,
      checkoutUrl: url ?? tip.checkoutUrl,
      status: tip.status === "creating" ? "open" : tip.status,
    });
  },
});

// Stripe never took money on this one. A late success still wins in applyPaymentSnapshot.
export const closeUnpaid = internalMutation({
  args: { tipPaymentId: v.id("tipPayments"), status: v.union(v.literal("expired"), v.literal("canceled"), v.literal("failed")) },
  handler: async (ctx, { tipPaymentId, status }) => {
    const tip = await ctx.db.get(tipPaymentId);
    if (!tip || tip.status === "succeeded" || tip.status === "processing") return;
    await ctx.db.patch(tip._id, { status });
  },
});

const snapshotValidator = v.object({
  paymentIntentId: v.string(),
  piStatus: v.string(),
  amountCents: v.number(),
  currency: v.string(),
  livemode: v.boolean(),
  metadataTipPaymentId: v.optional(v.string()),
  chargeId: v.optional(v.string()),
  paidAt: v.optional(v.number()),
  stripeFeeCents: v.optional(v.number()),
  refunds: v.array(v.object({ id: v.string(), amountCents: v.number(), status: v.string() })),
  cardBrand: v.optional(v.string()),
  disputes: v.array(v.object({ id: v.string(), status: v.string(), amountCents: v.number(), feeCents: v.number() })),
});

// Claims the next read of this payment. Only the newest claim can be applied, so whichever read gets
// applied started after anything already on file finished. Clocks and arrival order don't come into it.
export const beginPaymentRead = internalMutation({
  args: { tipPaymentId: v.id("tipPayments") },
  handler: async (ctx, { tipPaymentId }) => {
    const tip = await ctx.db.get(tipPaymentId);
    if (!tip) return null;
    const readToken = tip.latestReadToken + 1;
    await ctx.db.patch(tip._id, { latestReadToken: readToken });
    return readToken;
  },
});

// Stripe's charges to us for this payment. Both totals can go up or down, so these post the change.
async function bookStripeCharges(ctx: MutationCtx, tipPaymentId: Id<"tipPayments">, s: PaymentSnapshot) {
  const tip = (await ctx.db.get(tipPaymentId))!;
  const base = { livemode: tip.livemode, tipPaymentId: tip._id, workerId: tip.workerId };
  let seq = tip.ledgerSeq;
  const patch: Partial<Doc<"tipPayments">> = {};
  if (s.stripeFeeCents !== undefined && s.stripeFeeCents !== (tip.postedStripeFeeCents ?? 0)) {
    const delta = s.stripeFeeCents - (tip.postedStripeFeeCents ?? 0);
    seq += 1;
    await post(ctx, { ...base, ref: `tip:${tip._id}:stripe-fee:${seq}`, debit: delta > 0 ? "processing_cost" : "stripe_balance", credit: delta > 0 ? "stripe_balance" : "processing_cost", amountCents: Math.abs(delta) });
    patch.postedStripeFeeCents = s.stripeFeeCents;
  }
  const disputeFees = disputeFeeCents(s.disputes);
  if (disputeFees !== tip.postedDisputeFeeCents) {
    const delta = disputeFees - tip.postedDisputeFeeCents;
    seq += 1;
    await post(ctx, { ...base, ref: `tip:${tip._id}:dispute-fee:${seq}`, debit: delta > 0 ? "dispute_fees" : "stripe_balance", credit: delta > 0 ? "stripe_balance" : "dispute_fees", amountCents: Math.abs(delta), stripeObjectId: s.disputes[0]?.id });
    patch.postedDisputeFeeCents = disputeFees;
  }
  if (seq !== tip.ledgerSeq) await ctx.db.patch(tip._id, { ...patch, ledgerSeq: seq });
}

// Money Stripe is holding for us on a payment under review: in the balance, but not ours or a worker's yet.
async function bookReviewHold(ctx: MutationCtx, tipPaymentId: Id<"tipPayments">, heldCents: number) {
  const tip = (await ctx.db.get(tipPaymentId))!;
  const delta = heldCents - tip.postedReviewHeldCents;
  if (delta === 0) return;
  const seq = tip.ledgerSeq + 1;
  await post(ctx, {
    ref: `tip:${tip._id}:review-held:${seq}`,
    debit: delta > 0 ? "stripe_balance" : "review_held",
    credit: delta > 0 ? "review_held" : "stripe_balance",
    amountCents: Math.abs(delta),
    livemode: tip.livemode,
    tipPaymentId: tip._id,
    workerId: tip.workerId,
  });
  await ctx.db.patch(tip._id, { postedReviewHeldCents: heldCents, ledgerSeq: seq });
}

function refundFields(tip: Doc<"tipPayments">, s: PaymentSnapshot) {
  const hold = guestHoldCents({ refunds: s.refunds, failedRefundAckCents: tip.failedRefundAckCents, inquiryCents: inquiryCents(s.disputes) });
  return {
    refundedCents: activeRefundCents(s.refunds),
    refunds: s.refunds,
    disputedCents: disputedCents(s.disputes),
    disputeFeeCents: disputeFeeCents(s.disputes),
    disputeOpen: disputeOpen(s.disputes),
    disputeIds: s.disputes.map((d) => d.id),
    inquiryCents: inquiryCents(s.disputes),
    guestHoldCents: hold,
    hasGuestHold: hold > 0,
  };
}

async function alertFailedRefunds(ctx: MutationCtx, tip: Doc<"tipPayments">, s: PaymentSnapshot) {
  const failed = failedRefundCents(s.refunds);
  if (failed > failedRefundCents(tip.refunds)) {
    await raiseAlert(ctx, { kind: "refund_failed", severity: "critical", message: `A refund of payment ${tip._id} failed. The guest hasn't got it back and their worker's money is on hold. Refund another way, then run ops:resolveFailedRefund.`, ref: `${tip._id}:${failed}` });
  }
}

// The only way a payment becomes real: what Stripe says right now, checked against what we asked for.
export const applyPaymentSnapshot = internalMutation({
  args: { tipPaymentId: v.id("tipPayments"), readToken: v.number(), snapshot: snapshotValidator },
  handler: async (ctx, { tipPaymentId, readToken, snapshot: s }) => {
    const tip = await ctx.db.get(tipPaymentId);
    if (!tip) return { applied: false, reason: "missing" };
    // Another read started while this one was out, so this one might be older. The caller reads again.
    if (readToken !== tip.latestReadToken) return { applied: false, reason: "superseded" };

    const problems = snapshotProblems(tip, s);
    if (problems.length > 0) {
      const reason = problems.join("; ");
      // Stripe has this money whatever we think of it. When the payment is really ours, keep track of it.
      const ours = s.metadataTipPaymentId === tip._id && s.currency === "usd" && s.livemode === tip.livemode && (!tip.stripePaymentIntentId || tip.stripePaymentIntentId === s.paymentIntentId);
      await ctx.db.patch(tip._id, { reviewReason: reason, ...(ours ? { stripePaymentIntentId: s.paymentIntentId, stripeChargeId: s.chargeId ?? tip.stripeChargeId, stripeFeeCents: s.stripeFeeCents ?? tip.stripeFeeCents, ...refundFields(tip, s) } : {}) });
      if (ours) {
        await alertFailedRefunds(ctx, tip, s);
        await bookStripeCharges(ctx, tip._id, s);
        const held = s.piStatus === "succeeded" ? Math.max(0, s.amountCents - activeRefundCents(s.refunds) - disputedCents(s.disputes)) : 0;
        await bookReviewHold(ctx, tip._id, held);
      }
      await raiseAlert(ctx, { kind: "payment_mismatch", severity: "critical", message: `Payment ${tip._id}: ${reason}`, ref: tip._id });
      return { applied: false, reason };
    }

    const status = nextPaymentStatus(tip.status, s.piStatus);
    const firstSuccess = status === "succeeded" && tip.status !== "succeeded";
    const paidAt = tip.paidAt ?? (status === "succeeded" ? s.paidAt ?? Date.now() : undefined);
    await alertFailedRefunds(ctx, tip, s);
    await ctx.db.patch(tip._id, {
      status,
      stripePaymentIntentId: s.paymentIntentId,
      stripeChargeId: s.chargeId ?? tip.stripeChargeId,
      stripeFeeCents: s.stripeFeeCents ?? tip.stripeFeeCents,
      cardBrand: s.cardBrand ?? tip.cardBrand,
      paidAt,
      ...refundFields(tip, s),
    });
    await bookReviewHold(ctx, tip._id, 0);
    if (status !== "succeeded") return { applied: true, status };

    const base = { livemode: tip.livemode, tipPaymentId: tip._id, workerId: tip.workerId };
    if (firstSuccess) {
      await post(ctx, { ...base, ref: `tip:${tip._id}:sale:net`, debit: "stripe_balance", credit: "worker_liability", amountCents: tip.netCents, stripeObjectId: s.chargeId });
      await post(ctx, { ...base, ref: `tip:${tip._id}:sale:fees`, debit: "stripe_balance", credit: "platform_fees", amountCents: tip.chargedCents - tip.netCents, stripeObjectId: s.chargeId });
    }
    await bookStripeCharges(ctx, tip._id, s);
    if (firstSuccess && s.disputes.length > 0) {
      await raiseAlert(ctx, { kind: "dispute", severity: "warning", message: `Payment ${tip._id} has a dispute.`, ref: s.disputes[0].id });
    }

    if (firstSuccess) {
      // A pool stops changing when its crew closes, so a late success stays with the worker who took it.
      const crew = tip.crewId ? await ctx.db.get(tip.crewId) : null;
      if (crew?.status !== "open") {
        if (tip.crewId) await ctx.db.patch(tip._id, { crewId: undefined });
        const fresh = await ctx.db.get(tip._id);
        if (!fresh?.reviewReason) await allocateSolo(ctx, fresh!);
      }
    }
    await rebalanceTip(ctx, tip._id);
    if (disputeOpen(s.disputes) && !tip.disputeOpen) {
      await raiseAlert(ctx, { kind: "dispute", severity: "warning", message: `Payment ${tip._id} is disputed. Respond in the Stripe Dashboard.`, ref: tip._id });
    }
    return { applied: true, status };
  },
});

// Payee accounts

// Creates the row once. If two requests raced to Stripe, the first account stays and the second is flagged.
export const saveNewPayee = internalMutation({
  args: {
    tokenIdentifier: v.string(),
    workerId: v.id("workers"),
    livemode: v.boolean(),
    stripeAccountId: v.string(),
    transfersStatus: v.string(),
    payoutsStatus: v.string(),
    requirementsDue: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("payeeAccounts")
      .withIndex("by_token_mode", (q) => q.eq("tokenIdentifier", args.tokenIdentifier).eq("livemode", args.livemode))
      .unique();
    if (existing) {
      if (existing.stripeAccountId !== args.stripeAccountId) {
        await raiseAlert(ctx, { kind: "duplicate_account", severity: "warning", message: `Unused Stripe account ${args.stripeAccountId} for worker ${args.workerId}.`, ref: args.stripeAccountId });
      }
      return existing._id;
    }
    return await ctx.db.insert("payeeAccounts", { ...args, syncedAt: Date.now(), payoutsPaused: false, payoutScheduleDesired: "weekly", payoutScheduleGeneration: 0, payoutScheduleAttempts: 0, owedCents: 0 });
  },
});

export const applyAccountStatus = internalMutation({
  args: { stripeAccountId: v.string(), transfersStatus: v.string(), payoutsStatus: v.string(), requirementsDue: v.number() },
  handler: async (ctx, { stripeAccountId, ...status }) => {
    const payee = await ctx.db.query("payeeAccounts").withIndex("by_stripe_account", (q) => q.eq("stripeAccountId", stripeAccountId)).unique();
    if (!payee) return null;
    if ((payee.transfersStatus === "active" && status.transfersStatus !== "active") || ["restricted", "rejected", "unsupported"].includes(status.transfersStatus)) {
      await raiseAlert(ctx, { kind: "account_restricted", severity: "warning", message: `Stripe restricted ${stripeAccountId}: ${status.transfersStatus}.`, ref: stripeAccountId });
    }
    await ctx.db.patch(payee._id, { ...status, syncedAt: Date.now() });
    return payee._id;
  },
});

export const applyBalance = internalMutation({
  args: { stripeAccountId: v.string(), availableCents: v.number(), pendingCents: v.number() },
  handler: async (ctx, { stripeAccountId, availableCents, pendingCents }) => {
    const payee = await ctx.db.query("payeeAccounts").withIndex("by_stripe_account", (q) => q.eq("stripeAccountId", stripeAccountId)).unique();
    if (!payee) return;
    await ctx.db.patch(payee._id, { balanceAvailableCents: availableCents, balancePendingCents: pendingCents, balanceSyncedAt: Date.now() });
    if (availableCents < 0 && !payee.frozenReason) {
      // We answer for this account's negative balance, so it stops paying out until someone looks.
      await freezePayee(ctx, payee, "Negative Stripe balance");
      await raiseAlert(ctx, { kind: "negative_balance", severity: "critical", message: `${stripeAccountId} is negative: ${availableCents} cents.`, ref: stripeAccountId });
    }
  },
});

const MAX_SCHEDULE_RETRY_MS = 60 * MIN;

// Stripe has confirmed this schedule. An older run for a schedule we've since changed records nothing.
export const confirmPayoutSchedule = internalMutation({
  args: { payeeAccountId: v.id("payeeAccounts"), generation: v.number(), interval: v.string(), drifted: v.boolean() },
  handler: async (ctx, { payeeAccountId, generation, interval, drifted }) => {
    const payee = await ctx.db.get(payeeAccountId);
    if (!payee || payee.payoutScheduleGeneration !== generation) return { current: false };
    await ctx.db.patch(payee._id, {
      payoutsPaused: interval === "manual",
      payoutScheduleConfirmed: interval,
      payoutScheduleVerifiedAt: Date.now(),
      payoutScheduleAttempts: 0,
      payoutScheduleError: undefined,
    });
    await resolveAlertByKey(ctx, `payout_schedule_failed:${payee._id}`);
    if (drifted) {
      await raiseAlert(ctx, { kind: "payout_schedule_drift", severity: "critical", message: `${payee.stripeAccountId}'s payout schedule on Stripe wasn't what we expected. It was set back to ${interval}. Check who changed it.`, ref: `${payee._id}:${Date.now()}` });
    }
    return { current: true };
  },
});

// Stripe didn't take the change. Scheduled actions don't retry by themselves, so this does, and it tells
// someone straight away: a frozen worker whose payouts keep running is an emergency.
export const payoutScheduleFailed = internalMutation({
  args: { payeeAccountId: v.id("payeeAccounts"), generation: v.number(), error: v.string() },
  handler: async (ctx, { payeeAccountId, generation, error }) => {
    const payee = await ctx.db.get(payeeAccountId);
    if (!payee || payee.payoutScheduleGeneration !== generation) return;
    const attempts = payee.payoutScheduleAttempts + 1;
    await ctx.db.patch(payee._id, { payoutScheduleAttempts: attempts, payoutScheduleError: error });
    const manual = payee.payoutScheduleDesired === "manual";
    await raiseAlert(ctx, {
      kind: "payout_schedule_failed",
      severity: manual ? "critical" : "warning",
      message: manual ? `Couldn't pause payouts for ${payee.stripeAccountId}: ${error}. Their bank payouts are still running. Retrying.` : `Couldn't set ${payee.stripeAccountId}'s payout schedule to ${payee.payoutScheduleDesired}: ${error}. Retrying.`,
      ref: payee._id,
    });
    await ctx.scheduler.runAfter(Math.min(2 ** attempts * MIN, MAX_SCHEDULE_RETRY_MS), internal.paymentsNode.enforcePayoutSchedule, { payeeAccountId });
  },
});

export const upsertPayout = internalMutation({
  args: {
    stripeAccountId: v.string(),
    stripePayoutId: v.string(),
    amountCents: v.number(),
    status: v.string(),
    arrivalDate: v.number(),
    failureMessage: v.optional(v.string()),
    livemode: v.boolean(),
  },
  handler: async (ctx, args) => {
    const payee = await ctx.db.query("payeeAccounts").withIndex("by_stripe_account", (q) => q.eq("stripeAccountId", args.stripeAccountId)).unique();
    if (!payee) return;
    const existing = await ctx.db.query("payouts").withIndex("by_stripe_id", (q) => q.eq("stripePayoutId", args.stripePayoutId)).unique();
    const fields = { ...args, payeeAccountId: payee._id, syncedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("payouts", fields);
    if (args.status === "failed") {
      await raiseAlert(ctx, { kind: "payout_failed", severity: "warning", message: `Payout ${args.stripePayoutId} failed: ${args.failureMessage ?? "no reason given"}.`, ref: args.stripePayoutId });
    }
  },
});

// The owner taking money out, or putting it in, so the books still match Stripe's balance.
export const recordPlatformMovement = internalMutation({
  args: { kind: v.union(v.literal("payout"), v.literal("topup")), stripeObjectId: v.string(), amountCents: v.number(), status: v.string(), livemode: v.boolean() },
  handler: async (ctx, { kind, stripeObjectId, amountCents, status, livemode }) => {
    const base = { livemode, stripeObjectId, amountCents };
    const booked = async (ref: string) => (await ctx.db.query("ledgerEntries").withIndex("by_ref", (q) => q.eq("ref", ref)).first()) !== null;
    if (kind === "topup") {
      if (status === "succeeded") await post(ctx, { ...base, ref: `topup:${stripeObjectId}`, debit: "stripe_balance", credit: "owner_capital" });
      else if (["reversed", "failed", "canceled"].includes(status) && await booked(`topup:${stripeObjectId}`)) {
        await post(ctx, { ...base, ref: `topup-back:${stripeObjectId}`, debit: "owner_capital", credit: "stripe_balance" });
      }
      return;
    }
    // Stripe takes it from the balance when the payout is created, not when it lands.
    if (["pending", "in_transit", "paid"].includes(status)) {
      await post(ctx, { ...base, ref: `platform-payout:${stripeObjectId}`, debit: "owner_withdrawals", credit: "stripe_balance" });
    } else if (status === "failed" || status === "canceled") {
      // Only undo one we'd booked. The money came back to the balance.
      if (await booked(`platform-payout:${stripeObjectId}`)) await post(ctx, { ...base, ref: `platform-payout-back:${stripeObjectId}`, debit: "stripe_balance", credit: "owner_withdrawals" });
    }
  },
});

// After the owner's money has left: did it take more than was theirs? Comes after the fact, because Stripe
// doesn't ask us first. Withdraw only what ops:books says, and this stays quiet.
export const checkOwnerPayout = internalMutation({
  args: { stripeObjectId: v.string(), amountCents: v.number(), status: v.string(), automatic: v.boolean(), availableCents: v.number(), connectReservedCents: v.number() },
  handler: async (ctx, { stripeObjectId, amountCents, status, automatic, availableCents, connectReservedCents }) => {
    if (automatic) {
      await raiseAlert(ctx, { kind: "platform_auto_payout", severity: "critical", message: `Stripe automatically paid out ${amountCents} cents (${stripeObjectId}) from the platform's balance. It could include worker money. Set platform payouts to manual.`, ref: stripeObjectId });
    }
    if (status === "failed" || status === "canceled") return;
    const rows = (await ctx.db.query("ledgerEntries").collect()) as unknown as LedgerRow[];
    const { obligations } = await currentObligations(ctx, connectReservedCents, rows, 0);
    const owed = obligationTotal(obligations);
    if (availableCents < owed) {
      await raiseAlert(ctx, { kind: "withdrawal_above_safe", severity: "critical", message: `Payout ${stripeObjectId} of ${amountCents} cents left ${availableCents} available, but ${owed} belongs to workers, guests or payments under review. Add funds to the Stripe balance before transfers fail.`, ref: stripeObjectId });
    }
  },
});

// Webhooks

export const recordEvent = internalMutation({
  args: {
    eventId: v.string(),
    type: v.string(),
    livemode: v.boolean(),
    source: v.union(v.literal("platform"), v.literal("connect")),
    stripeAccountId: v.optional(v.string()),
    created: v.number(),
    target: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("stripeEvents").withIndex("by_event", (q) => q.eq("eventId", args.eventId)).first();
    if (existing) return { duplicate: true };
    const now = Date.now();
    const mode = configuredMode();
    const wrongMode = !mode || isLive(mode) !== args.livemode;
    const ignored = wrongMode || JSON.parse(args.target).kind === "ignore";
    await ctx.db.insert("stripeEvents", {
      ...args,
      status: ignored ? "ignored" : "pending",
      attempts: 0,
      // The scheduled run below usually handles it; this is the cron's fallback if that run dies.
      nextAttemptAt: now + 5 * MIN,
    });
    if (wrongMode) {
      await raiseAlert(ctx, { kind: "event_wrong_mode", severity: "critical", message: `Event ${args.eventId} livemode=${args.livemode} doesn't match this deployment.`, dedupeKey: `event_wrong_mode:${args.livemode}` });
      return { duplicate: false };
    }
    if (!ignored) await ctx.scheduler.runAfter(0, internal.paymentsNode.processEvent, { eventId: args.eventId });
    return { duplicate: false };
  },
});

export const getEvent = internalQuery({
  args: { eventId: v.string() },
  handler: async (ctx, { eventId }) => await ctx.db.query("stripeEvents").withIndex("by_event", (q) => q.eq("eventId", eventId)).first(),
});

export const finishEvent = internalMutation({
  args: { eventId: v.string(), error: v.optional(v.string()) },
  handler: async (ctx, { eventId, error }) => {
    const event = await ctx.db.query("stripeEvents").withIndex("by_event", (q) => q.eq("eventId", eventId)).first();
    if (!event) return;
    if (!error) {
      await ctx.db.patch(event._id, { status: "done", lastError: undefined });
      return;
    }
    const attempts = event.attempts + 1;
    if (attempts >= 8) {
      await ctx.db.patch(event._id, { status: "failed", attempts, lastError: error });
      await raiseAlert(ctx, { kind: "event_failed", severity: "critical", message: `Event ${eventId} (${event.type}) keeps failing: ${error}`, ref: eventId });
      return;
    }
    await ctx.db.patch(event._id, { attempts, lastError: error, nextAttemptAt: Date.now() + 2 ** attempts * MIN });
  },
});

export const dueEvents = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("stripeEvents")
      .withIndex("by_status_next", (q) => q.eq("status", "pending").lte("nextAttemptAt", Date.now()))
      .take(25);
    return rows.map((e) => e.eventId);
  },
});

// Reconciliation inputs

// Payments that should have changed state by now, or still lack Stripe's real fee.
export const paymentsToRecheck = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const out: Id<"tipPayments">[] = [];
    for (const status of ["creating", "open", "processing"] as const) {
      const rows = await ctx.db.query("tipPayments").withIndex("by_status", (q) => q.eq("status", status)).take(100);
      for (const p of rows) if (p._creationTime < now - 10 * MIN) out.push(p._id);
    }
    const paid = await ctx.db.query("tipPayments").withIndex("by_status", (q) => q.eq("status", "succeeded")).order("desc").take(200);
    for (const p of paid) {
      // Stripe's refund failures come up to 30 days later, so a refund stays worth rechecking until then.
      const refundRecent = p.refunds.length > 0 && (p.paidAt ?? 0) > now - 40 * 24 * 60 * MIN;
      if (p.stripeFeeCents === undefined || refundRecent || p.hasGuestHold || (p.paidAt ?? 0) > now - 3 * 24 * 60 * MIN) out.push(p._id);
    }
    // Disputes can run for months, so these don't come from the newest-200 window above.
    const disputed = await ctx.db.query("tipPayments").withIndex("by_dispute_open", (q) => q.eq("disputeOpen", true)).take(200);
    for (const p of disputed) if (!out.includes(p._id)) out.push(p._id);
    return out;
  },
});

export const accountsToRefresh = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("payeeAccounts").take(500);
    return rows.map((p) => p.stripeAccountId);
  },
});

export const alert = internalMutation({
  args: { kind: v.string(), severity: v.union(v.literal("critical"), v.literal("warning")), message: v.string(), ref: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await raiseAlert(ctx, args);
  },
});

export const enrollmentExists = internalQuery({
  args: { tokenIdentifier: v.string() },
  handler: async (ctx, { tokenIdentifier }) => (await enrollmentFor(ctx, tokenIdentifier)) !== null,
});

export const payeeForToken = internalQuery({
  args: { tokenIdentifier: v.string() },
  handler: async (ctx, { tokenIdentifier }) => await payeeFor(ctx, tokenIdentifier),
});
