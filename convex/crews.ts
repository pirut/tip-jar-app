import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { splitMode } from "./schema";
import { activeMembership, currentWorker, requireWorker } from "./helpers";
import { customPercentsValid, splitCents, weightsFor, type SplitMember } from "./lib/split";

const HOUR = 60 * 60 * 1000;

function memberHours(m: Doc<"crewMembers">, now: number): number {
  if (m.hoursOverride !== undefined) return m.hoursOverride;
  const end = m.leftAt ?? now;
  return Math.max(0, Math.round(((end - m.joinedAt) / HOUR) * 4) / 4); // nearest 15 min
}

async function crewState(ctx: { db: MutationCtx["db"] | any }, crew: Doc<"crews">, now: number) {
  const members: Doc<"crewMembers">[] = await ctx.db
    .query("crewMembers")
    .withIndex("by_crew", (q: any) => q.eq("crewId", crew._id))
    .collect();
  const active = members.filter((m) => m.leftAt === undefined);
  const tips: Doc<"tips">[] = await ctx.db
    .query("tips")
    .withIndex("by_crew", (q: any) => q.eq("crewId", crew._id))
    .collect();
  const poolCents = tips.reduce((a, t) => a + t.netCents, 0);
  const splitInputs: SplitMember[] = active.map((m) => ({
    hours: memberHours(m, now),
    shares: m.shares,
    pct: m.pct,
  }));
  const valid = crew.splitMode !== "custom" || customPercentsValid(splitInputs);
  const shares = valid ? splitCents(poolCents, weightsFor(crew.splitMode, splitInputs)) : null;
  return { active, poolCents, splitInputs, shares, valid };
}

export const current = query({
  args: {},
  handler: async (ctx) => {
    const worker = await currentWorker(ctx);
    if (!worker) return null;
    const membership = await activeMembership(ctx, worker._id);
    if (!membership) return { crew: null };
    const { crew } = membership;
    const now = Date.now();
    const state = await crewState(ctx, crew, now);
    const members = await Promise.all(
      state.active.map(async (m, i) => {
        const w = await ctx.db.get(m.workerId);
        return {
          memberId: m._id,
          workerId: m.workerId,
          name: w?.name ?? "Someone",
          jobTitle: w?.jobTitle ?? "",
          isMe: m.workerId === worker._id,
          isStarter: m.workerId === crew.starterId,
          hours: state.splitInputs[i].hours,
          shares: m.shares,
          pct: m.pct,
          projectedCents: state.shares ? state.shares[i] : null,
        };
      }),
    );
    return {
      crew: {
        _id: crew._id,
        name: crew.name,
        code: crew.code,
        splitMode: crew.splitMode,
        closesAt: crew.closesAt,
        poolCents: state.poolCents,
        splitValid: state.valid,
        iAmStarter: crew.starterId === worker._id,
        members,
      },
    };
  },
});

// Most recent closed crew payout for this worker, for the "crew closed" summary.
export const lastClosed = query({
  args: {},
  handler: async (ctx) => {
    const worker = await currentWorker(ctx);
    if (!worker) return null;
    const mine = await ctx.db
      .query("crewMembers")
      .withIndex("by_worker", (q) => q.eq("workerId", worker._id))
      .order("desc")
      .take(10);
    for (const m of mine) {
      if (m.payoutCents === undefined) continue;
      const crew = await ctx.db.get(m.crewId);
      if (!crew || crew.status !== "closed") continue;
      const all = await ctx.db
        .query("crewMembers")
        .withIndex("by_crew", (q) => q.eq("crewId", crew._id))
        .collect();
      const rows = await Promise.all(
        all
          .filter((x) => x.payoutCents !== undefined)
          .map(async (x) => ({ name: (await ctx.db.get(x.workerId))?.name ?? "Someone", payoutCents: x.payoutCents! })),
      );
      return { name: crew.name, splitMode: crew.splitMode, closedAt: crew.closedAt, myPayoutCents: m.payoutCents, rows };
    }
    return null;
  },
});

async function newCode(ctx: MutationCtx): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const clash = await ctx.db
      .query("crews")
      .withIndex("by_code_status", (q) => q.eq("code", code).eq("status", "open"))
      .first();
    if (!clash) return code;
  }
  throw new ConvexError("Couldn't make a crew code. Try again.");
}

export const start = mutation({
  args: { name: v.string(), splitMode, closesInHours: v.number() },
  handler: async (ctx, { name, splitMode, closesInHours }) => {
    const worker = await requireWorker(ctx);
    if (await activeMembership(ctx, worker._id)) throw new ConvexError("Leave your current crew first.");
    if (!(closesInHours > 0 && closesInHours <= 24)) throw new ConvexError("A crew can stay open up to 24 hours.");
    const now = Date.now();
    const closesAt = now + closesInHours * HOUR;
    const crewId = await ctx.db.insert("crews", {
      name: name.trim() || `${worker.workplace || worker.name}'s crew`,
      code: await newCode(ctx),
      starterId: worker._id,
      splitMode,
      status: "open",
      closesAt,
    });
    await ctx.db.insert("crewMembers", { crewId, workerId: worker._id, joinedAt: now, shares: 1, pct: 0 });
    await ctx.scheduler.runAt(closesAt, internal.crews.autoClose, { crewId });
    return crewId;
  },
});

