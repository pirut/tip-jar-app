// Moves money from the platform's Stripe balance to workers, one allocation at a time. These are the
// transaction halves; paymentsNode.runDue makes the Stripe calls between them.
import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { freezePayee, getControls, post, raiseAlert } from "./lib/paymentsDb";
import { allocationDue, applyOwed, canReceive, failedRefundCents, planReversal } from "./lib/paymentRules";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const WAIT_WHEN_BLOCKED = 30 * MIN;
const IN_FLIGHT_TIMEOUT = 15 * MIN; // longer than a Convex action can run, so the old run is gone
const ALERT_AFTER_ATTEMPTS = 5;
const SHORT_RETRY = 6 * 60 * MIN;
const SHORT_BECOMES_DEBT = 7 * DAY; // long enough for pending funds to settle and a failed payout to return

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

// The debt a claim set aside goes back when its transfer didn't happen.
async function returnReservedDebt(ctx: MutationCtx, a: Doc<"allocations">) {
  const offset = a.inFlightOffsetCents ?? 0;
  if (offset <= 0) return;
  const payee = await ctx.db.get(a.payeeAccountId);
  if (payee) await ctx.db.patch(payee._id, { owedCents: payee.owedCents + offset });
}

// A run that died mid-call leaves its row in flight. The next claim looks up what Stripe did first.
export const releaseStuck = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stuck = await ctx.db.query("allocations").withIndex("by_state_eligible", (q) => q.eq("state", "in_flight")).take(100);
    for (const a of stuck) {
      if ((a.claimedAt ?? 0) >= now - IN_FLIGHT_TIMEOUT) continue;
      await returnReservedDebt(ctx, a);
      await ctx.db.patch(a._id, { state: "due", eligibleAt: now, inFlightOffsetCents: undefined });
    }
  },
});

type Claim =
  | { action: "skip"; reason: string }
  | { action: "transfer"; amountCents: number; offsetCents: number; idempotencyKey: string; destination: string; transferGroup: string; sourceCharge?: string; retry: boolean; livemode: boolean; tipPaymentId: string }
  | { action: "reverse"; transferGroup: string; destination: string }
  | { action: "recheck"; transferGroup: string };

export const claimAllocation = internalMutation({
  args: { allocationId: v.id("allocations") },
  handler: async (ctx, { allocationId }): Promise<Claim> => {
    const a = await ctx.db.get(allocationId);
    if (!a || a.state !== "due") return { action: "skip", reason: "not due" };
    const now = Date.now();
    const transferGroup = `tip_${a.tipPaymentId}`;
    const due = allocationDue(a);
    if (due === 0) {
      // An earlier attempt may have reached Stripe without us hearing back. Look before calling it done.
      if (a.attempts > 0) {
        await ctx.db.patch(a._id, { state: "in_flight", claimedAt: now, attempts: a.attempts + 1 });
        return { action: "recheck", transferGroup };
      }
      await ctx.db.patch(a._id, { state: "settled" });
      return { action: "skip", reason: "nothing due" };
    }
    const tip = await ctx.db.get(a.tipPaymentId);
    const payee = await ctx.db.get(a.payeeAccountId);
    if (!tip || !payee) {
      await raiseAlert(ctx, { kind: "allocation_orphan", severity: "critical", message: `Allocation ${a._id} has no payment or payee.`, ref: a._id });
      await ctx.db.patch(a._id, { eligibleAt: now + WAIT_WHEN_BLOCKED });
      return { action: "skip", reason: "orphan" };
    }

    if (due < 0) {
      // Taking money back never waits for a kill switch. The action reads Stripe's totals, then plans.
      await ctx.db.patch(a._id, { state: "in_flight", claimedAt: now, attempts: a.attempts + 1 });
      return { action: "reverse", transferGroup, destination: a.stripeAccountId };
    }

    const controls = await getControls(ctx);
    const blocked = !controls?.transfersEnabled ? "transfers are switched off"
      : tip.status !== "succeeded" ? "payment hasn't succeeded"
      : tip.reviewReason ? "payment is under review"
      : tip.disputeOpen ? "payment is disputed"
      : failedRefundCents(tip.refunds) > tip.failedRefundAckCents ? "a refund failed and hasn't been dealt with"
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
      await ctx.db.patch(a._id, { paidCents: a.paidCents + offsetCents, seq: a.seq + 1, state: "settled", attempts: 0, lastError: undefined });
      return { action: "skip", reason: "covered what they owed" };
    }
    // Sets the debt aside now, so a second claim running at the same time can't take the same debt again.
    if (offsetCents > 0) await ctx.db.patch(payee._id, { owedCents: payee.owedCents - offsetCents });
    await ctx.db.patch(a._id, { state: "in_flight", claimedAt: now, attempts: a.attempts + 1, inFlightOffsetCents: offsetCents });
    return {
      action: "transfer",
      amountCents: transferCents,
      offsetCents,
      idempotencyKey: `alloc:${a._id}:${a.seq}:${transferCents}`,
      destination: a.stripeAccountId,
      transferGroup,
      // Ties the transfer to the charge, so it can't outrun the money. Not for re-payments after a
      // dispute: that money came back into the platform's balance.
      sourceCharge: a.transfers.length === 0 && tip.disputeIds.length === 0 ? tip.stripeChargeId : undefined,
      retry: a.attempts > 0,
      livemode: tip.livemode,
      tipPaymentId: tip._id,
    };
  },
});

