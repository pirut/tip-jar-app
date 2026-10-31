"use node";
// Everything that talks to Stripe. Actions read Stripe and write through internal mutations, so
// a crash between the two is recoverable: every Stripe call is idempotent and every record can be
// rebuilt by reading Stripe again.
import Stripe from "stripe";
import { ConvexError, v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { WorkerStage } from "./lib/paymentsDb";
import type { PaymentSnapshot } from "./lib/paymentRules";
import { safeToWithdraw, ledgerTotals } from "./lib/paymentRules";
import { accountStatus, accountStatusV1, eventTarget, usdCents, type EventTarget } from "./lib/stripeEvents";
import { isLive, requireStripeConfig, supportEmail, tipOrigin } from "./lib/stripeEnv";

let fake: Stripe | null = null;
// Tests hand in a stand-in here. Nothing in a deployed app calls this.
export function useStripeForTests(client: unknown) {
  fake = client as Stripe | null;
}

function stripe(): Stripe {
  const { key } = requireStripeConfig();
  return fake ?? new Stripe(key, { maxNetworkRetries: 2, appInfo: { name: "Tip Jar" } });
}

const payoutSchedule = (): Stripe.BalanceSettingsUpdateParams.Payments.Payouts.Schedule => ({ interval: "weekly", weekly_payout_days: ["monday"] });

type WorkerContext = { worker: Doc<"workers">; stage: WorkerStage; payee: Doc<"payeeAccounts"> | null };

async function requireIdentity(ctx: ActionCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Sign in first.");
  return identity;
}

async function workerFor(ctx: ActionCtx) {
  const identity = await requireIdentity(ctx);
  const found: WorkerContext | null = await ctx.runQuery(internal.payments.workerContext, { tokenIdentifier: identity.tokenIdentifier });
  if (!found) throw new ConvexError("Sign in and set up your profile first.");
  return { ...found, identity };
}

// Set up payouts

// Accounts v2 by default. STRIPE_CONNECT_API=v1 is for a sandbox where Accounts v2 hasn't been switched
// on in the Dashboard: the same recipient setup, written as v1 controller properties. Stripe stopped
// accepting that on API versions after this one, so it can't be the route for new live accounts.
const V1_ACCOUNTS_API_VERSION = "2026-07-29.dahlia";
const useV1Accounts = () => process.env.STRIPE_CONNECT_API === "v1";

async function readAccountStatus(stripeAccountId: string) {
  if (useV1Accounts()) return accountStatusV1(await stripe().accounts.retrieve(stripeAccountId));
  return accountStatus(await stripe().v2.core.accounts.retrieve(stripeAccountId, { include: ["configuration.recipient", "requirements"] }));
}

async function syncAccount(ctx: ActionCtx, stripeAccountId: string) {
  const status = await readAccountStatus(stripeAccountId);
  await ctx.runMutation(internal.payments.applyAccountStatus, { stripeAccountId, ...status });
  return status;
}

async function createRecipient(worker: Doc<"workers">, email: string | undefined) {
  const idempotencyKey = `account:${worker._id}`;
  if (useV1Accounts()) {
    const account = await stripe().accounts.create(
      {
        country: "US",
        business_type: "individual",
        email,
        business_profile: { product_description: `Receives tips for work as ${worker.jobTitle || "a service worker"}` },
        controller: {
          fees: { payer: "application" },
          losses: { payments: "application" },
          requirement_collection: "stripe",
          stripe_dashboard: { type: "express" },
        },
        capabilities: { transfers: { requested: true } },
        metadata: { tipJarWorkerId: worker._id },
      },
      { idempotencyKey, apiVersion: V1_ACCOUNTS_API_VERSION },
    );
    return { id: account.id, status: accountStatusV1(account) };
  }
  const account = await stripe().v2.core.accounts.create(
    {
      display_name: worker.name,
      contact_email: email,
      dashboard: "express",
      identity: { country: "us", entity_type: "individual" },
      defaults: { responsibilities: { fees_collector: "application", losses_collector: "application" } },
      configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
      include: ["configuration.recipient", "requirements"],
      metadata: { tipJarWorkerId: worker._id },
    },
    { idempotencyKey },
  );
  return { id: account.id, status: accountStatus(account) };
}

async function accountLinkUrl(stripeAccountId: string, firstTime: boolean): Promise<string> {
  const origin = tipOrigin();
  const urls = { refresh_url: `${origin}/payouts/return?expired=1`, return_url: `${origin}/payouts/return` };
  if (useV1Accounts()) {
    const link = await stripe().accountLinks.create({ account: stripeAccountId, type: firstTime ? "account_onboarding" : "account_update", ...urls });
    return link.url;
  }
  const link = await stripe().v2.core.accountLinks.create({
    account: stripeAccountId,
    use_case: firstTime ? { type: "account_onboarding", account_onboarding: urls } : { type: "account_update", account_update: urls },
  });
  return link.url;
}

// Creates the worker's Stripe account behind the scenes if needed, then sends them to Stripe's secure
// form for identity and bank details. Tip Jar never sees those.
export const startPayoutSetup = action({
  args: {},
  handler: async (ctx): Promise<{ url: string }> => {
    const { worker, stage, payee: existing, identity } = await workerFor(ctx);
    if (stage === "demo" || stage === "suspended") throw new ConvexError("Payouts aren't open for your account yet.");
    const { mode } = requireStripeConfig();
    let stripeAccountId = existing?.stripeAccountId;
    if (!stripeAccountId) {
      const created = await createRecipient(worker, identity.email);
      await ctx.runMutation(internal.payments.saveNewPayee, {
        tokenIdentifier: identity.tokenIdentifier,
        workerId: worker._id,
        livemode: isLive(mode),
        stripeAccountId: created.id,
        ...created.status,
      });
      const saved = await ctx.runQuery(internal.payments.payeeForToken, { tokenIdentifier: identity.tokenIdentifier });
      stripeAccountId = saved!.stripeAccountId;
    }
    // Daily payouts cost more than a tip's fee earns; see docs/payments-architecture.md. Set on every
    // visit so a failure here last time gets fixed, and never over a freeze.
    if (!existing?.payoutsPaused) {
      await stripe().balanceSettings.update({ payments: { payouts: { schedule: payoutSchedule() } } }, { stripeAccount: stripeAccountId });
    }
    // Stripe only offers the update flow once onboarding has been finished.
    const finished = !!existing && existing.transfersStatus === "active";
    return { url: await accountLinkUrl(stripeAccountId, !finished) };
  },
});

export const refreshPayoutStatus = action({
  args: {},
  handler: async (ctx): Promise<{ transfersStatus: string; payoutsStatus: string; requirementsDue: number } | null> => {
    const { payee } = await workerFor(ctx);
    if (!payee) return null;
    return await syncAccount(ctx, payee.stripeAccountId);
  },
});

// Stripe's own page for bank details, payout history and tax forms.
export const payoutDashboardLink = action({
  args: {},
  handler: async (ctx): Promise<{ url: string }> => {
    const { payee } = await workerFor(ctx);
    if (!payee) throw new ConvexError("Set up payouts first.");
    const link = await stripe().accounts.createLoginLink(payee.stripeAccountId);
    return { url: link.url };
  },
});

async function syncBalance(ctx: ActionCtx, stripeAccountId: string) {
  const balance = await stripe().balance.retrieve({}, { stripeAccount: stripeAccountId });
  await ctx.runMutation(internal.payments.applyBalance, {
    stripeAccountId,
    availableCents: usdCents(balance.available),
    pendingCents: usdCents(balance.pending),
  });
}

export const refreshBalance = action({
  args: {},
  handler: async (ctx) => {
    const { payee } = await workerFor(ctx);
    if (payee) await syncBalance(ctx, payee.stripeAccountId);
  },
});

export const setPayoutsPaused = internalAction({
  args: { payeeAccountId: v.id("payeeAccounts"), paused: v.boolean() },
  handler: async (ctx, { payeeAccountId, paused }) => {
    const payee = await ctx.runQuery(internal.payments.payeeById, { payeeAccountId });
    if (!payee) return;
    await stripe().balanceSettings.update(
      { payments: { payouts: { schedule: paused ? { interval: "manual" } : payoutSchedule() } } },
      { stripeAccount: payee.stripeAccountId },
    );
    await ctx.runMutation(internal.payments.setPayoutsPausedRecord, { payeeAccountId, paused });
  },
});

// Taking money

// Confirms with Stripe, not our copy, that this worker can still be paid before charging anyone.
async function confirmReceivable(ctx: ActionCtx, tipPaymentId: Id<"tipPayments">, stripeAccountId: string, check: boolean) {
  if (!check) return;
  const { transfersStatus } = await syncAccount(ctx, stripeAccountId);
  if (transfersStatus !== "active") {
    await ctx.runMutation(internal.payments.closeUnpaid, { tipPaymentId, status: "canceled" });
    throw new ConvexError("This person can't take tips through Tip Jar right now.");
  }
}

// A guest's tip from the QR page. The guest only chooses the amount and whether to cover fees.
export const createGuestCheckout = action({
  args: { handle: v.string(), tipCents: v.number(), coverFees: v.boolean(), clientRequestId: v.string() },
  handler: async (ctx, { handle, tipCents, coverFees, clientRequestId }): Promise<{ url: string }> => {
    if (requireStripeConfig().mode === "live" && !supportEmail()) throw new ConvexError("Payments are paused while support is being configured.");
    const target = await ctx.runQuery(internal.payments.guestTarget, { handle });
    if (!target) throw new ConvexError("We couldn't find that person.");
    const r = await ctx.runMutation(internal.payments.reservePayment, { workerId: target.workerId, tipCents, coverFees, clientRequestId });
    if (r.repeat) {
      if (r.checkoutUrl && r.status === "open") return { url: r.checkoutUrl };
      if (r.status !== "creating") throw new ConvexError("This tip has already been handled. Reload to tip again.");
    }
    await confirmReceivable(ctx, r.tipPaymentId, r.stripeAccountId, r.needsAccountCheck);
    const origin = tipOrigin();
    const line = (name: string, cents: number) => ({ quantity: 1, price_data: { currency: "usd", unit_amount: cents, product_data: { name } } });
    const session = await stripe().checkout.sessions.create(
      {
        mode: "payment",
        adaptive_pricing: { enabled: false },
        line_items: [
          line(`Tip for ${target.firstName}`, r.chargedCents - (coverFees ? r.feesCents : 0)),
          ...(coverFees ? [line("Card and service fees", r.feesCents)] : []),
        ],
        metadata: { tipPaymentId: r.tipPaymentId },
        payment_intent_data: { transfer_group: `tip_${r.tipPaymentId}`, metadata: { tipPaymentId: r.tipPaymentId } },
        success_url: `${origin}/${target.handle}?paid={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/${target.handle}`,
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
        // Pay-later on a tip adds dispute risk and no value to a guest. Cards and wallets stay.
        excluded_payment_method_types: ["klarna", "affirm", "afterpay_clearpay"],
        integration_identifier: "tipjar_qr_tjqrgues",
      },
      { idempotencyKey: `checkout:${r.tipPaymentId}` },
    );
    await ctx.runMutation(internal.payments.attachCheckout, { tipPaymentId: r.tipPaymentId, sessionId: session.id, url: session.url ?? undefined });
    if (!session.url) throw new ConvexError("Couldn't start the payment. Try again.");
    return { url: session.url };
  },
});

// The return page's nudge. Reads Stripe; a guest can't claim anything by calling it.
export const refreshGuestReceipt = action({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    const tip = await ctx.runQuery(internal.payments.tipBySession, { sessionId });
    if (tip) await syncPayment(ctx, { tipPaymentId: tip._id, sessionId });
  },
});

