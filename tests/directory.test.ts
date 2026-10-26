import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import { DirectoryError, createDirectory, loadDirectory } from "../src/directory.ts";

const dest = () => Keypair.random().publicKey();
const provider = (id: string, destination = dest()) => ({ id, displayName: id, category: "x", country: "NG", destination, verification: "fixture", fixture: true });
const bill = (overrides: Record<string, unknown> = {}) => ({ id: "b1", providerId: "p1", currency: "USD", totalMinor: 1000, fundedMinor: 0, acceptsPartialFunding: true, status: "open", ...overrides });
const build = (providers: unknown[], bills: unknown[]) => createDirectory({ providers: providers as never, bills: bills as never, supportedCurrencies: ["USD", "NGN"] });

describe("directory validation", () => {
  it("loads a consistent directory", () => {
    const directory = build([provider("p1")], [bill()]);
    assert.equal(directory.bill("b1")?.totalMinor, 1000n);
    assert.equal(directory.provider("p1")?.fixture, true);
    assert.equal(directory.bills().length, 1);
  });

  it("rejects a provider with an invalid destination", () => {
    assert.throws(() => build([provider("p1", "GNOTAKEY")], []), /invalid destination/);
    assert.throws(() => build([provider("p1", `S${dest().slice(1)}`)], []), DirectoryError);
  });

  it("rejects duplicates and a shared destination", () => {
    const shared = dest();
    assert.throws(() => build([provider("p1"), provider("p1")], []), /duplicate provider/);
    assert.throws(() => build([provider("p1", shared), provider("p2", shared)], []), /reuses a destination/);
    assert.throws(() => build([provider("p1")], [bill(), bill()]), /duplicate bill/);
  });

  it("rejects a bill that points nowhere or is inconsistent", () => {
    assert.throws(() => build([provider("p1")], [bill({ providerId: "ghost" })]), /unknown provider/);
    assert.throws(() => build([provider("p1")], [bill({ currency: "XYZ" })]), /unsupported currency/);
    assert.throws(() => build([provider("p1")], [bill({ totalMinor: 0 })]), /positive total/);
    assert.throws(() => build([provider("p1")], [bill({ fundedMinor: 2000 })]), /beyond its total/);
    assert.throws(() => build([provider("p1")], [bill({ totalMinor: 1.5 })]), /whole number/);
    assert.throws(() => build([provider("p1")], [bill({ totalMinor: -5 })]), /whole number/);
    assert.throws(() => build([provider("p1")], [bill({ status: "weird" })]), /unknown status/);
  });

  it("does not treat missing flags as permission", () => {
    const directory = build([provider("p1")], [bill({ acceptsPartialFunding: undefined })]);
    assert.equal(directory.bill("b1")?.acceptsPartialFunding, false);
  });
});

describe("the shipped testnet fixtures", () => {
  it("load, validate, and are clearly labelled as fixtures", () => {
    const directory = loadDirectory("./data", ["USD", "GBP", "CAD", "NGN", "KES"]);
    assert.ok(directory.providers().length >= 5);
    for (const entry of directory.providers()) {
      assert.equal(entry.fixture, true);
      assert.equal(entry.verification, "fixture");
    }
    assert.ok(directory.bill("bill-amina-electricity"));
    assert.equal(directory.bill("bill-leila-internet")?.status, "settled");
  });
});
