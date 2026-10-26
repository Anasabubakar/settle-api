import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GENESIS_HASH, ReceiptLedger, type ReceiptBody } from "../src/ledger.ts";

const body = (n: number): ReceiptBody => ({
  paymentId: `p_${n}`,
  quoteId: `q_${n}`,
  billId: "bill-1",
  providerId: "prov-1",
  network: "testnet",
  usdc: { amountStroops: String(n * 1000), code: "USDC", issuer: "GISSUER" },
  fiat: { amountMinor: String(n * 100), currency: "USD" },
  destination: "GDEST",
  source: "GSOURCE",
  txHash: `hash${n}`,
  stellarLedger: 1000 + n,
  confirmedAt: "2026-10-26T12:00:00.000Z",
});

describe("receipt ledger", () => {
  it("starts empty and verified", () => {
    const ledger = new ReceiptLedger();
    assert.deepEqual(ledger.head(), { count: 0, headHash: GENESIS_HASH });
    assert.deepEqual(ledger.verify(), { ok: true, count: 0, headHash: GENESIS_HASH });
  });

  it("chains each receipt to the one before", () => {
    const ledger = new ReceiptLedger();
    const first = ledger.append(body(1));
    const second = ledger.append(body(2));
    assert.equal(first.sequence, 1);
    assert.equal(first.prevHash, GENESIS_HASH);
    assert.equal(second.prevHash, first.hash);
    assert.equal(ledger.head().headHash, second.hash);
    assert.equal(ledger.verify().ok, true);
  });

  it("issues at most one receipt per payment", () => {
    const ledger = new ReceiptLedger();
    const first = ledger.append(body(1));
    const again = ledger.append({ ...body(1), usdc: { amountStroops: "1", code: "USDC", issuer: "GISSUER" } });
    assert.equal(again.id, first.id);
    assert.equal(ledger.all().length, 1);
    assert.equal(again.usdc.amountStroops, first.usdc.amountStroops, "the original receipt is returned, never rewritten");
  });

  it("detects any edited field", () => {
    const ledger = new ReceiptLedger();
    ledger.append(body(1));
    ledger.append(body(2));
    ledger.append(body(3));
    (ledger.all()[1] as { fiat: { amountMinor: string } }).fiat.amountMinor = "999999";
    const check = ledger.verify();
    assert.equal(check.ok, false);
    if (!check.ok) {
      assert.equal(check.brokenAt, 2);
      assert.match(check.reason, /do not match/);
    }
  });

  it("detects a removed or reordered receipt", () => {
    const removed = new ReceiptLedger();
    for (const n of [1, 2, 3]) removed.append(body(n));
    (removed.all() as unknown[]).splice(1, 1);
    assert.equal(removed.verify().ok, false);

    const reordered = new ReceiptLedger();
    for (const n of [1, 2, 3]) reordered.append(body(n));
    const list = reordered.all() as unknown[];
    [list[0], list[1]] = [list[1], list[0]];
    assert.equal(reordered.verify().ok, false);
  });

  it("looks receipts up by id and by payment", () => {
    const ledger = new ReceiptLedger();
    const receipt = ledger.append(body(7));
    assert.equal(ledger.get(receipt.id)?.paymentId, "p_7");
    assert.equal(ledger.forPayment("p_7")?.id, receipt.id);
    assert.equal(ledger.get("r_nope"), undefined);
  });

  it("persists as an append-only file and reloads identically", () => {
    const dir = mkdtempSync(join(tmpdir(), "settle-ledger-"));
    const path = join(dir, "receipts.jsonl");
    const ledger = new ReceiptLedger(path);
    ledger.append(body(1));
    ledger.append(body(2));
    const reloaded = new ReceiptLedger(path);
    assert.equal(reloaded.head().count, 2);
    assert.equal(reloaded.head().headHash, ledger.head().headHash);
    reloaded.append(body(3));
    assert.equal(new ReceiptLedger(path).head().count, 3);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 3);
  });

  it("refuses to load, and so to extend, a file that was tampered with", () => {
    const dir = mkdtempSync(join(tmpdir(), "settle-ledger-"));
    const path = join(dir, "receipts.jsonl");
    const ledger = new ReceiptLedger(path);
    ledger.append(body(1));
    ledger.append(body(2));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const edited = JSON.parse(lines[0]!);
    edited.fiat.amountMinor = "1";
    writeFileSync(path, `${JSON.stringify(edited)}\n${lines[1]}\n`);
    assert.throws(() => new ReceiptLedger(path), /failed verification/);
  });
});