// Reading the truth back from Stripe

async function buildSnapshot(paymentIntentId: string, fetchedFrom: number): Promise<PaymentSnapshot> {
  const s = stripe();
  const pi = await s.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.balance_transaction"] });
  const charge = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const txn = charge?.balance_transaction && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
  const disputes = charge ? await s.disputes.list({ charge: charge.id, limit: 10 }) : { data: [] };
  const details = charge?.payment_method_details as { card?: { brand?: string | null } } | null | undefined;
  return {
    fetchedFrom,
    paymentIntentId: pi.id,
    piStatus: pi.status,
    amountCents: pi.amount,
    currency: pi.currency,
    livemode: pi.livemode,
    metadataTipPaymentId: pi.metadata?.tipPaymentId,
    chargeId: charge?.id,
    paidAt: charge ? charge.created * 1000 : undefined,
    stripeFeeCents: txn?.fee ?? undefined,
    refundedCents: charge?.amount_refunded ?? 0,
    cardBrand: details?.card?.brand ?? undefined,
    disputes: disputes.data.map((d) => ({
      id: d.id,
      status: d.status,
      amountCents: d.amount,
      feeCents: (d.balance_transactions ?? []).reduce((a, b) => a + b.fee, 0),
    })),
  };
}

async function syncPayment(ctx: ActionCtx, a: { tipPaymentId?: string; paymentIntentId?: string; sessionId?: string }) {
  const startedAt = Date.now();
  let tip = a.tipPaymentId ? await ctx.runQuery(internal.payments.getTip, { tipPaymentId: a.tipPaymentId }) : null;
  if (!tip && a.paymentIntentId) tip = await ctx.runQuery(internal.payments.tipByIntent, { paymentIntentId: a.paymentIntentId });
  if (!tip && a.sessionId) tip = await ctx.runQuery(internal.payments.tipBySession, { sessionId: a.sessionId });
  if (!tip) return;

  let paymentIntentId = tip.stripePaymentIntentId ?? a.paymentIntentId;
  const sessionId = tip.stripeCheckoutSessionId ?? a.sessionId;
  if (sessionId && !tip.stripePaymentIntentId) {
    const session = await stripe().checkout.sessions.retrieve(sessionId);
    if (session.metadata?.tipPaymentId !== tip._id) {
      await ctx.runMutation(internal.payments.alert, { kind: "payment_mismatch", severity: "critical", message: `Session ${session.id} doesn't belong to payment ${tip._id}.`, ref: session.id });
      return;
    }
    if (!tip.stripeCheckoutSessionId) await ctx.runMutation(internal.payments.attachCheckout, { tipPaymentId: tip._id, sessionId: session.id, url: session.url ?? undefined });
    paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    if (session.status === "expired") await ctx.runMutation(internal.payments.closeUnpaid, { tipPaymentId: tip._id, status: "expired" });
  }
  if (!paymentIntentId) {
    // Nothing ever reached Stripe, or the row was abandoned before it could.
    if (tip.status === "creating" && startedAt - tip._creationTime > 60 * 60 * 1000) {
      await ctx.runMutation(internal.payments.closeUnpaid, { tipPaymentId: tip._id, status: "expired" });
    }
    return;
  }
  const snapshot = await buildSnapshot(paymentIntentId, startedAt);
  await ctx.runMutation(internal.payments.applyPaymentSnapshot, { tipPaymentId: tip._id, snapshot });
}

