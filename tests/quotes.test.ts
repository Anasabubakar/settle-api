import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, Networks, TransactionBuilder, type Operation, type Transaction } from "@stellar/stellar-sdk";
import { ApiError } from "../src/errors.ts";
import { PROVIDER_KEY, createHarness, freshKey, quoteFor, richAccount, ISSUER } from "./helpers.ts";

async function rejects(promise: Promise<unknown>, status: number, code: string): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected an ApiError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return error;
  }
  assert.fail(`expected ${code} but the call succeeded`);
}

const request = (h: ReturnType<typeof createHarness>, overrides: Record<string, unknown> = {}) => ({
  billId: "bill-partial",
  amountMinor: 1_000,
  currency: "USD",
  sourceAccount: h.supporter.publicKey(),
  ...overrides,
});

describe("quote creation", () => {
  it("returns the fields the Settle client expects, resolved by the server", async () => {
    const h = createHarness();
    const quote = await quoteFor(h);
    assert.match(String(quote.quoteId), /^q_[a-z0-9]{20}$/);
    assert.equal(quote.destination, PROVIDER_KEY.publicKey());
    assert.equal(quote.assetIssuer, ISSUER);
    assert.equal(quote.usdcAmountStroops, "100000000"); // $10.00 at 1:1 = 10 USDC
    assert.equal(quote.network, "testnet");
    assert.equal(quote.networkPassphrase, Networks.TESTNET);
    assert.ok(Date.parse(String(quote.expiresAt)) > h.clock.now());
    assert.ok(new TextEncoder().encode(String(quote.memo)).length <= 28, "a text memo is capped at 28 bytes");
    assert.deepEqual(quote.fiat, { amountMinor: "1000", currency: "USD" });
  });

  it("discloses every fee, and who pays it", async () => {
    const quote = await quoteFor(createHarness());
    assert.deepEqual(quote.fees, { network: { asset: "XLM", stroops: "100", paidBy: "supporter" }, platform: { bps: 0 } });
    assert.equal((quote.rate as { source: string }).source, "testnet-fixture");
    assert.equal((quote.rate as { lockedUntil: string }).lockedUntil, quote.expiresAt);
  });

  it("builds an unsigned payment that says exactly what was quoted", async () => {
    const h = createHarness();
    const quote = await quoteFor(h);
    const tx = TransactionBuilder.fromXDR(quote.unsignedXdr, Networks.TESTNET) as Transaction;
    assert.equal(tx.source, h.supporter.publicKey());
    assert.equal(tx.signatures.length, 0, "the server never signs for the supporter");
    assert.equal(tx.operations.length, 1);
    const op = tx.operations[0] as Operation.Payment;
    assert.equal(op.type, "payment");
    assert.equal(op.destination, PROVIDER_KEY.publicKey());
    assert.equal(op.asset.getCode(), "USDC");
    assert.equal(op.asset.getIssuer(), ISSUER);
    assert.equal(op.amount, "10.0000000");
    assert.equal(new TextDecoder().decode(tx.memo.value as Uint8Array), quote.memo);
    assert.equal(tx.timeBounds?.minTime, "0");
    assert.equal(tx.timeBounds?.maxTime, String(Math.floor(Date.parse(String(quote.expiresAt)) / 1000)));
    assert.equal(tx.fee, "100");
    assert.equal(tx.sequence, "1001");
  });

  it("converts other currencies through the disclosed rate", async () => {
    const h = createHarness();
    // KES 500.00 at 7,700 micro-USD per shilling = $3.85 = 3.85 USDC.
    const quote = await quoteFor(h, { billId: "bill-whole", amountMinor: 50_000, currency: "KES" });
    assert.equal(quote.usdcAmountStroops, "38500000");
    assert.equal((quote.usdc as { amount: string }).amount, "3.8500000");
  });

  it("resolves the provider from the bill, never from the client", async () => {
    const h = createHarness();
    const a = await quoteFor(h);
    const b = await quoteFor(h, { billId: "bill-whole", amountMinor: 50_000, currency: "KES" });
    assert.notEqual(a.destination, b.destination);
  });

  it("stores the quote so it can be read back", async () => {
    const h = createHarness();
    const quote = await quoteFor(h);
    const read = h.service.getQuote(String(quote.quoteId));
    assert.equal(read.quoteId, quote.quoteId);
    assert.equal(read.state, "open");
    await rejects(Promise.resolve().then(() => h.service.getQuote("q_missing")), 404, "quote_not_found");
  });

  it("shows a quote as expired once its time is up", async () => {
    const h = createHarness();
    const quote = await quoteFor(h);
    h.clock.advanceSeconds(301);
    assert.equal(h.service.getQuote(String(quote.quoteId)).state, "expired");
  });
});

