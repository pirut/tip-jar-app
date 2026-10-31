// Stripe's balance transactions, one row each, explained against what we've recorded. These are the
// transaction halves; paymentsNode.reconcileBooks reads Stripe between them.
import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { freezePayee, getControls, post, raiseAlert, resolveAlertByKey } from "./lib/paymentsDb";
import { classifyBalanceTxn, type LedgerAccount } from "./lib/paymentRules";

const OVERLAP_SECONDS = 24 * 60 * 60; // Stripe can date a transaction a little before it shows up in the list
const CLOCK_MARGIN_SECONDS = 60; // a tip's row always comes before its charge, give or take the clocks

const facts = v.object({
  sourceId: v.optional(v.string()),
  chargeId: v.optional(v.string()),
  paymentIntentId: v.optional(v.string()),
  metadataTipPaymentId: v.optional(v.string()),
  allocationId: v.optional(v.string()),
  destination: v.optional(v.string()),
  transferAmountCents: v.optional(v.number()),
  transferReversedCents: v.optional(v.number()),
  sourceStatus: v.optional(v.string()),
});

const row = v.object({
  txnId: v.string(),
  created: v.number(),
  type: v.string(),
  reportingCategory: v.optional(v.string()),
  amountCents: v.number(),
  feeCents: v.number(),
  netCents: v.number(),
  currency: v.string(),
  sourceId: v.optional(v.string()),
  livemode: v.boolean(),
});

async function scanRow(ctx: { db: MutationCtx["db"] }) {
  return await ctx.db.query("balanceScan").withIndex("by_key", (q) => q.eq("key", "platform")).unique();
}

// Where to read from. The first run reaches back to our first payment, or starts now if there's none.
export const startScan = internalMutation({
  args: {},
  handler: async (ctx) => {
    let scan = await scanRow(ctx);
    if (!scan) {
      const first = await ctx.db.query("tipPayments").first();
      const fromCreated = Math.floor((first?._creationTime ?? Date.now()) / 1000) - CLOCK_MARGIN_SECONDS;
      const id = await ctx.db.insert("balanceScan", { key: "platform", fromCreated, scannedNetCents: 0 });
      scan = (await ctx.db.get(id))!;
    }
    return { fromCreated: scan.fromCreated, startingAfter: scan.startingAfter };
  },
});

export const savePage = internalMutation({
  args: { startingAfter: v.optional(v.string()), newestCreated: v.optional(v.number()) },
  handler: async (ctx, { startingAfter, newestCreated }) => {
    const scan = (await scanRow(ctx))!;
    await ctx.db.patch(scan._id, { startingAfter, scanNewestCreated: Math.max(scan.scanNewestCreated ?? 0, newestCreated ?? 0) });
  },
});

// A full pass over the window is done. The next one overlaps it; row ids keep that from counting twice.
export const finishScan = internalMutation({
  args: { nowSeconds: v.number() },
  handler: async (ctx, { nowSeconds }) => {
    const scan = (await scanRow(ctx))!;
    const newest = scan.scanNewestCreated ?? nowSeconds;
    await ctx.db.patch(scan._id, { startingAfter: undefined, scanNewestCreated: undefined, completedAt: Date.now(), fromCreated: Math.max(scan.fromCreated, newest - OVERLAP_SECONDS) });
  },
});

// Everything before the first scanned transaction is what was there already.
export const openingBalance = internalMutation({
  args: { totalCents: v.number() },
  handler: async (ctx, { totalCents }) => {
    const scan = (await scanRow(ctx))!;
    if (scan.openingCents === undefined) {
      const openingCents = totalCents - scan.scannedNetCents;
      await ctx.db.patch(scan._id, { openingCents });
      return { openingCents, scannedNetCents: scan.scannedNetCents };
    }
    return { openingCents: scan.openingCents, scannedNetCents: scan.scannedNetCents };
  },
});

export const seenTxns = internalQuery({
  args: { txnIds: v.array(v.string()) },
  handler: async (ctx, { txnIds }) => {
    const closed: string[] = [];
    for (const txnId of txnIds) {
      const existing = await ctx.db.query("balanceTxns").withIndex("by_txn", (q) => q.eq("txnId", txnId)).unique();
      if (existing && existing.state !== "open") closed.push(txnId);
    }
    return closed;
  },
});

export const openTxns = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.query("balanceTxns").withIndex("by_state", (q) => q.eq("state", "open")).take(limit);
    return rows.map((r) => r.txnId);
  },
});

const COST_ACCOUNT: Partial<Record<string, LedgerAccount>> = { stripe_cost: "stripe_costs", connect_reserve: "connect_reserve", unknown: "unclassified" };

