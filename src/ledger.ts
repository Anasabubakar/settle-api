import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { newId } from "./ids.ts";

/**
 * The receipt ledger: append-only and hash-chained.
 *
 * Each receipt commits to the one before it, so changing, removing or reordering
 * any past receipt breaks every hash after it. There is deliberately no update or
 * delete operation. It proves the *sequence of receipts this service issued*; the
 * authority on whether a payment happened remains the Stellar ledger, whose
 * transaction hash every receipt carries.
 */

export const GENESIS_HASH = "0".repeat(64);

export interface ReceiptBody {
  paymentId: string;
  quoteId: string;
  billId: string;
  providerId: string;
  network: "testnet";
  usdc: { amountStroops: string; code: string; issuer: string };
  fiat: { amountMinor: string; currency: string };
  destination: string;
  source: string;
  txHash: string;
  stellarLedger: number;
  confirmedAt: string;
}

export interface Receipt extends ReceiptBody {
  id: string;
  sequence: number;
  prevHash: string;
  hash: string;
}

export type LedgerVerification = { ok: true; count: number; headHash: string } | { ok: false; count: number; brokenAt: number; reason: string };

function hashReceipt(receipt: Omit<Receipt, "hash">): string {
  return sha256Hex(canonicalJson(receipt));
}

export class ReceiptLedger {
  private readonly receipts: Receipt[] = [];
  private readonly byId = new Map<string, Receipt>();
  private readonly byPayment = new Map<string, Receipt>();
  private readonly path: string | undefined;

  constructor(path?: string) {
    this.path = path;
    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path)) {
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (line.trim() === "") continue;
          const receipt = JSON.parse(line) as Receipt;
          this.index(receipt);
        }
        const check = this.verify();
        if (!check.ok) {
          // Fail closed: a ledger that does not verify must never be extended.
          throw new Error(`receipt ledger failed verification at #${check.brokenAt}: ${check.reason}`);
        }
      }
    }
  }

  private index(receipt: Receipt): void {
    this.receipts.push(receipt);
    this.byId.set(receipt.id, receipt);
    this.byPayment.set(receipt.paymentId, receipt);
  }

  /** Append a receipt for a confirmed payment. A payment can have at most one. */
  append(body: ReceiptBody): Receipt {
    const existing = this.byPayment.get(body.paymentId);
    if (existing) return existing;
    const prev = this.receipts.at(-1);
    const unsealed: Omit<Receipt, "hash"> = {
      ...body,
      id: newId("r"),
      sequence: this.receipts.length + 1,
      prevHash: prev?.hash ?? GENESIS_HASH,
    };
    const receipt: Receipt = { ...unsealed, hash: hashReceipt(unsealed) };
    if (this.path) appendFileSync(this.path, `${JSON.stringify(receipt)}\n`, { flag: "a" });
    this.index(receipt);
    return receipt;
  }

  get(id: string): Receipt | undefined {
    return this.byId.get(id);
  }

  forPayment(paymentId: string): Receipt | undefined {
    return this.byPayment.get(paymentId);
  }

  head(): { count: number; headHash: string } {
    return { count: this.receipts.length, headHash: this.receipts.at(-1)?.hash ?? GENESIS_HASH };
  }

  all(): readonly Receipt[] {
    return this.receipts;
  }

  /** Recompute every hash and link. Reports the first receipt that does not hold. */
  verify(): LedgerVerification {
    let prevHash = GENESIS_HASH;
    for (const [index, receipt] of this.receipts.entries()) {
      if (receipt.sequence !== index + 1) {
        return { ok: false, count: this.receipts.length, brokenAt: receipt.sequence, reason: "sequence is not contiguous" };
      }
      if (receipt.prevHash !== prevHash) {
        return { ok: false, count: this.receipts.length, brokenAt: receipt.sequence, reason: "does not link to the previous receipt" };
      }
      const { hash, ...rest } = receipt;
      if (hashReceipt(rest) !== hash) {
        return { ok: false, count: this.receipts.length, brokenAt: receipt.sequence, reason: "contents do not match the recorded hash" };
      }
      prevHash = hash;
    }
    return { ok: true, count: this.receipts.length, headHash: prevHash };
  }
}
