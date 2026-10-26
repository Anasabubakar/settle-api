import { Account, Asset, Keypair, Memo, Networks, Operation, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { AccountInfo, ChainClient, FetchedTransaction, SubmitOutcome } from "../src/chain.ts";
import { TESTNET_FIXTURE_RATES, type Config } from "../src/config.ts";
import { createDirectory, type Directory } from "../src/directory.ts";
import { ReceiptLedger } from "../src/ledger.ts";
import { stroopsToDecimal } from "../src/money.ts";
import { SettlementService } from "../src/service.ts";
import { Store, type QuoteRecord } from "../src/store.ts";

export const ISSUER = Keypair.random().publicKey();
export const OTHER_ISSUER = Keypair.random().publicKey();

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    network: "testnet",
    networkPassphrase: Networks.TESTNET,
    horizonUrl: "https://horizon-testnet.stellar.org",
    assetCode: "USDC",
    assetIssuer: ISSUER,
    port: 0,
    host: "127.0.0.1",
    quoteTtlSeconds: 300,
    baseFeeStroops: 100,
    maxFeeStroops: 10_000,
    minContributionMinor: 100n,
    dataDir: "./data",
    corsOrigins: ["http://localhost:8081"],
    rateLimitPerMinute: 1000,
    expiryGraceSeconds: 120,
    rates: TESTNET_FIXTURE_RATES,
    rateSource: "testnet-fixture",
    ...overrides,
  };
}

export const PROVIDER_KEY = Keypair.random();
export const WHOLE_PROVIDER_KEY = Keypair.random();

export function testDirectory(): Directory {
  return createDirectory({
    supportedCurrencies: Object.keys(TESTNET_FIXTURE_RATES),
    providers: [
      { id: "prov-a", displayName: "Provider A", category: "electricity", country: "NG", destination: PROVIDER_KEY.publicKey(), verification: "fixture", fixture: true },
      { id: "prov-b", displayName: "Provider B", category: "education", country: "KE", destination: WHOLE_PROVIDER_KEY.publicKey(), verification: "fixture", fixture: true },
    ],
    bills: [
      { id: "bill-partial", providerId: "prov-a", currency: "USD", totalMinor: 10_000, fundedMinor: 2_000, acceptsPartialFunding: true, status: "open" },
      { id: "bill-whole", providerId: "prov-b", currency: "KES", totalMinor: 50_000, fundedMinor: 0, acceptsPartialFunding: false, status: "open" },
      { id: "bill-settled", providerId: "prov-a", currency: "USD", totalMinor: 5_000, fundedMinor: 5_000, acceptsPartialFunding: true, status: "settled" },
      { id: "bill-paused", providerId: "prov-a", currency: "USD", totalMinor: 5_000, fundedMinor: 0, acceptsPartialFunding: true, status: "paused" },
    ],
  });
}

export const richAccount = (overrides: Partial<AccountInfo> = {}): AccountInfo => ({
  sequence: "1000",
  hasTrustline: true,
  assetBalanceStroops: 100_000_000_000n,
  nativeBalanceStroops: 1_000_000_000n,
  ...overrides,
});

/**
 * A controllable stand-in for Horizon. Submitting a transaction "applies" it: the
 * fake records what the ledger would contain, derived from the signed envelope,
 * so confirmation is checked against real transaction contents.
 */
export class FakeChain implements ChainClient {
  readonly accounts = new Map<string, AccountInfo>();
  readonly recorded = new Map<string, FetchedTransaction>();
  readonly submissions: string[] = [];
  /** Force the next `submitTransaction` result (or throw). */
  nextSubmit: SubmitOutcome | Error | undefined;
  /** When set, `fetchTransaction` answers `null` for every hash. */
  hideTransactions = false;
  /** When set, alters what the "ledger" recorded, to simulate a mismatch. */
  tamperRecorded: ((tx: FetchedTransaction) => FetchedTransaction) | undefined;
  loadError: Error | undefined;
  /** When set, `submitTransaction` waits for it, holding a request in flight. */
  gate: Promise<void> | undefined;
  ledgerCounter = 5_000;

  async loadAccount(publicKey: string): Promise<AccountInfo | null> {
    if (this.loadError) throw this.loadError;
    return this.accounts.get(publicKey) ?? null;
  }

  async submitTransaction(signedXdr: string, networkPassphrase: string): Promise<SubmitOutcome> {
    this.submissions.push(signedXdr);
    if (this.gate) await this.gate;
    const forced = this.nextSubmit;
    this.nextSubmit = undefined;
    if (forced instanceof Error) throw forced;
    if (forced) {
      if (forced.kind === "success") this.apply(signedXdr, networkPassphrase);
      return forced;
    }
    const recorded = this.apply(signedXdr, networkPassphrase);
    return { kind: "success", hash: recorded.hash, ledger: recorded.ledger };
  }

