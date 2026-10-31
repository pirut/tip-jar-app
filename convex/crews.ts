import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { splitMode } from "./schema";
import { JOIN_WINDOW_MS, activeMembership, currentWorker, joinAttemptsFor, requireWorker, unsettledCrew } from "./helpers";
import { customPercentsValid, effectiveWeights, splitCents, weightsFor, type SplitMember } from "./lib/split";

const HOUR = 60 * 60 * 1000;
const JOIN_FAILS_ALLOWED = 5;
const CREW_NAME_MAX = 60;

function memberHours(m: Doc<"crewMembers">, now: number): number {
  if (m.hoursOverride !== undefined) return m.hoursOverride;
  const end = m.leftAt ?? now;
  return Math.max(0, Math.round((((m.priorMs ?? 0) + end - m.joinedAt) / HOUR) * 4) / 4); // nearest 15 min
}

async function crewState(ctx: { db: MutationCtx["db"] | any }, crew: Doc<"crews">, now: number) {
  const rows: Doc<"crewMembers">[] = await ctx.db
    .query("crewMembers")
    .withIndex("by_crew", (q: any) => q.eq("crewId", crew._id))
    .collect();
  // Everyone who gets paid: people who left are still owed for their time.
  const members = rows.filter((m) => m.removedAt === undefined);
  const tips: Doc<"tips">[] = await ctx.db
    .query("tips")
    .withIndex("by_crew", (q: any) => q.eq("crewId", crew._id))
    .collect();
  const poolCents = tips.reduce((a, t) => a + t.netCents, 0);
  const splitInputs: SplitMember[] = members.map((m) => ({
    hours: memberHours(m, now),
    shares: m.shares,
    pct: m.pct,
  }));
  const valid = crew.splitMode !== "custom" || customPercentsValid(splitInputs);
  const shares = valid ? splitCents(poolCents, effectiveWeights(crew.splitMode, splitInputs)) : null;
  // Weights that add to nothing pay out evenly; say so rather than showing surprising numbers.
  const evenFallback = valid && weightsFor(crew.splitMode, splitInputs).every((w) => w === 0);
  return { members, poolCents, splitInputs, shares, valid, evenFallback };
}

