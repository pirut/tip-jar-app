// Runs the real backend logic against the real Stripe sandbox, through the Stripe CLI's login.
//
//   npm run test:sandbox     (needs `stripe login` on a sandbox, and Playwright; see PLAYWRIGHT_PATH)
//
// What's real: Stripe's API, Checkout pages, test cards, charges, transfers, reversals, refunds,
// disputes, signed webhooks. What's not: Convex (the database is the in-memory test one) and Express
// onboarding (Stripe needs a person for that, so test workers use prefilled accounts).
//
// It refuses to run against anything but test mode. No live money can move.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = process.env.E2E_OUT ?? "/tmp/tipjar-sandbox-e2e";
mkdirSync(OUT, { recursive: true });
const PORT = 45871;
const API_VERSION = "2026-10-28.endive";
const RUN = Date.now().toString(36);

process.env.STRIPE_MODE = "test";
process.env.STRIPE_SECRET_KEY = "sk_test_unused_cli_login_is_used";
process.env.STRIPE_CONNECT_API = "v1";
process.env.TIP_ORIGIN = `http://localhost:${PORT}`;

function flatten(prefix: string, value: unknown, out: string[]) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) value.forEach((v, i) => flatten(`${prefix}[${i}]`, v, out));
  else if (typeof value === "object") for (const [k, v] of Object.entries(value)) flatten(prefix ? `${prefix}[${k}]` : k, v, out);
  else out.push(`${prefix}=${value}`);
}

class CliError extends Error {
  type: string;
  code?: string;
  constructor(body: any) {
    super(body.message ?? "Stripe error");
    this.type = body.type === "invalid_request_error" ? "StripeInvalidRequestError" : body.type;
    this.code = body.code;
  }
}

function cli(method: "get" | "post", path: string, params: any = {}, options: any = {}) {
  const data: string[] = [];
  flatten("", params, data);
  const args = [method, path, "-v", options.apiVersion ?? API_VERSION, ...data.flatMap((d) => ["-d", d])];
  if (options.stripeAccount) args.push("--stripe-account", options.stripeAccount);
  // In-memory ids repeat from run to run, and Stripe would replay the earlier run's answer.
  if (options.idempotencyKey) args.push("-i", `${RUN}:${options.idempotencyKey}`);
  if (method === "post") args.push("-c");
  const r = spawnSync("stripe", args, { encoding: "utf8", maxBuffer: 50_000_000 });
  const text = r.stdout ?? "";
  const start = text.indexOf("{");
  if (start < 0) throw new Error(`stripe ${method} ${path}: ${r.stderr?.slice(0, 300)}`);
  const body = JSON.parse(text.slice(start));
  if (body.error) throw new CliError(body.error);
  if (body.livemode === true) throw new Error("Refusing: Stripe returned a live-mode object");
  return body;
}

const client = {
  accounts: {
    create: async (p: any, o: any) => cli("post", "/v1/accounts", p, o),
    retrieve: async (id: string) => cli("get", `/v1/accounts/${id}`),
    createLoginLink: async (id: string) => cli("post", `/v1/accounts/${id}/login_links`),
  },
  accountLinks: { create: async (p: any) => cli("post", "/v1/account_links", p) },
  balanceSettings: { update: async (p: any, o: any) => cli("post", "/v1/balance_settings", p, o) },
  balance: { retrieve: async (_p: any = {}, o: any = {}) => cli("get", "/v1/balance", {}, o) },
  checkout: {
    sessions: {
      create: async (p: any, o: any) => cli("post", "/v1/checkout/sessions", p, o),
      retrieve: async (id: string) => cli("get", `/v1/checkout/sessions/${id}`),
    },
  },
  paymentIntents: {
    retrieve: async (id: string, p: any) => cli("get", `/v1/payment_intents/${id}`, p),
    list: async (p: any) => cli("get", "/v1/payment_intents", p),
  },
  disputes: { list: async (p: any) => cli("get", "/v1/disputes", p) },
  refunds: { create: async (p: any, o: any) => cli("post", "/v1/refunds", p, o) },
  transfers: {
    create: async (p: any, o: any) => cli("post", "/v1/transfers", p, o),
    list: async (p: any) => cli("get", "/v1/transfers", p),
    retrieve: async (id: string) => cli("get", `/v1/transfers/${id}`),
    createReversal: async (id: string, p: any, o: any) => cli("post", `/v1/transfers/${id}/reversals`, p, o),
  },
  payouts: { retrieve: async (id: string, _p: any, o: any) => cli("get", `/v1/payouts/${id}`, {}, o) },
};

