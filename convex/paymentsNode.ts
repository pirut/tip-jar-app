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
import { ledgerTotals } from "./lib/paymentRules";
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

const payoutSchedule = (desired: "weekly" | "manual"): Stripe.BalanceSettingsUpdateParams.Payments.Payouts.Schedule =>
  desired === "manual" ? { interval: "manual" } : { interval: "weekly", weekly_payout_days: ["monday"] };

// Every page of a Stripe list. Stripe's lists are newest first and give ids to continue from.
async function listAll<T extends { id: string }>(page: (startingAfter?: string) => Promise<{ data: T[]; has_more?: boolean }>): Promise<T[]> {
  const out: T[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const { data, has_more } = await page(startingAfter);
    out.push(...data);
    if (!has_more || data.length === 0) return out;
    startingAfter = data[data.length - 1].id;
  }
}

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
      stripeAccountId = saved!.stripeAccountId as string;
    }
    // Daily payouts cost more than a tip's fee earns; see docs/payments-architecture.md. Checked on
    // every visit, and it always asks for what the row wants, so a frozen worker stays on manual.
    const payee: Doc<"payeeAccounts"> | null = existing ?? await ctx.runQuery(internal.payments.payeeForToken, { tokenIdentifier: identity.tokenIdentifier });
    if (payee) await applyPayoutSchedule(ctx, payee._id);
    // Stripe only offers the update flow once onboarding has been finished.
    const finished = !!existing && existing.transfersStatus === "active";
    return { url: await accountLinkUrl(stripeAccountId!, !finished) };
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

// Makes Stripe's schedule match the row's desired one, and only records what Stripe confirms. Failures
// are recorded and retried rather than thrown: nothing retries a scheduled action that throws.
async function applyPayoutSchedule(ctx: ActionCtx, payeeAccountId: Id<"payeeAccounts">) {
  for (let pass = 0; pass < 3; pass++) {
    const payee = await ctx.runQuery(internal.payments.payeeById, { payeeAccountId });
    if (!payee) return;
    const { payoutScheduleDesired: desired, payoutScheduleGeneration: generation, stripeAccountId } = payee;
    try {
      const options = { stripeAccount: stripeAccountId };
      const read = async () => (await stripe().balanceSettings.retrieve({}, options)).payments?.payouts?.schedule?.interval;
      let interval = await read();
      // Stripe differing from what it last confirmed means someone else changed it.
      const drifted = interval !== desired && payee.payoutScheduleConfirmed === desired;
      if (interval !== desired) {
        await stripe().balanceSettings.update({ payments: { payouts: { schedule: payoutSchedule(desired) } } }, options);
        interval = await read();
        if (interval !== desired) throw new Error(`Stripe reports ${interval} after being asked for ${desired}`);
      }
      const { current } = await ctx.runMutation(internal.payments.confirmPayoutSchedule, { payeeAccountId, generation, interval: interval!, drifted });
      if (current) return;
      // The desired schedule changed while this ran. Stripe may now have the old one, so go again.
    } catch (e) {
      await ctx.runMutation(internal.payments.payoutScheduleFailed, { payeeAccountId, generation, error: e instanceof Error ? e.message : String(e) });
      return;
    }
  }
}

export const enforcePayoutSchedule = internalAction({
  args: { payeeAccountId: v.id("payeeAccounts") },
  handler: async (ctx, { payeeAccountId }) => {
    await applyPayoutSchedule(ctx, payeeAccountId);
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
    // A busy payment can lose every read to newer ones. Those will update the receipt, so stay quiet.
    if (tip) await syncPayment(ctx, { tipPaymentId: tip._id, sessionId }).catch((e) => console.warn(e));
  },
});

// Reading the truth back from Stripe

