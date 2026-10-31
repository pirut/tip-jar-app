// Stands in for Stripe's API in tests: it keeps state, honors idempotency keys and filters, keeps a
// balance transaction for every movement, and can be told to fail. It proves our logic against the API
// as we understand it, not that the API behaves this way. Real-API evidence comes from
// scripts/sandbox-e2e.ts and scripts/sandbox-probes.ts; those probes are what these behaviours copy.
export class FakeStripeError extends Error {
  type = "StripeInvalidRequestError";
}

export class FakeIdempotencyError extends Error {
  type = "StripeIdempotencyError";
}

export function fakeStripe() {
  let n = 0;
  const id = (prefix: string) => `${prefix}_${++n}`;
  const seen = new Map<string, { params: string; out: any }>();
  const once = (options: any, make: () => any, params?: any) => {
    const key = options?.idempotencyKey;
    const body = JSON.stringify(params ?? null);
    const earlier = key ? seen.get(key) : undefined;
    if (earlier) {
      if (earlier.params !== body) throw new FakeIdempotencyError("Keys for idempotent requests can only be used with the same parameters they were first used with.");
      return earlier.out;
    }
    const out = make();
    if (key) seen.set(key, { params: body, out });
    return out;
  };
  // Stripe's list behaviour: newest first, and ids to page from.
  const pageOf = (rows: any[], params: any = {}) => {
    const newestFirst = [...rows].reverse();
    const start = params.starting_after ? newestFirst.findIndex((r) => r.id === params.starting_after) + 1 : 0;
    const limit = params.limit ?? 10;
    return { data: newestFirst.slice(start, start + limit), has_more: start + limit < newestFirst.length };
  };
  const accounts = new Map<string, any>();
  const sessions = new Map<string, any>();
  const intents = new Map<string, any>();
  const charges = new Map<string, any>();
  const disputes: any[] = [];
  const refunds: any[] = [];
  const txns: any[] = [];
  const transfers = new Map<string, any>();
  const balances = new Map<string, { available: number; pending: number }>();
  const payoutSchedules: Record<string, any> = {};
  const payouts = new Map<string, any>();
  const calls: string[] = [];
  const extra = { balance: 0 };
  const topups = new Map<string, any>();
  // connectedReserves: on, as with the platform-liability accounts in the sandbox, a reversal always
  // succeeds and can take a worker's balance negative. Off, Stripe refuses it, as its docs describe.
  const knobs = { failTransfer: null as null | Error, failReversal: null as null | Error, crashAfterTransfer: false, connectedReserves: true };

  const txn = (type: string, amount: number, source: string, opts: { fee?: number; category?: string; currency?: string } = {}) => {
    const fee = opts.fee ?? 0;
    const t = { id: id("txn"), object: "balance_transaction", type, reporting_category: opts.category ?? type, amount, fee, net: amount - fee, currency: opts.currency ?? "usd", source, created: Math.floor(Date.now() / 1000), status: "available" };
    txns.push(t);
    return t;
  };
  // Stripe holds back a negative worker balance from the platform's, a little later in real life.
  const reserved = new Map<string, number>();
  const settleReserve = (accountId: string) => {
    const b = balances.get(accountId) ?? { available: 0, pending: 0 };
    const want = Math.max(0, -b.available);
    const had = reserved.get(accountId) ?? 0;
    if (want !== had) txn("reserve_transaction", had - want, accountId, { category: "connect_reserved_funds" });
    reserved.set(accountId, want);
  };
  const reservedTotal = () => [...reserved.values()].reduce((a, x) => a + x, 0);
  const sourceOf = (t: any): any => {
    for (const map of [charges, transfers, payouts, topups]) if (map.has(t.source)) return { object: map === charges ? "charge" : map === transfers ? "transfer" : map === payouts ? "payout" : "topup", ...map.get(t.source) };
    const refund = refunds.find((r) => r.id === t.source);
    if (refund) return { object: "refund", ...refund };
    const dispute = disputes.find((d) => d.id === t.source);
    if (dispute) return { object: "dispute", ...dispute };
    return t.source;
  };
  const expandTxn = (t: any, on: boolean) => (on ? { ...t, source: sourceOf(t) } : t);
  // A dispute takes the money while it's on, and gives it back if it's won.
  const takesMoney = (status: string) => !["warning_needs_response", "warning_under_review", "warning_closed", "won", "prevented"].includes(status);
  const moveDisputeMoney = (d: any, status: string) => {
    if (takesMoney(status) && !d.taken) {
      d.taken = true;
      const fee = d.balance_transactions.length === 0 ? 1500 : 0;
      if (fee) d.balance_transactions.push({ fee });
      txn("adjustment", -d.amount, d.id, { fee, category: "dispute" });
    } else if (!takesMoney(status) && d.taken) {
      d.taken = false;
      txn("adjustment", d.amount, d.id, { category: "dispute_reversal" });
    }
    d.status = status;
  };

  const accountBody = (a: any) => ({
    id: a.id,
    livemode: false,
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: a.transfers }, payouts: { status: a.payouts } } } } },
    requirements: { entries: a.due.map((d: string) => ({ description: d, minimum_deadline: { status: "currently_due" } })) },
  });

  const client: any = {
    v2: {
      core: {
        accounts: {
          create: async (params: any, options: any) => once(options, () => {
            calls.push("accounts.create");
            const a = { id: id("acct"), params, transfers: "pending", payouts: "pending", due: ["identity"] };
            accounts.set(a.id, a);
            return accountBody(a);
          }),
          retrieve: async (accountId: string) => accountBody(accounts.get(accountId)),
        },
        accountLinks: {
          create: async (params: any) => { calls.push(`accountLinks.create:${params.use_case.type}`); return { url: `https://connect.stripe.test/${params.account}` }; },
        },
      },
    },
    accounts: { createLoginLink: async (accountId: string) => ({ url: `https://express.stripe.test/${accountId}` }) },
    balanceSettings: {
      // A new account starts on Stripe's default, not ours. The platform's own defaults to manual here.
      retrieve: async (_params: any, options: any) => ({ payments: { payouts: { schedule: payoutSchedules[options?.stripeAccount ?? "platform"] ?? { interval: options?.stripeAccount ? "daily" : "manual" } } } }),
      update: async (params: any, options: any) => { payoutSchedules[options?.stripeAccount ?? "platform"] = params.payments.payouts.schedule; return {}; },
    },
    balance: {
      retrieve: async (_params: any, options: any) => {
        if (!options?.stripeAccount) {
          const total = extra.balance + txns.filter((t) => t.currency === "usd").reduce((a, t) => a + t.net, 0);
          return { available: [{ amount: total, currency: "usd" }], pending: [], connect_reserved: [{ amount: reservedTotal(), currency: "usd" }] };
        }
        const b = balances.get(options.stripeAccount) ?? { available: 0, pending: 0 };
        return { available: [{ amount: b.available, currency: "usd" }], pending: [{ amount: b.pending, currency: "usd" }] };
      },
    },
    balanceTransactions: {
      list: async (params: any = {}) => {
        const from = params.created?.gte ?? 0;
        const { data, has_more } = pageOf(txns.filter((t) => t.created >= from), params);
        return { data: data.map((t) => expandTxn(t, (params.expand ?? []).includes("data.source"))), has_more };
      },
      retrieve: async (txnId: string, params: any = {}) => expandTxn(txns.find((t) => t.id === txnId), (params.expand ?? []).includes("source")),
    },
    checkout: {
      sessions: {
        create: async (params: any, options: any) => once(options, () => {
          calls.push("checkout.create");
          const total = params.line_items.reduce((a: number, l: any) => a + l.price_data.unit_amount * l.quantity, 0);
          const s = { id: id("cs_test"), url: `https://checkout.stripe.test/${n}`, status: "open", metadata: params.metadata, payment_intent: null, total, params };
          sessions.set(s.id, s);
          return s;
        }),
        retrieve: async (sessionId: string) => sessions.get(sessionId),
      },
    },
    paymentIntents: {
      retrieve: async (intentId: string) => {
        const pi = intents.get(intentId);
        return { ...pi, latest_charge: pi.chargeId ? chargeBody(pi.chargeId) : null };
      },
      list: async (params: any = {}) => pageOf([...intents.values()], { limit: 100, ...params }),
    },
    disputes: { list: async (params: any) => pageOf(disputes.filter((d) => d.charge === params.charge), params) },
    refunds: {
      create: async (params: any, options: any) => once(options, () => addRefund(intents.get(params.payment_intent).chargeId, params.amount), params),
      list: async (params: any) => pageOf(refunds.filter((r) => r.charge === params.charge), params),
    },
    transfers: {
      create: async (params: any, options: any) => {
        if (knobs.failTransfer) throw knobs.failTransfer;
        const out = once(options, () => {
          calls.push("transfers.create");
          // A source_transaction transfer takes the charge's group. Confirmed against the sandbox.
          const group = params.transfer_group ?? (params.source_transaction ? charges.get(params.source_transaction)?.transfer_group ?? `group_${params.source_transaction}` : undefined);
          const t = { id: id("tr"), amount: params.amount, amount_reversed: 0, destination: params.destination, metadata: params.metadata, source_transaction: params.source_transaction, transfer_group: group };
          transfers.set(t.id, t);
          const b = balances.get(params.destination) ?? { available: 0, pending: 0 };
          b.available += params.amount;
          balances.set(params.destination, b);
          settleReserve(params.destination);
          txn("transfer", -params.amount, t.id);
          return t;
        }, params);
        if (knobs.crashAfterTransfer) {
          knobs.crashAfterTransfer = false;
          throw new Error("network dropped after Stripe succeeded");
        }
        return out;
      },
      list: async (params: any = {}) => pageOf([...transfers.values()].filter((t) => params.transfer_group === undefined || t.transfer_group === params.transfer_group), params),
      retrieve: async (transferId: string) => ({ ...transfers.get(transferId) }),
      createReversal: async (transferId: string, params: any, options: any) => {
        if (knobs.failReversal) throw knobs.failReversal;
        return once(options, () => {
          const t = transfers.get(transferId);
          if (params.amount > t.amount - t.amount_reversed) throw new FakeStripeError(`This transfer only has ${t.amount - t.amount_reversed} remaining to reverse.`);
          const b = balances.get(t.destination)!;
          if (!knobs.connectedReserves && b.available + b.pending < params.amount) throw new FakeStripeError("Insufficient funds in the connected account");
          // Pending funds count, as the sandbox showed. Past that, the balance goes negative.
          const fromPending = Math.min(Math.max(0, b.pending), params.amount);
          b.pending -= fromPending;
          b.available -= params.amount - fromPending;
          t.amount_reversed += params.amount;
          calls.push("transfers.reverse");
          // Stripe's transaction for a reversal names the transfer as its source, not the reversal.
          txn("transfer_refund", params.amount, transferId, { category: "transfer_reversal" });
          settleReserve(t.destination);
          return { id: id("trr"), amount: params.amount };
        }, params);
      },
    },
    payouts: { retrieve: async (payoutId: string) => payouts.get(payoutId) },
    topups: { retrieve: async (topupId: string) => topups.get(topupId) },
  };

  const addRefund = (chargeId: string, amount: number, status = "succeeded") => {
    const c = charges.get(chargeId);
    const r = { id: id("re"), amount, charge: chargeId, payment_intent: c.intentId, status, metadata: {} };
    refunds.push(r);
    c.amount_refunded += amount;
    txn("refund", -amount, r.id);
    return r;
  };

  const chargeBody = (chargeId: string) => {
    const c = charges.get(chargeId);
    return { ...c, balance_transaction: { fee: c.fee }, payment_method_details: { card: { brand: "visa" } } };
  };

  return {
    client,
    extra,
    topups,
    calls,
    knobs,
    accounts,
    transfers,
    balances,
    payoutSchedules,
    payouts,
    activate(accountId: string) {
      const a = accounts.get(accountId);
      a.transfers = "active";
      a.payouts = "active";
      a.due = [];
    },
    restrict(accountId: string) {
      accounts.get(accountId).transfers = "restricted";
    },
    // The guest pays. `amount` lets a test make Stripe's record disagree with ours.
    pay(sessionId: string, opts: { amount?: number; currency?: string; metadata?: any; status?: string } = {}) {
      const s = sessions.get(sessionId);
      const piId = id("pi");
      const chargeId = id("ch");
      const amount = opts.amount ?? s.total;
      const fee = Math.round(amount * 0.029) + 30;
      const paid = (opts.status ?? "succeeded") === "succeeded";
      charges.set(chargeId, { id: chargeId, amount, amount_refunded: 0, created: Math.floor(Date.now() / 1000), fee, intentId: piId, payment_intent: piId, metadata: opts.metadata ?? s.metadata, transfer_group: s.params.payment_intent_data?.transfer_group });
      intents.set(piId, { id: piId, status: opts.status ?? "succeeded", amount, currency: opts.currency ?? "usd", livemode: false, metadata: opts.metadata ?? s.metadata, chargeId });
      if (paid) txn("charge", amount, chargeId, { fee, currency: opts.currency ?? "usd" });
      s.payment_intent = piId;
      s.status = "complete";
      return { piId, chargeId, sessionId };
    },
    expire(sessionId: string) {
      sessions.get(sessionId).status = "expired";
    },
    dispute(chargeId: string, status: string, amount: number) {
      const c = charges.get(chargeId);
      let d = disputes.find((x) => x.charge === chargeId);
      if (!d) {
        d = { id: id("dp"), charge: chargeId, payment_intent: c.intentId, status, amount, balance_transactions: [], taken: false, metadata: {} };
        disputes.push(d);
      }
      moveDisputeMoney(d, status);
      return d;
    },
    setDisputeStatus(chargeId: string, status: string) {
      moveDisputeMoney(disputes.find((d) => d.charge === chargeId), status);
    },
    // A later fee on the same dispute, like a network fee for an appeal.
    addDisputeFee(chargeId: string, fee: number) {
      const d = disputes.find((x) => x.charge === chargeId);
      d.balance_transactions.push({ fee });
      txn("adjustment", 0, d.id, { fee, category: "dispute" });
    },
    setBalance(accountId: string, available: number, pending = 0) {
      balances.set(accountId, { available, pending });
      settleReserve(accountId);
    },
    // Money left the balance some other way, like a Dashboard refund. A negative amount makes the most
    // recent refund of that size fail, which returns the money the way Stripe does.
    refund(chargeId: string, amount: number, status = "succeeded") {
      if (amount > 0) return addRefund(chargeId, amount, status);
      const r = [...refunds].reverse().find((x) => x.charge === chargeId && x.amount === -amount && x.status !== "failed");
      return this.failRefund(r.id);
    },
    failRefund(refundId: string) {
      const r = refunds.find((x) => x.id === refundId);
      r.status = "failed";
      charges.get(r.charge).amount_refunded -= r.amount;
      txn("refund_failure", r.amount, r.id, { category: "refund_failure" });
      return r;
    },
    refunds,
    txns,
    reserved,
    // Things that happen on Stripe with no tip behind them.
    stripeFee(amount: number) { return txn("stripe_fee", -amount, id("fee"), { category: "fee" }); },
    adjustment(amount: number, category = "other_adjustment") { return txn("adjustment", amount, id("adj"), { category }); },
    ownerPayout(amount: number, opts: { automatic?: boolean; status?: string } = {}) {
      const p = { id: id("po"), amount, status: opts.status ?? "paid", automatic: opts.automatic ?? false, livemode: false };
      payouts.set(p.id, p);
      txn("payout", -amount, p.id);
      return p;
    },
    topup(amount: number) {
      const t = { id: id("tu"), amount, status: "succeeded", livemode: false };
      topups.set(t.id, t);
      txn("topup", amount, t.id);
      return t;
    },
    // A guest's charge that has nothing to do with a tip here.
    outsideCharge(amount: number, currency = "usd") {
      const chargeId = id("ch");
      const piId = id("pi");
      charges.set(chargeId, { id: chargeId, amount, amount_refunded: 0, created: Math.floor(Date.now() / 1000), fee: 0, intentId: piId, payment_intent: piId, metadata: {} });
      intents.set(piId, { id: piId, status: "succeeded", amount, currency, livemode: false, metadata: {}, chargeId });
      txn("charge", amount, chargeId, { currency });
      return { chargeId, piId };
    },
  };
}
