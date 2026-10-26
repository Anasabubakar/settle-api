import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Networks, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { createApp } from "../src/http.ts";
import { createHarness, freshKey, signQuote, type Harness } from "./helpers.ts";

let server: Server;
let base: string;
let h: Harness;

async function start(overrides: Parameters<typeof createHarness>[0] = {}) {
  h = createHarness(overrides);
  server = createServer(createApp({ config: h.config, service: h.service, now: h.clock.now, log: (event) => h.logs.push(event) }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const stop = () => new Promise<void>((resolve) => server.close(() => resolve()));

async function call(path: string, init: RequestInit & { json?: unknown; key?: string | null } = {}) {
  const { json, key, ...rest } = init;
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  const request: RequestInit = { ...rest, headers };
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    request.body = JSON.stringify(json);
  }
  if (key !== null && init.method === "POST") headers["idempotency-key"] = key ?? freshKey("http");
  const response = await fetch(base + path, request);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined, text };
}

describe("the HTTP surface", () => {
  before(() => start());
  after(stop);

  it("reports health and the configuration", async () => {
    const health = await call("/healthz");
    assert.equal(health.status, 200);
    assert.equal(health.body.status, "ok");
    assert.equal(health.body.ledger.verified, true);
    const config = await call("/v1/config");
    assert.equal(config.body.mode, "testnet-only");
    assert.equal(config.body.asset.code, "USDC");
  });

  it("lists and reads bills", async () => {
    const bills = await call("/v1/bills");
    assert.equal(bills.body.bills.length, 4);
    const one = await call("/v1/bills/bill-partial");
    assert.equal(one.body.remainingMinor, "8000");
    assert.equal((await call("/v1/bills/nope")).status, 404);
  });

  it("sets safe headers and a request id on every response", async () => {
    const { headers } = await call("/healthz");
    assert.equal(headers.get("cache-control"), "no-store");
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    assert.equal(headers.get("referrer-policy"), "no-referrer");
    assert.match(headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
  });

  it("answers 404 for an unknown path and 405, with Allow, for a wrong method", async () => {
    const missing = await call("/v1/nothing");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, "not_found");
    const wrong = await call("/v1/quotes", { method: "GET" });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("allow"), "POST");
    assert.equal((await call("/healthz", { method: "DELETE" })).status, 405);
  });

  it("uses one error shape that carries the request id", async () => {
    const { body, headers } = await call("/v1/quotes/q_missing");
    assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "requestId"]);
    assert.equal(body.error.requestId, headers.get("x-request-id"));
  });

  it("requires an Idempotency-Key on writes", async () => {
    const response = await call("/v1/quotes", { method: "POST", json: {}, key: null });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "idempotency_key_required");
  });

  it("requires a JSON body", async () => {
    const wrongType = await call("/v1/quotes", { method: "POST", body: "x=1", headers: { "content-type": "text/plain" } });
    assert.equal(wrongType.status, 415);
    const badJson = await call("/v1/quotes", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, "invalid_json");
  });

  it("refuses an oversized body", async () => {
    const response = await call("/v1/quotes", { method: "POST", json: { filler: "x".repeat(70_000) } });
    assert.equal(response.status, 413);
    assert.equal(response.body.error.code, "payload_too_large");
  });

  it("refuses a malformed path escape", async () => {
    const response = await call("/v1/bills/%E0%A4%A");
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid_path");
  });

  it("does not leak internals when something unexpected breaks", async () => {
    const original = h.store.getQuote.bind(h.store);
    h.store.getQuote = () => {
      throw new Error("secret internal detail: /var/lib/settle/state.json");
    };
    try {
      const response = await call("/v1/quotes/q_anything");
      assert.equal(response.status, 500);
      assert.equal(response.body.error.code, "internal_error");
      assert.doesNotMatch(response.text, /secret internal detail|state\.json|at .*\.ts/);
    } finally {
      h.store.getQuote = original;
    }
  });
});

