import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { currentWorker, requireWorker, resolveDayStart } from "./helpers";
import { instantFeeCents } from "./lib/money";

const DAY = 86400000;

async function ledger(ctx: QueryCtx, workerId: Id<"workers">) {
  const tips = await ctx.db.query("tips").withIndex("by_worker", (q) => q.eq("workerId", workerId)).collect();
  const memberships = await ctx.db
    .query("crewMembers")
    .withIndex("by_worker", (q) => q.eq("workerId", workerId))
    .collect();
  const cashouts = await ctx.db.query("cashouts").withIndex("by_worker", (q) => q.eq("workerId", workerId)).collect();

  const soloCents = tips.filter((t) => t.crewId === undefined).reduce((a, t) => a + t.netCents, 0);
  const crewPaidCents = memberships.reduce((a, m) => a + (m.payoutCents ?? 0), 0);
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
    for (const m of l.memberships) if (m.payoutCents !== undefined && m.leftAt) add(m.leftAt, m.payoutCents);
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

export const cashOutInstant = mutation({
  args: {},
  handler: async (ctx) => {
    const worker = await requireWorker(ctx);
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
