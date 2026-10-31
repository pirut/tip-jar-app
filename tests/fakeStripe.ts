// Stands in for Stripe's API in tests: it keeps state, honors idempotency keys and can be told to
// fail. It proves our logic against the API as we understand it, not that the API behaves this way.
// Real-API evidence comes from scripts/sandbox-e2e.ts.
export class FakeStripeError extends Error {
  type = "StripeInvalidRequestError";
}

export function fakeStripe() {
  let n = 0;
  const id = (prefix: string) => `${prefix}_${++n}`;
  const seen = new Map<string, any>();
  const once = (options: any, make: () => any) => {
    const key = options?.idempotencyKey;
    if (key && seen.has(key)) return seen.get(key);
    const out = make();
    if (key) seen.set(key, out);
    return out;
  };
  const accounts = new Map<string, any>();
  const sessions = new Map<string, any>();
  const intents = new Map<string, any>();
  const charges = new Map<string, any>();
  const disputes: any[] = [];
  const transfers = new Map<string, any>();
  const balances = new Map<string, { available: number; pending: number }>();
  const payoutSchedules: Record<string, any> = {};
  const payouts = new Map<string, any>();
  const calls: string[] = [];
  const extra = { balance: 0 };
  const topups = new Map<string, any>();
  const knobs = { failTransfer: null as null | Error, failReversal: null as null | Error, crashAfterTransfer: false };

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
      update: async (params: any, options: any) => { payoutSchedules[options.stripeAccount] = params.payments.payouts.schedule; return {}; },
    },
    balance: {
      retrieve: async (_params: any, options: any) => {
        if (!options?.stripeAccount) {
          const total = extra.balance + [...charges.values()].reduce((a, c) => a + c.amount - c.amount_refunded - c.fee, 0) - [...transfers.values()].reduce((a, t) => a + t.amount - t.amount_reversed, 0);
          return { available: [{ amount: total, currency: "usd" }], pending: [] };
        }
        const b = balances.get(options.stripeAccount) ?? { available: 0, pending: 0 };
        return { available: [{ amount: b.available, currency: "usd" }], pending: [{ amount: b.pending, currency: "usd" }] };
      },
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
      list: async () => ({ data: [...intents.values()] }),
    },
    disputes: { list: async ({ charge }: any) => ({ data: disputes.filter((d) => d.charge === charge) }) },
    refunds: {
      create: async (params: any, options: any) => once(options, () => {
        const pi = intents.get(params.payment_intent);
        charges.get(pi.chargeId).amount_refunded += params.amount;
        return { id: id("re"), status: "succeeded" };
      }),
    },
    transfers: {
      create: async (params: any, options: any) => {
        if (knobs.failTransfer) throw knobs.failTransfer;
        const out = once(options, () => {
          calls.push("transfers.create");
          const t = { id: id("tr"), amount: params.amount, amount_reversed: 0, destination: params.destination, metadata: params.metadata, source_transaction: params.source_transaction, transfer_group: params.transfer_group ?? (params.source_transaction ? `group_${params.source_transaction}` : undefined) };
          transfers.set(t.id, t);
          const b = balances.get(params.destination) ?? { available: 0, pending: 0 };
          b.available += params.amount;
          balances.set(params.destination, b);
          return t;
        });
        if (knobs.crashAfterTransfer) {
          knobs.crashAfterTransfer = false;
          throw new Error("network dropped after Stripe succeeded");
        }
        return out;
      },
      list: async () => ({ data: [...transfers.values()] }),
      retrieve: async (transferId: string) => transfers.get(transferId),
      createReversal: async (transferId: string, params: any, options: any) => {
        if (knobs.failReversal) throw knobs.failReversal;
        return once(options, () => {
          const t = transfers.get(transferId);
          const b = balances.get(t.destination)!;
          if (b.available < params.amount) throw new FakeStripeError("Insufficient funds in the connected account");
          b.available -= params.amount;
          t.amount_reversed += params.amount;
          calls.push("transfers.reverse");
          return { id: id("trr"), amount: params.amount };
        });
      },
    },
    payouts: { retrieve: async (payoutId: string) => payouts.get(payoutId) },
    topups: { retrieve: async (topupId: string) => topups.get(topupId) },
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
      charges.set(chargeId, { id: chargeId, amount, amount_refunded: 0, created: Math.floor(Date.now() / 1000), fee: Math.round(amount * 0.029) + 30 });
      intents.set(piId, { id: piId, status: opts.status ?? "succeeded", amount, currency: opts.currency ?? "usd", livemode: false, metadata: opts.metadata ?? s.metadata, chargeId });
      s.payment_intent = piId;
      s.status = "complete";
      return { piId, chargeId, sessionId };
    },
    expire(sessionId: string) {
      sessions.get(sessionId).status = "expired";
    },
    dispute(chargeId: string, status: string, amount: number) {
      const existing = disputes.find((d) => d.charge === chargeId);
      if (existing) existing.status = status;
      else disputes.push({ id: id("dp"), charge: chargeId, status, amount, balance_transactions: [{ fee: status.startsWith("warning") ? 0 : 1500 }] });
    },
    setDisputeStatus(chargeId: string, status: string) {
      disputes.find((d) => d.charge === chargeId).status = status;
    },
    setBalance(accountId: string, available: number, pending = 0) {
      balances.set(accountId, { available, pending });
    },
    refund(chargeId: string, amount: number) {
      charges.get(chargeId).amount_refunded += amount;
    },
  };
}