const whoami = cli("get", "/v1/account");
const listen = spawnSync("stripe", ["listen", "--print-secret"], { encoding: "utf8" });
const secret = listen.stdout.trim();
if (!secret.startsWith("whsec_")) throw new Error("Couldn't get a listen secret");
process.env.STRIPE_WEBHOOK_SECRET = secret;
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = secret;

const { crews, earnings, ops, payments, paymentsNode, world, workers } = await import("../tests/harness.ts");
const { ledgerTotals } = await import("../convex/lib/paymentRules.ts");
const { chromium } = await import(process.env.PLAYWRIGHT_PATH ?? "playwright");
paymentsNode.useStripeForTests(client);

const w = world({ realClock: true });
const report: any = { platform: whoami.id, livemode: false, apiVersion: API_VERSION, startedAt: new Date().toISOString(), steps: [] };
const step = (name: string, data: any = {}) => {
  report.steps.push({ name, ...data });
  console.log(`  ok  ${name}`, Object.keys(data).length ? JSON.stringify(data) : "");
};
const check = (cond: unknown, what: string) => {
  if (!cond) {
    writeFileSync(`${OUT}/report.json`, JSON.stringify({ ...report, failed: what, tables: dump() }, null, 2));
    throw new Error(`FAILED: ${what}`);
  }
};
const dump = () => Object.fromEntries(["tipPayments", "allocations", "stripeEvents", "opsAlerts"].map((t) => [t, w.rows(t)]));

// Webhooks, signed by Stripe, through the same entry points http.ts uses.
const events = { received: 0, rejected: 0 };
const server = createServer((req, res) => {
  if (req.method === "GET") {
    res.setHeader("content-type", "text/html");
    res.end("<h1>Back from Stripe</h1>");
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    try {
      const source = req.url!.includes("connect") ? "connect" : "platform";
      const event = await w.act(paymentsNode.verifyWebhook, null, { body: Buffer.concat(chunks).toString("utf8"), signature: req.headers["stripe-signature"], source });
      if (!event) {
        events.rejected++;
        res.statusCode = 400;
        res.end();
        return;
      }
      events.received++;
      await w.call(payments.recordEvent, null, event);
      res.end();
    } catch (e) {
      console.error("webhook error", e);
      res.statusCode = 500;
      res.end();
    }
  });
});
await new Promise<void>((r) => server.listen(PORT, r));
const listener = spawn("stripe", ["listen", "--latest", "--all-snapshot", "--forward-to", `localhost:${PORT}/stripe/webhook`, "--forward-connect-to", `localhost:${PORT}/stripe/connect-webhook`], { stdio: ["ignore", "ignore", "pipe"] });
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("stripe listen didn't start")), 30_000);
  listener.stderr.on("data", (chunk) => {
    if (String(chunk).includes("Ready!")) {
      clearTimeout(timer);
      resolve();
    }
  });
});

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    await w.runDueJobs();
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) {
      check(false, `timed out: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const browser = await chromium.launch();

async function payOnStripe(url: string, card: string, shot?: string) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#email, #cardNumber, [data-testid=card-accordion-item-button]", { timeout: 30_000 });
  const accordion = page.locator("[data-testid=card-accordion-item-button]");
  if (await accordion.count()) await accordion.first().evaluate((el: any) => el.click());
  await page.fill("#email", "guest@example.com").catch(() => {});
  await page.waitForSelector("#cardNumber", { state: "visible", timeout: 20_000 }).catch(async (e: Error) => {
    await page.screenshot({ path: `${OUT}/checkout-failed.png`, fullPage: true });
    throw e;
  });
  await page.fill("#cardNumber", card);
  await page.fill("#cardExpiry", "12 / 34");
  await page.fill("#cardCvc", "123");
  await page.fill("#billingName", "Test Guest").catch(() => {});
  await page.fill("#billingPostalCode", "33139").catch(() => {});
  // Stripe's Link sign-up asks for a phone number. A guest can skip it; so does this.
  const link = page.locator("#enableStripePass");
  if (await link.count() && await link.isChecked().catch(() => false)) await link.evaluate((el: any) => el.click());
  if (shot) await page.screenshot({ path: `${OUT}/${shot}.png`, fullPage: true });
  await page.click("[data-testid=hosted-payment-submit-button]");
  await page.waitForURL(/paid=/, { timeout: 60_000 }).catch(async (e: Error) => {
    await page.screenshot({ path: `${OUT}/checkout-failed.png`, fullPage: true });
    throw e;
  });
  await page.close();
}

// Prefilled so Stripe activates it without a person. The real app path is checked separately below.
function activeTestAccount(name: string) {
  const account = cli("post", "/v1/accounts", {
    country: "US",
    business_type: "individual",
    email: `${name}@example.com`,
    controller: { fees: { payer: "application" }, losses: { payments: "application" }, requirement_collection: "application", stripe_dashboard: { type: "none" } },
    capabilities: { transfers: { requested: true } },
    business_profile: { mcc: "7299", url: "https://tip.jrbussard.com" },
    individual: { first_name: name, last_name: "Test", email: `${name}@example.com`, phone: "+15555550100", id_number: "000000000", dob: { day: 1, month: 1, year: 1901 }, address: { line1: "address_full_match", city: "Miami", state: "FL", postal_code: "33139" } },
    external_account: "btok_us_verified",
    tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: "127.0.0.1" },
    metadata: { tipJarE2E: "true" },
  }, { apiVersion: "2026-07-29.dahlia" });
  return account.id as string;
}

async function pilotWorker(token: string, handle: string) {
  const stripeAccountId = activeTestAccount(handle);
  await w.profile(token, handle);
  await w.call(ops.enrollWorker, null, { handle });
  const worker = w.rows("workers").find((x) => x.handle === handle);
  await w.call(payments.saveNewPayee, null, { tokenIdentifier: token, workerId: worker._id, livemode: false, stripeAccountId, transfersStatus: "pending", payoutsStatus: "pending", requirementsDue: 0 });
  await until(`${handle}'s account activates`, async () => {
    const status = await w.act(paymentsNode.refreshPayoutStatus, token);
    return status?.transfersStatus === "active";
  });
  return stripeAccountId;
}

