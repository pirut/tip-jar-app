import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { activeMembership, requireWorker, currentWorker, resolveDayStart, resolveWorkerByHandle } from "./helpers";
import { MAX_TIP_CENTS, MIN_TIP_CENTS, feesCents } from "./lib/money";
import { entitlement } from "./lib/paymentRules";
import { enrollmentFor, workerStage } from "./lib/paymentsDb";

const GUEST_TIPS_PER_MINUTE = 10;
const DEMO_PAYERS = ["Apple Pay", "Google Pay", "Visa ••4242", "Mastercard ••4444", "Amex ••0005"];

// Someone in the real-money pilot must never collect a pretend tip by accident.
async function refuseDemoForPilot(ctx: MutationCtx, worker: Doc<"workers">) {
  if (await enrollmentFor(ctx, worker.tokenIdentifier)) {
    throw new ConvexError("This worker takes real tips, so demo tips are turned off.");
  }
}

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
  // A demo tip can't join a real pool. Enrollment rules make this unreachable; this keeps it so.
  if (membership?.crew.moneyMode === "real") throw new ConvexError("This crew takes real tips, so demo tips are turned off.");
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
    const worker = await resolveWorkerByHandle(ctx, handle);
    if (!worker) throw new ConvexError("We couldn't find that person.");
    await refuseDemoForPilot(ctx, worker);
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

// A simulated tap for demo accounts. Real Tap to Pay is coming later.
export const recordTap = mutation({
  args: { amountCents: v.number(), coverFees: v.boolean() },
  handler: async (ctx, { amountCents, coverFees }) => {
    const worker = await requireWorker(ctx);
    await refuseDemoForPilot(ctx, worker);
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
    const { stage } = await workerStage(ctx, worker.tokenIdentifier);
    // Pilot workers see real money only. Old demo tips are on the Earnings screen, kept apart.
    if (stage !== "demo") {
      const payments = await ctx.db
        .query("tipPayments")
        .withIndex("by_worker", (q) => q.eq("workerId", worker._id))
        .order("desc")
        .take(200);
      const paid = payments.filter((p) => p.status === "succeeded");
      const todaysPaid = paid.filter((p) => (p.paidAt ?? p._creationTime) >= since);
      return {
        totalCents: todaysPaid.reduce((a, p) => a + entitlement(p).entitledCents, 0),
        crewCents: todaysPaid.filter((p) => p.crewId !== undefined).reduce((a, p) => a + entitlement(p).entitledCents, 0),
        count: todaysPaid.length,
        recent: paid.slice(0, 15).map((p) => ({
          _id: p._id as string,
          at: p.paidAt ?? p._creationTime,
          netCents: entitlement(p).entitledCents,
          source: "qr" as const,
          payerLabel: p.cardBrand ? p.cardBrand[0].toUpperCase() + p.cardBrand.slice(1) : "Guest tip",
          toCrew: p.crewId !== undefined,
          demo: false,
          test: !p.livemode,
          refunded: p.refundedCents > 0,
          disputed: p.disputeOpen,
        })),
      };
    }
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
        _id: t._id as string,
        at: t._creationTime,
        netCents: t.netCents,
        source: t.source,
        payerLabel: t.payerLabel,
        toCrew: t.crewId !== undefined,
        demo: t.demo,
        test: false,
        refunded: false,
        disputed: false,
      })),
    };
  },
});
