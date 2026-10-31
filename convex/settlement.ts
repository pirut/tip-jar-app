// Moves money from the platform's Stripe balance to workers, one allocation at a time. These are the
// transaction halves; paymentsNode.runDue makes the Stripe calls between them.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { freezePayee, getControls, post, raiseAlert } from "./lib/paymentsDb";
import { allocationDue, applyOwed, canReceive, planReversal } from "./lib/paymentRules";

const MIN = 60 * 1000;
const WAIT_WHEN_BLOCKED = 30 * MIN;
const IN_FLIGHT_TIMEOUT = 15 * MIN;
const ALERT_AFTER_ATTEMPTS = 5;

export const dueAllocations = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const now = Date.now();
    const due = await ctx.db
      .query("allocations")
      .withIndex("by_state_eligible", (q) => q.eq("state", "due").lte("eligibleAt", now))
      .take(limit);
    return due.map((a) => a._id);
  },
});

// A run that died mid-call leaves its row in flight. The next claim looks up what Stripe did first.
export const releaseStuck = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stuck = await ctx.db.query("allocations").withIndex("by_state_eligible", (q) => q.eq("state", "in_flight")).take(100);
    for (const a of stuck) {
      if ((a.claimedAt ?? 0) < now - IN_FLIGHT_TIMEOUT) await ctx.db.patch(a._id, { state: "due", eligibleAt: now });
    }
  },
});

type Claim =
  | { action: "skip"; reason: string }
  | { action: "transfer"; amountCents: number; offsetCents: number; idempotencyKey: string; destination: string; transferGroup: string; sourceCharge?: string; retry: boolean; livemode: boolean; tipPaymentId: string }
  | { action: "reverse"; plan: { transferId: string; amountCents: number; idempotencyKey: string }[]; uncoveredCents: number };

export const claimAllocation = internalMutation({
  args: { allocationId: v.id("allocations") },
  handler: async (ctx, { allocationId }): Promise<Claim> => {
    const a = await ctx.db.get(allocationId);
    if (!a || a.state !== "due") return { action: "skip", reason: "not due" };
    const due = allocationDue(a);
    if (due === 0) {
      await ctx.db.patch(a._id, { state: "settled" });
      return { action: "skip", reason: "nothing due" };
    }
    const tip = await ctx.db.get(a.tipPaymentId);
    const payee = await ctx.db.get(a.payeeAccountId);
    if (!tip || !payee) {
      await raiseAlert(ctx, { kind: "allocation_orphan", severity: "critical", message: `Allocation ${a._id} has no payment or payee.`, ref: a._id });
      await ctx.db.patch(a._id, { eligibleAt: Date.now() + WAIT_WHEN_BLOCKED });
      return { action: "skip", reason: "orphan" };
    }
    const now = Date.now();

    if (due < 0) {
      // Taking money back never waits for a kill switch.
      const { plan, uncoveredCents } = planReversal(a.transfers, -due);
      await ctx.db.patch(a._id, { state: "in_flight", claimedAt: now, attempts: a.attempts + 1 });
      return {
        action: "reverse",
        plan: plan.map((p) => ({ ...p, idempotencyKey: `rev:${a._id}:${a.seq}:${p.transferId}:${p.amountCents}` })),
        uncoveredCents,
      };
    }

    const controls = await getControls(ctx);
    const blocked = !controls?.transfersEnabled ? "transfers are switched off"
      : tip.status !== "succeeded" ? "payment hasn't succeeded"
      : tip.reviewReason ? "payment is under review"
      : tip.disputeOpen ? "payment is disputed"
      : payee.frozenReason ? "account is frozen"
      : !canReceive(payee.transfersStatus) ? "account can't receive transfers"
      : null;
    if (blocked) {
      await ctx.db.patch(a._id, { eligibleAt: now + WAIT_WHEN_BLOCKED, lastError: blocked });
      return { action: "skip", reason: blocked };
    }

    const { transferCents, offsetCents } = applyOwed(due, payee.owedCents);
    if (transferCents === 0) {
      await ctx.db.patch(payee._id, { owedCents: payee.owedCents - offsetCents });
      await ctx.db.patch(a._id, { paidCents: a.paidCents + offsetCents, seq: a.seq + 1, state: "settled", lastError: undefined });
      return { action: "skip", reason: "covered what they owed" };
    }
    await ctx.db.patch(a._id, { state: "in_flight", claimedAt: now, attempts: a.attempts + 1, inFlightOffsetCents: offsetCents });
    return {
      action: "transfer",
      amountCents: transferCents,
      offsetCents,
      idempotencyKey: `alloc:${a._id}:${a.seq}:${transferCents}`,
      destination: a.stripeAccountId,
      transferGroup: `tip_${tip._id}`,
      // Ties the transfer to the charge, so it can't outrun the money. Not for re-payments after a
      // dispute: that money came back into the platform's balance.
      sourceCharge: a.transfers.length === 0 && tip.disputedCents === 0 ? tip.stripeChargeId : undefined,
      retry: a.attempts > 0,
      livemode: tip.livemode,
      tipPaymentId: tip._id,
    };
  },
});

