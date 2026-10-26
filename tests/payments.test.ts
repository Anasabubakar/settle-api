import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Keypair, Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { ApiError } from "../src/errors.ts";
import { ReceiptLedger } from "../src/ledger.ts";
import { Store } from "../src/store.ts";
import { OTHER_ISSUER, PROVIDER_KEY, createHarness, forgeTransaction, freshKey, quoteFor, signQuote, testDirectory, type Harness } from "./helpers.ts";

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

const pay = (h: Harness, quoteId: string, signedXdr: string, key = freshKey("pay")) => h.service.submitPayment({ quoteId, signedXdr }, key);
const body = (result: { body: unknown }) => result.body as Record<string, any>;

/** Quote, sign and submit in one go. */
async function settle(h: Harness, overrides: Record<string, unknown> = {}) {
  const quote = await quoteFor(h, overrides);
  const result = await pay(h, quote.quoteId, signQuote(quote, h.supporter));
  return { quote, result };
}

describe("a successful payment", () => {
  it("is confirmed, independently, and produces a receipt", async () => {
    const h = createHarness();
    const { quote, result } = await settle(h);
    assert.equal(result.status, 200);
    const view = body(result);
    assert.equal(view.status, "confirmed");
    assert.equal(view.quoteId, quote.quoteId);
    assert.match(view.explorerUrl, /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/);
    assert.equal(view.receipt.txHash, view.txHash);
    assert.equal(view.receipt.fiat.amountMinor, "1000");
    assert.equal(view.receipt.usdc.amountStroops, "100000000");
    assert.equal(view.receipt.destination, PROVIDER_KEY.publicKey());
    assert.equal(view.receipt.source, h.supporter.publicKey());
    assert.equal(view.receipt.network, "testnet");
    assert.equal(h.chain.submissions.length, 1);
  });

  it("is added to the funded total, and the reservation becomes real funding", async () => {
    const h = createHarness();
    await settle(h, { amountMinor: 1_000 });
    const bill = h.service.billView("bill-partial") as Record<string, string>;
    assert.equal(bill.fundedMinor, "3000"); // 2,000 before + 1,000 confirmed
    assert.equal(bill.reservedMinor, "0");
    assert.equal(bill.remainingMinor, "7000");
  });

  it("can be read back, along with its receipt and the ledger", async () => {
    const h = createHarness();
    const { result } = await settle(h);
    const view = body(result);
    const again = (await h.service.getPayment(view.paymentId)) as Record<string, any>;
    assert.deepEqual(again, view);
    assert.equal(h.service.getReceipt(view.receipt.id).hash, view.receipt.hash);
    const ledger = h.service.ledgerStatus() as { count: number; verified: boolean };
    assert.equal(ledger.count, 1);
    assert.equal(ledger.verified, true);
  });

  it("chains one receipt after another", async () => {
    const h = createHarness();
    const first = body((await settle(h)).result).receipt;
    const second = body((await settle(h, { amountMinor: 500 })).result).receipt;
    assert.equal(second.prevHash, first.hash);
    assert.equal(second.sequence, 2);
    assert.equal(h.ledger.verify().ok, true);
  });
});

