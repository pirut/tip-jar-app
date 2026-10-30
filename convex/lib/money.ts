// Shared money helpers. All amounts are integer cents.

export const PRESETS_CENTS = [500, 1000, 2000] as const;
export const MIN_TIP_CENTS = 100;
export const MAX_TIP_CENTS = 50000;

// Tip Jar's platform fee per tip, collected on top of card processing.
export const PLATFORM_FEE_CENTS = 25;

// Estimated card processing (2.9% + 30¢). Real pricing comes from Stripe once it's connected.
export function cardFeeCents(amountCents: number): number {
  return Math.round(amountCents * 0.029) + 30;
}

// Everything charged on top of the tip when the guest covers fees (the default).
export function feesCents(amountCents: number): number {
  return cardFeeCents(amountCents) + PLATFORM_FEE_CENTS;
}

// Instant cash-out fee: 1.5%, minimum 50¢.
export function instantFeeCents(amountCents: number): number {
  return Math.max(50, Math.round(amountCents * 0.015));
}
