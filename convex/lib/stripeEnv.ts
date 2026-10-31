// Which kind of Stripe money this deployment may touch. STRIPE_MODE is set per deployment and
// the key has to agree with it, so a live key on a dev deployment refuses to run.

export type StripeMode = "test" | "live";

// Null means this deployment takes no real payments at all.
export function configuredMode(value = process.env.STRIPE_MODE): StripeMode | null {
  return value === "test" || value === "live" ? value : null;
}

export function keyMode(key: string): StripeMode | null {
  if (/^(sk|rk)_test_/.test(key)) return "test";
  if (/^(sk|rk)_live_/.test(key)) return "live";
  return null;
}

export function requireStripeConfig(env: Record<string, string | undefined> = process.env): { mode: StripeMode; key: string } {
  const mode = configuredMode(env.STRIPE_MODE ?? "");
  if (!mode) throw new Error("STRIPE_MODE isn't set on this deployment");
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY isn't set on this deployment");
  if (keyMode(key) !== mode) throw new Error(`STRIPE_SECRET_KEY doesn't match STRIPE_MODE=${mode}`);
  return { mode, key };
}

export function isLive(mode: StripeMode): boolean {
  return mode === "live";
}

// Where Stripe sends guests and workers back to. Comes from the server so a client can't
// point a checkout's return at someone else's site.
export function tipOrigin(value = process.env.TIP_ORIGIN): string {
  if (!value || !/^https?:\/\/[^/]+$/.test(value)) throw new Error("TIP_ORIGIN must be an origin like https://tip.jrbussard.com");
  return value;
}

// Public contact only; never an API key or a bank detail.
export function supportEmail(value = process.env.SUPPORT_EMAIL): string | null {
  const email = value?.trim();
  return email && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(email) ? email : null;
}
