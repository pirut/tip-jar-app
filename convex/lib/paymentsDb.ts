// Database helpers shared by the real-money functions: gates, the ledger and allocations.
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { adjustmentPostings, allocationDue, allocationTargets, canReceive, entitlement, splitTipAmongMembers } from "./paymentRules";
import { configuredMode, isLive } from "./stripeEnv";

export async function getControls(ctx: QueryCtx): Promise<Doc<"paymentControls"> | null> {
  return await ctx.db.query("paymentControls").withIndex("by_key", (q) => q.eq("key", "global")).unique();
}

export async function enrollmentFor(ctx: QueryCtx, tokenIdentifier: string): Promise<Doc<"pilotEnrollments"> | null> {
  return await ctx.db.query("pilotEnrollments").withIndex("by_token", (q) => q.eq("tokenIdentifier", tokenIdentifier)).unique();
}

export async function payeeFor(ctx: QueryCtx, tokenIdentifier: string): Promise<Doc<"payeeAccounts"> | null> {
  const mode = configuredMode();
  if (!mode) return null;
  return await ctx.db
    .query("payeeAccounts")
    .withIndex("by_token_mode", (q) => q.eq("tokenIdentifier", tokenIdentifier).eq("livemode", isLive(mode)))
    .unique();
}

export type WorkerStage = "demo" | "suspended" | "paused" | "setup" | "action_needed" | "pending" | "frozen" | "ready";

// Where a worker stands on taking real money. Everything but "demo" means demo tips are refused.
export async function workerStage(ctx: QueryCtx, tokenIdentifier: string): Promise<{ stage: WorkerStage; payee: Doc<"payeeAccounts"> | null; enrollment: Doc<"pilotEnrollments"> | null }> {
  const enrollment = await enrollmentFor(ctx, tokenIdentifier);
  if (!enrollment) return { stage: "demo", payee: null, enrollment };
  const payee = await payeeFor(ctx, tokenIdentifier);
  if (enrollment.status === "suspended") return { stage: "suspended", payee, enrollment };
  if (!configuredMode()) return { stage: "paused", payee, enrollment };
  if (!payee) return { stage: "setup", payee, enrollment };
  if (payee.frozenReason) return { stage: "frozen", payee, enrollment };
  if (!canReceive(payee.transfersStatus)) return { stage: payee.requirementsDue > 0 ? "action_needed" : "pending", payee, enrollment };
  const controls = await getControls(ctx);
  if (!controls?.chargesEnabled) return { stage: "paused", payee, enrollment };
  return { stage: "ready", payee, enrollment };
}

export async function raiseAlert(
  ctx: MutationCtx,
  a: { kind: string; severity: "critical" | "warning"; message: string; ref?: string; dedupeKey?: string },
) {
  const dedupeKey = a.dedupeKey ?? `${a.kind}:${a.ref ?? a.message}`;
  const existing = await ctx.db.query("opsAlerts").withIndex("by_dedupe", (q) => q.eq("dedupeKey", dedupeKey)).first();
  if (existing && existing.resolvedAt === undefined) return;
  await ctx.db.insert("opsAlerts", { ...a, dedupeKey, at: Date.now() });
  await ctx.scheduler.runAfter(0, internal.paymentsNode.sendAlert, { kind: a.kind, severity: a.severity, message: a.message });
}

// Stops money going to this worker and tells Stripe to stop their payouts.
export async function freezePayee(ctx: MutationCtx, payee: Doc<"payeeAccounts">, reason: string) {
  await ctx.db.patch(payee._id, { frozenReason: reason, payoutsPaused: true });
  await ctx.scheduler.runAfter(0, internal.paymentsNode.setPayoutsPaused, { payeeAccountId: payee._id, paused: true });
}

type Post = { ref: string; debit: string; credit: string; amountCents: number; livemode: boolean; tipPaymentId?: Id<"tipPayments">; allocationId?: Id<"allocations">; workerId?: Id<"workers">; stripeObjectId?: string };