async function buildSnapshot(paymentIntentId: string): Promise<PaymentSnapshot> {
  const s = stripe();
  const pi = await s.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.balance_transaction"] });
  const charge = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const txn = charge?.balance_transaction && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
  const disputes = charge ? await listAll((starting_after) => s.disputes.list({ charge: charge.id, limit: 100, starting_after })) : [];
  // charge.amount_refunded can't say what happened to each refund. A failed one must count for nothing.
  const refunds = charge ? await listAll((starting_after) => s.refunds.list({ charge: charge.id, limit: 100, starting_after })) : [];
  const details = charge?.payment_method_details as { card?: { brand?: string | null } } | null | undefined;
  return {
    paymentIntentId: pi.id,
    piStatus: pi.status,
    amountCents: pi.amount,
    currency: pi.currency,
    livemode: pi.livemode,
    metadataTipPaymentId: pi.metadata?.tipPaymentId,
    chargeId: charge?.id,
    paidAt: charge ? charge.created * 1000 : undefined,
    stripeFeeCents: txn?.fee ?? undefined,
    refunds: refunds.map((r) => ({ id: r.id, amountCents: r.amount, status: r.status ?? "pending" })),
    cardBrand: details?.card?.brand ?? undefined,
    disputes: disputes.map((d) => ({
      id: d.id,
      status: d.status,
      amountCents: d.amount,
      feeCents: (d.balance_transactions ?? []).reduce((a, b) => a + b.fee, 0),
    })),
  };
}

const READ_ATTEMPTS = 4;

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
  // Overlapping reads can finish in any order, so only the newest one to start can be applied. A read
  // that's overtaken starts again. The last one to start always applies, unless its run dies, and then
  // the thrown error (or the hourly recheck) brings it back.
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 100 * attempt));
    const readToken = await ctx.runMutation(internal.payments.beginPaymentRead, { tipPaymentId: tip._id });
    if (readToken === null) return;
    const snapshot = await buildSnapshot(paymentIntentId);
    const result = await ctx.runMutation(internal.payments.applyPaymentSnapshot, { tipPaymentId: tip._id, readToken, snapshot });
    if (result.reason !== "superseded") return;
  }
  throw new Error(`Payment ${tip._id} was overtaken by other reads ${READ_ATTEMPTS} times`);
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
      await recordOwnerPayout(ctx, await stripe().payouts.retrieve(target.payoutId));
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

async function recordOwnerPayout(ctx: ActionCtx, payout: Stripe.Payout) {
  await ctx.runMutation(internal.payments.recordPlatformMovement, { kind: "payout", stripeObjectId: payout.id, amountCents: payout.amount, status: payout.status, livemode: payout.livemode });
  const balance = await stripe().balance.retrieve();
  await ctx.runMutation(internal.payments.checkOwnerPayout, {
    stripeObjectId: payout.id,
    amountCents: payout.amount,
    status: payout.status,
    automatic: payout.automatic === true,
    availableCents: usdCents(balance.available),
    connectReservedCents: usdCents(balance.connect_reserved),
  });
}

const destinationOf = (transfer: Stripe.Transfer) => (typeof transfer.destination === "string" ? transfer.destination : transfer.destination?.id ?? "");

// Writes down what Stripe says about one transfer. True if it wasn't on file before.
async function observeTransfer(ctx: ActionCtx, allocationId: string, transfer: Stripe.Transfer): Promise<boolean> {
  const fields = { allocationId, transferId: transfer.id, amountCents: transfer.amount, reversedCents: transfer.amount_reversed, destination: destinationOf(transfer) };
  const seen = await ctx.runMutation(internal.settlement.observeTransfer, fields);
  if (!seen.unknown) return false;
  await ctx.runMutation(internal.settlement.completeTransfer, {
    allocationId: allocationId as Id<"allocations">,
    transferId: transfer.id,
    amountCents: transfer.amount,
    destination: fields.destination,
  });
  // It may have been reversed already, before we ever knew about it.
  if (transfer.amount_reversed > 0) await ctx.runMutation(internal.settlement.observeTransfer, fields);
  return true;
}