const tipByCheckout = async (handle: string, tipCents: number, card: string, shot?: string) => {
  const { url } = await w.act(paymentsNode.createGuestCheckout, null, { handle, tipCents, coverFees: true, clientRequestId: `e2e-${Date.now()}-${Math.random()}` });
  const tipId = w.rows("tipPayments").at(-1)._id;
  await payOnStripe(url, card, shot);
  await until("the signed webhook records the payment", () => w.rows("tipPayments").find((t) => t._id === tipId)?.status === "succeeded");
  return tipId;
};

const tip = (id: string) => w.rows("tipPayments").find((t) => t._id === id);
const allocs = (id: string) => w.rows("allocations").filter((a) => a.tipPaymentId === id);
const transferOf = (id: string) => cli("get", `/v1/transfers/${id}`);
const settle = async () => {
  await w.act(paymentsNode.runDue);
  await w.runDueJobs();
};

const INSTANT_FUNDS = "4000000000000077"; // Funds are available at once, like a settled charge.
const DISPUTED = "4000000000000259"; // Pays, then a dispute opens.

const usd = (rows: any[]) => rows.filter((r) => r.currency === "usd").reduce((a, r) => a + r.amount, 0);
const platformBalance = () => {
  const b = cli("get", "/v1/balance");
  return { available: usd(b.available), pending: usd(b.pending) };
};