export const syncPaymentById = internalAction({
  args: { tipPaymentId: v.string() },
  handler: async (ctx, { tipPaymentId }) => {
    await syncPayment(ctx, { tipPaymentId });
  },
});

// Webhooks

// Returns only what's needed. Event contents are never stored or trusted beyond naming what to re-read.
export const verifyWebhook = internalAction({
  args: { body: v.string(), signature: v.string(), source: v.union(v.literal("platform"), v.literal("connect")) },
  handler: async (_ctx, { body, signature, source }) => {
    const secret = source === "platform" ? process.env.STRIPE_WEBHOOK_SECRET : process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
    if (!secret) throw new Error(`Webhook secret for ${source} isn't set`);
    let event: Stripe.Event;
    try {
      // Verification needs no API call, but the SDK's helper hangs off a client.
      event = new Stripe("sk_test_unused").webhooks.constructEvent(body, signature, secret);
    } catch {
      return null;
    }
    return {
      eventId: event.id,
      type: event.type,
      livemode: event.livemode,
      source,
      stripeAccountId: event.account,
      created: event.created,
      target: JSON.stringify(eventTarget(event as never)),
    };
  },
});

async function handleTarget(ctx: ActionCtx, target: EventTarget) {
  switch (target.kind) {
    case "payment":
      await syncPayment(ctx, target);
      return;
    case "account":
      if (await ctx.runQuery(internal.payments.payeeByStripeId, { stripeAccountId: target.stripeAccountId })) await syncAccount(ctx, target.stripeAccountId);
      return;
    case "balance":
      if (await ctx.runQuery(internal.payments.payeeByStripeId, { stripeAccountId: target.stripeAccountId })) await syncBalance(ctx, target.stripeAccountId);
      return;
    case "payout": {
      const payout = await stripe().payouts.retrieve(target.payoutId, {}, { stripeAccount: target.stripeAccountId });
      await ctx.runMutation(internal.payments.upsertPayout, {
        stripeAccountId: target.stripeAccountId,
        stripePayoutId: payout.id,
        amountCents: payout.amount,
        status: payout.status,
        arrivalDate: payout.arrival_date * 1000,
        failureMessage: payout.failure_message ?? undefined,
        livemode: payout.livemode,
      });
      await syncBalance(ctx, target.stripeAccountId);
      return;
    }
    case "platform_payout": {
      const payout = await stripe().payouts.retrieve(target.payoutId);
      await ctx.runMutation(internal.payments.recordPlatformMovement, { kind: "payout", stripeObjectId: payout.id, amountCents: payout.amount, status: payout.status, livemode: payout.livemode });
      return;
    }
    case "platform_topup": {
      const topup = await stripe().topups.retrieve(target.topupId);
      await ctx.runMutation(internal.payments.recordPlatformMovement, { kind: "topup", stripeObjectId: topup.id, amountCents: topup.amount, status: topup.status, livemode: topup.livemode });
      return;
    }
    case "transfer": {
      const transfer = await stripe().transfers.retrieve(target.transferId);
      const allocationId = target.allocationId ?? transfer.metadata?.allocationId;
      if (!allocationId) return;
      await observeTransfer(ctx, allocationId, transfer);
      return;
    }
  }
}