export const current = query({
  args: {},
  handler: async (ctx) => {
    const worker = await currentWorker(ctx);
    if (!worker) return null;
    const membership = await activeMembership(ctx, worker._id);
    if (!membership) {
      // Someone who stepped out of a crew that's still open is owed a share when it closes.
      const open = await unsettledCrew(ctx, worker._id);
      if (open) return { crew: null, leftCrew: { name: open.name, closesAt: open.closesAt } };
      return { crew: null };
    }
    const { crew } = membership;
    const now = Date.now();
    const state = await crewState(ctx, crew, now);
    const members = await Promise.all(
      state.members.map(async (m, i) => {
        const w = await ctx.db.get(m.workerId);
        return {
          memberId: m._id,
          workerId: m.workerId,
          name: w?.name ?? "Someone",
          jobTitle: w?.jobTitle ?? "",
          isMe: m.workerId === worker._id,
          isStarter: m.workerId === crew.starterId,
          left: m.leftAt !== undefined,
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
        evenFallback: state.evenFallback,
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
      if (m.payoutCents === undefined || m.removedAt !== undefined) continue;
      const crew = await ctx.db.get(m.crewId);
      if (!crew || crew.status !== "closed") continue;
      const all = await ctx.db
        .query("crewMembers")
        .withIndex("by_crew", (q) => q.eq("crewId", crew._id))
        .collect();
      const rows = await Promise.all(
        all
          .filter((x) => x.payoutCents !== undefined && x.removedAt === undefined)
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
    if (name.trim().length > CREW_NAME_MAX) throw new ConvexError("That crew name is a bit long. Please shorten it.");
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

type CodeLookup = { ok: true; crew: Doc<"crews"> } | { ok: false; error: string };

// Mutations that throw roll back their writes, so a wrong code returns an error
// instead of throwing. Otherwise the failed guess wouldn't be counted.
async function findCrewByCode(ctx: MutationCtx, worker: Doc<"workers">, code: string): Promise<CodeLookup> {
  const now = Date.now();
  const attempts = await joinAttemptsFor(ctx, worker);
  const inWindow = attempts !== null && now - attempts.windowStart < JOIN_WINDOW_MS;
  if (inWindow && attempts.fails >= JOIN_FAILS_ALLOWED) {
    return { ok: false, error: "Too many wrong codes. Wait 10 minutes and try again." };
  }
  const crew = await ctx.db
    .query("crews")
    .withIndex("by_code_status", (q) => q.eq("code", code.trim()).eq("status", "open"))
    .first();
  if (crew) return { ok: true, crew };
  const { tokenIdentifier } = worker;
  const count = inWindow ? { fails: attempts.fails + 1 } : { windowStart: now, fails: 1 };
  if (attempts) await ctx.db.patch(attempts._id, { tokenIdentifier, workerId: undefined, ...count });
  else await ctx.db.insert("joinAttempts", { tokenIdentifier, windowStart: now, fails: 1 });
  return { ok: false, error: "No open crew has that code." };
}

// Scheduled when an account is deleted mid-window. A window that has ended counts for nothing.
export const purgeJoinAttempts = internalMutation({
  args: { id: v.id("joinAttempts") },
  handler: async (ctx, { id }: { id: Id<"joinAttempts"> }) => {
    const attempts = await ctx.db.get(id);
    if (attempts && Date.now() - attempts.windowStart >= JOIN_WINDOW_MS) await ctx.db.delete(id);
  },
});

// Shows what you'd be joining, so people see the split before they commit.
export const lookup = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const worker = await requireWorker(ctx);
    const found = await findCrewByCode(ctx, worker, code);
    if (!found.ok) return found;
    const { crew } = found;
    const starter = await ctx.db.get(crew.starterId);
    const rows = await ctx.db.query("crewMembers").withIndex("by_crew", (q) => q.eq("crewId", crew._id)).collect();
    return {
      ok: true as const,
      crew: {
        name: crew.name,
        splitMode: crew.splitMode,
        closesAt: crew.closesAt,
        starterName: starter?.name ?? "Someone",
        memberCount: rows.filter((m) => m.leftAt === undefined).length,
      },
    };
  },
});

export const join = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const worker = await requireWorker(ctx);
    if (await activeMembership(ctx, worker._id)) return { ok: false as const, error: "You're already in a crew." };
    const found = await findCrewByCode(ctx, worker, code);
    if (!found.ok) return found;
    const { crew } = found;
    const now = Date.now();
    const rows = await ctx.db.query("crewMembers").withIndex("by_worker", (q) => q.eq("workerId", worker._id)).collect();
    const earlier = rows.find((m) => m.crewId === crew._id);
    if (earlier?.removedAt !== undefined) return { ok: false as const, error: "The crew starter removed you from this crew." };
    if (earlier) {
      // Back from a break: same person, same one share, and earlier hours still count.
      await ctx.db.patch(earlier._id, {
        priorMs: (earlier.priorMs ?? 0) + ((earlier.leftAt ?? now) - earlier.joinedAt),
        joinedAt: now,
        leftAt: undefined,
      });
      return { ok: true as const };
    }
    // Tips received before joining stay with the worker; only new tips go to the pool.
    await ctx.db.insert("crewMembers", { crewId: crew._id, workerId: worker._id, joinedAt: now, shares: 1, pct: 0 });
    return { ok: true as const };
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

// Their own tips go back to them, since they're no longer part of this pool.
export const removeMember = mutation({
  args: { memberId: v.id("crewMembers") },
  handler: async (ctx, { memberId }) => {
    const crew = await requireStarterCrew(ctx);
    const member = await ctx.db.get(memberId);
    if (!member || member.crewId !== crew._id) throw new ConvexError("That person isn't in your crew.");
    if (member.workerId === crew.starterId) throw new ConvexError("You can't remove yourself. Close the crew instead.");
    const now = Date.now();
    await ctx.db.patch(memberId, { removedAt: now, leftAt: member.leftAt ?? now });
    const tips = await ctx.db.query("tips").withIndex("by_crew", (q) => q.eq("crewId", crew._id)).collect();
    for (const tip of tips) {
      if (tip.workerId === member.workerId) await ctx.db.patch(tip._id, { crewId: undefined });
    }
  },
});

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
    if ([hours, shares, pct].some((n) => n !== undefined && !Number.isFinite(n))) throw new ConvexError("Enter a number.");
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
  const all = state.members;
  const start = Math.floor(now / 86400000) % Math.max(1, all.length); // rotate who gets leftover cents
  const payouts = splitCents(state.poolCents, effectiveWeights(crew.splitMode, state.splitInputs), start);
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