export async function post(ctx: MutationCtx, p: Post) {
  if (p.amountCents === 0) return;
  if (!Number.isInteger(p.amountCents) || p.amountCents < 0) throw new Error(`Bad ledger amount ${p.amountCents}`);
  const existing = await ctx.db.query("ledgerEntries").withIndex("by_ref", (q) => q.eq("ref", p.ref)).first();
  if (existing) return;
  await ctx.db.insert("ledgerEntries", { ...p, at: Date.now() });
}

const HOUR = 60 * 60 * 1000;

async function insertAllocation(
  ctx: MutationCtx,
  tip: Doc<"tipPayments">,
  payee: Doc<"payeeAccounts">,
  workerId: Id<"workers">,
  grossCents: number,
  crewId: Id<"crews"> | undefined,
) {
  const controls = await getControls(ctx);
  const hold = (controls?.transferHoldHours ?? 24) * HOUR;
  await ctx.db.insert("allocations", {
    tipPaymentId: tip._id,
    workerId,
    payeeAccountId: payee._id,
    stripeAccountId: payee.stripeAccountId,
    crewId,
    grossCents,
    targetCents: 0, // rebalanceTip sets this, counting any refunds that arrived first
    paidCents: 0,
    unrecoveredCents: 0,
    state: "due",
    eligibleAt: (tip.paidAt ?? Date.now()) + hold,
    seq: 0,
    attempts: 0,
    transfers: [],
  });
}

// A tip that isn't going to a crew: all of it is the receiving worker's.
export async function allocateSolo(ctx: MutationCtx, tip: Doc<"tipPayments">) {
  const existing = await ctx.db.query("allocations").withIndex("by_tip", (q) => q.eq("tipPaymentId", tip._id)).first();
  if (existing) return;
  const payee = await ctx.db.get(tip.payeeAccountId);
  if (!payee) throw new Error(`Payment ${tip._id} has no payee account`);
  await insertAllocation(ctx, tip, payee, tip.workerId, tip.netCents, undefined);
  await rebalanceTip(ctx, tip._id);
}

// Applies refunds and disputes: books the change, then sets what each person should end up with.
export async function rebalanceTip(ctx: MutationCtx, tipPaymentId: Id<"tipPayments">) {
  const tip = await ctx.db.get(tipPaymentId);
  if (!tip) return;
  const e = entitlement(tip);
  const netDelta = e.netTakenCents - tip.postedNetTakenCents;
  const feeDelta = e.feesTakenCents - tip.postedFeesTakenCents;
  if (netDelta !== 0 || feeDelta !== 0) {
    const stamp = `${tip.refundedCents}:${tip.disputedCents}`;
    for (const row of adjustmentPostings(netDelta, feeDelta)) {
      await post(ctx, {
        ref: `tip:${tip._id}:adjust:${stamp}:${row.debit}:${row.credit}`,
        debit: row.debit,
        credit: row.credit,
        amountCents: row.amountCents,
        livemode: tip.livemode,
        tipPaymentId: tip._id,
        workerId: tip.workerId,
      });
    }
    await ctx.db.patch(tip._id, { postedNetTakenCents: e.netTakenCents, postedFeesTakenCents: e.feesTakenCents });
  }
  const allocations = await ctx.db.query("allocations").withIndex("by_tip", (q) => q.eq("tipPaymentId", tip._id)).collect();
  if (allocations.length === 0) return;
  const targets = allocationTargets(e.entitledCents, allocations.map((a) => a.grossCents));
  for (let i = 0; i < allocations.length; i++) {
    await setTarget(ctx, allocations[i], targets[i]);
  }
}