// Brings an allocation up to date with Stripe, including transfers an earlier run made but never wrote
// down. A retrieve is exact for known ids; the list finds the unknown ones. Returns how many were new.
async function refreshAllocation(ctx: ActionCtx, allocationId: Id<"allocations">, transferGroup: string): Promise<number> {
  const s = stripe();
  const a: Doc<"allocations"> | null = await ctx.runQuery(internal.settlement.allocationForAlert, { allocationId });
  for (const known of a?.transfers ?? []) await observeTransfer(ctx, allocationId, await s.transfers.retrieve(known.id));
  const inGroup = await listAll((starting_after) => s.transfers.list({ transfer_group: transferGroup, limit: 100, starting_after }));
  let found = 0;
  for (const t of inGroup) {
    if (t.metadata?.allocationId === allocationId && !a?.transfers.some((k: { id: string }) => k.id === t.id)) {
      if (await observeTransfer(ctx, allocationId, t)) found++;
    }
  }
  return found;
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

async function runTransfer(ctx: ActionCtx, allocationId: Id<"allocations">, claim: { amountCents: number; idempotencyKey: string; destination: string; transferGroup: string; sourceCharge?: string; retry: boolean; tipPaymentId: string }) {
  const s = stripe();
  // A retry first looks for what an earlier run did. Keys alone aren't enough: Stripe forgets them after
  // a while, and if a refund changed the amount since, the key differs and it'd pay twice.
  if (claim.retry && (await refreshAllocation(ctx, allocationId, claim.transferGroup)) > 0) return;
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
    destination: destinationOf(transfer),
  });
}

// What Stripe says when a connected account can't cover a reversal. The sandbox never returns this for
// the recipient accounts this pilot uses (they go negative instead), so it's matched by meaning and
// anything else counts as an ordinary failure. docs/pilot-runbook.md lists this as a live check.
function isShortBalance(e: unknown): boolean {
  const { type, code, message } = (e ?? {}) as { type?: string; code?: string; message?: string };
  if (type !== "StripeInvalidRequestError") return false;
  return code === "insufficient_funds" || code === "balance_insufficient" || /insufficient (funds|balance)/i.test(message ?? "");
}

// Reads Stripe's totals first, so what an earlier run or the Dashboard already reversed isn't reversed
// again, then plans from those. Going negative is a success as far as Stripe is concerned, so the
// worker's balance gets checked afterwards either way.
async function runReversal(ctx: ActionCtx, allocationId: Id<"allocations">, claim: { transferGroup: string; destination: string }) {
  const s = stripe();
  await refreshAllocation(ctx, allocationId, claim.transferGroup);
  const { plan, uncoveredCents } = await ctx.runMutation(internal.settlement.planClaimedReversal, { allocationId });
  let short: string | null = null;
  for (const step of plan) {
    try {
      await s.transfers.createReversal(step.transferId, { amount: step.amountCents, metadata: { allocationId } }, { idempotencyKey: step.idempotencyKey });
    } catch (e) {
      if (!isShortBalance(e)) throw e;
      short = (e as Error).message;
      break;
    }
    await observeTransfer(ctx, allocationId, await s.transfers.retrieve(step.transferId));
  }
  await syncBalance(ctx, claim.destination).catch((e) => console.warn(`Balance check after reversal: ${e}`));
  if (short) {
    await ctx.runMutation(internal.settlement.reversalShort, { allocationId, reason: short });
    return;
  }
  if (uncoveredCents > 0) await ctx.runMutation(internal.settlement.reversalUncovered, { allocationId, amountCents: uncoveredCents });
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
        else if (claim.action === "reverse") await runReversal(ctx, allocationId, claim);
        else {
          await refreshAllocation(ctx, allocationId, claim.transferGroup);
          await ctx.runMutation(internal.settlement.finishRecheck, { allocationId });
        }
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
      // The count of refunds tells a new try apart from a retry, after an earlier refund failed.
      { idempotencyKey: `refund:${tip._id}:${tip.refunds.length}:${tip.refundedCents}:${amount}` },
    );
    // The refund has happened. If this read loses out, the webhook and the hourly recheck carry on.
    await syncPayment(ctx, { tipPaymentId: tip._id }).catch((e) => console.warn(e));
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
        // Catches a freeze whose Stripe call never landed, and anyone changing it in the Dashboard.
        const payee = await ctx.runQuery(internal.payments.payeeByStripeId, { stripeAccountId });
        if (payee) await applyPayoutSchedule(ctx, payee._id);
      } catch (e) {
        await ctx.runMutation(internal.payments.alert, { kind: "sync_failed", severity: "warning", message: `Couldn't sync ${stripeAccountId}: ${e instanceof Error ? e.message : e}`, ref: stripeAccountId });
      }
    }
  },
});

const SCAN_PAGES_PER_RUN = 20;
const OPEN_TXNS_PER_RUN = 25;