async function afterOperation(ctx: MutationCtx, id: Id<"allocations">) {
  const a = (await ctx.db.get(id))!;
  await ctx.db.patch(id, { state: allocationDue(a) === 0 ? "settled" : "due", eligibleAt: Date.now(), attempts: 0, lastError: undefined, inFlightOffsetCents: undefined, shortSince: undefined });
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
    await ctx.db.patch(a._id, {
      paidCents: a.paidCents + amountCents + (a.inFlightOffsetCents ?? 0),
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

// The reversal plan for a claimed allocation, from what Stripe has just confirmed. Keys carry the transfer's
// reversed total, so a retry repeats the same request until Stripe's total moves, then can't repeat it.
export const planClaimedReversal = internalMutation({
  args: { allocationId: v.id("allocations") },
  handler: async (ctx, { allocationId }) => {
    const a = await ctx.db.get(allocationId);
    if (!a || a.state !== "in_flight") return { plan: [], uncoveredCents: 0 };
    const due = allocationDue(a);
    if (due >= 0) return { plan: [], uncoveredCents: 0 };
    const { plan, uncoveredCents } = planReversal(a.transfers, -due);
    return {
      plan: plan.map((p) => {
        const reversed = a.transfers.find((t) => t.id === p.transferId)!.reversedCents;
        return { ...p, idempotencyKey: `rev:${a._id}:${p.transferId}:${reversed}:${p.amountCents}` };
      }),
      uncoveredCents,
    };
  },
});

async function addDebt(ctx: MutationCtx, a: Doc<"allocations">, amountCents: number, reason: string) {
  await ctx.db.patch(a._id, { unrecoveredCents: a.unrecoveredCents + amountCents, lastError: reason });
  const payee = await ctx.db.get(a.payeeAccountId);
  if (!payee) return;
  await ctx.db.patch(payee._id, { owedCents: payee.owedCents + amountCents });
  if (!payee.frozenReason) await freezePayee(ctx, payee, "A refund or dispute couldn't be recovered");
  await raiseAlert(ctx, { kind: "reversal_debt", severity: "critical", message: `Couldn't recover ${amountCents} cents from ${payee.stripeAccountId}: ${reason}. They owe it now, later transfers are reduced by it, and the platform carries the loss until then.`, ref: a._id });
}

// Stripe refused for lack of balance. That can be temporary, so it isn't a debt yet: the account stops
// paying out, an alert goes up and it retries. Only a week of refusals turns it into a debt.
export const reversalShort = internalMutation({
  args: { allocationId: v.id("allocations"), reason: v.string() },
  handler: async (ctx, { allocationId, reason }) => {
    const a = await ctx.db.get(allocationId);
    if (!a) return;
    const now = Date.now();
    const shortSince = a.shortSince ?? now;
    const payee = await ctx.db.get(a.payeeAccountId);
    if (payee && !payee.frozenReason) await freezePayee(ctx, payee, "A refund or dispute couldn't be recovered yet");
    if (now - shortSince >= SHORT_BECOMES_DEBT) {
      await addDebt(ctx, a, -allocationDue(a), reason);
      await afterOperation(ctx, a._id);
      return;
    }
    await ctx.db.patch(a._id, { state: "due", eligibleAt: now + SHORT_RETRY, attempts: 0, shortSince, lastError: reason });
    await raiseAlert(ctx, { kind: "reversal_short", severity: "critical", message: `Stripe won't take ${-allocationDue(a)} cents back from ${a.stripeAccountId} yet: ${reason}. They're frozen and it's retrying.`, ref: a._id });
  },
});

// Nothing is left to reverse, because the rest was paid by reducing a transfer. That's a debt right away.
export const reversalUncovered = internalMutation({
  args: { allocationId: v.id("allocations"), amountCents: v.number() },
  handler: async (ctx, { allocationId, amountCents }) => {
    const a = await ctx.db.get(allocationId);
    if (a && amountCents > 0) await addDebt(ctx, a, amountCents, "No transfer left to reverse");
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

// Stripe has been asked, and whatever it did is on file now.
export const finishRecheck = internalMutation({
  args: { allocationId: v.id("allocations") },
  handler: async (ctx, { allocationId }) => {
    const a = await ctx.db.get(allocationId);
    if (a?.state === "in_flight") await afterOperation(ctx, a._id);
  },
});

// A Stripe call failed in a way worth retrying. Backs off and tells someone if it keeps happening.
export const releaseClaim = internalMutation({
  args: { allocationId: v.id("allocations"), error: v.string() },
  handler: async (ctx, { allocationId, error }) => {
    const a = await ctx.db.get(allocationId);
    if (!a || a.state !== "in_flight") return;
    await returnReservedDebt(ctx, a);
    await ctx.db.patch(a._id, { state: "due", eligibleAt: Date.now() + Math.min(2 ** a.attempts * MIN, 6 * 60 * MIN), lastError: error, inFlightOffsetCents: undefined });
    if (a.attempts >= ALERT_AFTER_ATTEMPTS) {
      await raiseAlert(ctx, { kind: "transfer_stuck", severity: "critical", message: `Allocation ${a._id} failed ${a.attempts} times: ${error}`, ref: a._id });
    }
  },
});

// What Stripe says about one of our transfers. amount_reversed is Stripe's running total, so this is
// the one place a reversal enters the books, whichever of the direct call, a retry or a webhook sees it
// first. The total only ever grows, which makes a repeated or late read harmless.
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
    // A transfer we made but never wrote down, because a run died between the two.
    if (!known) return { recorded: false, unknown: true };
    if (args.reversedCents <= known.reversedCents) return { recorded: true };
    const delta = args.reversedCents - known.reversedCents;
    await ctx.db.patch(a._id, {
      paidCents: a.paidCents - delta,
      transfers: a.transfers.map((t) => (t.id === args.transferId ? { ...t, reversedCents: args.reversedCents } : t)),
    });
    const tip = await ctx.db.get(a.tipPaymentId);
    await post(ctx, { ref: `reversal:${args.transferId}:${args.reversedCents}`, debit: "stripe_balance", credit: "worker_liability", amountCents: delta, livemode: tip?.livemode ?? false, tipPaymentId: a.tipPaymentId, allocationId: a._id, workerId: a.workerId, stripeObjectId: args.transferId });
    if (a.state === "in_flight") return { recorded: true };
    await afterOperation(ctx, a._id);
    // Someone reversed more than this tip called for, outside Tip Jar. Paying it straight back could
    // undo what they meant to do, so the worker waits for a person.
    const after = (await ctx.db.get(a._id))!;
    if (allocationDue(after) > 0) {
      const payee = await ctx.db.get(a.payeeAccountId);
      if (payee && !payee.frozenReason) await freezePayee(ctx, payee, "A transfer was reversed outside Tip Jar");
      await raiseAlert(ctx, { kind: "reversal_unexpected", severity: "critical", message: `Transfer ${args.transferId} was reversed outside Tip Jar. ${a.stripeAccountId} is frozen until someone checks. Unfreeze to pay what's left.`, ref: args.transferId });
    }
    return { recorded: true };
  },
});

export const allocationForAlert = internalQuery({
  args: { allocationId: v.id("allocations") },
  handler: async (ctx, { allocationId }) => await ctx.db.get(allocationId),
});