async function observeTransfer(ctx: ActionCtx, allocationId: string, transfer: Stripe.Transfer) {
  const destination = typeof transfer.destination === "string" ? transfer.destination : transfer.destination?.id ?? "";
  const seen = await ctx.runMutation(internal.settlement.observeTransfer, {
    allocationId,
    transferId: transfer.id,
    amountCents: transfer.amount,
    reversedCents: transfer.amount_reversed,
    destination,
  });
  if (seen.unknown) {
    await ctx.runMutation(internal.settlement.completeTransfer, {
      allocationId: allocationId as Id<"allocations">,
      transferId: transfer.id,
      amountCents: transfer.amount,
      destination,
    });
  }
}

export const processEvent = internalAction({
  args: { eventId: v.string() },
  handler: async (ctx, { eventId }) => {
    const event = await ctx.runQuery(internal.payments.getEvent, { eventId });
    if (!event || event.status !== "pending") return;
    try {
      await handleTarget(ctx, JSON.parse(event.target) as EventTarget);
      await ctx.runMutation(internal.payments.finishEvent, { eventId });
    } catch (e) {
      await ctx.runMutation(internal.payments.finishEvent, { eventId, error: e instanceof Error ? e.message : String(e) });
    }
  },
});

// Paying workers

const BATCH = 25;

