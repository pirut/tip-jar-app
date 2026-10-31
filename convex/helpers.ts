import { ConvexError } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

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

// The crew a worker is currently in (open crew, not left), if any.
export async function activeMembership(
  ctx: QueryCtx,
  workerId: Id<"workers">,
): Promise<{ member: Doc<"crewMembers">; crew: Doc<"crews"> } | null> {
  const memberships = await ctx.db
    .query("crewMembers")
    .withIndex("by_worker", (q) => q.eq("workerId", workerId))
    .order("desc")
    .take(20);
  for (const member of memberships) {
    if (member.leftAt !== undefined) continue;
    const crew = await ctx.db.get(member.crewId);
    if (crew && crew.status === "open") return { member, crew };
  }
  return null;
}

// The start of the worker's day. Only their device knows their time zone, so clients
// pass it in. Anything implausible falls back to midnight UTC.
export function resolveDayStart(dayStart: number | undefined, now = Date.now()): number {
  if (dayStart !== undefined && Number.isFinite(dayStart) && Math.abs(now - dayStart) <= 36 * 60 * 60 * 1000) return dayStart;
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}
