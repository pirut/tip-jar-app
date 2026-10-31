import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { JOIN_WINDOW_MS } from "./helpers";

// joinAttempts moved from workerId to tokenIdentifier. After this version is deployed:
//   npx convex run migrations:keyJoinAttemptsByIdentity '{"dryRun":true}'
//   npx convex run migrations:keyJoinAttemptsByIdentity
//   npx convex run migrations:joinAttemptsKeyedByWorker    # wait for 0
// Then make tokenIdentifier required, drop workerId and by_worker, drop the by_worker
// fallback in joinAttemptsFor, and delete this file.
export const keyJoinAttemptsByIdentity = internalMutation({
  args: { cursor: v.optional(v.string()), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { cursor, dryRun }): Promise<{ moved: number; deleted: number; isDone: boolean }> => {
    const { page, isDone, continueCursor } = await ctx.db
      .query("joinAttempts")
      .paginate({ cursor: cursor ?? null, numItems: 100 });
    let moved = 0;
    let deleted = 0;
    for (const row of page) {
      if (row.tokenIdentifier !== undefined || row.workerId === undefined) continue;
      const worker = await ctx.db.get(row.workerId);
      // An ended window counts for nothing, and neither does a count nobody can reach.
      if (!worker || Date.now() - row.windowStart >= JOIN_WINDOW_MS) {
        deleted++;
        if (!dryRun) await ctx.db.delete(row._id);
      } else {
        // A functions-only rollback can create a legacy row beside an identity row.
        // Reconcile them before narrowing so identity lookups remain unique.
        const existing = await ctx.db.query("joinAttempts")
          .withIndex("by_token", (q) => q.eq("tokenIdentifier", worker.tokenIdentifier))
          .unique();
        if (existing) {
          deleted++;
          if (!dryRun) {
            const existingActive = Date.now() - existing.windowStart < JOIN_WINDOW_MS;
            await ctx.db.patch(existing._id, {
              fails: row.fails + (existingActive ? existing.fails : 0),
              windowStart: existingActive ? Math.max(existing.windowStart, row.windowStart) : row.windowStart,
            });
            await ctx.db.delete(row._id);
          }
        } else {
          moved++;
          if (!dryRun) await ctx.db.patch(row._id, { tokenIdentifier: worker.tokenIdentifier, workerId: undefined });
        }
      }
    }
    if (!isDone) await ctx.scheduler.runAfter(0, internal.migrations.keyJoinAttemptsByIdentity, { cursor: continueCursor, dryRun });
    return { moved, deleted, isDone };
  },
});

export const joinAttemptsKeyedByWorker = internalQuery({
  args: {},
  handler: async (ctx): Promise<number> => {
    const rows = await ctx.db.query("joinAttempts").collect(); // one row per worker at most
    return rows.filter((row) => row.tokenIdentifier === undefined).length;
  },
});
