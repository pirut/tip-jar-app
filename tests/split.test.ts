import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCents, weightsFor } from "../convex/lib/split.ts";

test("even split hands leftover cents out in rotating order", () => {
  assert.deepEqual(splitCents(1000, [1, 1, 1]), [334, 333, 333]);
  assert.deepEqual(splitCents(1000, [1, 1, 1], 1), [333, 334, 333]);
});

test("split always sums to the pool", () => {
  for (const pool of [0, 1, 99, 38600, 41237]) {
    const out = splitCents(pool, [6.5, 8, 8, 4]);
    assert.equal(out.reduce((a, b) => a + b, 0), pool);
  }
});

test("hours mode weights by time", () => {
  const ms = [{ hours: 8, shares: 1, pct: 0 }, { hours: 4, shares: 1, pct: 0 }];
  assert.deepEqual(splitCents(1200, weightsFor("hours", ms)), [800, 400]);
});

test("zero-weight members never get leftover cents", () => {
  assert.deepEqual(splitCents(101, [1, 0, 1]), [51, 0, 50]);
});

test("empty or zero weights give zeros", () => {
  assert.deepEqual(splitCents(500, [0, 0]), [0, 0]);
  assert.deepEqual(splitCents(500, []), []);
});