describe("the client has no authority over destination, asset, rate or memo", () => {
  for (const field of ["destination", "assetIssuer", "assetCode", "issuer", "providerId", "usdcAmountStroops", "memo", "rate", "fee", "network", "networkPassphrase"]) {
    it(`refuses a client-supplied ${field}`, async () => {
      const h = createHarness();
      const error = await rejects(h.service.createQuote(request(h, { [field]: "x" }), freshKey()), 400, "client_authority_forbidden");
      assert.deepEqual(error.details?.fields, [field]);
      assert.equal(h.chain.submissions.length, 0);
    });
  }

  it("names every forbidden field at once", async () => {
    const h = createHarness();
    const error = await rejects(
      h.service.createQuote(request(h, { destination: Keypair.random().publicKey(), assetIssuer: Keypair.random().publicKey() }), freshKey()),
      400,
      "client_authority_forbidden",
    );
    assert.deepEqual(error.details?.fields, ["destination", "assetIssuer"]);
  });

  it("refuses unknown fields rather than ignoring them", async () => {
    const h = createHarness();
    await rejects(h.service.createQuote(request(h, { surprise: true }), freshKey()), 400, "unknown_fields");
  });
});

describe("request validation", () => {
  it("rejects a malformed request", async () => {
    const h = createHarness();
    await rejects(h.service.createQuote(null, freshKey()), 400, "invalid_body");
    await rejects(h.service.createQuote([], freshKey()), 400, "invalid_body");
    await rejects(h.service.createQuote("x", freshKey()), 400, "invalid_body");
    await rejects(h.service.createQuote(request(h, { billId: "" }), freshKey()), 400, "invalid_bill_id");
    await rejects(h.service.createQuote(request(h, { currency: 5 }), freshKey()), 400, "invalid_currency");
    await rejects(h.service.createQuote(request(h, { sourceAccount: "GNOPE" }), freshKey()), 400, "invalid_source_account");
    await rejects(h.service.createQuote(request(h, { sourceAccount: Keypair.random().secret() }), freshKey()), 400, "invalid_source_account");
  });

  it("rejects bad amounts", async () => {
    const h = createHarness();
    for (const amountMinor of [0, -5, 1.5, "abc", null, "1e3", "-1", Number.MAX_SAFE_INTEGER + 1]) {
      await rejects(h.service.createQuote(request(h, { amountMinor }), freshKey()), 400, "invalid_amount");
    }
    await rejects(h.service.createQuote(request(h, { amountMinor: 99 }), freshKey()), 422, "amount_too_small");
  });

  it("rejects an unknown, closed or mismatched bill", async () => {
    const h = createHarness();
    await rejects(h.service.createQuote(request(h, { billId: "bill-ghost" }), freshKey()), 404, "bill_not_found");
    await rejects(h.service.createQuote(request(h, { billId: "bill-settled" }), freshKey()), 409, "bill_not_open");
    await rejects(h.service.createQuote(request(h, { billId: "bill-paused" }), freshKey()), 409, "bill_not_open");
    const error = await rejects(h.service.createQuote(request(h, { currency: "GBP" }), freshKey()), 422, "currency_mismatch");
    assert.equal(error.details?.expected, "USD");
  });
});

describe("how much a bill can still take", () => {
  it("allows up to exactly what remains, and no more", async () => {
    const h = createHarness();
    // bill-partial: total 10,000, already funded 2,000 → 8,000 remain.
    const error = await rejects(h.service.createQuote(request(h, { amountMinor: 8_001 }), freshKey()), 409, "exceeds_remaining");
    assert.equal(error.details?.remainingMinor, "8000");
    const ok = await h.service.createQuote(request(h, { amountMinor: 8_000 }), freshKey());
    assert.equal(ok.status, 201);
  });

  it("reserves what is already quoted, so two supporters cannot both claim the last of a bill", async () => {
    const h = createHarness();
    const second = Keypair.random();
    h.chain.accounts.set(second.publicKey(), richAccount());
    await quoteFor(h, { amountMinor: 5_000 });
    const error = await rejects(
      h.service.createQuote(request(h, { amountMinor: 3_500, sourceAccount: second.publicKey() }), freshKey()),
      409,
      "exceeds_remaining",
    );
    assert.equal(error.details?.remainingMinor, "3000");
    assert.equal((h.service.billView("bill-partial") as { reservedMinor: string }).reservedMinor, "5000");
  });

  it("releases a reservation when its quote expires", async () => {
    const h = createHarness();
    await quoteFor(h, { amountMinor: 8_000 });
    await rejects(h.service.createQuote(request(h, { amountMinor: 100 }), freshKey()), 409, "exceeds_remaining");
    h.clock.advanceSeconds(301);
    const again = await h.service.createQuote(request(h, { amountMinor: 8_000 }), freshKey());
    assert.equal(again.status, 201);
  });

  it("makes a whole-bill-only bill refuse a partial contribution", async () => {
    const h = createHarness();
    const base = { billId: "bill-whole", currency: "KES" };
    await rejects(h.service.createQuote(request(h, { ...base, amountMinor: 49_999 }), freshKey()), 422, "partial_funding_not_allowed");
    const full = await h.service.createQuote(request(h, { ...base, amountMinor: 50_000 }), freshKey());
    assert.equal(full.status, 201);
  });
});

