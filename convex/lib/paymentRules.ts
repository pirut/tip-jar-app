// The money rules for real payments, kept free of Convex and Stripe so they can be tested alone.
// All amounts are integer cents. docs/payments-architecture.md explains the model.
import { PLATFORM_FEE_CENTS, cardFeeCents, feesCents } from "./money";
import { splitCents } from "./split";

export type TipAmounts = {
  tipCents: number;
  coveredFees: boolean;
  feesCents: number;
  cardFeeEstimateCents: number;
  platformFeeCents: number;
  chargedCents: number; // what the guest pays
  netCents: number; // what's owed to the worker or crew
};

export function tipAmounts(tipCents: number, coveredFees: boolean): TipAmounts {
  const fees = feesCents(tipCents);
  return {
    tipCents,
    coveredFees,
    feesCents: fees,
    cardFeeEstimateCents: cardFeeCents(tipCents),
    platformFeeCents: PLATFORM_FEE_CENTS,
    chargedCents: coveredFees ? tipCents + fees : tipCents,
    netCents: coveredFees ? tipCents : tipCents - fees,
  };
}

// Capability statuses Stripe reports on a recipient account.
export function canReceive(transfersStatus: string | undefined): boolean {
  return transfersStatus === "active";
}

export type DisputeSnapshot = { id: string; status: string; amountCents: number; feeCents: number };

const NO_MONEY_TAKEN = new Set(["warning_needs_response", "warning_under_review", "warning_closed", "won", "prevented"]);
const INQUIRY_OPEN = new Set(["warning_needs_response", "warning_under_review"]);
// An appeal of a lost dispute isn't over: the money stays taken, but it can still come back.
const FORMAL_OPEN = new Set(["needs_response", "under_review", "appeal_needs_response", "appeal_under_review"]);

// Money Stripe has taken back for disputes. Inquiries take none; won disputes give it back.
export function disputedCents(disputes: DisputeSnapshot[]): number {
  return disputes.filter((d) => !NO_MONEY_TAKEN.has(d.status)).reduce((a, d) => a + d.amountCents, 0);
}

export function disputeFeeCents(disputes: DisputeSnapshot[]): number {
  return disputes.reduce((a, d) => a + d.feeCents, 0);
}

// Anything still being argued stops further transfers for this tip.
export function disputeOpen(disputes: DisputeSnapshot[]): boolean {
  return disputes.some((d) => INQUIRY_OPEN.has(d.status) || FORMAL_OPEN.has(d.status));
}

// Inquiries Stripe hasn't taken money for yet, but might.
export function inquiryCents(disputes: DisputeSnapshot[]): number {
  return disputes.filter((d) => INQUIRY_OPEN.has(d.status)).reduce((a, d) => a + d.amountCents, 0);
}

export type RefundSnapshot = { id: string; amountCents: number; status: string };

// Stripe's refund statuses. A failed or canceled refund has returned, or will return, to the balance.
const REFUND_GONE = new Set(["failed", "canceled"]);
const REFUND_UNFINISHED = new Set(["pending", "requires_action"]);

// What the guest is getting back: anything not known to have failed.
export function activeRefundCents(refunds: RefundSnapshot[]): number {
  return refunds.filter((r) => !REFUND_GONE.has(r.status)).reduce((a, r) => a + r.amountCents, 0);
}

export function failedRefundCents(refunds: RefundSnapshot[]): number {
  return refunds.filter((r) => REFUND_GONE.has(r.status)).reduce((a, r) => a + r.amountCents, 0);
}

export function unfinishedRefundCents(refunds: RefundSnapshot[]): number {
  return refunds.filter((r) => REFUND_UNFINISHED.has(r.status)).reduce((a, r) => a + r.amountCents, 0);
}

// Money that belongs to guests, or may: refunds still on their way, refunds that failed and nobody
// has dealt with, and inquiries that could become chargebacks. Never available to the owner.
export function guestHoldCents(p: { refunds: RefundSnapshot[]; failedRefundAckCents: number; inquiryCents: number }): number {
  return unfinishedRefundCents(p.refunds) + Math.max(0, failedRefundCents(p.refunds) - p.failedRefundAckCents) + p.inquiryCents;
}

// What's left for workers once refunds and disputes are counted.
export function entitlement(p: { netCents: number; chargedCents: number; refundedCents: number; disputedCents: number }) {
  const adverse = Math.min(p.chargedCents, Math.max(0, p.refundedCents) + Math.max(0, p.disputedCents));
  const netTaken = p.chargedCents === 0 ? 0 : Math.round((p.netCents * adverse) / p.chargedCents);
  return {
    adverseCents: adverse,
    netTakenCents: netTaken,
    feesTakenCents: adverse - netTaken,
    entitledCents: p.netCents - netTaken,
  };
}

// Each allocation's fair part of what's left, in proportion to its original share.
export function allocationTargets(entitledCents: number, grossShares: number[]): number[] {
  if (grossShares.every((g) => g === 0)) return grossShares.map(() => 0);
  return splitCents(entitledCents, grossShares);
}