// Books movements that have no tip or transfer behind them, so the balance still adds up. The sign is
// Stripe's: money out is a debit on the cost account, money back is the reverse.
async function bookOutsideTips(ctx: MutationCtx, t: Doc<"balanceTxns">) {
  const account = COST_ACCOUNT[t.txnClass];
  if (!account || t.currency !== "usd") return;
  const out = t.netCents < 0;
  await post(ctx, { ref: `txn:${t.txnId}`, debit: out ? account : "stripe_balance", credit: out ? "stripe_balance" : account, amountCents: Math.abs(t.netCents), livemode: t.livemode, stripeObjectId: t.txnId });
}

async function tipFor(ctx: MutationCtx, f: { chargeId?: string; paymentIntentId?: string; metadataTipPaymentId?: string }) {
  const byCharge = f.chargeId ? await ctx.db.query("tipPayments").withIndex("by_charge", (q) => q.eq("stripeChargeId", f.chargeId)).first() : null;
  if (byCharge) return byCharge;
  const byIntent = f.paymentIntentId ? await ctx.db.query("tipPayments").withIndex("by_intent", (q) => q.eq("stripePaymentIntentId", f.paymentIntentId)).first() : null;
  if (byIntent) return byIntent;
  const id = f.metadataTipPaymentId ? ctx.db.normalizeId("tipPayments", f.metadataTipPaymentId) : null;
  return id ? await ctx.db.get(id) : null;
}

type Verdict = { problem?: string; tipPaymentId?: Id<"tipPayments">; allocationId?: Id<"allocations"> };

async function verdictFor(ctx: MutationCtx, t: Doc<"balanceTxns">, f: { sourceId?: string; chargeId?: string; paymentIntentId?: string; metadataTipPaymentId?: string; allocationId?: string; destination?: string; transferAmountCents?: number; transferReversedCents?: number; sourceStatus?: string }): Promise<Verdict> {
  switch (t.txnClass) {
    case "charge": {
      const tip = await tipFor(ctx, { chargeId: f.sourceId ?? t.sourceId, paymentIntentId: f.paymentIntentId, metadataTipPaymentId: f.metadataTipPaymentId });
      if (!tip) return { problem: `Charge ${t.sourceId} on Stripe has no record here.` };
      if (tip.stripeChargeId !== (f.sourceId ?? t.sourceId)) return { tipPaymentId: tip._id, problem: `Charge ${t.sourceId} isn't on payment ${tip._id} yet.` };
      if (tip.stripeFeeCents !== t.feeCents) return { tipPaymentId: tip._id, problem: `Charge ${t.sourceId}: Stripe's fee is ${t.feeCents}, recorded ${tip.stripeFeeCents ?? "nothing"}.` };
      return { tipPaymentId: tip._id };
    }
    case "refund":
    case "refund_failure": {
      const tip = await tipFor(ctx, f);
      if (!tip) return { problem: `Refund ${t.sourceId} on Stripe has no payment here.` };
      const refund = tip.refunds.find((r) => r.id === (f.sourceId ?? t.sourceId));
      if (!refund) return { tipPaymentId: tip._id, problem: `Refund ${t.sourceId} of ${-t.amountCents} cents isn't on payment ${tip._id} yet.` };
      if (t.txnClass === "refund_failure" && !["failed", "canceled"].includes(refund.status)) return { tipPaymentId: tip._id, problem: `Refund ${t.sourceId} came back on Stripe but is ${refund.status} here.` };
      return { tipPaymentId: tip._id };
    }
    case "dispute": {
      const tip = await tipFor(ctx, f);
      if (!tip) return { problem: `Dispute ${t.sourceId} on Stripe has no payment here.` };
      if (!tip.disputeIds.includes(f.sourceId ?? t.sourceId ?? "")) return { tipPaymentId: tip._id, problem: `Dispute ${t.sourceId} isn't on payment ${tip._id} yet.` };
      return { tipPaymentId: tip._id };
    }
    case "transfer":
    case "transfer_reversal":
    case "transfer_failure": {
      const id = f.allocationId ? ctx.db.normalizeId("allocations", f.allocationId) : null;
      const a = id ? await ctx.db.get(id) : null;
      if (!a) return { problem: `Transfer ${t.sourceId} of ${Math.abs(t.amountCents)} cents to ${f.destination ?? "an unknown account"} has no allocation here.` };
      if (f.destination !== a.stripeAccountId) return { allocationId: a._id, problem: `Transfer ${t.sourceId} went to ${f.destination}, not ${a.stripeAccountId}.` };
      if (t.txnClass === "transfer_failure") return { allocationId: a._id, problem: `Stripe reports transfer ${t.sourceId} failed or was canceled (${t.type}). Nothing here handles that by itself.` };
      const known = a.transfers.find((x) => x.id === (f.sourceId ?? t.sourceId));
      if (!known) return { allocationId: a._id, problem: `Transfer ${t.sourceId} isn't on allocation ${a._id} yet.` };
      if (f.transferAmountCents !== undefined && f.transferAmountCents !== known.amountCents) return { allocationId: a._id, problem: `Transfer ${t.sourceId}: Stripe says ${f.transferAmountCents} cents, recorded ${known.amountCents}.` };
      if (f.transferReversedCents !== undefined && f.transferReversedCents > known.reversedCents) return { allocationId: a._id, problem: `Transfer ${t.sourceId}: Stripe has reversed ${f.transferReversedCents}, recorded ${known.reversedCents}.` };
      return { allocationId: a._id };
    }
    case "owner_payout":
    case "owner_topup": {
      if (!t.sourceId) return { problem: `${t.type} ${t.txnId} names no payout or top-up.` };
      // Stripe has moved the money but a pending top-up isn't booked, so this has to be looked at again.
      if (t.txnClass === "owner_topup" && f.sourceStatus === "pending") return { problem: `Top-up ${t.sourceId} is still pending on Stripe.` };
      return {};
    }
    case "stripe_cost":
      return {};
    case "connect_reserve":
      return {};
    default:
      return { problem: `Stripe moved ${t.netCents} cents as ${t.type}${t.reportingCategory ? ` (${t.reportingCategory})` : ""}, txn ${t.txnId}. Nothing here explains it.` };
  }
}

