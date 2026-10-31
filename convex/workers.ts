import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { activeMembership, currentWorker, requireWorker } from "./helpers";
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
    if (await activeMembership(ctx, worker._id)) {
      throw new ConvexError("Leave or close your crew before deleting your account.");
    }
    for (const table of ["tips", "cashouts"] as const) {
      const rows = await ctx.db.query(table).withIndex("by_worker", (q) => q.eq("workerId", worker._id)).collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }
    const attempts = await ctx.db.query("joinAttempts").withIndex("by_worker", (q) => q.eq("workerId", worker._id)).unique();
    if (attempts) await ctx.db.delete(attempts._id);
    await ctx.db.delete(worker._id);
  },
});
