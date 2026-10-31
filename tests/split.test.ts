import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveWeights, splitCents, weightsFor } from "../convex/lib/split.ts";
import { handleError } from "../convex/lib/handles.ts";

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

const m = (hours: number, shares: number, pct: number) => ({ hours, shares, pct });

test("an hours crew closed early still pays the whole pool", () => {
  const out = splitCents(4000, effectiveWeights("hours", [m(0, 1, 0), m(0, 1, 0)]));
  assert.deepEqual(out, [2000, 2000]);
});

test("all-zero shares pay evenly rather than losing the pool", () => {
  assert.deepEqual(splitCents(1000, effectiveWeights("shares", [m(1, 0, 0), m(1, 0, 0)])), [500, 500]);
});

test("percents that don't add to 100 pay evenly", () => {
  assert.deepEqual(effectiveWeights("custom", [m(1, 1, 70), m(1, 1, 70)]), [1, 1]);
});

test("valid weights are left alone", () => {
  assert.deepEqual(effectiveWeights("custom", [m(1, 1, 60), m(1, 1, 40)]), [60, 40]);
  assert.deepEqual(effectiveWeights("hours", [m(8, 1, 0), m(0, 1, 0)]), [8, 0]);
});

test("link names", () => {
  assert.equal(handleError("marcus-2"), null);
  assert.match(handleError("company") ?? "", /reserved/);
  assert.match(handleError("sign-in") ?? "", /reserved/);
  assert.match(handleError("ab") ?? "", /3–30/);
  assert.match(handleError("-abc") ?? "", /3–30/);
});