async function afterOperation(ctx: { db: any }, id: Doc<"allocations">["_id"]) {
  const a: Doc<"allocations"> = await ctx.db.get(id);
  await ctx.db.patch(id, { state: allocationDue(a) === 0 ? "settled" : "due", eligibleAt: Date.now(), attempts: 0, lastError: undefined, inFlightOffsetCents: undefined });
}

export const completeTransfer = internalMutation({
  args: { allocationId: v.id("allocations"), transferId: v.string(), amountCents: v.number(), destination: v.string() },
  handler: async (ctx, { allocationId, transferId, amountCents, destination }) => {
    const a = await ctx.db.get(allocationId);
    if (!a) return;
    if (a.transfers.some((t) => t.id === transferId)) return;
    if (destination !== a.stripeAccountId) {
      await raiseAlert(ctx, { kind: "transfer_wrong_recipient", severity: "critical", message: `Transfer ${transferId} went to ${destination}, not ${a.stripeAccountId}.`, ref: transferId });
      return;
    }
    const offset = a.inFlightOffsetCents ?? 0;
    if (offset > 0) {
      const payee = await ctx.db.get(a.payeeAccountId);
      if (payee) await ctx.db.patch(payee._id, { owedCents: Math.max(0, payee.owedCents - offset) });
    }
    await ctx.db.patch(a._id, {
      paidCents: a.paidCents + amountCents + offset,
      seq: a.seq + 1,
      transfers: [...a.transfers, { id: transferId, amountCents, reversedCents: 0 }],
    });
    const tip = await ctx.db.get(a.tipPaymentId);
    await post(ctx, {
      ref: `transfer:${transferId}`,
      debit: "worker_liability",
      credit: "stripe_balance",
      amountCents,
      livemode: tip?.livemode ?? false,
      tipPaymentId: a.tipPaymentId,
      allocationId: a._id,
      workerId: a.workerId,
      stripeObjectId: transferId,
    });
    await afterOperation(ctx, a._id);
  },
});

export const recordReversal = internalMutation({
  args: { allocationId: v.id("allocations"), transferId: v.string(), reversalId: v.string(), amountCents: v.number() },
  handler: async (ctx, { allocationId, transferId, reversalId, amountCents }) => {
    const a = await ctx.db.get(allocationId);
    if (!a) return;
    const ref = `reversal:${reversalId}`;
    const already = await ctx.db.query("ledgerEntries").withIndex("by_ref", (q) => q.eq("ref", ref)).first();
    if (already) return;
    await ctx.db.patch(a._id, {
      paidCents: a.paidCents - amountCents,
      transfers: a.transfers.map((t) => (t.id === transferId ? { ...t, reversedCents: t.reversedCents + amountCents } : t)),
    });
    const tip = await ctx.db.get(a.tipPaymentId);
    await post(ctx, { ref, debit: "stripe_balance", credit: "worker_liability", amountCents, livemode: tip?.livemode ?? false, tipPaymentId: a.tipPaymentId, allocationId: a._id, workerId: a.workerId, stripeObjectId: reversalId });
  },
});