describe("what the supporter signed must be exactly what was quoted", () => {
  const cases: Array<[string, string, (h: Harness, record: any) => string]> = [
    ["a different destination", "destination", (h, r) => forgeTransaction(r, h.supporter, { destination: Keypair.random().publicKey() })],
    ["one stroop more", "amount", (h, r) => forgeTransaction(r, h.supporter, { amountStroops: BigInt(r.usdcAmountStroops) + 1n })],
    ["one stroop less", "amount", (h, r) => forgeTransaction(r, h.supporter, { amountStroops: BigInt(r.usdcAmountStroops) - 1n })],
    ["another issuer of USDC", "asset", (h, r) => forgeTransaction(r, h.supporter, { issuer: OTHER_ISSUER })],
    ["a different asset code", "asset", (h, r) => forgeTransaction(r, h.supporter, { code: "USDX" })],
    ["a different memo", "memo", (h, r) => forgeTransaction(r, h.supporter, { memo: "settle:somethingelse" })],
    ["no memo at all", "memo", (h, r) => forgeTransaction(r, h.supporter, { memo: null })],
    ["an extra operation", "operations", (h, r) => forgeTransaction(r, h.supporter, { extraOperation: true })],
    ["a higher fee than quoted", "fee", (h, r) => forgeTransaction(r, h.supporter, { fee: "5000" })],
    ["an unreasonable fee", "fee", (h, r) => forgeTransaction(r, h.supporter, { fee: "9999999" })],
    ["a different sequence number", "sequence", (h, r) => forgeTransaction(r, h.supporter, { sequence: "5000" })],
    ["a longer time window", "time_bounds", (h, r) => forgeTransaction(r, h.supporter, { maxTime: Math.floor(Date.parse(r.expiresAt) / 1000) + 3600 })],
    ["another source account", "source", (h, r) => forgeTransaction(r, Keypair.random(), { source: Keypair.random().publicKey() })],
  ];

  for (const [name, field, forge] of cases) {
    it(`refuses ${name}, and sends nothing to the network`, async () => {
      const h = createHarness();
      const quote = await quoteFor(h);
      const record = h.store.getQuote(quote.quoteId)!;
      const error = await rejects(pay(h, quote.quoteId, forge(h, record)), 422, "signed_payload_mismatch");
      assert.equal(error.details?.field, field);
      assert.equal(h.chain.submissions.length, 0, "nothing reached the network");
      assert.equal(h.store.getQuote(quote.quoteId)?.state, "open", "the quote was not consumed by a bad attempt");
    });
  }

  it("refuses a transaction signed for a different network", async () => {
    const h = createHarness();
    const quote = await quoteFor(h);
    const record = h.store.getQuote(quote.quoteId)!;
    // The body is identical, but the signature is over the public-network hash, so it is worthless on testnet.
    await rejects(pay(h, quote.quoteId, forgeTransaction(record, h.supporter, { networkPassphrase: Networks.PUBLIC })), 422, "invalid_signature");
    assert.equal(h.chain.submissions.length, 0);
  });

  it("refuses an unsigned transaction", async () => {
    const h = createHarness();
    const quote = await quoteFor(h);
    await rejects(pay(h, quote.quoteId, quote.unsignedXdr), 422, "invalid_signature");
    assert.equal(h.chain.submissions.length, 0);
  });

  it("refuses the right transaction signed by the wrong key", async () => {
    const h = createHarness();
    const quote = await quoteFor(h);
    await rejects(pay(h, quote.quoteId, signQuote(quote, Keypair.random())), 422, "invalid_signature");
    assert.equal(h.chain.submissions.length, 0);
  });

  it("refuses garbage and a fee-bump wrapper", async () => {
    const h = createHarness();
    const quote = await quoteFor(h);
    await rejects(pay(h, quote.quoteId, "not-base64-xdr"), 400, "invalid_xdr");
    await rejects(pay(h, quote.quoteId, ""), 400, "invalid_xdr");
    const inner = TransactionBuilder.fromXDR(signQuote(quote, h.supporter), Networks.TESTNET) as Transaction;
    const wrapper = TransactionBuilder.buildFeeBumpTransaction(Keypair.random(), "1000", inner, Networks.TESTNET);
    await rejects(pay(h, quote.quoteId, wrapper.toXDR()), 422, "fee_bump_not_accepted");
    assert.equal(h.chain.submissions.length, 0);
  });

  it("refuses a missing or unknown quote and malformed requests", async () => {
    const h = createHarness();
    await rejects(pay(h, "q_unknown", "AAAA"), 404, "quote_not_found");
    await rejects(h.service.submitPayment({ signedXdr: "x" }, freshKey()), 400, "invalid_quote_id");
    await rejects(h.service.submitPayment({ quoteId: "q_x" }, freshKey()), 400, "invalid_xdr");
    await rejects(h.service.submitPayment({ quoteId: "q_x", signedXdr: "x", extra: 1 }, freshKey()), 400, "unknown_fields");
    await rejects(h.service.submitPayment("nope", freshKey()), 400, "invalid_body");
    await rejects(h.service.submitPayment({ quoteId: "q_x", signedXdr: "x".repeat(20_000) }, freshKey()), 400, "invalid_xdr");
  });
});

