/**
 * Money arithmetic. Everything is integer `bigint`: no floating point ever
 * touches an amount. Two different units live here and must never be mixed:
 *
 *   - fiat *minor units* (kobo, pence, cents) — what a bill is denominated in;
 *   - USDC *stroops* (1 USDC = 10_000_000) — what the Stellar network moves.
 *
 * A fiat minor unit is never a USDC cent. Conversion goes through an explicit,
 * disclosed rate.
 */

export const STROOPS_PER_USDC = 10_000_000n;

export interface FiatRate {
  /** Minor units in one major unit (100 for every currency Settle supports today). */
  minorPerMajor: bigint;
  /** Micro-USD (1e-6 USD) per one *major* unit of the currency. */
  usdMicroPerMajor: bigint;
}

/**
 * USDC stroops for a fiat amount, rounded **up** so a provider is never
 * underpaid by rounding.
 *
 *   stroops = ceil( minor × usdMicro × 1e7 / (minorPerMajor × 1e6) )
 */
export function fiatMinorToUsdcStroops(amountMinor: bigint, rate: FiatRate): bigint {
  if (amountMinor <= 0n) throw new RangeError("amount must be positive");
  const numerator = amountMinor * rate.usdMicroPerMajor * STROOPS_PER_USDC;
  const denominator = rate.minorPerMajor * 1_000_000n;
  return (numerator + denominator - 1n) / denominator;
}

/** Stellar's decimal amount string for stroops: `123456789n` → `"12.3456789"`. */
export function stroopsToDecimal(stroops: bigint): string {
  if (stroops < 0n) throw new RangeError("stroops must not be negative");
  const whole = stroops / STROOPS_PER_USDC;
  const fraction = (stroops % STROOPS_PER_USDC).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}

/** Inverse of {@link stroopsToDecimal}. Rejects anything that is not a plain 7-place amount. */
export function decimalToStroops(amount: string): bigint {
  const match = /^(\d+)\.(\d{1,7})$/.exec(amount);
  if (!match) throw new RangeError(`not a Stellar amount: ${amount}`);
  return BigInt(match[1]!) * STROOPS_PER_USDC + BigInt(match[2]!.padEnd(7, "0"));
}

/** A positive integer sent as a JSON number or numeric string, as `bigint`; otherwise `null`. */
export function parseMinorUnits(value: unknown): bigint | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? BigInt(value) : null;
  }
  if (typeof value === "string" && /^[1-9]\d{0,15}$/.test(value)) return BigInt(value);
  return null;
}
