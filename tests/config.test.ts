import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { ConfigError, loadConfig } from "../src/config.ts";

const issuer = Keypair.random().publicKey();
const valid = { SETTLE_USDC_ISSUER: issuer };

describe("loadConfig", () => {
  it("loads a minimal valid testnet configuration", () => {
    const config = loadConfig(valid);
    assert.equal(config.network, "testnet");
    assert.equal(config.assetIssuer, issuer);
    assert.equal(config.assetCode, "USDC");
    assert.equal(config.quoteTtlSeconds, 300);
    assert.equal(config.horizonUrl, "https://horizon-testnet.stellar.org");
  });

  it("refuses to run on mainnet, in any spelling", () => {
    for (const network of ["mainnet", "MAINNET", "public", "pubnet"]) {
      assert.throws(() => loadConfig({ ...valid, SETTLE_NETWORK: network }), ConfigError, network);
    }
    assert.throws(() => loadConfig({ ...valid, SETTLE_NETWORK: "mainnet" }), /testnet-only/);
  });

  it("will not default the asset issuer", () => {
    assert.throws(() => loadConfig({}), /SETTLE_USDC_ISSUER is required/);
    assert.throws(() => loadConfig({ SETTLE_USDC_ISSUER: "   " }), /required/);
  });

  it("rejects an issuer that is not a Stellar public key", () => {
    for (const bad of ["not-a-key", "GABC", `S${issuer.slice(1)}`, issuer.toLowerCase()]) {
      assert.throws(() => loadConfig({ SETTLE_USDC_ISSUER: bad }), ConfigError, bad);
    }
  });

  it("requires https for the Horizon URL, except on loopback", () => {
    assert.throws(() => loadConfig({ ...valid, SETTLE_HORIZON_URL: "http://horizon.example.com" }), /https/);
    assert.throws(() => loadConfig({ ...valid, SETTLE_HORIZON_URL: "not a url" }), /valid URL/);
    assert.equal(loadConfig({ ...valid, SETTLE_HORIZON_URL: "http://localhost:8000" }).horizonUrl, "http://localhost:8000");
  });

  it("bounds numeric settings instead of trusting them", () => {
    assert.throws(() => loadConfig({ ...valid, SETTLE_QUOTE_TTL_SECONDS: "5" }), /between/);
    assert.throws(() => loadConfig({ ...valid, SETTLE_QUOTE_TTL_SECONDS: "999999" }), /between/);
    assert.throws(() => loadConfig({ ...valid, PORT: "abc" }), /whole number/);
    assert.throws(() => loadConfig({ ...valid, SETTLE_BASE_FEE_STROOPS: "1" }), /between/);
    assert.equal(loadConfig({ ...valid, SETTLE_QUOTE_TTL_SECONDS: "60" }).quoteTtlSeconds, 60);
  });

  it("keeps the maximum fee at or above the base fee", () => {
    const config = loadConfig({ ...valid, SETTLE_BASE_FEE_STROOPS: "20000" });
    assert.ok(config.maxFeeStroops >= config.baseFeeStroops);
  });

  it("labels its rates as fixtures, not market data", () => {
    assert.equal(loadConfig(valid).rateSource, "testnet-fixture");
  });
});