async function runTransfer(ctx: ActionCtx, allocationId: Id<"allocations">, claim: { amountCents: number; idempotencyKey: string; destination: string; transferGroup: string; sourceCharge?: string; retry: boolean; knownTransferIds: string[]; tipPaymentId: string }) {
  const s = stripe();
  // A retry first looks for what an earlier run did. Keys alone aren't enough: Stripe forgets them after
  // a while, and if a refund changed the amount since, the key differs and it'd pay twice.
  if (claim.retry) {
    const earlier = await s.transfers.list({ transfer_group: claim.transferGroup, limit: 100 });
    const match = earlier.data.find((t) => t.metadata?.allocationId === allocationId && !claim.knownTransferIds.includes(t.id));
    if (match) {
      await ctx.runMutation(internal.settlement.completeTransfer, { allocationId, transferId: match.id, amountCents: match.amount, destination: typeof match.destination === "string" ? match.destination : match.destination?.id ?? "" });
      return;
    }
  }
  // Stripe's view of the recipient, right before moving the money.
  const status = await syncAccount(ctx, claim.destination);
  if (status.transfersStatus !== "active") {
    await ctx.runMutation(internal.settlement.releaseClaim, { allocationId, error: `recipient capability is ${status.transfersStatus}` });
    return;
  }
  const transfer = await s.transfers.create(
    {
      amount: claim.amountCents,
      currency: "usd",
      destination: claim.destination,
      ...(claim.sourceCharge ? { source_transaction: claim.sourceCharge } : { transfer_group: claim.transferGroup }),
      metadata: { allocationId, tipPaymentId: claim.tipPaymentId },
    },
    { idempotencyKey: claim.idempotencyKey },
  );
  await ctx.runMutation(internal.settlement.completeTransfer, {
    allocationId,
    transferId: transfer.id,
    amountCents: transfer.amount,
    destination: typeof transfer.destination === "string" ? transfer.destination : transfer.destination?.id ?? "",
  });
}