// One tip across a crew. The starting member rotates per tip so leftover cents move around.
export function splitTipAmongMembers(netCents: number, weights: number[], tipIndex: number): number[] {
  return splitCents(netCents, weights, tipIndex % Math.max(1, weights.length));
}

export type AllocationMoney = { targetCents: number; paidCents: number; unrecoveredCents: number };

// Positive: move money to the worker. Negative: take it back. Reversals we already gave up on
// count as if recovered, because they're tracked as what the worker owes.
export function allocationDue(a: AllocationMoney): number {
  return a.targetCents - a.paidCents + a.unrecoveredCents;
}

// A transfer is reduced by whatever the worker still owes from a failed reversal.
export function applyOwed(dueCents: number, owedCents: number): { transferCents: number; offsetCents: number } {
  const offset = Math.min(Math.max(0, dueCents), Math.max(0, owedCents));
  return { transferCents: dueCents - offset, offsetCents: offset };
}

// A reversal is spread over the transfers that paid an allocation, newest first.
export function planReversal(transfers: { id: string; amountCents: number; reversedCents: number }[], reverseCents: number) {
  const plan: { transferId: string; amountCents: number }[] = [];
  let left = reverseCents;
  for (const t of [...transfers].reverse()) {
    if (left <= 0) break;
    const room = t.amountCents - t.reversedCents;
    if (room <= 0) continue;
    const take = Math.min(room, left);
    plan.push({ transferId: t.id, amountCents: take });
    left -= take;
  }
  return { plan, uncoveredCents: left };
}

export type PiStatus = string;
export type PaymentStatus = "creating" | "open" | "processing" | "succeeded" | "failed" | "expired" | "canceled";

// How a PaymentIntent's status reads on our record. Once money has been taken, nothing moves it back.
export function nextPaymentStatus(current: PaymentStatus, piStatus: PiStatus): PaymentStatus {
  if (current === "succeeded") return "succeeded";
  switch (piStatus) {
    case "succeeded": return "succeeded";
    case "processing": return "processing";
    case "canceled": return "canceled";
    default: return current === "creating" ? "open" : current;
  }
}

export type PaymentSnapshot = {
  paymentIntentId: string;
  piStatus: PiStatus;
  amountCents: number;
  currency: string;
  livemode: boolean;
  metadataTipPaymentId?: string;
  chargeId?: string;
  paidAt?: number;
  stripeFeeCents?: number;
  refunds: RefundSnapshot[];
  cardBrand?: string;
  disputes: DisputeSnapshot[];
};

// Anything here means the money doesn't match what we asked Stripe to collect. Never pay out on it.
export function snapshotProblems(
  tip: { _id: string; chargedCents: number; livemode: boolean; stripePaymentIntentId?: string },
  s: PaymentSnapshot,
): string[] {
  const problems: string[] = [];
  if (s.metadataTipPaymentId !== tip._id) problems.push("metadata doesn't name this payment");
  if (s.amountCents !== tip.chargedCents) problems.push(`amount ${s.amountCents} isn't the expected ${tip.chargedCents}`);
  if (s.currency !== "usd") problems.push(`currency ${s.currency}`);
  if (s.livemode !== tip.livemode) problems.push("test and live don't match");
  if (tip.stripePaymentIntentId && tip.stripePaymentIntentId !== s.paymentIntentId) problems.push("a different PaymentIntent is already recorded");
  return problems;
}

// Debit and credit rows for a change in refunds and disputes. Debits and credits always match.
export function adjustmentPostings(netDelta: number, feeDelta: number) {
  const rows: { debit: LedgerAccount; credit: LedgerAccount; amountCents: number }[] = [];
  if (netDelta > 0) rows.push({ debit: "worker_liability", credit: "stripe_balance", amountCents: netDelta });
  if (netDelta < 0) rows.push({ debit: "stripe_balance", credit: "worker_liability", amountCents: -netDelta });
  if (feeDelta > 0) rows.push({ debit: "platform_fees", credit: "stripe_balance", amountCents: feeDelta });
  if (feeDelta < 0) rows.push({ debit: "stripe_balance", credit: "platform_fees", amountCents: -feeDelta });
  return rows;
}

export type LedgerAccount =
  | "stripe_balance"
  | "worker_liability"
  | "platform_fees"
  | "processing_cost"
  | "dispute_fees"
  | "owner_withdrawals"
  | "owner_capital"
  | "stripe_costs" // Connect, tax and other Stripe charges that aren't tied to one tip
  | "connect_reserve" // what Stripe holds back from the platform for negative worker balances
  | "review_held" // money Stripe collected on a payment waiting for a person to look at it
  | "unclassified"; // Stripe activity nobody has explained yet

export type LedgerRow = { debit: LedgerAccount; credit: LedgerAccount; amountCents: number };

