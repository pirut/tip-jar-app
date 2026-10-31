import { test } from "node:test";
import assert from "node:assert/strict";
import { crews, earnings, workers, world, DAY, HOUR, MINUTE } from "./harness.ts";

const WRONG = "0000"; // newCode only makes 1000-9999
const start = (w: ReturnType<typeof world>, token: string, name = "Crew") =>
  w.call(crews.start, token, { name, splitMode: "even", closesInHours: 24 });
const codeOf = (w: ReturnType<typeof world>, id: string) => w.rows("crews").find((c) => c._id === id).code;
const wrongGuess = (w: ReturnType<typeof world>, token: string) => w.call(crews.lookup, token, { code: WRONG });
const blocked = /Too many wrong codes/;
const noCrew = /No open crew/;

async function annAndBen() {
  const w = world();
  await w.profile("ann-token", "ann-a");
  await w.profile("ben-token", "ben-b");
  const crewId = await start(w, "ann-token");
  await w.call(crews.join, "ben-token", { code: codeOf(w, crewId) });
  await w.tip("ann-a", 10000);
  await w.tip("ben-b", 10000);
  return { w, crewId };
}

// Account deletion and open crews

test("someone who left an open crew can't delete their tips out of the pool", async () => {
  const { w } = await annAndBen();
  await w.call(crews.leave, "ben-token");
  await assert.rejects(w.call(workers.deleteAccount, "ben-token"), /still open.*once it closes/);

  assert.equal(w.rows("tips").length, 2);
  assert.ok(await w.call(workers.me, "ben-token").then((me: any) => me.worker));
  const { crew } = await w.call(crews.current, "ann-token");
  assert.equal(crew.poolCents, 20000);

  await w.call(crews.close, "ann-token");
  assert.deepEqual(w.rows("crewMembers").map((m) => m.payoutCents), [10000, 10000]);
});

test("a member still in the crew gets the same wait, and the starter is told to close", async () => {
  const { w } = await annAndBen();
  await assert.rejects(w.call(workers.deleteAccount, "ben-token"), /still open.*once it closes/);
  await assert.rejects(w.call(workers.deleteAccount, "ann-token"), /Close your crew/);
});

test("deleting after the crew closes leaves everyone else's payout alone", async () => {
  const { w } = await annAndBen();
  await w.call(crews.leave, "ben-token");
  await w.call(crews.close, "ann-token");
  const before = await w.call(earnings.summary, "ann-token");

  await w.call(workers.deleteAccount, "ben-token");

  assert.equal((await w.call(workers.me, "ben-token")).worker, null);
  assert.deepEqual(w.rows("tips").map((t) => t.workerId), [w.rows("workers")[0]._id]);
  const after = await w.call(earnings.summary, "ann-token");
  assert.equal(before.balanceCents, 10000);
  assert.equal(after.balanceCents, 10000);
  const closed = await w.call(crews.lastClosed, "ann-token");
  assert.equal(closed.rows.reduce((a: number, r: any) => a + r.payoutCents, 0), 20000);
  assert.ok(closed.rows.some((r: any) => r.name === "Someone"));
});

test("deleting works once the crew closes on its own", async () => {
  const { w } = await annAndBen();
  await w.call(crews.leave, "ben-token");
  w.advance(24 * HOUR);
  await w.runDueJobs();
  await w.call(workers.deleteAccount, "ben-token");
  assert.equal((await w.call(earnings.summary, "ann-token")).balanceCents, 10000);
});

test("someone the starter removed isn't owed anything, so they can delete right away", async () => {
  const { w } = await annAndBen();
  const { crew } = await w.call(crews.current, "ann-token");
  const ben = crew.members.find((m: any) => !m.isMe);
  await w.call(crews.removeMember, "ann-token", { memberId: ben.memberId });
  await w.call(workers.deleteAccount, "ben-token");
  assert.equal((await w.call(crews.current, "ann-token")).crew.poolCents, 10000);
  await w.call(crews.close, "ann-token");
  assert.equal((await w.call(earnings.summary, "ann-token")).balanceCents, 10000);
});