async function runReversal(ctx: ActionCtx, allocationId: Id<"allocations">, plan: { transferId: string; amountCents: number; idempotencyKey: string }[], uncoveredCents: number) {
  for (const step of plan) {
    try {
      const reversal = await stripe().transfers.createReversal(step.transferId, { amount: step.amountCents, metadata: { allocationId } }, { idempotencyKey: step.idempotencyKey });
      await ctx.runMutation(internal.settlement.recordReversal, { allocationId, transferId: step.transferId, reversalId: reversal.id, amountCents: reversal.amount });
    } catch (e) {
      if (e instanceof Stripe.errors.StripeInvalidRequestError || (e as { type?: string })?.type === "StripeInvalidRequestError") {
        // The worker's balance can't cover it. Retrying won't help until they have more.
        await ctx.runMutation(internal.settlement.reversalShort, { allocationId, amountCents: step.amountCents, reason: (e as Error).message });
        continue;
      }
      throw e;
    }
  }
  if (uncoveredCents > 0) await ctx.runMutation(internal.settlement.reversalShort, { allocationId, amountCents: uncoveredCents, reason: "No transfer left to reverse" });
  await ctx.runMutation(internal.settlement.finishReversal, { allocationId });
}

export const runDue = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.settlement.releaseStuck, {});
    const ids = await ctx.runQuery(internal.settlement.dueAllocations, { limit: BATCH });
    for (const allocationId of ids) {
      const claim = await ctx.runMutation(internal.settlement.claimAllocation, { allocationId });
      if (claim.action === "skip") continue;
      try {
        if (claim.action === "transfer") await runTransfer(ctx, allocationId, claim);
        else await runReversal(ctx, allocationId, claim.plan, claim.uncoveredCents);
      } catch (e) {
        await ctx.runMutation(internal.settlement.releaseClaim, { allocationId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (ids.length === BATCH) await ctx.scheduler.runAfter(0, internal.paymentsNode.runDue, {});
  },
});

// Operator tools

// `npx convex run paymentsNode:refundTip '{"tipPaymentId":"...","reason":"requested_by_customer"}'`
export const refundTip = internalAction({
  args: { tipPaymentId: v.string(), amountCents: v.optional(v.number()) },
  handler: async (ctx, { tipPaymentId, amountCents }) => {
    const tip = await ctx.runQuery(internal.payments.getTip, { tipPaymentId });
    if (!tip?.stripePaymentIntentId) throw new Error("No such paid tip");
    const amount = amountCents ?? tip.chargedCents - tip.refundedCents;
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("Nothing to refund");
    const refund = await stripe().refunds.create(
      { payment_intent: tip.stripePaymentIntentId, amount, reason: "requested_by_customer", metadata: { tipPaymentId: tip._id } },
      { idempotencyKey: `refund:${tip._id}:${tip.refundedCents}:${amount}` },
    );
    await syncPayment(ctx, { tipPaymentId: tip._id });
    return { refundId: refund.id, status: refund.status };
  },
});

// Hourly: catches anything a webhook missed.
export const reconcile = internalAction({
  args: {},
  handler: async (ctx) => {
    for (const eventId of await ctx.runQuery(internal.payments.dueEvents, {})) {
      await ctx.runAction(internal.paymentsNode.processEvent, { eventId });
    }
    const ids = await ctx.runQuery(internal.payments.paymentsToRecheck, {});
    for (const tipPaymentId of ids) {
      try {
        await syncPayment(ctx, { tipPaymentId });
      } catch (e) {
        await ctx.runMutation(internal.payments.alert, { kind: "sync_failed", severity: "warning", message: `Couldn't sync ${tipPaymentId}: ${e instanceof Error ? e.message : e}`, ref: tipPaymentId });
      }
    }
    for (const stripeAccountId of await ctx.runQuery(internal.payments.accountsToRefresh, {})) {
      try {
        await syncAccount(ctx, stripeAccountId);
        await syncBalance(ctx, stripeAccountId);
      } catch (e) {
        await ctx.runMutation(internal.payments.alert, { kind: "sync_failed", severity: "warning", message: `Couldn't sync ${stripeAccountId}: ${e instanceof Error ? e.message : e}`, ref: stripeAccountId });
      }
    }
  },
});

// Daily: our books against Stripe's balance, and every recent charge against our records.
export const reconcileBooks = internalAction({
  args: {},
  handler: async (ctx) => {
    const { mode } = requireStripeConfig();
    const s = stripe();
    const balance = await s.balance.retrieve();
    const availableCents = usdCents(balance.available);
    const pendingCents = usdCents(balance.pending);
    const { rows, reserveCents } = await ctx.runQuery(internal.ops.ledgerRows, {});
    const totals = ledgerTotals(rows);
    const problems: string[] = [];
    if (availableCents + pendingCents < totals.workerLiabilityCents) {
      problems.push(`Stripe holds ${availableCents + pendingCents}, but workers are owed ${totals.workerLiabilityCents}.`);
    }
    // Stripe also debits things we don't book per tip, like monthly Connect fees, so a difference is worth a look but isn't alarming alone.
    const differenceCents = availableCents + pendingCents - totals.expectedStripeBalanceCents;
    const since = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;
    const intents = await s.paymentIntents.list({ created: { gte: since }, limit: 100 });
    const paid = intents.data.filter((p) => p.status === "succeeded");
    const known = new Set(await ctx.runQuery(internal.payments.knownIntents, { paymentIntentIds: paid.map((p) => p.id) }));
    for (const p of paid) {
      if (!known.has(p.id)) problems.push(`PaymentIntent ${p.id} succeeded on Stripe with no record here.`);
    }
    await ctx.runMutation(internal.ops.saveReconciliation, {
      livemode: isLive(mode),
      availableCents,
      pendingCents,
      expectedStripeBalanceCents: totals.expectedStripeBalanceCents,
      workerLiabilityCents: totals.workerLiabilityCents,
      platformRevenueCents: totals.platformRevenueCents,
      safeToWithdrawCents: safeToWithdraw({ availableCents, workerLiabilityCents: totals.workerLiabilityCents, reserveCents }),
      differenceCents,
      problems,
    });
    return { problems };
  },
});

// Off unless OPS_ALERT_WEBHOOK_URL is set. Alerts are always readable with ops:status either way.
export const sendAlert = internalAction({
  args: { kind: v.string(), severity: v.string(), message: v.string() },
  handler: async (_ctx, { kind, severity, message }) => {
    const url = process.env.OPS_ALERT_WEBHOOK_URL;
    if (!url) return;
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `[Tip Jar ${severity}] ${kind}: ${message}` }) });
  },
});