// Debit-positive balance per account, then the figures the owner needs.
export function ledgerTotals(rows: LedgerRow[]) {
  const balance: Record<LedgerAccount, number> = { stripe_balance: 0, worker_liability: 0, platform_fees: 0, processing_cost: 0, dispute_fees: 0, owner_withdrawals: 0, owner_capital: 0, stripe_costs: 0, connect_reserve: 0, review_held: 0, unclassified: 0 };
  for (const r of rows) {
    balance[r.debit] += r.amountCents;
    balance[r.credit] -= r.amountCents;
  }
  const workerLiabilityCents = 0 - balance.worker_liability;
  const feesCollectedCents = 0 - balance.platform_fees;
  const platformRevenueCents = feesCollectedCents - balance.processing_cost - balance.dispute_fees - balance.stripe_costs;
  return {
    expectedStripeBalanceCents: balance.stripe_balance,
    workerLiabilityCents,
    feesCollectedCents,
    processingCostCents: balance.processing_cost,
    disputeFeesCents: balance.dispute_fees,
    stripeCostsCents: balance.stripe_costs,
    connectReserveCents: balance.connect_reserve,
    reviewHeldCents: 0 - balance.review_held,
    unclassifiedCents: balance.unclassified,
    platformRevenueCents,
    ownerWithdrawalsCents: balance.owner_withdrawals,
    ownerCapitalCents: 0 - balance.owner_capital,
  };
}

// Everything that has to stay in the balance. Each part is gross: what one worker owes never makes
// room for what another is owed, because a debt isn't cash.
export type Obligations = {
  workerDueCents: number; // allocations still to transfer
  unallocatedTipCents: number; // tips in open crew pools, not split yet
  reviewHeldCents: number; // collected on a payment under review
  guestHoldCents: number; // refunds in progress or failed, and open inquiries
  negativeWorkerCents: number; // negative worker balances Stripe hasn't reserved from us yet
  reserveCents: number; // the owner's own buffer
};

export function obligationTotal(o: Obligations): number {
  return o.workerDueCents + o.unallocatedTipCents + o.reviewHeldCents + o.guestHoldCents + o.negativeWorkerCents + o.reserveCents;
}

// The most the owner can take without touching any of that. Any blocker makes it zero: when we can't
// trust the inputs, the answer is "don't", not a number.
export function safeToWithdraw(p: { availableCents: number; obligations: Obligations; blockers: string[] }): number {
  if (p.blockers.length > 0) return 0;
  return Math.max(0, p.availableCents - obligationTotal(p.obligations));
}

// How long a reconciliation's Stripe balance can be used for a withdrawal decision.
export const SAFE_FIGURE_TTL_MS = 2 * 60 * 60 * 1000;

export type BalanceTxnClass = "charge" | "refund" | "refund_failure" | "dispute" | "transfer" | "transfer_reversal" | "transfer_failure" | "owner_payout" | "owner_topup" | "stripe_cost" | "connect_reserve" | "unknown";

const TXN_CLASS: Record<string, BalanceTxnClass> = {
  charge: "charge",
  payment: "charge",
  refund: "refund",
  payment_refund: "refund",
  refund_failure: "refund_failure",
  transfer: "transfer",
  transfer_refund: "transfer_reversal",
  transfer_cancel: "transfer_failure",
  transfer_failure: "transfer_failure",
  payout: "owner_payout",
  payout_cancel: "owner_payout",
  payout_failure: "owner_payout",
  topup: "owner_topup",
  topup_reversal: "owner_topup",
  stripe_fee: "stripe_cost",
  tax_fee: "stripe_cost",
  stripe_fx_fee: "stripe_cost",
  reserve_transaction: "connect_reserve",
  connect_collection_transfer: "connect_reserve",
};

// What a balance transaction is. Stripe reports disputes and refund failures as `adjustment` with the
// real meaning in reporting_category, and an adjustment we can't name stays unknown on purpose.
export function classifyBalanceTxn(t: { type: string; reporting_category?: string | null; currency: string; source?: unknown }): BalanceTxnClass {
  if (t.currency !== "usd") return "unknown";
  if (t.type === "adjustment") {
    const category = t.reporting_category ?? "";
    if (category === "dispute" || category === "dispute_reversal") return "dispute";
    if (category === "refund_failure") return "refund_failure";
    return "unknown";
  }
  return TXN_CLASS[t.type] ?? "unknown";
}

export const CHARGE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type LimitCheck = {
  tipCents: number;
  chargedCents: number;
  perTipLimitCents: number;
  workerDailyLimitCents: number;
  globalDailyLimitCents: number;
  workerRecentCents: number;
  globalRecentCents: number;
};

// Null means allowed. Messages are for the worker or guest who hit the limit.
export function limitProblem(c: LimitCheck): string | null {
  if (c.tipCents > c.perTipLimitCents) return "That tip is over the limit during the pilot.";
  if (c.workerRecentCents + c.chargedCents > c.workerDailyLimitCents) return "This worker has reached today's tip limit during the pilot.";
  if (c.globalRecentCents + c.chargedCents > c.globalDailyLimitCents) return "Tips are paused for now. Try again later.";
  return null;
}