// Long membership histories

async function hopAfterLeaving(crewsAfter: number) {
  const { w, crewId } = await annAndBen();
  await w.call(crews.leave, "ben-token");
  for (let i = 0; i < crewsAfter; i++) {
    await start(w, "ben-token", `Hop ${i}`);
    await w.call(crews.close, "ben-token");
  }
  return { w, crewId };
}

test("an open crew someone left is still found behind many later crews", async () => {
  const { w } = await hopAfterLeaving(25);
  assert.equal((await w.call(crews.current, "ben-token")).leftCrew?.name, "Crew");
  await assert.rejects(w.call(workers.deleteAccount, "ben-token"), /still open/);
  assert.equal((await w.call(crews.current, "ann-token")).crew.poolCents, 20000);
});

test("rejoining an old crew counts as being in it, however many crews came between", async () => {
  const { w, crewId } = await hopAfterLeaving(25);
  await w.call(crews.join, "ben-token", { code: codeOf(w, crewId) });

  assert.equal((await w.call(crews.current, "ben-token")).crew?._id, crewId);
  await assert.rejects(w.call(crews.start, "ben-token", { name: "Two", splitMode: "even", closesInHours: 1 }), /Leave your current crew/);
  await w.tip("ben-b", 500);
  assert.equal(w.rows("tips").at(-1).crewId, crewId);
});

// Wrong crew code limit

test("deleting and recreating a profile doesn't reset the limit", async () => {
  const w = world();
  await w.profile("x-token", "xav-x");
  let counted = 0;
  for (let cycle = 0; cycle < 4; cycle++) {
    for (let i = 0; i < 6; i++) {
      const out = await wrongGuess(w, "x-token");
      assert.equal(out.ok, false);
      if (noCrew.test(out.error)) counted++;
    }
    await w.call(workers.deleteAccount, "x-token");
    await w.profile("x-token", "xav-x");
  }
  assert.equal(counted, 5);
});

test("the count carries across recreation instead of only the block", async () => {
  const w = world();
  await w.profile("x-token", "xav-x");
  for (let i = 0; i < 3; i++) await wrongGuess(w, "x-token");
  await w.call(workers.deleteAccount, "x-token");
  await w.profile("x-token", "xav-x");
  for (let i = 0; i < 2; i++) assert.match((await wrongGuess(w, "x-token")).error, noCrew);
  assert.match((await wrongGuess(w, "x-token")).error, blocked);
});

test("lookup and join share the limit, and a right code waits out the block", async () => {
  const w = world();
  await w.profile("ann-token", "ann-a");
  await w.profile("x-token", "xav-x");
  const code = codeOf(w, await start(w, "ann-token"));
  for (let i = 0; i < 3; i++) await wrongGuess(w, "x-token");
  for (let i = 0; i < 2; i++) await w.call(crews.join, "x-token", { code: WRONG });
  assert.match((await w.call(crews.join, "x-token", { code })).error, blocked);
  assert.equal(w.rows("crewMembers").length, 1);
});

test("the limit lifts when the window ends, and counting starts over", async () => {
  const w = world();
  await w.profile("x-token", "xav-x");
  for (let i = 0; i < 5; i++) await wrongGuess(w, "x-token");
  w.advance(10 * MINUTE - 1);
  assert.match((await wrongGuess(w, "x-token")).error, blocked);
  w.advance(1);
  assert.match((await wrongGuess(w, "x-token")).error, noCrew);
  const [row] = w.rows("joinAttempts");
  assert.equal(w.rows("joinAttempts").length, 1);
  assert.equal(row.fails, 1);
  assert.equal(row.windowStart, Date.now());
  for (let i = 0; i < 4; i++) assert.match((await wrongGuess(w, "x-token")).error, noCrew);
  assert.match((await wrongGuess(w, "x-token")).error, blocked);
});