describe("a complete payment over HTTP", () => {
  before(() => start());
  after(stop);

  it("goes quote → sign → pay → status → receipt → ledger", async () => {
    const request = { billId: "bill-partial", amountMinor: 2_500, currency: "USD", sourceAccount: h.supporter.publicKey() };
    const key = freshKey("quote");
    const quote = await call("/v1/quotes", { method: "POST", json: request, key });
    assert.equal(quote.status, 201);
    assert.equal(quote.headers.get("idempotent-replay"), null);

    const replay = await call("/v1/quotes", { method: "POST", json: request, key });
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("idempotent-replay"), "true");
    assert.equal(replay.body.quoteId, quote.body.quoteId);

    const tx = TransactionBuilder.fromXDR(quote.body.unsignedXdr, Networks.TESTNET) as Transaction;
    assert.equal(tx.signatures.length, 0);

    const signedXdr = signQuote(quote.body, h.supporter);
    const payment = await call("/v1/payments", { method: "POST", json: { quoteId: quote.body.quoteId, signedXdr } });
    assert.equal(payment.status, 200);
    assert.equal(payment.body.status, "confirmed");

    const status = await call(`/v1/payments/${payment.body.paymentId}`);
    assert.equal(status.body.status, "confirmed");
    const receipt = await call(`/v1/receipts/${payment.body.receipt.id}`);
    assert.equal(receipt.body.txHash, payment.body.txHash);
    const ledger = await call("/v1/ledger");
    assert.equal(ledger.body.count, 1);
    assert.equal(ledger.body.verified, true);
    assert.equal((await call("/v1/bills/bill-partial")).body.fundedMinor, "4500");
  });

  it("refuses a client-chosen destination with a 400 and a named field", async () => {
    const response = await call("/v1/quotes", {
      method: "POST",
      json: { billId: "bill-partial", amountMinor: 1000, currency: "USD", sourceAccount: h.supporter.publicKey(), destination: h.supporter.publicKey() },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "client_authority_forbidden");
    assert.deepEqual(response.body.error.details.fields, ["destination"]);
  });

  it("maps a missing quote to 404 and an expired one to 410", async () => {
    const missing = await call("/v1/payments", { method: "POST", json: { quoteId: "q_none", signedXdr: "AAAA" } });
    assert.equal(missing.status, 404);
    const quote = await call("/v1/quotes", { method: "POST", json: { billId: "bill-partial", amountMinor: 500, currency: "USD", sourceAccount: h.supporter.publicKey() } });
    const signedXdr = signQuote(quote.body, h.supporter);
    h.clock.advanceSeconds(301);
    const expired = await call("/v1/payments", { method: "POST", json: { quoteId: quote.body.quoteId, signedXdr } });
    assert.equal(expired.status, 410);
    assert.equal(expired.body.error.code, "quote_expired");
  });

  it("answers 202 while the network has not yet shown the transaction", async () => {
    h.chain.hideTransactions = true;
    const quote = await call("/v1/quotes", { method: "POST", json: { billId: "bill-partial", amountMinor: 500, currency: "USD", sourceAccount: h.supporter.publicKey() } });
    const payment = await call("/v1/payments", { method: "POST", json: { quoteId: quote.body.quoteId, signedXdr: signQuote(quote.body, h.supporter) } });
    assert.equal(payment.status, 202);
    assert.equal(payment.body.status, "submitted");
    h.chain.hideTransactions = false;
  });
});

describe("browser access", () => {
  before(() => start());
  after(stop);

  it("allows only configured origins", async () => {
    const allowed = await call("/healthz", { headers: { origin: "http://localhost:8081" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:8081");
    assert.equal(allowed.headers.get("vary"), "Origin");
    const denied = await call("/healthz", { headers: { origin: "https://evil.example" } });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
  });

  it("answers a preflight without touching the service", async () => {
    const response = await fetch(`${base}/v1/quotes`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:8081", "access-control-request-method": "POST" },
    });
    assert.equal(response.status, 204);
    assert.match(response.headers.get("access-control-allow-headers") ?? "", /idempotency-key/);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:8081");
  });
});

describe("rate limiting", () => {
  before(() => start({ config: { rateLimitPerMinute: 3 } }));
  after(stop);

  it("answers 429 with Retry-After once a client exceeds its allowance, and recovers", async () => {
    for (let i = 0; i < 3; i += 1) assert.equal((await call("/healthz")).status, 200);
    const limited = await call("/healthz");
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, "rate_limited");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    h.clock.advanceSeconds(61);
    assert.equal((await call("/healthz")).status, 200);
  });
});