  /** Put a transaction on the fake ledger without the service having submitted it (a late landing). */
  apply(signedXdr: string, networkPassphrase: string): FetchedTransaction {
    const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase) as Transaction;
    const op = tx.operations[0] as Operation.Payment;
    const hash = Buffer.from(tx.hash()).toString("hex");
    const recorded: FetchedTransaction = {
      hash,
      successful: true,
      ledger: ++this.ledgerCounter,
      createdAt: new Date().toISOString(),
      source: tx.source,
      memo: tx.memo.type === "text" ? new TextDecoder().decode(tx.memo.value as Uint8Array) : null,
      operations: [
        {
          type: "payment",
          from: op.source ?? tx.source,
          to: op.destination,
          assetCode: op.asset.getCode(),
          assetIssuer: op.asset.getIssuer() as string,
          amount: op.amount,
        },
      ],
    };
    this.recorded.set(hash, recorded);
    return recorded;
  }

  async fetchTransaction(hash: string): Promise<FetchedTransaction | null> {
    if (this.hideTransactions) return null;
    const recorded = this.recorded.get(hash);
    if (!recorded) return null;
    return this.tamperRecorded ? this.tamperRecorded(recorded) : recorded;
  }
}

export class TestClock {
  ms = Date.parse("2026-10-26T12:00:00.000Z");
  readonly now = () => this.ms;
  advanceSeconds(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

export interface Harness {
  service: SettlementService;
  chain: FakeChain;
  clock: TestClock;
  store: Store;
  ledger: ReceiptLedger;
  config: Config;
  supporter: Keypair;
  logs: Record<string, unknown>[];
}

export function createHarness(options: { config?: Partial<Config>; directory?: Directory; store?: Store; ledger?: ReceiptLedger; fund?: boolean } = {}): Harness {
  const config = testConfig(options.config);
  const chain = new FakeChain();
  const clock = new TestClock();
  const store = options.store ?? new Store();
  const ledger = options.ledger ?? new ReceiptLedger();
  const supporter = Keypair.random();
  if (options.fund !== false) chain.accounts.set(supporter.publicKey(), richAccount());
  const logs: Record<string, unknown>[] = [];
  const service = new SettlementService({
    config,
    directory: options.directory ?? testDirectory(),
    store,
    ledger,
    chain,
    now: clock.now,
    log: (event) => logs.push(event),
  });
  return { service, chain, clock, store, ledger, config, supporter, logs };
}

let keyCounter = 0;
/** A fresh, valid idempotency key. */
export const freshKey = (prefix = "key"): string => `${prefix}-${++keyCounter}-${Math.random().toString(36).slice(2, 10)}`;

export interface QuoteBody {
  quoteId: string;
  unsignedXdr: string;
  [key: string]: unknown;
}

export async function quoteFor(h: Harness, overrides: Record<string, unknown> = {}, key = freshKey("q")): Promise<QuoteBody> {
  const result = await h.service.createQuote(
    { billId: "bill-partial", amountMinor: 1_000, currency: "USD", sourceAccount: h.supporter.publicKey(), ...overrides },
    key,
  );
  return result.body as QuoteBody;
}

/** Sign exactly what the quote returned, as a wallet would. */
export function signQuote(quote: { unsignedXdr: string }, signer: Keypair, networkPassphrase = Networks.TESTNET): string {
  const tx = TransactionBuilder.fromXDR(quote.unsignedXdr, networkPassphrase) as Transaction;
  tx.sign(signer);
  return tx.toXDR();
}

/** Build and sign a transaction that differs from the quote in the stated ways. */
export function forgeTransaction(
  record: QuoteRecord,
  signer: Keypair,
  overrides: {
    destination?: string;
    amountStroops?: bigint;
    issuer?: string;
    code?: string;
    memo?: string | null;
    extraOperation?: boolean;
    fee?: string;
    sequence?: string;
    source?: string;
    maxTime?: number;
    networkPassphrase?: string;
  } = {},
): string {
  const source = overrides.source ?? record.source;
  const sequence = BigInt(overrides.sequence ?? record.sequence) - 1n;
  const builder = new TransactionBuilder(new Account(source, sequence.toString()), {
    fee: overrides.fee ?? record.fees.networkFeeStroops,
    networkPassphrase: overrides.networkPassphrase ?? Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: overrides.maxTime ?? Math.floor(Date.parse(record.expiresAt) / 1000) },
  });
  const asset = new Asset(overrides.code ?? record.assetCode, overrides.issuer ?? record.assetIssuer);
  builder.addOperation(
    Operation.payment({
      destination: overrides.destination ?? record.destination,
      asset,
      amount: stroopsToDecimal(overrides.amountStroops ?? BigInt(record.usdcAmountStroops)),
    }),
  );
  if (overrides.extraOperation) {
    builder.addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset, amount: "0.0000001" }));
  }
  if (overrides.memo !== null) builder.addMemo(Memo.text(overrides.memo ?? record.memo));
  const tx = builder.build();
  tx.sign(signer);
  return tx.toXDR();
}