describe("expiry", () => {
  it("refuses to submit an expired quote", async () => {
    const h = createHarness();
    const quote = await quoteFor(h);
    const signed = signQuote(quote, h.supporter);
    h.clock.advanceSeconds(301);
    await rejects(pay(h, quote.quoteId, signed), 410, "quote_expired");
    assert.equal(h.chain.submissions.length, 0);
  });

  it("accepts a quote right up to its expiry", async () => {
    const h = createHarness();
    const quote = await quoteFor(h);
    const signed = signQuote(quote, h.supporter);
    h.clock.advanceSeconds(299);
    assert.equal((await pay(h, quote.quoteId, signed)).status, 200);
  });
});

describe("a quote can be used once", () => {
  it("refuses a second payment with a different key, and points at the first", async () => {
    const h = createHarness();
    const { quote, result } = await settle(h);
    const error = await rejects(pay(h, quote.quoteId, signQuote(quote, h.supporter)), 409, "quote_already_used");
    assert.equal(error.details?.paymentId, body(result).paymentId);
    assert.equal(h.chain.submissions.length, 1);
  });

  it("returns the original result for a retry with the same key, without submitting again", async () => {
    const h = createHarness();
    const quote = await quoteFor(h);
    const signed = signQuote(quote, h.supporter);
    const key = freshKey("pay");
    const first = await pay(h, quote.quoteId, signed, key);
    const retry = await pay(h, quote.quoteId, signed, key);
    assert.equal(retry.replay, true);
    assert.deepEqual(retry.body, first.body);
    assert.equal(h.chain.submissions.length, 1);
    assert.equal(h.ledger.all().length, 1, "no second receipt");
  });

  it("refuses the same key for a different payment", async () => {
    const h = createHarness();
    const a = await quoteFor(h);
    const b = await quoteFor(h, { amountMinor: 500 });
    const key = freshKey("pay");
    await pay(h, a.quoteId, signQuote(a, h.supporter), key);
    await rejects(pay(h, b.quoteId, signQuote(b, h.supporter), key), 422, "idempotency_key_reuse");
  });

  it("lets only one of two simultaneous attempts through", async () => {
    const h = createHarness();
    const quote = await quoteFor(h);
    const signed = signQuote(quote, h.supporter);
    const results = await Promise.allSettled([pay(h, quote.quoteId, signed), pay(h, quote.quoteId, signed)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.equal((failure.reason as ApiError).code, "quote_already_used");
    assert.equal(h.chain.submissions.length, 1);
  });

  it("tells a concurrent retry with the same key that the first request is still running", async () => {
    const h = createHarness();
    const quote = await quoteFor(h);
    const signed = signQuote(quote, h.supporter);
    let release!: () => void;
    h.chain.gate = new Promise<void>((resolve) => (release = resolve));
    const key = freshKey("pay");
    const first = pay(h, quote.quoteId, signed, key);
    await rejects(pay(h, quote.quoteId, signed, key), 409, "request_in_progress");
    release();
    assert.equal((await first).status, 200);
    assert.equal(h.chain.submissions.length, 1);
  });
});

describe("when the network refuses the payment", () => {
  it("records a failure with no receipt and no funding, and releases the amount", async () => {
    const h = createHarness();
    h.chain.nextSubmit = { kind: "rejected", code: "tx_bad_seq", message: "The network rejected the payment (tx_bad_seq)." };
    const { quote, result } = await settle(h);
    const view = body(result);
    assert.equal(result.status, 200);
    assert.equal(view.status, "failed");
    assert.deepEqual(view.failure, { code: "tx_bad_seq", message: "The network rejected the payment (tx_bad_seq)." });
    assert.equal(view.receipt, undefined);
    assert.equal(h.ledger.all().length, 0);
    const bill = h.service.billView("bill-partial") as Record<string, string>;
    assert.equal(bill.fundedMinor, "2000");
    assert.equal(bill.reservedMinor, "0");
    await rejects(pay(h, quote.quoteId, signQuote(quote, h.supporter)), 409, "quote_failed");
    assert.equal((await quoteFor(h)).quoteId.length > 0, true, "a new quote for the same amount works");
  });
});

describe("when the network gives no definite answer", () => {
  it("stays submitted, then confirms once the transaction is found", async () => {
    const h = createHarness();
    h.chain.nextSubmit = { kind: "unknown", message: "timeout" };
    h.chain.hideTransactions = true;
    const { quote, result } = await settle(h);
    assert.equal(result.status, 202);
    const view = body(result);
    assert.equal(view.status, "submitted");
    assert.match(view.note, /did not give a definite answer/);

    // The transaction turns out to have landed.
    h.chain.hideTransactions = false;
    h.chain.apply(signQuote(quote, h.supporter), Networks.TESTNET);
    const outcome = await h.service.reconcile();
    assert.deepEqual(outcome, { checked: 1, confirmed: 1, failed: 0 });
    const confirmed = (await h.service.getPayment(view.paymentId)) as Record<string, any>;
    assert.equal(confirmed.status, "confirmed");
    assert.ok(confirmed.receipt);
    assert.equal(confirmed.note, undefined);
  });

  it("treats a thrown submission error the same way, never as a failure", async () => {
    const h = createHarness();
    h.chain.nextSubmit = new Error("socket hang up");
    h.chain.hideTransactions = true;
    const { result } = await settle(h);
    assert.equal(result.status, 202);
    assert.equal(body(result).status, "submitted");
  });

  it("lets a client's own status poll drive the confirmation", async () => {
    const h = createHarness();
    h.chain.nextSubmit = { kind: "unknown", message: "timeout" };
    h.chain.hideTransactions = true;
    const { quote, result } = await settle(h);
    h.chain.hideTransactions = false;
    h.chain.apply(signQuote(quote, h.supporter), Networks.TESTNET);
    const polled = (await h.service.getPayment(body(result).paymentId)) as Record<string, any>;
    assert.equal(polled.status, "confirmed");
  });

  it("marks a transaction that never appears as failed once it can no longer land", async () => {
    const h = createHarness();
    h.chain.nextSubmit = { kind: "unknown", message: "timeout" };
    h.chain.hideTransactions = true;
    const { result } = await settle(h);

    h.clock.advanceSeconds(300 + 60); // past the quote's expiry but inside the grace
    assert.deepEqual(await h.service.reconcile(), { checked: 1, confirmed: 0, failed: 0 });

    h.clock.advanceSeconds(120); // past expiry plus grace: it can never be included
    assert.deepEqual(await h.service.reconcile(), { checked: 1, confirmed: 0, failed: 1 });
    const view = (await h.service.getPayment(body(result).paymentId)) as Record<string, any>;
    assert.equal(view.status, "failed");
    assert.equal(view.failure.code, "expired_unseen");
    assert.equal((h.service.billView("bill-partial") as Record<string, string>).reservedMinor, "0");
  });

  it("keeps going when the network is unreachable during a check", async () => {
    const h = createHarness();
    h.chain.nextSubmit = { kind: "unknown", message: "timeout" };
    h.chain.hideTransactions = true;
    await settle(h);
    h.chain.fetchTransaction = async () => {
      throw new Error("ECONNRESET");
    };
    assert.deepEqual(await h.service.reconcile(), { checked: 1, confirmed: 0, failed: 0 });
    assert.ok(h.logs.some((event) => event.event === "reconcile_error"));
  });
});

describe("independent confirmation", () => {
  it("issues no receipt when the recorded transaction does not match the quote", async () => {
    const h = createHarness();
    h.chain.tamperRecorded = (tx) => ({ ...tx, operations: [{ ...tx.operations[0]!, amount: "0.0000001" }] });
    const { result } = await settle(h);
    const view = body(result);
    assert.equal(view.status, "failed");
    assert.equal(view.failure.code, "confirmation_mismatch");
    assert.equal(view.receipt, undefined);
    assert.equal(h.ledger.all().length, 0);
    assert.equal((h.service.billView("bill-partial") as Record<string, string>).fundedMinor, "2000");
    assert.ok(h.logs.some((event) => event.event === "confirmation_mismatch"));
  });

  for (const [name, tamper] of [
    ["a different destination", (tx: any) => ({ ...tx, operations: [{ ...tx.operations[0], to: Keypair.random().publicKey() }] })],
    ["a different asset issuer", (tx: any) => ({ ...tx, operations: [{ ...tx.operations[0], assetIssuer: OTHER_ISSUER }] })],
    ["a different memo", (tx: any) => ({ ...tx, memo: "settle:other" })],
    ["a different source", (tx: any) => ({ ...tx, source: Keypair.random().publicKey() })],
    ["an extra operation", (tx: any) => ({ ...tx, operations: [tx.operations[0], tx.operations[0]] })],
    ["a different transaction hash", (tx: any) => ({ ...tx, hash: "0".repeat(64) })],
  ] as const) {
    it(`rejects ${name} in the recorded transaction`, async () => {
      const h = createHarness();
      h.chain.tamperRecorded = tamper;
      const { result } = await settle(h);
      assert.equal(body(result).status, "failed");
      assert.equal(body(result).failure.code, "confirmation_mismatch");
      assert.equal(h.ledger.all().length, 0);
    });
  }

  it("does not count a transaction the ledger recorded as unsuccessful", async () => {
    const h = createHarness();
    h.chain.tamperRecorded = (tx) => ({ ...tx, successful: false });
    const { result } = await settle(h);
    assert.equal(body(result).status, "failed");
    assert.equal(body(result).failure.code, "transaction_not_successful");
    assert.equal(h.ledger.all().length, 0);
  });

  it("stays submitted, never confirmed, while the network cannot yet show the transaction", async () => {
    const h = createHarness();
    h.chain.hideTransactions = true;
    const { result } = await settle(h);
    assert.equal(result.status, 202);
    assert.equal(body(result).status, "submitted");
    assert.equal(h.ledger.all().length, 0);
  });
});

describe("recovering from a crash mid-submission", () => {
  it("writes the payment down before sending it, so a restart can finish the job", async () => {
    const dir = mkdtempSync(join(tmpdir(), "settle-state-"));
    const statePath = join(dir, "state.json");
    const ledgerPath = join(dir, "receipts.jsonl");

    const first = createHarness({ store: new Store(statePath), ledger: new ReceiptLedger(ledgerPath) });
    const quote = await quoteFor(first);
    const signed = signQuote(quote, first.supporter);
    // The process dies after the payment is recorded, while the network call is in flight.
    first.chain.gate = new Promise(() => {});
    void pay(first, quote.quoteId, signed).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));

    // A new process starts from what was written to disk.
    const store = new Store(statePath);
    const restored = store.paymentsWithStatus("submitted");
    assert.equal(restored.length, 1, "the in-flight payment survived the crash");
    assert.equal(store.getQuote(quote.quoteId)?.state, "submitted");

    // The transaction did land on the network in the meantime.
    const second = createHarness({ store, ledger: new ReceiptLedger(ledgerPath), directory: testDirectory() });
    second.chain.apply(signed, Networks.TESTNET);
    const outcome = await second.service.reconcile();
    assert.deepEqual(outcome, { checked: 1, confirmed: 1, failed: 0 });
    assert.equal(new Store(statePath).paymentsWithStatus("confirmed").length, 1);
    assert.equal(new ReceiptLedger(ledgerPath).all().length, 1);
  });

  it("does not remember a request that was still in flight, but remembers finished ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "settle-state-"));
    const statePath = join(dir, "state.json");
    const h = createHarness({ store: new Store(statePath) });
    const done = freshKey("q");
    await quoteFor(h, {}, done);
    const reloaded = new Store(statePath);
    assert.equal(reloaded.getIdempotency("quote", done)?.state, "done");
  });
});

describe("a payment lookup", () => {
  it("404s for an unknown payment or receipt", async () => {
    const h = createHarness();
    await rejects(h.service.getPayment("p_unknown"), 404, "payment_not_found");
    await rejects(Promise.resolve().then(() => h.service.getReceipt("r_unknown")), 404, "receipt_not_found");
  });
});

describe("the service configuration it exposes", () => {
  it("says it is testnet-only and where its rates come from", () => {
    const h = createHarness();
    assert.deepEqual(h.service.config_(), {
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
      asset: { code: "USDC", issuer: h.config.assetIssuer },
      quoteTtlSeconds: 300,
      rateSource: "testnet-fixture",
      mode: "testnet-only",
    });
  });
});
