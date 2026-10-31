import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { JOIN_WINDOW_MS, activeMembership, currentWorker, joinAttemptsFor, requireWorker, unsettledCrew } from "./helpers";
import { handleError } from "./lib/handles";

export const me = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const worker = await currentWorker(ctx);
    return { signedIn: true as const, worker };
  },
});

// Public: what a guest sees on the tip page.
export const byHandle = query({
  args: { handle: v.string() },
  handler: async (ctx, { handle }) => {
    const worker = await ctx.db
      .query("workers")
      .withIndex("by_handle", (q) => q.eq("handle", handle.toLowerCase()))
      .unique();
    if (!worker) return null;
    const inCrew = (await activeMembership(ctx, worker._id)) !== null;
    return {
      name: worker.name,
      handle: worker.handle,
      jobTitle: worker.jobTitle,
      workplace: worker.workplace,
      inCrew,
    };
  },
});

export const saveProfile = mutation({
  args: {
    name: v.string(),
    handle: v.string(),
    jobTitle: v.string(),
    workplace: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Sign in first.");
    const handle = args.handle.trim().toLowerCase();
    const name = args.name.trim();
    if (!name) throw new ConvexError("Add your name.");
    if (name.length > 60 || args.jobTitle.length > 60 || args.workplace.length > 80) {
      throw new ConvexError("That's a bit long. Please shorten it.");
    }
    const invalid = handleError(handle);
    if (invalid) throw new ConvexError(invalid);
    const taken = await ctx.db
      .query("workers")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    const existing = await currentWorker(ctx);
    if (taken && taken._id !== existing?._id) throw new ConvexError("That link name is taken.");
    const fields = { name, handle, jobTitle: args.jobTitle.trim(), workplace: args.workplace.trim() };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("workers", { tokenIdentifier: identity.tokenIdentifier, ...fields });
  },
});

// Store rules require in-app account deletion. Crew history keeps the row, so other
// people's payouts still add up; the name shows as "Someone" once the worker is gone.
export const deleteAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const worker = await requireWorker(ctx);
    // An open crew's pool is made of its members' tips, so they have to stay until it closes.
    const crew = await unsettledCrew(ctx, worker._id);
    if (crew) {
      throw new ConvexError(
        crew.starterId === worker._id
          ? "Close your crew before deleting your account."
          : `${crew.name} is still open and your share isn't settled yet. You can delete your account once it closes, within 24 hours.`,
      );
    }
    for (const table of ["tips", "cashouts"] as const) {
      const rows = await ctx.db.query(table).withIndex("by_worker", (q) => q.eq("workerId", worker._id)).collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }
    // A running count stays until its window ends, or recreating a profile would reset the
    // limit. The cleanup goes by row id so the identity doesn't sit in the scheduler log.
    const attempts = await joinAttemptsFor(ctx, worker);
    if (attempts) {
      const windowEnd = attempts.windowStart + JOIN_WINDOW_MS;
      if (Date.now() >= windowEnd) {
        await ctx.db.delete(attempts._id);
      } else {
        await ctx.db.patch(attempts._id, { tokenIdentifier: worker.tokenIdentifier, workerId: undefined });
        await ctx.scheduler.runAt(windowEnd, internal.crews.purgeJoinAttempts, { id: attempts._id });
      }
    }
    await ctx.db.delete(worker._id);
  },
});
