import { ConvexError } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

export const JOIN_WINDOW_MS = 10 * 60 * 1000;

export async function currentWorker(ctx: QueryCtx): Promise<Doc<"workers"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("workers")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
}

export async function requireWorker(ctx: QueryCtx): Promise<Doc<"workers">> {
  const worker = await currentWorker(ctx);
  if (!worker) throw new ConvexError("Sign in and set up your profile first.");
  return worker;
}

// Who a tip link pays. A renamed link keeps paying the same person, because it may be printed
// somewhere. A deleted worker's link stays dead rather than ever paying someone else.
export async function resolveWorkerByHandle(ctx: QueryCtx, rawHandle: string): Promise<Doc<"workers"> | null> {
  const handle = rawHandle.toLowerCase();
  const worker = await ctx.db.query("workers").withIndex("by_handle", (q) => q.eq("handle", handle)).unique();
  if (worker) return worker;
  const claim = await ctx.db.query("handleClaims").withIndex("by_handle", (q) => q.eq("handle", handle)).unique();
  return claim?.workerId ? await ctx.db.get(claim.workerId) : null;
}

// The crew a worker is currently in (open crew, not left), if any.
export async function activeMembership(
  ctx: QueryCtx,
  workerId: Id<"workers">,
): Promise<{ member: Doc<"crewMembers">; crew: Doc<"crews"> } | null> {
  // Someone can rejoin an old crew, so the row that matters isn't always a recent one.
  const memberships = await ctx.db
    .query("crewMembers")
    .withIndex("by_worker", (q) => q.eq("workerId", workerId))
    .order("desc")
    .collect();
  for (const member of memberships) {
    if (member.leftAt !== undefined) continue;
    const crew = await ctx.db.get(member.crewId);
    if (crew && crew.status === "open") return { member, crew };
  }
  return null;
}

// The newest open crew that still owes this worker a share, including one they stepped
// out of. Only people the starter removed are off the hook.
export async function unsettledCrew(ctx: QueryCtx, workerId: Id<"workers">): Promise<Doc<"crews"> | null> {
  const memberships = await ctx.db
    .query("crewMembers")
    .withIndex("by_worker", (q) => q.eq("workerId", workerId))
    .order("desc")
    .collect();
  for (const member of memberships) {
    if (member.removedAt !== undefined || member.payoutCents !== undefined) continue;
    const crew = await ctx.db.get(member.crewId);
    if (crew && crew.status === "open") return crew;
  }
  return null;
}

// Counts written before limits moved to the sign-in identity are still keyed by worker.
export async function joinAttemptsFor(ctx: QueryCtx, worker: Doc<"workers">): Promise<Doc<"joinAttempts"> | null> {
  const attempts = await ctx.db
    .query("joinAttempts")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", worker.tokenIdentifier))
    .unique();
  if (attempts) return attempts;
  return await ctx.db.query("joinAttempts").withIndex("by_worker", (q) => q.eq("workerId", worker._id)).unique();
}

// The start of the worker's day. Only their device knows their time zone, so clients
// pass it in. Anything implausible falls back to midnight UTC.
export function resolveDayStart(dayStart: number | undefined, now = Date.now()): number {
  if (dayStart !== undefined && Number.isFinite(dayStart) && Math.abs(now - dayStart) <= 36 * 60 * 60 * 1000) return dayStart;
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}