// Records one transaction (once) and says whether it's explained. It's safe to call again after the
// action has fetched what was missing: that's how a late webhook or a crashed run gets repaired.
export const matchTxn = internalMutation({
  args: { row, facts },
  handler: async (ctx, { row: r, facts: f }) => {
    let t = await ctx.db.query("balanceTxns").withIndex("by_txn", (q) => q.eq("txnId", r.txnId)).unique();
    if (!t) {
      const txnClass = classifyBalanceTxn({ type: r.type, reporting_category: r.reportingCategory, currency: r.currency });
      const id = await ctx.db.insert("balanceTxns", { ...r, txnClass, state: "open" });
      t = (await ctx.db.get(id))!;
      const scan = await scanRow(ctx);
      if (scan && r.currency === "usd") await ctx.db.patch(scan._id, { scannedNetCents: scan.scannedNetCents + r.netCents });
      await bookOutsideTips(ctx, t);
    }
    if (t.state !== "open") return { state: t.state, txnClass: t.txnClass };
    const verdict = await verdictFor(ctx, t, f);
    if (verdict.problem) {
      await ctx.db.patch(t._id, { problem: verdict.problem, tipPaymentId: verdict.tipPaymentId, allocationId: verdict.allocationId });
      return { state: "open" as const, txnClass: t.txnClass, problem: verdict.problem, noAllocation: !verdict.allocationId };
    }
    await ctx.db.patch(t._id, { state: "matched", problem: undefined, tipPaymentId: verdict.tipPaymentId, allocationId: verdict.allocationId });
    await resolveAlertByKey(ctx, `txn_unexplained:${t.txnId}`);
    if (t.type === "connect_collection_transfer") {
      await raiseAlert(ctx, { kind: "connect_collection", severity: "critical", message: `Stripe collected ${-t.netCents} cents from the platform for a worker's balance that stayed negative for 180 days (${t.txnId}).`, ref: t.txnId });
    }
    return { state: "matched" as const, txnClass: t.txnClass };
  },
});

// The action has done all it can and this is still unexplained, so a person has to hear about it.
export const flagTxn = internalMutation({
  args: { txnId: v.string(), destination: v.optional(v.string()), unknownOutflow: v.boolean() },
  handler: async (ctx, { txnId, destination, unknownOutflow }) => {
    const t = await ctx.db.query("balanceTxns").withIndex("by_txn", (q) => q.eq("txnId", txnId)).unique();
    if (!t || t.state !== "open") return;
    await raiseAlert(ctx, { kind: "txn_unexplained", severity: "critical", message: t.problem ?? `Stripe transaction ${txnId} isn't explained.`, ref: txnId });
    if (!unknownOutflow) return;
    // Money went to an account nothing here sent it to. Nothing more goes out until someone has looked.
    const controls = await getControls(ctx);
    if (controls?.transfersEnabled) {
      await ctx.db.patch(controls._id, { transfersEnabled: false, note: `Stopped by reconciliation: ${t.problem ?? txnId}`, updatedAt: Date.now() });
      await raiseAlert(ctx, { kind: "transfers_stopped", severity: "critical", message: `Transfers were switched off because of an unexplained transfer (${txnId}). Reversals still run. Turn them on again with ops:setControls once it's understood.`, ref: txnId });
    }
    if (destination) {
      const payee = await ctx.db.query("payeeAccounts").withIndex("by_stripe_account", (q) => q.eq("stripeAccountId", destination)).unique();
      if (payee && !payee.frozenReason) await freezePayee(ctx, payee, "An unexplained transfer reached this account");
    }
  },
});
