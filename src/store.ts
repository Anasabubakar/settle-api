import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type QuoteState = "open" | "submitted" | "confirmed" | "failed";

export interface QuoteRecord {
  id: string;
  memo: string;
  billId: string;
  providerId: string;
  destination: string;
  assetCode: string;
  assetIssuer: string;
  usdcAmountStroops: string;
  fiatAmountMinor: string;
  fiatCurrency: string;
  rate: { usdMicroPerMajor: string; minorPerMajor: string; source: string };
  fees: { networkFeeStroops: string; platformFeeBps: number };
  /** The supporter's account: the only party who can sign this payment. */
  source: string;
  sequence: string;
  networkPassphrase: string;
  unsignedXdr: string;
  /** Hash of the unsigned transaction body. A valid signature must be over exactly this. */
  unsignedHash: string;
  createdAt: string;
  expiresAt: string;
  state: QuoteState;
  paymentId?: string;
}

export type PaymentStatus = "submitted" | "confirmed" | "failed";

export interface PaymentRecord {
  id: string;
  quoteId: string;
  billId: string;
  status: PaymentStatus;
  txHash: string;
  submittedAt: string;
  confirmedAt?: string;
  stellarLedger?: number;
  receiptId?: string;
  /** Set when Horizon answered ambiguously and the observer has to find the truth. */
  outcomeUnknown?: boolean;
  failureCode?: string;
  failureMessage?: string;
}

export interface IdempotencyRecord {
  scope: "quote" | "payment";
  key: string;
  fingerprint: string;
  state: "in_progress" | "done";
  status?: number;
  body?: unknown;
  createdAt: string;
}

interface Snapshot {
  version: 1;
  quotes: QuoteRecord[];
  payments: PaymentRecord[];
  idempotency: IdempotencyRecord[];
}

const IDEMPOTENCY_RETENTION_MS = 48 * 60 * 60 * 1000;

/**
 * Service state. Held in memory and, when given a path, snapshotted to disk
 * atomically (write a temp file, rename it over the old one) so a crash never
 * leaves a half-written file. Callers `save()` after each state change, and they
 * save a payment as `submitted` *before* handing it to the network, so a crash
 * mid-submission is recovered by the observer rather than lost.
 *
 * It is a pilot-grade store. A production deployment needs a database with
 * transactions, backups and access control; the interface is small on purpose.
 */
export class Store {
  private readonly quotes = new Map<string, QuoteRecord>();
  private readonly payments = new Map<string, PaymentRecord>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly path: string | undefined;

  constructor(path?: string) {
    this.path = path;
    if (path && existsSync(path)) {
      const snapshot = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
      if (snapshot.version !== 1) throw new Error(`unsupported state version ${String(snapshot.version)}`);
      for (const quote of snapshot.quotes) this.quotes.set(quote.id, quote);
      for (const payment of snapshot.payments) this.payments.set(payment.id, payment);
      for (const record of snapshot.idempotency) {
        // An in-flight request did not survive the restart; its client must retry.
        if (record.state === "done") this.idempotency.set(this.idemKey(record.scope, record.key), record);
      }
    }
  }

  private idemKey(scope: string, key: string): string {
    return `${scope}:${key}`;
  }

  save(now = Date.now()): void {
    if (!this.path) return;
    for (const [key, record] of this.idempotency) {
      if (now - Date.parse(record.createdAt) > IDEMPOTENCY_RETENTION_MS) this.idempotency.delete(key);
    }
    const snapshot: Snapshot = {
      version: 1,
      quotes: [...this.quotes.values()],
      payments: [...this.payments.values()],
      idempotency: [...this.idempotency.values()].filter((record) => record.state === "done"),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
    renameSync(temp, this.path);
  }

  putQuote(quote: QuoteRecord): void {
    this.quotes.set(quote.id, quote);
  }

  getQuote(id: string): QuoteRecord | undefined {
    return this.quotes.get(id);
  }

  putPayment(payment: PaymentRecord): void {
    this.payments.set(payment.id, payment);
  }

  getPayment(id: string): PaymentRecord | undefined {
    return this.payments.get(id);
  }

  paymentsWithStatus(status: PaymentStatus): PaymentRecord[] {
    return [...this.payments.values()].filter((payment) => payment.status === status);
  }

  getIdempotency(scope: IdempotencyRecord["scope"], key: string): IdempotencyRecord | undefined {
    return this.idempotency.get(this.idemKey(scope, key));
  }

  putIdempotency(record: IdempotencyRecord): void {
    this.idempotency.set(this.idemKey(record.scope, record.key), record);
  }

  deleteIdempotency(scope: IdempotencyRecord["scope"], key: string): void {
    this.idempotency.delete(this.idemKey(scope, key));
  }

  /** Fiat funded by payments that are confirmed on the Stellar network. */
  confirmedMinor(billId: string): bigint {
    let total = 0n;
    for (const quote of this.quotes.values()) {
      if (quote.billId === billId && quote.state === "confirmed") total += BigInt(quote.fiatAmountMinor);
    }
    return total;
  }

  /**
   * Fiat that is spoken for but not yet confirmed: unexpired open quotes and
   * submitted payments. Counting these stops two supporters from both being
   * quoted the last of a bill.
   */
  reservedMinor(billId: string, nowMs: number): bigint {
    let total = 0n;
    for (const quote of this.quotes.values()) {
      if (quote.billId !== billId) continue;
      const live = quote.state === "open" && Date.parse(quote.expiresAt) > nowMs;
      if (live || quote.state === "submitted") total += BigInt(quote.fiatAmountMinor);
    }
    return total;
  }
}
