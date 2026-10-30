import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { currentWorker } from "./helpers";

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const RESERVED = new Set(["app", "api", "login", "signup", "admin", "settings", "about", "help"]);

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
    const membership = await ctx.db
      .query("crewMembers")
      .withIndex("by_worker", (q) => q.eq("workerId", worker._id))
      .order("desc")
      .first();
    let inCrew = false;
    if (membership && membership.leftAt === undefined) {
      const crew = await ctx.db.get(membership.crewId);
      inCrew = crew?.status === "open";
    }
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
    if (!HANDLE_RE.test(handle) || RESERVED.has(handle)) {
      throw new ConvexError("Pick a link name of 3–30 letters, numbers or dashes.");
    }
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