export const join = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const worker = await requireWorker(ctx);
    if (await activeMembership(ctx, worker._id)) throw new ConvexError("You're already in a crew.");
    const crew = await ctx.db
      .query("crews")
      .withIndex("by_code_status", (q) => q.eq("code", code.trim()).eq("status", "open"))
      .first();
    if (!crew) throw new ConvexError("No open crew has that code.");
    // Tips received before joining stay with the worker; only new tips go to the pool.
    await ctx.db.insert("crewMembers", {
      crewId: crew._id,
      workerId: worker._id,
      joinedAt: Date.now(),
      shares: 1,
      pct: 0,
    });
    return crew._id;
  },
});

export const leave = mutation({
  args: {},
  handler: async (ctx) => {
    const worker = await requireWorker(ctx);
    const membership = await activeMembership(ctx, worker._id);
    if (!membership) return;
    if (membership.crew.starterId === worker._id) {
      throw new ConvexError("You started this crew. Close it instead of leaving.");
    }
    // Leaving keeps your hours so far; your share is settled when the crew closes.
    await ctx.db.patch(membership.member._id, { leftAt: Date.now() });
  },
});

async function requireStarterCrew(ctx: MutationCtx) {
  const worker = await requireWorker(ctx);
  const membership = await activeMembership(ctx, worker._id);
  if (!membership) throw new ConvexError("You're not in a crew.");
  if (membership.crew.starterId !== worker._id) {
    throw new ConvexError("Only the person who started the crew can change this.");
  }
  return membership.crew;
}

export const setSplitMode = mutation({
  args: { splitMode },
  handler: async (ctx, { splitMode }) => {
    const crew = await requireStarterCrew(ctx);
    await ctx.db.patch(crew._id, { splitMode });
  },
});

export const setMemberWeights = mutation({
  args: {
    memberId: v.id("crewMembers"),
    hours: v.optional(v.number()),
    shares: v.optional(v.number()),
    pct: v.optional(v.number()),
  },
  handler: async (ctx, { memberId, hours, shares, pct }) => {
    const crew = await requireStarterCrew(ctx);
    const member = await ctx.db.get(memberId);
    if (!member || member.crewId !== crew._id) throw new ConvexError("That person isn't in your crew.");
    const patch: Partial<Doc<"crewMembers">> = {};
    if (hours !== undefined) patch.hoursOverride = Math.max(0, Math.min(24, hours));
    if (shares !== undefined) patch.shares = Math.max(0, Math.min(10, shares));
    if (pct !== undefined) patch.pct = Math.max(0, Math.min(100, Math.round(pct)));
    await ctx.db.patch(memberId, patch);
  },
});

async function closeCrew(ctx: MutationCtx, crew: Doc<"crews">) {
  if (crew.status === "closed") return;
  const now = Date.now();
  const state = await crewState(ctx, crew, now);
  // Members who left earlier still get paid for their time, so settle everyone who joined.
  const all: Doc<"crewMembers">[] = await ctx.db
    .query("crewMembers")
    .withIndex("by_crew", (q) => q.eq("crewId", crew._id))
    .collect();
  const inputs = all.map((m) => ({ hours: memberHours(m, now), shares: m.shares, pct: m.pct }));
  let weights = weightsFor(crew.splitMode, inputs);
  if (crew.splitMode === "custom" && !state.valid) weights = inputs.map(() => 1); // fall back to even
  const start = Math.floor(now / 86400000) % Math.max(1, all.length); // rotate who gets leftover cents
  const payouts = splitCents(state.poolCents, weights, start);
  for (let i = 0; i < all.length; i++) {
    await ctx.db.patch(all[i]._id, { payoutCents: payouts[i], leftAt: all[i].leftAt ?? now });
  }
  await ctx.db.patch(crew._id, { status: "closed", closedAt: now });
}

export const close = mutation({
  args: {},
  handler: async (ctx) => {
    const crew = await requireStarterCrew(ctx);
    const state = await crewState(ctx, crew, Date.now());
    if (!state.valid) throw new ConvexError("Custom percents need to add up to 100% before closing.");
    await closeCrew(ctx, crew);
  },
});

export const autoClose = internalMutation({
  args: { crewId: v.id("crews") },
  handler: async (ctx, { crewId }: { crewId: Id<"crews"> }) => {
    const crew = await ctx.db.get(crewId);
    if (crew) await closeCrew(ctx, crew);
  },
});
