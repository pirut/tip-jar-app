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
    // Fixed when the crew starts, so demo and real money can never share a pool. Unset means demo.
    moneyMode: v.optional(v.union(v.literal("demo"), v.literal("real"))),
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
    // This payout is real money, tracked in allocations. Demo balances must not count it.
    realMoney: v.optional(v.boolean()),
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

  // Every link name ever used, for good. A printed QR code must never start paying someone else.
  handleClaims: defineTable({
    handle: v.string(),
    tokenIdentifier: v.string(),
    workerId: v.optional(v.id("workers")), // empty once the account is deleted
  })
    .index("by_handle", ["handle"])
    .index("by_token", ["tokenIdentifier"]),

  // By sign-in identity, so deleting and recreating a profile can't undo a removal.
  crewRemovals: defineTable({
    crewId: v.id("crews"),
    tokenIdentifier: v.string(),
  }).index("by_crew_token", ["crewId", "tokenIdentifier"]),

  // One row. No row means every real-money switch is off.
  paymentControls: defineTable({
    key: v.literal("global"),
    chargesEnabled: v.boolean(),
    transfersEnabled: v.boolean(),
    perTipLimitCents: v.number(),
    workerDailyLimitCents: v.number(),
    globalDailyLimitCents: v.number(),
    transferHoldHours: v.number(),
    reserveCents: v.number(),
    note: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Who may take real money. Only internal functions write here.
  pilotEnrollments: defineTable({
    tokenIdentifier: v.string(),
    status: v.union(v.literal("active"), v.literal("suspended")),
    perTipLimitCents: v.optional(v.number()),
    dailyLimitCents: v.optional(v.number()),
    note: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_token", ["tokenIdentifier"]),

  // A worker's Stripe connected account. Outlives the profile: it holds tax and payout history.
  payeeAccounts: defineTable({
    tokenIdentifier: v.string(),
    workerId: v.optional(v.id("workers")),
    livemode: v.boolean(),
    stripeAccountId: v.string(),
    transfersStatus: v.string(), // Stripe's recipient capability status
    payoutsStatus: v.string(),
    requirementsDue: v.number(),
    syncedAt: v.number(),
    frozenReason: v.optional(v.string()),
    payoutsPaused: v.boolean(),
    owedCents: v.number(), // reversals Stripe couldn't complete; taken from later transfers
    balanceAvailableCents: v.optional(v.number()),
    balancePendingCents: v.optional(v.number()),
    balanceSyncedAt: v.optional(v.number()),
  })
    .index("by_token_mode", ["tokenIdentifier", "livemode"])
    .index("by_worker", ["workerId"])
    .index("by_stripe_account", ["stripeAccountId"]),

  // A real charge. Kept apart from `tips`, which only ever holds demo records.
  tipPayments: defineTable({
    workerId: v.id("workers"), // may point at a deleted profile; these records are kept
    payeeAccountId: v.id("payeeAccounts"),
    channel: v.literal("checkout"), // Tap to Pay is a later channel
    livemode: v.boolean(),
    status: v.union(
      v.literal("creating"),
      v.literal("open"),
      v.literal("processing"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("expired"),
      v.literal("canceled"),
    ),
    tipCents: v.number(),
    coveredFees: v.boolean(),
    feesCents: v.number(),
    cardFeeEstimateCents: v.number(),
    platformFeeCents: v.number(),
    chargedCents: v.number(),
    netCents: v.number(),
    crewId: v.optional(v.id("crews")), // fixed when the payment starts; cleared if it can't go to the pool
    clientRequestId: v.string(),
    checkoutUrl: v.optional(v.string()),
    stripeCheckoutSessionId: v.optional(v.string()),
    stripePaymentIntentId: v.optional(v.string()),
    stripeChargeId: v.optional(v.string()),
    stripeFeeCents: v.optional(v.number()),
    cardBrand: v.optional(v.string()),
    paidAt: v.optional(v.number()),
    snapshotFrom: v.optional(v.number()),
    refundedCents: v.number(),
    disputedCents: v.number(),
    disputeFeeCents: v.number(),
    disputeOpen: v.boolean(),
    postedNetTakenCents: v.number(),
    postedFeesTakenCents: v.number(),
    postedStripeFeeCents: v.optional(v.number()),
    reviewReason: v.optional(v.string()), // the money didn't match; nothing moves until a person looks
  })
    .index("by_worker", ["workerId"])
    .index("by_crew", ["crewId"])
    .index("by_status", ["status"])
    .index("by_session", ["stripeCheckoutSessionId"])
    .index("by_intent", ["stripePaymentIntentId"])
    .index("by_worker_request", ["workerId", "clientRequestId"]),

  // One tip's money for one person. Target minus paid says what Stripe still has to do.
  allocations: defineTable({
    tipPaymentId: v.id("tipPayments"),
    workerId: v.id("workers"),
    payeeAccountId: v.id("payeeAccounts"),
    stripeAccountId: v.string(),
    crewId: v.optional(v.id("crews")),
    grossCents: v.number(),
    targetCents: v.number(),
    paidCents: v.number(),
    unrecoveredCents: v.number(),
    state: v.union(v.literal("due"), v.literal("in_flight"), v.literal("settled")),
    eligibleAt: v.number(),
    seq: v.number(), // bumps after each finished Stripe operation; part of the idempotency key
    attempts: v.number(),
    claimedAt: v.optional(v.number()),
    inFlightOffsetCents: v.optional(v.number()),
    lastError: v.optional(v.string()),
    transfers: v.array(v.object({ id: v.string(), amountCents: v.number(), reversedCents: v.number() })),
  })
    .index("by_state_eligible", ["state", "eligibleAt"])
    .index("by_tip", ["tipPaymentId"])
    .index("by_worker", ["workerId"])
    .index("by_payee_state", ["payeeAccountId", "state"]),

  // Append-only double entry. `ref` is unique, so a posting can't happen twice.
  ledgerEntries: defineTable({
    ref: v.string(),
    at: v.number(),
    debit: v.string(),
    credit: v.string(),
    amountCents: v.number(),
    livemode: v.boolean(),
    tipPaymentId: v.optional(v.id("tipPayments")),
    allocationId: v.optional(v.id("allocations")),
    workerId: v.optional(v.id("workers")),
    stripeObjectId: v.optional(v.string()),
  })
    .index("by_ref", ["ref"])
    .index("by_tip", ["tipPaymentId"]),

  // Copies of Stripe's payouts to workers' banks, refreshed from Stripe on each event.
  payouts: defineTable({
    stripePayoutId: v.string(),
    stripeAccountId: v.string(),
    payeeAccountId: v.id("payeeAccounts"),
    amountCents: v.number(),
    status: v.string(),
    arrivalDate: v.number(),
    failureMessage: v.optional(v.string()),
    livemode: v.boolean(),
    syncedAt: v.number(),
  })
    .index("by_stripe_id", ["stripePayoutId"])
    .index("by_payee", ["payeeAccountId"]),

  // Every webhook event received, for duplicates and retries.
  stripeEvents: defineTable({
    eventId: v.string(),
    type: v.string(),
    livemode: v.boolean(),
    source: v.union(v.literal("platform"), v.literal("connect")),
    stripeAccountId: v.optional(v.string()),
    created: v.number(),
    status: v.union(v.literal("pending"), v.literal("done"), v.literal("ignored"), v.literal("failed")),
    attempts: v.number(),
    target: v.string(), // JSON from eventTarget: what to re-read from Stripe. Never event contents.
    lastError: v.optional(v.string()),
    nextAttemptAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_status_next", ["status", "nextAttemptAt"]),

  // Things a person should look at. Read with `npx convex run ops:status`.
  opsAlerts: defineTable({
    kind: v.string(),
    severity: v.union(v.literal("critical"), v.literal("warning")),
    message: v.string(),
    ref: v.optional(v.string()),
    dedupeKey: v.string(),
    at: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_dedupe", ["dedupeKey"])
    .index("by_resolved", ["resolvedAt"]),

  // Daily comparison of our books with Stripe's balance.
  reconciliations: defineTable({
    at: v.number(),
    livemode: v.boolean(),
    availableCents: v.number(),
    pendingCents: v.number(),
    expectedStripeBalanceCents: v.number(),
    workerLiabilityCents: v.number(),
    platformRevenueCents: v.number(),
    safeToWithdrawCents: v.number(),
    problems: v.array(v.string()),
  }).index("by_at", ["at"]),
});
