import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EvidenceVault, tokenMatches } from "../src/evidence.ts";

describe("private evidence workflow", () => {
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("synthetic fixture")]);

  it("encrypts originals, gates summaries on review, logs access, and purges retained originals", () => {
    let now = Date.UTC(2026, 9, 26);
    const root = mkdtempSync(join(tmpdir(), "settle-evidence-"));
    const vault = new EvidenceVault(root, Buffer.alloc(32, 7), () => now);
    const record = vault.upload("bill_test", "image/png", png, "requester_1");
    assert.equal(vault.publicSummary(record.id).state, "pending");
    assert.equal(readFileSync(join(root, `${record.id}.blob`)).includes(png), false);
    assert.deepEqual(vault.openForReview(record.id, "reviewer_1"), png);
    vault.review(record.id, "reviewer_1", "approved", { provider: "Sample Power", amountMinor: 2400, currency: "USD", referenceLast4: "1234" });
    assert.deepEqual(vault.publicSummary(record.id).verified, { provider: "Sample Power", amountMinor: 2400, currency: "USD", referenceLast4: "1234" });
    assert.throws(() => vault.review(record.id, "reviewer_2", "rejected"));
    now += 31 * 86_400_000;
    assert.equal(vault.purgeOriginalsOlderThan(30), 1);
    assert.match(readFileSync(join(root, "audit.jsonl"), "utf8"), /original_purged/);
  });

  it("rejects mismatched file signatures and weak role tokens", () => {
    const vault = new EvidenceVault(mkdtempSync(join(tmpdir(), "settle-evidence-")), Buffer.alloc(32, 8));
    assert.throws(() => vault.upload("bill_test", "application/pdf", png, "requester_1"));
    assert.equal(tokenMatches("wrong", "expected"), false);
    assert.equal(tokenMatches("expected", "expected"), true);
  });

  it("refuses private fields in a supporter-facing summary", () => {
    const vault = new EvidenceVault(mkdtempSync(join(tmpdir(), "settle-evidence-")), Buffer.alloc(32, 9));
    const record = vault.upload("bill_test", "image/png", png, "requester_1");
    assert.throws(() => vault.review(record.id, "reviewer_1", "approved", {
      provider: "Sample Power", amountMinor: 2400, currency: "USD", fullAccountNumber: "123456789",
    } as never));
    assert.equal(vault.publicSummary(record.id).state, "pending");
  });
});