// Stripe can't take it back (the worker's balance is short). They owe it, later transfers are reduced
// by it, and their account stops paying out. The platform carries the loss in the meantime.
export const reversalShort = internalMutation({
  args: { allocationId: v.id("allocations"), amountCents: v.number(), reason: v.string() },
  handler: async (ctx, { allocationId, amountCents, reason }) => {
    const a = await ctx.db.get(allocationId);
    if (!a || amountCents <= 0) return;
    await ctx.db.patch(a._id, { unrecoveredCents: a.unrecoveredCents + amountCents, lastError: reason });
    const payee = await ctx.db.get(a.payeeAccountId);
    if (!payee) return;
    await ctx.db.patch(payee._id, { owedCents: payee.owedCents + amountCents });
    if (!payee.frozenReason) await freezePayee(ctx, payee, "A refund or dispute couldn't be recovered");
    await raiseAlert(ctx, { kind: "reversal_short", severity: "critical", message: `Couldn't recover ${amountCents} cents from ${payee.stripeAccountId}: ${reason}`, ref: a._id });
  },
});

export const finishReversal = internalMutation({
  args: { allocationId: v.id("allocations") },
  handler: async (ctx, { allocationId }) => {
    const a = await ctx.db.get(allocationId);
    if (!a) return;
    await ctx.db.patch(a._id, { seq: a.seq + 1 });
    await afterOperation(ctx, a._id);
  },
});

// A Stripe call failed in a way worth retrying. Backs off and tells someone if it keeps happening.
export const releaseClaim = internalMutation({
  args: { allocationId: v.id("allocations"), error: v.string() },
  handler: async (ctx, { allocationId, error }) => {
    const a = await ctx.db.get(allocationId);
    if (!a || a.state !== "in_flight") return;
    await ctx.db.patch(a._id, { state: "due", eligibleAt: Date.now() + Math.min(2 ** a.attempts * MIN, 6 * 60 * MIN), lastError: error });
    if (a.attempts >= ALERT_AFTER_ATTEMPTS) {
      await raiseAlert(ctx, { kind: "transfer_stuck", severity: "critical", message: `Allocation ${a._id} failed ${a.attempts} times: ${error}`, ref: a._id });
    }
  },
});

// What Stripe says about one of our transfers, for a crash between Stripe's success and our write,
// and for reversals someone made in the Dashboard.
export const observeTransfer = internalMutation({
  args: { allocationId: v.string(), transferId: v.string(), amountCents: v.number(), reversedCents: v.number(), destination: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("allocations", args.allocationId);
    const a = id ? await ctx.db.get(id) : null;
    if (!a) return { recorded: false };
    if (args.destination !== a.stripeAccountId) {
      await raiseAlert(ctx, { kind: "transfer_wrong_recipient", severity: "critical", message: `Transfer ${args.transferId} went to ${args.destination}, not ${a.stripeAccountId}.`, ref: args.transferId });
      return { recorded: false };
    }
    const known = a.transfers.find((t) => t.id === args.transferId);
    if (!known) return { recorded: false, unknown: a.state === "in_flight" };
    if (args.reversedCents > known.reversedCents) {
      const delta = args.reversedCents - known.reversedCents;
      await ctx.db.patch(a._id, {
        paidCents: a.paidCents - delta,
        transfers: a.transfers.map((t) => (t.id === args.transferId ? { ...t, reversedCents: args.reversedCents } : t)),
      });
      const tip = await ctx.db.get(a.tipPaymentId);
      await post(ctx, { ref: `reversal-seen:${args.transferId}:${args.reversedCents}`, debit: "stripe_balance", credit: "worker_liability", amountCents: delta, livemode: tip?.livemode ?? false, tipPaymentId: a.tipPaymentId, allocationId: a._id, workerId: a.workerId, stripeObjectId: args.transferId });
      if (a.state !== "in_flight") await afterOperation(ctx, a._id);
    }
    return { recorded: true };
  },
});

export const allocationForAlert = internalQuery({
  args: { allocationId: v.id("allocations") },
  handler: async (ctx, { allocationId }) => await ctx.db.get(allocationId),
});
