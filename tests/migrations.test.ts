import { test } from "node:test";
import assert from "node:assert/strict";
import { crews, migrations, workers, world, MINUTE } from "./harness.ts";

const { keyJoinAttemptsByIdentity: migrate, joinAttemptsKeyedByWorker: remaining } = migrations!;
const wrongGuess = (w: ReturnType<typeof world>, token: string) => w.call(crews.lookup, token, { code: "0000" });

async function mixed() {
  const w = world();
  const live = await w.profile("live-token", "liv-e");
  const stale = await w.profile("stale-token", "sta-l");
  const gone = await w.profile("gone-token", "gon-e");
  await w.profile("new-token", "new-n");
  await w.db.insert("joinAttempts", { workerId: live, windowStart: Date.now(), fails: 5 });
  await w.db.insert("joinAttempts", { workerId: stale, windowStart: Date.now() - 10 * MINUTE, fails: 5 });
  await w.db.insert("joinAttempts", { workerId: gone, windowStart: Date.now(), fails: 5 });
  await wrongGuess(w, "new-token");
  await w.db.delete(gone); // a count nothing can reach any more
  return w;
}

test("a dry run reports what would change and writes nothing", async () => {
  const w = await mixed();
  const before = JSON.stringify(w.rows("joinAttempts"));
  assert.deepEqual(await w.call(migrate, null, { dryRun: true }), { moved: 1, deleted: 2, isDone: true });
  assert.equal(JSON.stringify(w.rows("joinAttempts")), before);
  assert.equal(await w.call(remaining), 3);
});

test("live counts move to the identity, dead ones go, and running it twice is safe", async () => {
  const w = await mixed();
  assert.deepEqual(await w.call(migrate), { moved: 1, deleted: 2, isDone: true });
  assert.equal(await w.call(remaining), 0);
  const rows = w.rows("joinAttempts").map((r) => [r.tokenIdentifier, r.workerId, r.fails]);
  assert.deepEqual(rows, [["live-token", undefined, 5], ["new-token", undefined, 1]]);
  assert.deepEqual(await w.call(migrate), { moved: 0, deleted: 0, isDone: true });
});

test("a migrated count still blocks through profile recreation", async () => {
  const w = await mixed();
  await w.call(migrate);
  assert.match((await wrongGuess(w, "live-token")).error, /Too many/);
  await w.call(workers.deleteAccount, "live-token");
  await w.profile("live-token", "liv-e");
  assert.match((await wrongGuess(w, "live-token")).error, /Too many/);
  assert.match((await wrongGuess(w, "stale-token")).error, /No open crew/);
});

test("large tables are worked through in batches", async () => {
  const w = world();
  for (let i = 0; i < 250; i++) {
    const worker = await w.profile(`t${i}`, `worker-${i}`);
    await w.db.insert("joinAttempts", { workerId: worker, windowStart: Date.now(), fails: 1 });
  }
  assert.deepEqual(await w.call(migrate), { moved: 100, deleted: 0, isDone: false });
  assert.equal(await w.call(remaining), 150);
  await w.runDueJobs();
  assert.equal(await w.call(remaining), 0);
  assert.equal(w.rows("joinAttempts").length, 250);
});