test("a recreated profile also gets a clean slate once the window ends", async () => {
  const w = world();
  await w.profile("x-token", "xav-x");
  for (let i = 0; i < 5; i++) await wrongGuess(w, "x-token");
  await w.call(workers.deleteAccount, "x-token");
  await w.profile("x-token", "xav-x");
  assert.match((await wrongGuess(w, "x-token")).error, blocked);
  w.advance(10 * MINUTE);
  await w.runDueJobs();
  assert.match((await wrongGuess(w, "x-token")).error, noCrew);
});

test("counts belong to the signed-in identity, not the handle or the arguments", async () => {
  const w = world();
  await w.profile("x-token", "xav-x");
  await w.profile("y-token", "yan-y");
  for (let i = 0; i < 5; i++) await wrongGuess(w, "x-token");
  assert.match((await wrongGuess(w, "x-token")).error, blocked);
  assert.match((await wrongGuess(w, "y-token")).error, noCrew);

  // Someone else taking over the freed handle doesn't inherit the block.
  await w.call(workers.deleteAccount, "x-token");
  await w.call(workers.deleteAccount, "y-token");
  await w.profile("y-token", "xav-x");
  assert.match((await wrongGuess(w, "y-token")).error, noCrew);
  // The real owner of the count is still blocked under a new handle.
  await w.profile("x-token", "new-handle");
  assert.match((await wrongGuess(w, "x-token")).error, blocked);
  // A caller can't name another identity's counter.
  const naming = await w.call(crews.lookup, "y-token", { code: WRONG, tokenIdentifier: "x-token", workerId: "workers:1" });
  assert.match(naming.error, noCrew);
  const fails = Object.fromEntries(w.rows("joinAttempts").map((r) => [r.tokenIdentifier, r.fails]));
  assert.deepEqual(fails, { "x-token": 5, "y-token": 3 });
});

test("a wrong guess is counted because it returns instead of throwing", async () => {
  const w = world();
  await w.profile("x-token", "xav-x");
  assert.deepEqual(await wrongGuess(w, "x-token"), { ok: false, error: "No open crew has that code." });
  assert.equal(w.rows("joinAttempts")[0].fails, 1);
});

// What deletion keeps

test("deleting mid-window keeps only the count, and only until the window ends", async () => {
  const w = world();
  await w.profile("x-token", "xav-x");
  await wrongGuess(w, "x-token");
  const windowStart = Date.now();
  await w.call(workers.deleteAccount, "x-token");

  const [row] = w.rows("joinAttempts");
  assert.deepEqual(
    { tokenIdentifier: row.tokenIdentifier, workerId: row.workerId, fails: row.fails, windowStart: row.windowStart },
    { tokenIdentifier: "x-token", workerId: undefined, fails: 1, windowStart },
  );
  assert.equal(w.jobs().length, 1);
  assert.equal(w.jobs()[0].at, windowStart + 10 * MINUTE);
  assert.ok(!JSON.stringify(w.jobs()[0].args).includes("x-token"), "the token shouldn't sit in the scheduler log");

  w.advance(10 * MINUTE - 1);
  await w.runDueJobs();
  assert.equal(w.rows("joinAttempts").length, 1);
  w.advance(1);
  await w.runDueJobs();
  assert.equal(w.rows("joinAttempts").length, 0);
});

test("deleting after the window ended removes the count straight away", async () => {
  const w = world();
  await w.profile("x-token", "xav-x");
  await wrongGuess(w, "x-token");
  w.advance(10 * MINUTE);
  await w.call(workers.deleteAccount, "x-token");
  assert.equal(w.rows("joinAttempts").length, 0);
  assert.equal(w.jobs().length, 0);
});

test("an old cleanup doesn't erase a newer window", async () => {
  const w = world();
  await w.profile("x-token", "xav-x");
  await wrongGuess(w, "x-token");
  await w.call(workers.deleteAccount, "x-token");
  await w.profile("x-token", "xav-x");
  w.advance(10 * MINUTE - 1);
  await wrongGuess(w, "x-token"); // still the first window
  w.advance(1);
  await wrongGuess(w, "x-token"); // a new window starts exactly as the old cleanup is due
  await w.runDueJobs();
  assert.equal(w.rows("joinAttempts")[0].fails, 1);
});

