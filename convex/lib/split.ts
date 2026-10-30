export type SplitMode = "even" | "hours" | "shares" | "custom";

export type SplitMember = {
  hours: number;
  shares: number;
  pct: number;
};

export function weightsFor(mode: SplitMode, members: SplitMember[]): number[] {
  return members.map((m) =>
    mode === "even" ? 1 : mode === "hours" ? m.hours : mode === "shares" ? m.shares : m.pct,
  );
}

/**
 * Split a pool of cents by weights. Each member gets floor(pool * w / total);
 * leftover cents go one at a time in rotating order starting at `start`,
 * so the same person doesn't always get the extra cent.
 */
export function splitCents(pool: number, weights: number[], start = 0): number[] {
  if (!Number.isInteger(pool) || pool < 0) throw new Error("Pool must be a non-negative integer of cents");
  if (weights.some((w) => !(w >= 0))) throw new Error("Weights must be non-negative");
  const total = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0 || total === 0) return weights.map(() => 0);
  const out = weights.map((w) => Math.floor((pool * w) / total));
  let left = pool - out.reduce((a, b) => a + b, 0);
  const eligible = weights.map((w, i) => (w > 0 ? i : -1)).filter((i) => i >= 0);
  for (let i = 0; left > 0; i++, left--) out[eligible[(start + i) % eligible.length]]++;
  return out;
}

export function customPercentsValid(members: SplitMember[]): boolean {
  return members.reduce((a, m) => a + m.pct, 0) === 100;
}
