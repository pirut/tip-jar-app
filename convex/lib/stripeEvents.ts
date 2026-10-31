// Turns a verified Stripe event into what to re-read from Stripe. Events are only a nudge: their
// contents can be stale or out of order, so nothing here decides what happened to the money.

export type EventTarget =
  | { kind: "payment"; tipPaymentId?: string; paymentIntentId?: string; sessionId?: string }
  | { kind: "account"; stripeAccountId: string }
  | { kind: "payout"; stripeAccountId: string; payoutId: string }
  | { kind: "balance"; stripeAccountId: string }
  | { kind: "transfer"; allocationId?: string; transferId: string }
  | { kind: "platform_payout"; payoutId: string }
  | { kind: "platform_topup"; topupId: string }
  | { kind: "ignore" };

type EventLike = { type: string; account?: string; data: { object: any } };

const idOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "object" && value !== null && typeof (value as any).id === "string" ? (value as any).id : undefined;

export function eventTarget(event: EventLike): EventTarget {
  const o = event.data.object ?? {};
  const type = event.type;
  if (type.startsWith("checkout.session.")) {
    return { kind: "payment", tipPaymentId: o.metadata?.tipPaymentId, sessionId: o.id, paymentIntentId: idOf(o.payment_intent) };
  }
  if (type.startsWith("payment_intent.")) {
    return { kind: "payment", tipPaymentId: o.metadata?.tipPaymentId, paymentIntentId: o.id };
  }
  if (type.startsWith("charge.dispute.") || type.startsWith("refund.") || type.startsWith("charge.refund.") || type.startsWith("charge.")) {
    const paymentIntentId = idOf(o.payment_intent);
    return paymentIntentId ? { kind: "payment", paymentIntentId, tipPaymentId: o.metadata?.tipPaymentId } : { kind: "ignore" };
  }
  if (type.startsWith("transfer.")) {
    return { kind: "transfer", transferId: o.id, allocationId: o.metadata?.allocationId };
  }
  if (type === "account.updated" || type === "capability.updated" || type === "account.external_account.updated") {
    const stripeAccountId = event.account ?? (type === "account.updated" ? o.id : idOf(o.account));
    return stripeAccountId ? { kind: "account", stripeAccountId } : { kind: "ignore" };
  }
  if (type.startsWith("payout.") && event.account) {
    return { kind: "payout", stripeAccountId: event.account, payoutId: o.id };
  }
  // With no connected account, it's the owner's own money moving.
  if (type.startsWith("payout.")) return { kind: "platform_payout", payoutId: o.id };
  if (type.startsWith("topup.")) return { kind: "platform_topup", topupId: o.id };
  if (type === "balance.available" && event.account) {
    return { kind: "balance", stripeAccountId: event.account };
  }
  return { kind: "ignore" };
}

// The recipient capabilities and outstanding requirements on an Accounts v2 object.
export function accountStatus(account: any) {
  const balance = account?.configuration?.recipient?.capabilities?.stripe_balance;
  const entries: any[] = account?.requirements?.entries ?? [];
  const due = entries.filter((e) => e?.minimum_deadline?.status !== "eventually_due");
  return {
    transfersStatus: String(balance?.stripe_transfers?.status ?? "unknown"),
    payoutsStatus: String(balance?.payouts?.status ?? "unknown"),
    requirementsDue: due.length,
  };
}

// The same facts from a v1 account, for platforms still on STRIPE_CONNECT_API=v1.
export function accountStatusV1(account: any) {
  const transfers = account?.capabilities?.transfers;
  return {
    transfersStatus: transfers === "inactive" ? (account?.details_submitted ? "restricted" : "pending") : String(transfers ?? "unknown"),
    payoutsStatus: account?.payouts_enabled ? "active" : "restricted",
    requirementsDue: (account?.requirements?.currently_due ?? []).length,
  };
}

export function usdCents(rows: { amount: number; currency: string }[] | undefined): number {
  return (rows ?? []).filter((r) => r.currency === "usd").reduce((a, r) => a + r.amount, 0);
}