const idOf = (value: unknown) => (typeof value === "string" ? value : (value as { id?: string } | null | undefined)?.id);

function txnRow(t: Stripe.BalanceTransaction) {
  return {
    txnId: t.id,
    created: t.created,
    type: t.type,
    reportingCategory: t.reporting_category ?? undefined,
    amountCents: t.amount,
    feeCents: t.fee,
    netCents: t.net,
    currency: t.currency,
    sourceId: idOf(t.source),
    livemode: isLive(requireStripeConfig().mode),
  };
}

function txnFacts(t: Stripe.BalanceTransaction) {
  const source = (typeof t.source === "object" ? t.source : null) as null | { id: string; object?: string; [k: string]: any };
  const fields = source?.object === "charge"
    ? { paymentIntentId: idOf(source.payment_intent), metadataTipPaymentId: source.metadata?.tipPaymentId }
    : source?.object === "refund" || source?.object === "dispute"
      ? { chargeId: idOf(source.charge), paymentIntentId: idOf(source.payment_intent), metadataTipPaymentId: source.metadata?.tipPaymentId }
      : source?.object === "transfer"
        ? { allocationId: source.metadata?.allocationId, destination: idOf(source.destination), transferAmountCents: source.amount, transferReversedCents: source.amount_reversed }
        : source?.object === "topup"
          ? { sourceStatus: source.status }
          : {};
  return { sourceId: idOf(t.source), ...fields };
}

// Fetches whatever a transaction shows we're missing. Stripe is where the facts come from; the
// transaction only says which object to read. A webhook that never arrived gets repaired here.
async function repairFromTxn(ctx: ActionCtx, t: Stripe.BalanceTransaction, txnClass: string) {
  const source = (typeof t.source === "object" ? t.source : null) as null | { id: string; [k: string]: any };
  if (!source) return;
  switch (txnClass) {
    case "charge":
    case "refund":
    case "refund_failure":
    case "dispute": {
      const paymentIntentId = idOf(source.payment_intent);
      let tipPaymentId: string | undefined = source.metadata?.tipPaymentId;
      if (!tipPaymentId && paymentIntentId) tipPaymentId = (await stripe().paymentIntents.retrieve(paymentIntentId)).metadata?.tipPaymentId;
      if (tipPaymentId) await syncPayment(ctx, { tipPaymentId });
      else if (paymentIntentId) await syncPayment(ctx, { paymentIntentId });
      return;
    }
    case "transfer":
    case "transfer_reversal":
    case "transfer_failure": {
      const allocationId = source.metadata?.allocationId;
      if (allocationId) await observeTransfer(ctx, allocationId, source as unknown as Stripe.Transfer);
      return;
    }
    case "owner_payout":
      await recordOwnerPayout(ctx, source as unknown as Stripe.Payout);
      return;
    case "owner_topup":
      await ctx.runMutation(internal.payments.recordPlatformMovement, { kind: "topup", stripeObjectId: source.id, amountCents: source.amount, status: source.status, livemode: source.livemode });
      return;
  }
}

async function explainTxn(ctx: ActionCtx, t: Stripe.BalanceTransaction) {
  const row = txnRow(t);
  const first = await ctx.runMutation(internal.reconciliation.matchTxn, { row, facts: txnFacts(t) });
  // Owner movements are booked by reading them, so they always go through the repair step.
  if (first.state === "matched" && first.txnClass !== "owner_payout" && first.txnClass !== "owner_topup") return;
  if (first.state === "acknowledged") return;
  try {
    await repairFromTxn(ctx, t, first.txnClass);
  } catch (e) {
    // Couldn't look. It stays open and blocks withdrawals, and the next run tries again.
    console.warn(`Couldn't repair from ${t.id}: ${e}`);
    return;
  }
  const second = await ctx.runMutation(internal.reconciliation.matchTxn, { row, facts: txnFacts(t) });
  if (second.state !== "open") return;
  const { destination } = txnFacts(t) as { destination?: string };
  const unknownOutflow = second.txnClass === "transfer" && t.amount < 0 && second.noAllocation === true;
  await ctx.runMutation(internal.reconciliation.flagTxn, { txnId: t.id, destination, unknownOutflow });
}