describe("the supporter's account", () => {
  it("must exist", async () => {
    const h = createHarness({ fund: false });
    await rejects(h.service.createQuote(request(h), freshKey()), 409, "source_account_not_found");
  });

  it("must trust the asset", async () => {
    const h = createHarness();
    h.chain.accounts.set(h.supporter.publicKey(), richAccount({ hasTrustline: false }));
    await rejects(h.service.createQuote(request(h), freshKey()), 409, "trustline_missing");
  });

  it("must hold enough of it, and says how much it lacks", async () => {
    const h = createHarness();
    h.chain.accounts.set(h.supporter.publicKey(), richAccount({ assetBalanceStroops: 99_999_999n }));
    const error = await rejects(h.service.createQuote(request(h), freshKey()), 409, "insufficient_balance");
    assert.deepEqual(error.details, { requiredStroops: "100000000", availableStroops: "99999999" });
    h.chain.accounts.set(h.supporter.publicKey(), richAccount({ assetBalanceStroops: 100_000_000n }));
    assert.equal((await h.service.createQuote(request(h), freshKey())).status, 201, "exactly enough is enough");
  });

  it("must have XLM for the network fee", async () => {
    const h = createHarness();
    h.chain.accounts.set(h.supporter.publicKey(), richAccount({ nativeBalanceStroops: 99n }));
    await rejects(h.service.createQuote(request(h), freshKey()), 409, "insufficient_native_balance");
  });

  it("is reported as an upstream problem, not a bad request, when the network is unreachable", async () => {
    const h = createHarness();
    h.chain.loadError = new Error("ECONNRESET");
    await rejects(h.service.createQuote(request(h), freshKey()), 502, "upstream_unavailable");
  });
});

describe("idempotent quotes", () => {
  it("returns the same quote for a retried request", async () => {
    const h = createHarness();
    const key = freshKey();
    const first = await h.service.createQuote(request(h), key);
    const retry = await h.service.createQuote(request(h), key);
    assert.equal(first.replay, undefined);
    assert.equal(retry.replay, true);
    assert.deepEqual(retry.body, first.body);
    assert.equal((h.service.billView("bill-partial") as { reservedMinor: string }).reservedMinor, "1000", "a retry did not reserve twice");
  });

  it("treats key order inside the body as irrelevant", async () => {
    const h = createHarness();
    const key = freshKey();
    await h.service.createQuote({ billId: "bill-partial", amountMinor: 1000, currency: "USD", sourceAccount: h.supporter.publicKey() }, key);
    const retry = await h.service.createQuote({ sourceAccount: h.supporter.publicKey(), currency: "USD", amountMinor: 1000, billId: "bill-partial" }, key);
    assert.equal(retry.replay, true);
  });

  it("refuses the same key for a different request", async () => {
    const h = createHarness();
    const key = freshKey();
    await h.service.createQuote(request(h), key);
    await rejects(h.service.createQuote(request(h, { amountMinor: 2_000 }), key), 422, "idempotency_key_reuse");
  });

  it("replays a rejection as well, so a client sees a consistent answer", async () => {
    const h = createHarness();
    const key = freshKey();
    const first = await rejects(h.service.createQuote(request(h, { amountMinor: 999_999 }), key), 409, "exceeds_remaining");
    // The stored answer comes back as a response (flagged as a replay), not as a fresh failure.
    const again = await h.service.createQuote(request(h, { amountMinor: 999_999 }), key);
    assert.equal(again.status, 409);
    assert.equal(again.replay, true);
    const body = again.body as { error: { code: string; message: string } };
    assert.equal(body.error.code, "exceeds_remaining");
    assert.equal(body.error.message, first.message);
  });

  it("does not remember an upstream failure, so a retry can succeed", async () => {
    const h = createHarness();
    const key = freshKey();
    h.chain.loadError = new Error("timeout");
    await rejects(h.service.createQuote(request(h), key), 502, "upstream_unavailable");
    h.chain.loadError = undefined;
    const retry = await h.service.createQuote(request(h), key);
    assert.equal(retry.status, 201);
    assert.equal(retry.replay, undefined);
  });

  it("insists on a well-formed key", async () => {
    const h = createHarness();
    for (const key of ["", "short", "has spaces in it", "x".repeat(129), "bad/key/chars"]) {
      await rejects(h.service.createQuote(request(h), key), 400, "invalid_idempotency_key");
    }
  });
});

describe("bill view", () => {
  it("shows what is funded, reserved and remaining, from the server's own accounting", async () => {
    const h = createHarness();
    await quoteFor(h, { amountMinor: 1_500 });
    assert.deepEqual(h.service.billView("bill-partial"), {
      id: "bill-partial",
      status: "open",
      currency: "USD",
      totalMinor: "10000",
      fundedMinor: "2000",
      reservedMinor: "1500",
      remainingMinor: "6500",
      acceptsPartialFunding: true,
      provider: { id: "prov-a", displayName: "Provider A", verification: "fixture" },
    });
    assert.equal(h.service.listBills().length, 4);
  });
});