try {
  // Earlier runs' refund and dispute fees can leave the sandbox short. Real life: transfers wait until
  // the balance recovers and raise an alarm if they keep failing. Here: top it up so the run can go on.
  if (platformBalance().available < 10_000) {
    const before = platformBalance();
    cli("post", "/v1/payment_intents", { amount: 50_000, currency: "usd", confirm: true, payment_method: "pm_card_bypassPending", automatic_payment_methods: { enabled: true, allow_redirects: "never" }, metadata: { tipJarE2E: "top-up" } });
    await until("the top-up lands", () => platformBalance().available > before.available);
  }
  const startBalance = platformBalance();
  report.startBalance = startBalance;

  await w.call(ops.setControls, null, { chargesEnabled: true, transfersEnabled: true, transferHoldHours: 0, note: "sandbox e2e" });

  // The path a real worker takes: an account behind the scenes and a link to Stripe's form.
  await w.profile("new-worker", "new-worker");
  await w.call(ops.enrollWorker, null, { handle: "new-worker" });
  const setup = await w.act(paymentsNode.startPayoutSetup, "new-worker");
  const created = w.rows("payeeAccounts").find((p) => p.tokenIdentifier === "new-worker");
  check(/^https:\/\/connect\.stripe\.com\//.test(setup.url), "onboarding link is Stripe's");
  const fresh = cli("get", `/v1/accounts/${created.stripeAccountId}`);
  check(fresh.controller.losses.payments === "application" && fresh.controller.stripe_dashboard.type === "express", "account is the recipient setup we asked for");
  const schedule = cli("get", "/v1/balance_settings", {}, { stripeAccount: created.stripeAccountId });
  check(schedule.payments?.payouts?.schedule?.interval === "weekly", "payouts are weekly");
  const onboarding = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await onboarding.goto(setup.url, { waitUntil: "domcontentloaded" });
  await onboarding.waitForTimeout(4000);
  await onboarding.screenshot({ path: `${OUT}/stripe-onboarding.png` });
  await onboarding.close();
  step("Set up payouts creates a recipient account and a Stripe-hosted link", { transfersStatus: created.transfersStatus, schedule: schedule.payments.payouts.schedule.interval });
  const notReady = await w.call(workers.byHandle, null, { handle: "new-worker" });
  check(notReady.payments === "unavailable", "unfinished onboarding can't take tips");
  step("A worker who hasn't finished onboarding can't take tips");

  const annAcct = await pilotWorker("ann", "ann-e2e");
  const benAcct = await pilotWorker("ben", "ben-e2e");
  step("Two test workers are active", { annAcct, benAcct });

  // Solo, through to the worker's Stripe balance.
  const solo = await tipByCheckout("ann-e2e", 1000, INSTANT_FUNDS, "stripe-checkout");
  check(tip(solo).chargedCents === 1084 && tip(solo).stripeFeeCents! > 0, "charge and real fee recorded");
  step("Guest pays on Stripe's Checkout; a signed webhook records it", { charged: tip(solo).chargedCents, realStripeFee: tip(solo).stripeFeeCents, estimatedFees: tip(solo).feesCents, cardBrand: tip(solo).cardBrand });
  await settle();
  const soloAlloc = allocs(solo)[0];
  check(soloAlloc.state === "settled" && soloAlloc.paidCents === 1000, "solo tip transferred");
  const soloTransfer = transferOf(soloAlloc.transfers[0].id);
  check(soloTransfer.destination === annAcct && soloTransfer.amount === 1000 && soloTransfer.source_transaction === tip(solo).stripeChargeId, "transfer has the right amount, recipient and source");
  step("Transfer to the worker with the charge as its source", { transfer: soloTransfer.id, amount: soloTransfer.amount });
  await w.act(paymentsNode.refreshBalance, "ann");
  const annReal = await w.call(earnings.real, "ann", {});
  check(annReal.availableCents === 1000, `worker's Stripe balance is the source of their figure (${annReal.availableCents})`);
  step("Worker's available balance comes from Stripe", { availableCents: annReal.availableCents, pendingCents: annReal.stripePendingCents });

  // Duplicates: replay the same sync and transfer run.
  await w.act(paymentsNode.syncPaymentById, null, { tipPaymentId: solo });
  await settle();
  check(allocs(solo).length === 1 && allocs(solo)[0].transfers.length === 1, "replay changes nothing");
  step("Replaying sync and settlement changes nothing");

  // A refund after the transfer is taken back from the worker.
  const refund = await w.act(paymentsNode.refundTip, null, { tipPaymentId: solo });
  check(refund.status === "succeeded", "refund succeeded");
  await settle();
  const reversed = transferOf(soloAlloc.transfers[0].id);
  check(reversed.amount_reversed === 1000, `transfer reversed (${reversed.amount_reversed})`);
  await w.act(paymentsNode.refreshBalance, "ann");
  check((await w.call(earnings.real, "ann", {})).availableCents === 0, "worker's balance went back down");
  step("Refund after transfer reverses it", { refund: refund.refundId, reversedCents: reversed.amount_reversed });

  // A crew.
  await w.call(crews.start, "ann", { name: "E2E crew", splitMode: "even", closesInHours: 8 });
  const code = w.rows("crews")[0].code;
  check((await w.call(crews.join, "ben", { code })).ok, "ben joined");
  const pool1 = await tipByCheckout("ann-e2e", 1001, INSTANT_FUNDS);
  const pool2 = await tipByCheckout("ben-e2e", 2000, INSTANT_FUNDS);
  const crewNow = await w.call(crews.current, "ann");
  check(crewNow.crew.poolCents === 3001 && crewNow.crew.real, "pool counts confirmed payments");
  await w.call(crews.close, "ann");
  await settle();
  await until("every crew allocation settles", () => [...allocs(pool1), ...allocs(pool2)].every((a) => a.state === "settled"));
  const shares = w.rows("crewMembers").map((m) => m.payoutCents);
  check(shares[0] + shares[1] === 3001, "every cent assigned");
  const sent = [...allocs(pool1), ...allocs(pool2)].map((a) => transferOf(a.transfers[0].id));
  check(sent.reduce((a, t) => a + t.amount, 0) === 3001, "transfers match the pool");
  check(sent.filter((t) => t.destination === annAcct).reduce((a, t) => a + t.amount, 0) === shares[0], "ann's transfers match her share");
  step("Crew closes; each tip is split and transferred", { shares, transfers: sent.length });

  // A refund on a pooled tip comes back from everyone who shared it.
  await w.act(paymentsNode.refundTip, null, { tipPaymentId: pool2 });
  await settle();
  const pool2Reversals = allocs(pool2).map((a) => transferOf(a.transfers[0].id));
  check(pool2Reversals.every((t) => t.amount_reversed === t.amount), "both members' transfers reversed");
  step("Refund on a pooled tip reverses both members' transfers");

  // Dispute: opens by itself on this card, then is won with Stripe's test evidence.
  const disputed = await tipByCheckout("ben-e2e", 700, DISPUTED);
  await until("the dispute reaches us", () => tip(disputed).disputedCents > 0);
  check(tip(disputed).disputeOpen, "dispute is open");
  await settle();
  check(allocs(disputed)[0].targetCents === 0, "worker's share is taken back during the dispute");
  check(allocs(disputed)[0].paidCents === 0, "nothing went out while disputed");
  const beforeWin = ledgerTotals(w.rows("ledgerEntries"));
  check(beforeWin.disputeFeesCents > 0, "dispute fee is booked");
  step("Dispute opens: money frozen and fee booked", { disputeFeeCents: beforeWin.disputeFeesCents });
  const disputes = cli("get", "/v1/disputes", { charge: tip(disputed).stripeChargeId });
  cli("post", `/v1/disputes/${disputes.data[0].id}`, { evidence: { uncategorized_text: "winning_evidence" }, submit: true });
  await until("the win reaches us", () => tip(disputed).disputedCents === 0 && !tip(disputed).disputeOpen, 90_000);
  await settle();
  await until("re-payment settles", () => allocs(disputed)[0].state === "settled");
  const repaid = transferOf(allocs(disputed)[0].transfers[0].id);
  check(repaid.amount === 700 && repaid.destination === benAcct, "won dispute pays the worker");
  step("Dispute won: worker is paid", { amount: repaid.amount });

  // Books against Stripe.
  await new Promise((r) => setTimeout(r, 3000));
  await w.runDueJobs();
  await w.act(paymentsNode.reconcileBooks);
  const b = await w.call(ops.books);
  report.books = b;
  const endBalance = platformBalance();
  report.stripePlatformBalance = endBalance;
  const moved = endBalance.available + endBalance.pending - startBalance.available - startBalance.pending;
  check(moved === b.expectedStripeBalanceCents, `Stripe's balance moved ${moved}, the books expected ${b.expectedStripeBalanceCents}`);
  check(b.workerLiabilityCents === 0, `worker liability should be 0, is ${b.workerLiabilityCents}`);
  step("Books reconciled against Stripe's platform balance", {
    booksExpectedMovement: b.expectedStripeBalanceCents,
    stripeActualMovement: moved,
    platformRevenue: b.platformRevenueCents,
    feesCollected: b.feesCollectedCents,
    stripeFees: b.processingCostCents,
    disputeFees: b.disputeFeesCents,
  });
  report.events = events;
  report.eventStatuses = w.rows("stripeEvents").reduce((a: any, e: any) => ({ ...a, [e.status]: (a[e.status] ?? 0) + 1 }), {});
  report.eventTypes = [...new Set(w.rows("stripeEvents").map((e: any) => e.type))].sort();
  report.alerts = w.rows("opsAlerts").map((a: any) => `${a.severity} ${a.kind}: ${a.message}`);
  report.passed = true;
} finally {
  report.events ??= events;
  if (!report.passed) report.tables = dump();
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  listener.kill();
  await browser.close();
  server.close();
}
console.log(`\nAll steps passed. Report: ${OUT}/report.json`);
process.exit(0);
