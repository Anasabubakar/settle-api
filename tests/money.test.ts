import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decimalToStroops, fiatMinorToUsdcStroops, parseMinorUnits, stroopsToDecimal, STROOPS_PER_USDC } from "../src/money.ts";
import { TESTNET_FIXTURE_RATES } from "../src/config.ts";

describe("fiat minor units to USDC stroops", () => {
  it("converts exactly when the maths is exact", () => {
    // $100.00 at 1 USD/USD is 100 USDC.
    assert.equal(fiatMinorToUsdcStroops(10_000n, TESTNET_FIXTURE_RATES.USD!), 100n * STROOPS_PER_USDC);
    // £184.00 at 1.30 is 239.20 USDC.
    assert.equal(fiatMinorToUsdcStroops(18_400n, TESTNET_FIXTURE_RATES.GBP!), 2_392_000_000n);
  });

  it("rounds up, so a provider is never underpaid by rounding", () => {
    // 1 kobo at 650 micro-USD per naira: 1 × 650 / 10 = 65 stroops exactly; 3 kobo = 195.
    assert.equal(fiatMinorToUsdcStroops(1n, TESTNET_FIXTURE_RATES.NGN!), 65n);
    // KES 0.01 at 7_700: 7700/10 = 770 stroops, exact. Use an awkward rate to force rounding.
    const awkward = { minorPerMajor: 100n, usdMicroPerMajor: 1_234_567n };
    assert.equal(fiatMinorToUsdcStroops(1n, awkward), 123_457n); // ceil(123_456.7)
    assert.equal(fiatMinorToUsdcStroops(3n, awkward), 370_371n); // ceil(370_370.1)
  });

  it("is monotonic: more fiat is never less USDC", () => {
    let previous = 0n;
    for (let amount = 1n; amount < 500n; amount += 7n) {
      const stroops = fiatMinorToUsdcStroops(amount, TESTNET_FIXTURE_RATES.NGN!);
      assert.ok(stroops >= previous);
      previous = stroops;
    }
  });

  it("handles very large bills without losing precision", () => {
    const big = 9_007_199_254_740_991n; // beyond what a float adds exactly
    const stroops = fiatMinorToUsdcStroops(big, TESTNET_FIXTURE_RATES.USD!);
    assert.equal(stroops, big * 100_000n);
  });

  it("refuses a non-positive amount", () => {
    assert.throws(() => fiatMinorToUsdcStroops(0n, TESTNET_FIXTURE_RATES.USD!), RangeError);
    assert.throws(() => fiatMinorToUsdcStroops(-5n, TESTNET_FIXTURE_RATES.USD!), RangeError);
  });

  it("never treats a fiat cent as a USDC cent", () => {
    // 1,000 NGN-kobo is nowhere near 1,000 USDC-cents.
    const stroops = fiatMinorToUsdcStroops(1_000n, TESTNET_FIXTURE_RATES.NGN!);
    assert.notEqual(stroops, 1_000n * (STROOPS_PER_USDC / 100n));
    assert.equal(stroops, 65_000n);
  });
});

describe("stroops and decimal amounts", () => {
  it("formats with exactly seven places", () => {
    assert.equal(stroopsToDecimal(0n), "0.0000000");
    assert.equal(stroopsToDecimal(1n), "0.0000001");
    assert.equal(stroopsToDecimal(123_456_789n), "12.3456789");
    assert.equal(stroopsToDecimal(10_000_000n), "1.0000000");
  });

  it("round-trips", () => {
    for (const stroops of [1n, 99n, 10_000_000n, 123_456_789n, 9_999_999_999_999n]) {
      assert.equal(decimalToStroops(stroopsToDecimal(stroops)), stroops);
    }
  });

  it("rejects anything that is not a plain decimal", () => {
    for (const bad of ["", "1", "1.", ".5", "1.12345678", "-1.0", "1e3", "abc", "1,5"]) {
      assert.throws(() => decimalToStroops(bad), RangeError, bad);
    }
    assert.throws(() => stroopsToDecimal(-1n), RangeError);
  });
});

describe("parseMinorUnits", () => {
  it("accepts positive whole numbers as numbers or strings", () => {
    assert.equal(parseMinorUnits(100), 100n);
    assert.equal(parseMinorUnits("2500"), 2500n);
  });

  it("rejects everything else", () => {
    for (const bad of [0, -1, 1.5, "0", "01", "-5", "1.5", "1e3", "", " 5", null, undefined, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "99999999999999999"]) {
      assert.equal(parseMinorUnits(bad), null, String(bad));
    }
  });
});
