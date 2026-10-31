// Asks the real Stripe sandbox how reversals and refunds actually behave, through the Stripe CLI's
// login. No Convex and no app code: this is where tests/fakeStripe.ts gets its behaviour from.
//
//   npm run test:probes     (needs `stripe login` on a sandbox; takes up to about 6 minutes)
//
// It refuses to run against anything but test mode. No live money can move. It prints object amounts
// and statuses, never keys or links.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const OUT = process.env.PROBE_OUT ?? "/tmp/tipjar-sandbox-probes.json";
const API = "2026-10-28.endive";
const V1_ACCOUNTS_API = "2026-07-29.dahlia";
const results: Record<string, unknown> = {};
const note = (name: string, value: unknown) => {
  results[name] = value;
  console.log(`${name}: ${JSON.stringify(value)}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function flatten(prefix: string, value: unknown, out: string[]) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) value.forEach((v, i) => flatten(`${prefix}[${i}]`, v, out));
  else if (typeof value === "object") for (const [k, v] of Object.entries(value)) flatten(prefix ? `${prefix}[${k}]` : k, v, out);
  else out.push(`${prefix}=${value}`);
}

function stripe(method: "get" | "post", path: string, params: object = {}, options: { account?: string; key?: string; version?: string } = {}): any {
  const data: string[] = [];
  flatten("", params, data);
  const args = [method, path, "-v", options.version ?? API, ...data.flatMap((d) => ["-d", d])];
  if (options.account) args.push("--stripe-account", options.account);
  if (options.key) args.push("-i", options.key);
  if (method === "post") args.push("-c");
  const r = spawnSync("stripe", args, { encoding: "utf8", maxBuffer: 50_000_000 });
  const start = (r.stdout ?? "").indexOf("{");
  if (start < 0) throw new Error(`stripe ${method} ${path} gave no JSON`);
  const body = JSON.parse(r.stdout.slice(start));
  if (body.livemode === true) throw new Error("Refusing: Stripe returned a live-mode object");
  return body;
}

const errorOf = (b: any) => (b.error ? { type: b.error.type, code: b.error.code, message: b.error.message } : null);
const usd = (rows: any[]) => (rows ?? []).filter((r) => r.currency === "usd").reduce((a, r) => a + r.amount, 0);
const balance = (account?: string) => {
  const b = stripe("get", "/v1/balance", {}, { account });
  return { available: usd(b.available), pending: usd(b.pending), connect_reserved: usd(b.connect_reserved) };
};

async function recipient(name: string) {
  const id = stripe("post", "/v1/accounts", {
    country: "US",
    business_type: "individual",
    email: `${name}@example.com`,
    controller: { fees: { payer: "application" }, losses: { payments: "application" }, requirement_collection: "application", stripe_dashboard: { type: "none" } },
    capabilities: { transfers: { requested: true } },
    business_profile: { mcc: "7299", url: "https://tip.jrbussard.com" },
    individual: { first_name: name, last_name: "Test", email: `${name}@example.com`, phone: "+15555550100", id_number: "000000000", dob: { day: 1, month: 1, year: 1901 }, address: { line1: "address_full_match", city: "Miami", state: "FL", postal_code: "33139" } },
    external_account: "btok_us_verified",
    tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: "127.0.0.1" },
    metadata: { tipJarProbe: "true" },
  }, { version: V1_ACCOUNTS_API }).id as string;
  for (let i = 0; i < 40; i++) {
    if (stripe("get", `/v1/accounts/${id}`).capabilities?.transfers === "active") return id;
    await sleep(1500);
  }
  throw new Error(`${name} didn't activate`);
}

async function charge(paymentMethod: string, amount: number) {
  const pi = stripe("post", "/v1/payment_intents", { amount, currency: "usd", confirm: true, payment_method: paymentMethod, automatic_payment_methods: { enabled: true, allow_redirects: "never" }, metadata: { tipJarProbe: "true" } });
  for (let i = 0; i < 30; i++) {
    const c = stripe("get", `/v1/payment_intents/${pi.id}`, { expand: ["latest_charge.balance_transaction"] }).latest_charge;
    if (c?.balance_transaction) return { pi: pi.id as string, charge: c };
    await sleep(1000);
  }
  throw new Error("The charge never got a balance transaction");
}

note("account", stripe("get", "/v1/account").id);

// A normal card: the transfer's funds are pending on the worker's side when the refund comes.
const pendingAccount = await recipient("probe-pending");
const normal = await charge("pm_card_visa", 1500);
note("normal card: charge balance status", normal.charge.balance_transaction.status);
const pendingTransfer = stripe("post", "/v1/transfers", { amount: 1000, currency: "usd", destination: pendingAccount, source_transaction: normal.charge.id });
note("normal card: worker balance after transfer", balance(pendingAccount));
const whilePending = stripe("post", `/v1/transfers/${pendingTransfer.id}/reversals`, { amount: 400 });
note("normal card: reversal while pending", { amount: whilePending.amount, error: errorOf(whilePending) });
note("normal card: worker balance after reversal", balance(pendingAccount));
note("over-reversal error", errorOf(stripe("post", `/v1/transfers/${pendingTransfer.id}/reversals`, { amount: 5000 })));
const key = `probe-${Date.now()}`;
stripe("post", `/v1/transfers/${pendingTransfer.id}/reversals`, { amount: 10 }, { key });
note("same key, different amount", errorOf(stripe("post", `/v1/transfers/${pendingTransfer.id}/reversals`, { amount: 20 }, { key })));
note("transfer's running total", stripe("get", `/v1/transfers/${pendingTransfer.id}`).amount_reversed);

// Instant funds, paid out to the bank: the worker has nothing left when the refund comes.
const emptyAccount = await recipient("probe-empty");
const instant = await charge("pm_card_bypassPending", 1500);
const emptyTransfer = stripe("post", "/v1/transfers", { amount: 1000, currency: "usd", destination: emptyAccount, source_transaction: instant.charge.id });
stripe("post", "/v1/payouts", { amount: 1000, currency: "usd" }, { account: emptyAccount });
await sleep(4000);
note("instant card: worker balance after payout", balance(emptyAccount));
const beforeReserve = balance();
const whileEmpty = stripe("post", `/v1/transfers/${emptyTransfer.id}/reversals`, { amount: 400 });
note("instant card: reversal with nothing available", { amount: whileEmpty.amount, error: errorOf(whileEmpty) });
note("instant card: worker balance after reversal", balance(emptyAccount));
let reserved = false;
for (let i = 0; i < 60 && !reserved; i++) {
  reserved = balance().connect_reserved > beforeReserve.connect_reserved;
  if (!reserved) await sleep(3000);
}
note("platform balance once Stripe reserved for it", { reserved, before: beforeReserve, after: balance() });
const reversalTxn = stripe("get", "/v1/balance_transactions", { type: "transfer_refund", limit: 1, expand: ["data.source"] }).data[0];
note("a reversal's balance transaction", { category: reversalTxn.reporting_category, sourceObject: reversalTxn.source?.object });
const reserveTxn = stripe("get", "/v1/balance_transactions", { type: "reserve_transaction", limit: 1 }).data[0];
note("a reserve's balance transaction", reserveTxn && { amount: reserveTxn.amount, category: reserveTxn.reporting_category });

// A refund that looks fine, then fails.
const failing = await charge("pm_card_refundFail", 2000);
const started = Math.floor(Date.now() / 1000);
const refund = stripe("post", "/v1/refunds", { payment_intent: failing.pi, amount: 700 });
note("refund that will fail: at first", { status: refund.status, amount_refunded: stripe("get", `/v1/charges/${failing.charge.id}`).amount_refunded });
let current = refund;
for (let i = 0; i < 80 && current.status !== "failed"; i++) {
  await sleep(4000);
  current = stripe("get", `/v1/refunds/${refund.id}`);
}
note("refund that will fail: later", { status: current.status, reason: current.failure_reason, secondsLater: Math.floor(Date.now() / 1000) - started, amount_refunded: stripe("get", `/v1/charges/${failing.charge.id}`).amount_refunded });
if (current.failure_balance_transaction) {
  const t = stripe("get", `/v1/balance_transactions/${current.failure_balance_transaction}`, { expand: ["source"] });
  note("the failure's balance transaction", { type: t.type, category: t.reporting_category, amount: t.amount, fee: t.fee, sourceObject: t.source?.object, hasCharge: !!t.source?.charge, hasIntent: !!t.source?.payment_intent });
}
const events = stripe("get", "/v1/events", { created: { gte: started - 5 }, limit: 100 }).data.filter((e: any) => [e.data.object.id, e.data.object.charge].includes(refund.id) || e.data.object.id === failing.charge.id);
note("events after the refund", [...new Set(events.map((e: any) => e.type))]);

// A refund that sits pending.
const pendingCard = await charge("pm_card_pendingRefund", 1300);
const slow = stripe("post", "/v1/refunds", { payment_intent: pendingCard.pi, amount: 300 });
const slowTxn = slow.balance_transaction ? stripe("get", `/v1/balance_transactions/${slow.balance_transaction}`) : null;
note("pending refund", { status: slow.status, debitedAlready: slowTxn?.amount, amount_refunded: stripe("get", `/v1/charges/${pendingCard.charge.id}`).amount_refunded });

note("balance settings of the platform", stripe("get", "/v1/balance_settings").payments?.payouts?.schedule?.interval);
writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`\nWritten to ${OUT}`);
