import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const splitMode = v.union(
  v.literal("even"),
  v.literal("hours"),
  v.literal("shares"),
  v.literal("custom"),
);

export default defineSchema({
  // A person who receives tips. One per signed-in user.
  workers: defineTable({
    tokenIdentifier: v.string(), // from the Clerk identity
    name: v.string(),
    // Public handle for the tip page: tip.jrbussard.com/<handle>
    handle: v.string(),
    jobTitle: v.string(),
    workplace: v.string(),
  })
    .index("by_token", ["tokenIdentifier"])
    .index("by_handle", ["handle"]),

  tips: defineTable({
    workerId: v.id("workers"),
    amountCents: v.number(), // the tip the guest chose
    feesCents: v.number(), // card + platform fees
    coveredFees: v.boolean(), // true: guest paid fees on top; false: fees come out of the tip
    netCents: v.number(), // what goes to the worker (or the crew pool)
    source: v.union(v.literal("qr"), v.literal("tap")),
    payerLabel: v.string(), // e.g. "Apple Pay", "Visa ••42"
    crewId: v.optional(v.id("crews")), // set when the worker was in a crew
    demo: v.boolean(), // true until Stripe is connected
  })
    .index("by_worker", ["workerId"])
    .index("by_crew", ["crewId"]),

  crews: defineTable({
    name: v.string(),
    code: v.string(), // 4-digit join code
    starterId: v.id("workers"),
    splitMode,
    status: v.union(v.literal("open"), v.literal("closed")),
    closesAt: v.number(),
    closedAt: v.optional(v.number()),
  })
    .index("by_code_status", ["code", "status"])
    .index("by_status", ["status"]),

  crewMembers: defineTable({
    crewId: v.id("crews"),
    workerId: v.id("workers"),
    joinedAt: v.number(),
    leftAt: v.optional(v.number()),
    hoursOverride: v.optional(v.number()),
    shares: v.number(),
    pct: v.number(),
    // Time from earlier stints, when someone leaves and rejoins the same crew.
    priorMs: v.optional(v.number()),
    // The starter took this person out of the crew. They aren't paid and can't rejoin.
    removedAt: v.optional(v.number()),
    // Filled in when the crew closes.
    payoutCents: v.optional(v.number()),
  })
    .index("by_crew", ["crewId"])
    .index("by_worker", ["workerId"]),

  // Wrong crew codes per signed-in identity. Codes are only 4 digits, so guesses have to be
  // limited, and a count has to outlast the worker or recreating a profile would reset it.
  joinAttempts: defineTable({
    tokenIdentifier: v.optional(v.string()), // required once convex/migrations.ts has run
    workerId: v.optional(v.id("workers")), // the old key: goes away once convex/migrations.ts has run
    windowStart: v.number(),
    fails: v.number(),
  })
    .index("by_token", ["tokenIdentifier"])
    .index("by_worker", ["workerId"]),

  cashouts: defineTable({
    workerId: v.id("workers"),
    amountCents: v.number(), // taken from balance
    feeCents: v.number(),
    instant: v.boolean(),
    demo: v.boolean(),
  }).index("by_worker", ["workerId"]),
});
