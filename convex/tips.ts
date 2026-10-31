import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { activeMembership, requireWorker, currentWorker, resolveDayStart } from "./helpers";
import { MAX_TIP_CENTS, MIN_TIP_CENTS, feesCents } from "./lib/money";

const GUEST_TIPS_PER_MINUTE = 10;
const DEMO_PAYERS = ["Apple Pay", "Google Pay", "Visa ••4242", "Mastercard ••4444", "Amex ••0005"];

async function insertTip(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  args: { amountCents: number; coverFees: boolean; source: "qr" | "tap"; payerLabel: string },
) {
  const { amountCents, coverFees } = args;
  if (!Number.isInteger(amountCents) || amountCents < MIN_TIP_CENTS || amountCents > MAX_TIP_CENTS) {
    throw new ConvexError("Tips can be $1 to $500.");
  }
  const fees = feesCents(amountCents);
  const membership = await activeMembership(ctx, worker._id);
  const tipId = await ctx.db.insert("tips", {
    workerId: worker._id,
    amountCents,
    feesCents: fees,
    coveredFees: coverFees,
    netCents: coverFees ? amountCents : amountCents - fees,
    source: args.source,
    payerLabel: args.payerLabel,
    crewId: membership?.crew._id,
    // Payments are simulated until Stripe is connected.
    demo: true,
  });
  return {
    tipId,
    ticket: tipId.slice(-6).toUpperCase(),
    chargedCents: coverFees ? amountCents + fees : amountCents,
    feesCents: fees,
  };
}

// Guest tips from the public tip page (QR code). No account needed.
export const tipFromGuest = mutation({
  args: { handle: v.string(), amountCents: v.number(), coverFees: v.boolean() },
  handler: async (ctx, { handle, amountCents, coverFees }) => {
    const worker = await ctx.db
      .query("workers")
      .withIndex("by_handle", (q) => q.eq("handle", handle.toLowerCase()))
      .unique();
    if (!worker) throw new ConvexError("We couldn't find that person.");
    // This mutation is public, so keep anyone from flooding a worker's ledger.
    const recent = await ctx.db
      .query("tips")
      .withIndex("by_worker", (q) => q.eq("workerId", worker._id))
      .order("desc")
      .take(GUEST_TIPS_PER_MINUTE);
    if (recent.length === GUEST_TIPS_PER_MINUTE && recent[recent.length - 1]._creationTime > Date.now() - 60_000) {
      throw new ConvexError("Lots of tips just came in. Try again in a minute.");
    }
    return await insertTip(ctx, worker, { amountCents, coverFees, source: "qr", payerLabel: "Guest tip" });
  },
});

// Tap to Pay on the worker's own phone. Simulated until Stripe Terminal is connected.
export const recordTap = mutation({
  args: { amountCents: v.number(), coverFees: v.boolean() },
  handler: async (ctx, { amountCents, coverFees }) => {
    const worker = await requireWorker(ctx);
    const payerLabel = DEMO_PAYERS[Math.floor(Math.random() * DEMO_PAYERS.length)];
    return await insertTip(ctx, worker, { amountCents, coverFees, source: "tap", payerLabel });
  },
});

export const today = query({
  args: { dayStart: v.optional(v.number()) },
  handler: async (ctx, { dayStart }) => {
    const worker = await currentWorker(ctx);
    if (!worker) return null;
    const since = resolveDayStart(dayStart);
    const recent = await ctx.db
      .query("tips")
      .withIndex("by_worker", (q) => q.eq("workerId", worker._id))
      .order("desc")
      .take(200);
    const todays = recent.filter((t) => t._creationTime >= since);
    return {
      totalCents: todays.reduce((a, t) => a + t.netCents, 0),
      crewCents: todays.filter((t) => t.crewId !== undefined).reduce((a, t) => a + t.netCents, 0),
      count: todays.length,
      recent: recent.slice(0, 15).map((t) => ({
        _id: t._id,
        at: t._creationTime,
        netCents: t.netCents,
        source: t.source,
        payerLabel: t.payerLabel,
        toCrew: t.crewId !== undefined,
        demo: t.demo,
      })),
    };
  },
});
