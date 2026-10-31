// Real money: what clients may read, and the internal steps Stripe actions run in transactions.
// No public mutation lives here. Client requests go through paymentsNode, and money facts only
// enter through applyPaymentSnapshot after being read back from Stripe.
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { activeMembership, currentWorker, resolveWorkerByHandle } from "./helpers";
import { MAX_TIP_CENTS, MIN_TIP_CENTS } from "./lib/money";
import { allocateSolo, enrollmentFor, freezePayee, getControls, payeeFor, post, raiseAlert, rebalanceTip, workerStage } from "./lib/paymentsDb";
import {
  CHARGE_WINDOW_MS,
  disputeFeeCents,
  disputeOpen,
  disputedCents,
  limitProblem,
  nextPaymentStatus,
  snapshotProblems,
  tipAmounts,
} from "./lib/paymentRules";
import { configuredMode, isLive } from "./lib/stripeEnv";

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
      ticket: tip._id.slice(-6).toUpperCase(),
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
      refundedCents: 0,
      disputedCents: 0,
      disputeFeeCents: 0,
      disputeOpen: false,
      postedNetTakenCents: 0,
      postedFeesTakenCents: 0,
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
  fetchedFrom: v.number(),
  paymentIntentId: v.string(),
  piStatus: v.string(),
  amountCents: v.number(),
  currency: v.string(),
  livemode: v.boolean(),
  metadataTipPaymentId: v.optional(v.string()),
  chargeId: v.optional(v.string()),
  paidAt: v.optional(v.number()),
  stripeFeeCents: v.optional(v.number()),
  refundedCents: v.number(),
  cardBrand: v.optional(v.string()),
  disputes: v.array(v.object({ id: v.string(), status: v.string(), amountCents: v.number(), feeCents: v.number() })),
});

// The only way a payment becomes real: what Stripe says right now, checked against what we asked for.
export const applyPaymentSnapshot = internalMutation({
  args: { tipPaymentId: v.id("tipPayments"), snapshot: snapshotValidator },
  handler: async (ctx, { tipPaymentId, snapshot: s }) => {
    const tip = await ctx.db.get(tipPaymentId);
    if (!tip) return { applied: false, reason: "missing" };
    if (s.fetchedFrom < (tip.snapshotFrom ?? 0)) return { applied: false, reason: "stale" };

    const problems = snapshotProblems(tip, s);
    if (problems.length > 0) {
      const reason = problems.join("; ");
      await ctx.db.patch(tip._id, { reviewReason: reason, snapshotFrom: s.fetchedFrom });
      await raiseAlert(ctx, { kind: "payment_mismatch", severity: "critical", message: `Payment ${tip._id}: ${reason}`, ref: tip._id });
      return { applied: false, reason };
    }

    const status = nextPaymentStatus(tip.status, s.piStatus);
    const firstSuccess = status === "succeeded" && tip.status !== "succeeded";
    const paidAt = tip.paidAt ?? (status === "succeeded" ? s.paidAt ?? Date.now() : undefined);
    await ctx.db.patch(tip._id, {
      status,
      snapshotFrom: s.fetchedFrom,
      stripePaymentIntentId: s.paymentIntentId,
      stripeChargeId: s.chargeId ?? tip.stripeChargeId,
      stripeFeeCents: s.stripeFeeCents ?? tip.stripeFeeCents,
      cardBrand: s.cardBrand ?? tip.cardBrand,
      paidAt,
      refundedCents: s.refundedCents,
      disputedCents: disputedCents(s.disputes),
      disputeFeeCents: disputeFeeCents(s.disputes),
      disputeOpen: disputeOpen(s.disputes),
    });
    if (status !== "succeeded") return { applied: true, status };

    const base = { livemode: tip.livemode, tipPaymentId: tip._id, workerId: tip.workerId };
    if (firstSuccess) {
      await post(ctx, { ...base, ref: `tip:${tip._id}:sale:net`, debit: "stripe_balance", credit: "worker_liability", amountCents: tip.netCents, stripeObjectId: s.chargeId });
      await post(ctx, { ...base, ref: `tip:${tip._id}:sale:fees`, debit: "stripe_balance", credit: "platform_fees", amountCents: tip.chargedCents - tip.netCents, stripeObjectId: s.chargeId });
    }
    if (s.stripeFeeCents !== undefined && s.stripeFeeCents !== (tip.postedStripeFeeCents ?? 0)) {
      const delta = s.stripeFeeCents - (tip.postedStripeFeeCents ?? 0);
      await post(ctx, {
        ...base,
        ref: `tip:${tip._id}:stripe-fee:${s.stripeFeeCents}`,
        debit: delta > 0 ? "processing_cost" : "stripe_balance",
        credit: delta > 0 ? "stripe_balance" : "processing_cost",
        amountCents: Math.abs(delta),
      });
      await ctx.db.patch(tip._id, { postedStripeFeeCents: s.stripeFeeCents });
    }
    for (const d of s.disputes) {
      await post(ctx, { ...base, ref: `dispute:${d.id}:fee:${d.feeCents}`, debit: "dispute_fees", credit: "stripe_balance", amountCents: d.feeCents, stripeObjectId: d.id });
    }
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
    return await ctx.db.insert("payeeAccounts", { ...args, syncedAt: Date.now(), payoutsPaused: false, owedCents: 0 });
  },
});

export const applyAccountStatus = internalMutation({
  args: { stripeAccountId: v.string(), transfersStatus: v.string(), payoutsStatus: v.string(), requirementsDue: v.number() },
  handler: async (ctx, { stripeAccountId, ...status }) => {
    const payee = await ctx.db.query("payeeAccounts").withIndex("by_stripe_account", (q) => q.eq("stripeAccountId", stripeAccountId)).unique();
    if (!payee) return null;
    if (payee.transfersStatus === "active" && status.transfersStatus !== "active") {
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

export const setPayoutsPausedRecord = internalMutation({
  args: { payeeAccountId: v.id("payeeAccounts"), paused: v.boolean() },
  handler: async (ctx, { payeeAccountId, paused }) => {
    await ctx.db.patch(payeeAccountId, { payoutsPaused: paused });
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
    if (kind === "topup") {
      if (status === "succeeded") await post(ctx, { ...base, ref: `topup:${stripeObjectId}`, debit: "stripe_balance", credit: "owner_capital" });
      return;
    }
    if (status === "paid" || status === "in_transit") {
      await post(ctx, { ...base, ref: `platform-payout:${stripeObjectId}`, debit: "owner_withdrawals", credit: "stripe_balance" });
    } else if (status === "failed" || status === "canceled") {
      // Only undo one we'd booked. The money came back to the balance.
      const booked = await ctx.db.query("ledgerEntries").withIndex("by_ref", (q) => q.eq("ref", `platform-payout:${stripeObjectId}`)).first();
      if (booked) await post(ctx, { ...base, ref: `platform-payout-back:${stripeObjectId}`, debit: "stripe_balance", credit: "owner_withdrawals" });
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
      if (p.stripeFeeCents === undefined || p.disputeOpen || (p.paidAt ?? 0) > now - 3 * 24 * 60 * MIN) out.push(p._id);
    }
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

export const knownIntents = internalQuery({
  args: { paymentIntentIds: v.array(v.string()) },
  handler: async (ctx, { paymentIntentIds }) => {
    const known: string[] = [];
    for (const id of paymentIntentIds) {
      const row = await ctx.db.query("tipPayments").withIndex("by_intent", (q) => q.eq("stripePaymentIntentId", id)).first();
      if (row) known.push(id);
    }
    return known;
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