// Reads every balance transaction since the last run, newest first, in pages. Its position is saved, so
// a run that's cut off carries on where it stopped. Returns whether it got to the end.
async function scanBalanceTxns(ctx: ActionCtx): Promise<boolean> {
  const s = stripe();
  const { fromCreated, startingAfter: saved } = await ctx.runMutation(internal.reconciliation.startScan, {});
  let startingAfter = saved;
  for (let i = 0; i < SCAN_PAGES_PER_RUN; i++) {
    const page = await s.balanceTransactions.list({ created: { gte: fromCreated }, limit: 100, starting_after: startingAfter, expand: ["data.source"] });
    const closed = new Set(await ctx.runQuery(internal.reconciliation.seenTxns, { txnIds: page.data.map((t) => t.id) }));
    for (const t of page.data) if (!closed.has(t.id)) await explainTxn(ctx, t);
    startingAfter = page.data[page.data.length - 1]?.id ?? startingAfter;
    await ctx.runMutation(internal.reconciliation.savePage, { startingAfter: page.has_more ? startingAfter : undefined, newestCreated: page.data[0]?.created });
    if (!page.has_more) {
      await ctx.runMutation(internal.reconciliation.finishScan, { nowSeconds: Math.floor(Date.now() / 1000) });
      return true;
    }
  }
  return false;
}

// Our books against Stripe: every balance movement explained, then the totals compared.
export const reconcileBooks = internalAction({
  args: {},
  handler: async (ctx): Promise<{ problems: string[]; safeToWithdrawCents: number; blockers: string[] }> => {
    const { mode } = requireStripeConfig();
    const s = stripe();
    const complete = await scanBalanceTxns(ctx);
    if (!complete) await ctx.scheduler.runAfter(0, internal.paymentsNode.reconcileBooks, {});
    // Older unexplained rows get another look, in case what they were waiting for has turned up.
    for (const txnId of await ctx.runQuery(internal.reconciliation.openTxns, { limit: OPEN_TXNS_PER_RUN })) {
      await explainTxn(ctx, await s.balanceTransactions.retrieve(txnId, { expand: ["source"] }));
    }
    const balance = await s.balance.retrieve();
    const availableCents = usdCents(balance.available);
    const pendingCents = usdCents(balance.pending);
    const connectReservedCents = usdCents(balance.connect_reserved);
    const { rows, reserveCents } = await ctx.runQuery(internal.ops.ledgerRows, {});
    const totals = ledgerTotals(rows);
    const problems: string[] = [];
    const totalCents = availableCents + pendingCents;
    const opening: { openingCents: number; scannedNetCents: number } | null = complete ? await ctx.runMutation(internal.reconciliation.openingBalance, { totalCents }) : null;
    const openingCents: number = opening?.openingCents ?? 0;
    // Stripe's own list has to add up to its balance, or the scan has missed something.
    if (opening && opening.openingCents + opening.scannedNetCents !== totalCents) {
      problems.push(`Stripe's balance is ${totalCents}, but its transactions add up to ${opening.openingCents + opening.scannedNetCents}.`);
    }
    // Every movement is booked now, fees included, so whatever's left over is a real discrepancy.
    const differenceCents = complete ? totalCents - openingCents - totals.expectedStripeBalanceCents : 0;
    let platformPayoutInterval: string | undefined;
    try {
      platformPayoutInterval = (await s.balanceSettings.retrieve()).payments?.payouts?.schedule?.interval ?? undefined;
    } catch (e) {
      console.warn(`Couldn't read the platform's payout schedule: ${e}`);
    }
    const saved: { problems: string[]; safeToWithdrawCents: number; blockers: string[] } = await ctx.runMutation(internal.ops.saveReconciliation, {
      livemode: isLive(mode),
      availableCents,
      pendingCents,
      connectReservedCents,
      expectedStripeBalanceCents: totals.expectedStripeBalanceCents,
      openingBalanceCents: openingCents,
      workerLiabilityCents: totals.workerLiabilityCents,
      platformRevenueCents: totals.platformRevenueCents,
      differenceCents,
      platformPayoutInterval,
      scanComplete: complete,
      problems,
    });
    return { problems: saved.problems, safeToWithdrawCents: saved.safeToWithdrawCents, blockers: saved.blockers };
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