async function setTarget(ctx: MutationCtx, a: Doc<"allocations">, targetCents: number) {
  let { paidCents, unrecoveredCents } = a;
  // A dispute won back after a reversal failed: first clear what the worker was marked as owing.
  const due = allocationDue({ targetCents, paidCents, unrecoveredCents });
  if (due > 0 && unrecoveredCents > 0) {
    const clear = Math.min(due, unrecoveredCents);
    const payee = await ctx.db.get(a.payeeAccountId);
    const stillOwed = Math.min(payee?.owedCents ?? 0, clear);
    if (payee && stillOwed > 0) await ctx.db.patch(payee._id, { owedCents: payee.owedCents - stillOwed });
    unrecoveredCents -= clear;
    // What was already taken from their later transfers has to be paid back to them.
    paidCents -= clear - stillOwed;
  }
  const after = allocationDue({ targetCents, paidCents, unrecoveredCents });
  await ctx.db.patch(a._id, {
    targetCents,
    paidCents,
    unrecoveredCents,
    // A Stripe call in progress finishes first; completing it re-evaluates the state.
    ...(a.state === "in_flight" ? {} : { state: after === 0 ? ("settled" as const) : ("due" as const) }),
  });
}

// Turns a closed real crew's pool into allocations. Returns each member's total.
export async function allocateCrewPool(
  ctx: MutationCtx,
  crew: Doc<"crews">,
  tips: Doc<"tipPayments">[],
  members: { workerId: Id<"workers">; payee: Doc<"payeeAccounts"> | null }[],
  weights: number[],
): Promise<number[]> {
  const totals = members.map(() => 0);
  const usable = weights.map((w, i) => (members[i].payee ? w : 0));
  const canSplit = usable.some((w) => w > 0);
  let index = 0;
  for (const tip of tips) {
    // Payments under review wait for a person, and go to the worker who took them after that.
    if (tip.reviewReason) continue;
    if (!canSplit) {
      await allocateSolo(ctx, tip);
      continue;
    }
    const shares = splitTipAmongMembers(tip.netCents, usable, index++);
    for (let m = 0; m < members.length; m++) {
      if (shares[m] > 0) await insertAllocation(ctx, tip, members[m].payee!, members[m].workerId, shares[m], crew._id);
    }
    await rebalanceTip(ctx, tip._id);
    const rows = await ctx.db.query("allocations").withIndex("by_tip", (q) => q.eq("tipPaymentId", tip._id)).collect();
    for (const row of rows) {
      const m = members.findIndex((x) => x.workerId === row.workerId);
      if (m >= 0) totals[m] += row.targetCents;
    }
  }
  return totals;
}

// What keeps someone from deleting: anything where money could still move, or be owed.
export async function realMoneyBlock(ctx: QueryCtx, worker: Doc<"workers">): Promise<string | null> {
  const payee = await payeeFor(ctx, worker.tokenIdentifier);
  const tips = await ctx.db.query("tipPayments").withIndex("by_worker", (q) => q.eq("workerId", worker._id)).collect();
  if (tips.some((t) => t.status === "creating" || t.status === "open" || t.status === "processing")) {
    return "A tip of yours is still being processed. Try again in a few minutes.";
  }
  if (tips.some((t) => t.disputeOpen || t.reviewReason)) {
    return "A tip of yours is under review or being disputed. Contact support to delete your account.";
  }
  const allocations = await ctx.db.query("allocations").withIndex("by_worker", (q) => q.eq("workerId", worker._id)).collect();
  if (allocations.some((a) => a.state !== "settled")) {
    return "Some of your tips haven't reached your Stripe account yet. You can delete your account once they have.";
  }
  if (!payee) return null;
  if (payee.frozenReason || payee.owedCents > 0) return "Your payments are on hold. Contact support to delete your account.";
  const fresh = payee.balanceSyncedAt !== undefined && Date.now() - payee.balanceSyncedAt < 5 * 60 * 1000;
  if (!fresh) return "We need to check your Stripe balance first. Open Earnings, refresh it, then try again.";
  if ((payee.balanceAvailableCents ?? 0) !== 0 || (payee.balancePendingCents ?? 0) !== 0) {
    return "You still have money in your Stripe account. You can delete your account once it has been paid out.";
  }
  return null;
}