test("a cleanup for a count that's already gone does nothing", async () => {
  const w = world();
  await w.profile("x-token", "xav-x");
  await wrongGuess(w, "x-token");
  await w.call(workers.deleteAccount, "x-token");
  const [row] = w.rows("joinAttempts");
  w.advance(10 * MINUTE);
  await w.runDueJobs();
  await w.call(crews.purgeJoinAttempts, null, { id: row._id });
  assert.equal(w.rows("joinAttempts").length, 0);
});

// Counters written before this change, keyed by worker

async function legacyRow(fails: number, windowStart = Date.now()) {
  const w = world();
  const workerId = await w.profile("x-token", "xav-x");
  await w.db.insert("joinAttempts", { workerId, windowStart, fails });
  return { w, workerId };
}

test("a counter keyed by worker still blocks, and survives recreation", async () => {
  const { w } = await legacyRow(5);
  assert.match((await wrongGuess(w, "x-token")).error, blocked);
  await w.call(workers.deleteAccount, "x-token");
  const [row] = w.rows("joinAttempts");
  assert.equal(row.tokenIdentifier, "x-token");
  assert.equal(row.workerId, undefined);
  await w.profile("x-token", "xav-x");
  assert.match((await wrongGuess(w, "x-token")).error, blocked);
});

test("a counter keyed by worker moves to the identity on the next wrong guess", async () => {
  const { w } = await legacyRow(2);
  assert.match((await wrongGuess(w, "x-token")).error, noCrew);
  const rows = w.rows("joinAttempts");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fails, 3);
  assert.equal(rows[0].tokenIdentifier, "x-token");
  assert.equal(rows[0].workerId, undefined);
});

test("an expired counter keyed by worker restarts and is deleted with the account", async () => {
  const stale = Date.UTC(2027, 0, 15, 7);
  const { w } = await legacyRow(5, stale);
  assert.match((await wrongGuess(w, "x-token")).error, noCrew);
  assert.equal(w.rows("joinAttempts")[0].fails, 1);

  const again = await legacyRow(5, stale);
  await again.w.call(workers.deleteAccount, "x-token");
  assert.equal(again.w.rows("joinAttempts").length, 0);
});

// Other bounds

test("crew names are limited on the server, like the clients", async () => {
  const w = world();
  await w.profile("x-token", "xav-x", "W".repeat(80));
  const name = (length: number) => "N".repeat(length);
  await assert.rejects(start(w, "x-token", name(61)), /crew name/i);
  assert.equal(w.rows("crews").length, 0);

  await start(w, "x-token", `  ${name(60)}  `);
  assert.equal(w.rows("crews")[0].name, name(60));
  await w.call(crews.close, "x-token");

  // The generated default must respect the same crew-name limit.
  await start(w, "x-token", "   ");
  assert.equal(w.rows("crews")[1].name, `${"W".repeat(53)}'s crew`);
});

// Earnings chart

test("a crew payout is charted on the day the crew closed, not the day someone left", async () => {
  const { w } = await annAndBen();
  w.advance(15 * HOUR); // 11pm UTC
  await w.call(crews.leave, "ben-token");
  w.advance(2 * HOUR); // 1am UTC the next day
  await w.call(crews.close, "ann-token");

  const closeDay = (await w.call(earnings.summary, "ben-token")).week;
  assert.equal(closeDay[6].cents, 10000);
  assert.equal(closeDay[5].cents, 0);

  // Six days on, it's in the oldest bar even though the leave falls outside the chart.
  w.advance(6 * DAY);
  const week = (await w.call(earnings.summary, "ben-token")).week;
  assert.equal(week[0].cents, 10000);
});

test("a payout on a crew with no close time falls back to when the member left", async () => {
  const { w, crewId } = await annAndBen();
  await w.call(crews.close, "ann-token");
  const crew = w.db.docs.get(crewId);
  delete crew.closedAt;
  const { week } = await w.call(earnings.summary, "ben-token");
  assert.equal(week[6].cents, 10000);
});
