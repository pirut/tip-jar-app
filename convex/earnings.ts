import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { currentWorker, requireWorker, resolveDayStart } from "./helpers";
import { instantFeeCents } from "./lib/money";
import { allocationDue, entitlement } from "./lib/paymentRules";
import { enrollmentFor, workerStage } from "./lib/paymentsDb";
import { configuredMode } from "./lib/stripeEnv";

const DAY = 86400000;

async function ledger(ctx: QueryCtx, workerId: Id<"workers">) {
  const tips = await ctx.db.query("tips").withIndex("by_worker", (q) => q.eq("workerId", workerId)).collect();
  const memberships = await ctx.db
    .query("crewMembers")
    .withIndex("by_worker", (q) => q.eq("workerId", workerId))
    .collect();
  const cashouts = await ctx.db.query("cashouts").withIndex("by_worker", (q) => q.eq("workerId", workerId)).collect();

  const soloCents = tips.filter((t) => t.crewId === undefined).reduce((a, t) => a + t.netCents, 0);
  // This ledger is demo money only. Real crew payouts live in allocations.
  const crewPaidCents = memberships.filter((m) => !m.realMoney).reduce((a, m) => a + (m.payoutCents ?? 0), 0);
  const cashedCents = cashouts.reduce((a, c) => a + c.amountCents, 0);
  const settledCrews = new Set(memberships.filter((m) => m.payoutCents !== undefined).map((m) => m.crewId));
  const pendingCrewCents = tips
    .filter((t) => t.crewId !== undefined && !settledCrews.has(t.crewId))
    .reduce((a, t) => a + t.netCents, 0);
  return { tips, memberships, cashouts, balanceCents: soloCents + crewPaidCents - cashedCents, pendingCrewCents };
}

export const summary = query({
  args: { dayStart: v.optional(v.number()) },
  handler: async (ctx, { dayStart }) => {
    const worker = await currentWorker(ctx);
    if (!worker) return null;
    const l = await ledger(ctx, worker._id);
    // Earned per day for the last 7 days: solo tips plus crew payouts, by day received.
    const today = resolveDayStart(dayStart);
    const days = Array.from({ length: 7 }, (_, i) => ({ start: today - (6 - i) * DAY, cents: 0 }));
    const add = (at: number, cents: number) => {
      const d = days.find((x) => at >= x.start && at < x.start + DAY);
      if (d) d.cents += cents;
    };
    for (const t of l.tips) if (t.crewId === undefined) add(t._creationTime, t.netCents);
    // Crews stay open 24 hours at most, so anyone who left before that can't land on the chart.
    const paid = l.memberships.filter((m) => !m.realMoney && m.payoutCents !== undefined && m.leftAt !== undefined && m.leftAt >= days[0].start - DAY);
    for (const m of paid) {
      const crew = await ctx.db.get(m.crewId);
      add(crew?.closedAt ?? m.leftAt!, m.payoutCents!);
    }
    return {
      balanceCents: l.balanceCents,
      pendingCrewCents: l.pendingCrewCents,
      instantFeeCents: instantFeeCents(l.balanceCents),
      week: days,
      cashouts: l.cashouts
        .slice(-10)
        .reverse()
        .map((c) => ({ at: c._creationTime, amountCents: c.amountCents, feeCents: c.feeCents, demo: c.demo })),
    };
  },
});

// Real money for a pilot worker. Available and pending are Stripe's figures for their account;
// on hold and in a pool are ours, because that money hasn't left the platform yet. Never mixed with demo.
export const real = query({
  args: { dayStart: v.optional(v.number()) },
  handler: async (ctx, { dayStart }) => {
    const worker = await currentWorker(ctx);
    if (!worker) return null;
    const { stage, payee } = await workerStage(ctx, worker.tokenIdentifier);
    if (stage === "demo") return null;
    const allocations = await ctx.db.query("allocations").withIndex("by_worker", (q) => q.eq("workerId", worker._id)).collect();
    const payments = await ctx.db.query("tipPayments").withIndex("by_worker", (q) => q.eq("workerId", worker._id)).order("desc").take(500);
    const today = resolveDayStart(dayStart);
    const days = Array.from({ length: 7 }, (_, i) => ({ start: today - (6 - i) * DAY, cents: 0 }));
    const add = (at: number, cents: number) => {
      const d = days.find((x) => at >= x.start && at < x.start + DAY);
      if (d) d.cents += cents;
    };
    for (const a of allocations) {
      const tip = await ctx.db.get(a.tipPaymentId);
      add(tip?.paidAt ?? a._creationTime, a.targetCents);
    }
    let crewPoolCents = 0;
    for (const p of payments) {
      if (p.status !== "succeeded" || p.crewId === undefined) continue;
      const crew = await ctx.db.get(p.crewId);
      if (crew?.status === "open") crewPoolCents += entitlement(p).entitledCents;
    }
    const payouts = payee
      ? await ctx.db.query("payouts").withIndex("by_payee", (q) => q.eq("payeeAccountId", payee._id)).order("desc").take(10)
      : [];
    const now = Date.now();
    return {
      testMode: !(payee?.livemode ?? configuredMode() === "live"),
      stage,
      availableCents: payee?.balanceAvailableCents ?? null,
      stripePendingCents: payee?.balancePendingCents ?? null,
      balanceSyncedAt: payee?.balanceSyncedAt ?? null,
      onHoldCents: allocations.reduce((a, x) => a + Math.max(0, allocationDue(x)), 0),
      nextTransferAt: allocations.filter((a) => a.state === "due" && allocationDue(a) > 0).map((a) => a.eligibleAt).sort((a, b) => a - b)[0] ?? null,
      crewPoolCents,
      owedCents: payee?.owedCents ?? 0,
      payoutsPaused: payee?.payoutsPaused ?? false,
      week: days,
      payouts: payouts.map((p) => ({ id: p.stripePayoutId, amountCents: p.amountCents, status: p.status, arrivalDate: p.arrivalDate, failureMessage: p.failureMessage })),
      now,
    };
  },
});

export const cashOutInstant = mutation({
  args: {},
  handler: async (ctx) => {
    const worker = await requireWorker(ctx);
    // Demo only. Real money reaches a pilot worker's bank through Stripe's own payouts.
    if (await enrollmentFor(ctx, worker.tokenIdentifier)) throw new ConvexError("Your real money pays out to your bank automatically. Old demo balances can't be cashed out.");
    const { balanceCents } = await ledger(ctx, worker._id);
    const fee = instantFeeCents(balanceCents);
    if (balanceCents <= fee) throw new ConvexError("Not enough in your balance to cash out yet.");
    await ctx.db.insert("cashouts", {
      workerId: worker._id,
      amountCents: balanceCents,
      feeCents: fee,
      instant: true,
      demo: true,
    });
    return { sentCents: balanceCents - fee, feeCents: fee };
  },
});
