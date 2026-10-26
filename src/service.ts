import { Account, Operation, StrKey, Memo, TransactionBuilder } from "@stellar/stellar-sdk";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { toAsset, type ChainClient, type SubmitOutcome } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Directory } from "./directory.ts";
import { ApiError, badRequest, conflict, notFound, unprocessable } from "./errors.ts";
import { memoFor, newId } from "./ids.ts";
import type { ReceiptLedger } from "./ledger.ts";
import { fiatMinorToUsdcStroops, parseMinorUnits, stroopsToDecimal } from "./money.ts";
import { verifyConfirmedTransaction, verifySignedPayment } from "./payload.ts";
import type { PaymentRecord, QuoteRecord, Store } from "./store.ts";

export interface ServiceDeps {
  config: Config;
  directory: Directory;
  store: Store;
  ledger: ReceiptLedger;
  chain: ChainClient;
  /** Milliseconds since the epoch. Injected so tests control time. */
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
}

export interface HandlerResult {
  status: number;
  body: unknown;
  replay?: boolean;
}

/** Fields a client must never supply: each one is something only the server may decide. */
const SERVER_AUTHORITY_FIELDS = [
  "destination",
  "assetIssuer",
  "assetCode",
  "issuer",
  "providerId",
  "usdcAmountStroops",
  "memo",
  "rate",
  "fee",
  "network",
  "networkPassphrase",
] as const;

const explorerUrl = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(hash)}`;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export class SettlementService {
  private readonly config: Config;
  private readonly directory: Directory;
  private readonly store: Store;
  private readonly ledger: ReceiptLedger;
  private readonly chain: ChainClient;
  private readonly now: () => number;
  private readonly log: (event: Record<string, unknown>) => void;

  constructor(deps: ServiceDeps) {
    this.config = deps.config;
    this.directory = deps.directory;
    this.store = deps.store;
    this.ledger = deps.ledger;
    this.chain = deps.chain;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  // ── Idempotency ─────────────────────────────────────────────────────────

  /**
   * Run `work` at most once per (scope, key). A retry with the same key and the
   * same request returns the original response; the same key with a different
   * request is refused, because it means the client has confused two actions.
   * Responses that depend on transient upstream state (5xx) are not remembered.
   */
  private async idempotent(
    scope: "quote" | "payment",
    key: string,
    request: unknown,
    work: () => Promise<HandlerResult>,
  ): Promise<HandlerResult> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw badRequest("invalid_idempotency_key", "Idempotency-Key must be 8-128 characters of letters, digits, '.', '_', ':' or '-'.");
    }
    const fingerprint = sha256Hex(canonicalJson({ scope, request }));
    const existing = this.store.getIdempotency(scope, key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw unprocessable("idempotency_key_reuse", "This Idempotency-Key was already used for a different request.");
      }
      if (existing.state === "in_progress") {
        throw conflict("request_in_progress", "The original request is still being processed. Retry shortly with the same key.");
      }
      return { status: existing.status ?? 200, body: existing.body, replay: true };
    }

    const createdAt = new Date(this.now()).toISOString();
    this.store.putIdempotency({ scope, key, fingerprint, state: "in_progress", createdAt });
    try {
      const result = await work();
      this.store.putIdempotency({ scope, key, fingerprint, state: "done", status: result.status, body: result.body, createdAt });
      this.store.save(this.now());
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        const body = { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } };
        this.store.putIdempotency({ scope, key, fingerprint, state: "done", status: error.status, body, createdAt });
        this.store.save(this.now());
      } else {
        this.store.deleteIdempotency(scope, key);
      }
      throw error;
    }
  }

  // ── Quotes ──────────────────────────────────────────────────────────────

  createQuote(input: unknown, idempotencyKey: string): Promise<HandlerResult> {
    return this.idempotent("quote", idempotencyKey, input, async () => ({ status: 201, body: await this.buildQuote(input) }));
  }

  private async buildQuote(input: unknown): Promise<Record<string, unknown>> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw badRequest("invalid_body", "The request body must be a JSON object.");
    }
    const body = input as Record<string, unknown>;

    const forbidden = SERVER_AUTHORITY_FIELDS.filter((field) => field in body);
    if (forbidden.length > 0) {
      throw badRequest(
        "client_authority_forbidden",
        `The client may not set ${forbidden.join(", ")}. The server resolves the provider, destination, asset, rate and memo itself.`,
        { fields: forbidden },
      );
    }
    const unknownFields = Object.keys(body).filter((field) => !["billId", "amountMinor", "currency", "sourceAccount"].includes(field));
    if (unknownFields.length > 0) throw badRequest("unknown_fields", `Unknown fields: ${unknownFields.join(", ")}.`, { fields: unknownFields });

    const { billId, currency, sourceAccount } = body;
    if (typeof billId !== "string" || billId === "") throw badRequest("invalid_bill_id", "billId is required.");
    if (typeof currency !== "string") throw badRequest("invalid_currency", "currency is required.");
    if (typeof sourceAccount !== "string" || !StrKey.isValidEd25519PublicKey(sourceAccount)) {
      throw badRequest("invalid_source_account", "sourceAccount must be the supporter's Stellar public key (G…).");
    }
    const amountMinor = parseMinorUnits(body.amountMinor);
    if (amountMinor === null) throw badRequest("invalid_amount", "amountMinor must be a positive whole number of minor units.");

    const bill = this.directory.bill(billId);
    if (!bill) throw notFound("bill_not_found", "No such bill.");
    if (bill.status !== "open") throw conflict("bill_not_open", `This bill is ${bill.status.replace("_", " ")} and cannot take contributions.`);
    if (currency !== bill.currency) {
      throw unprocessable("currency_mismatch", `This bill is denominated in ${bill.currency}.`, { expected: bill.currency });
    }
    if (amountMinor < this.config.minContributionMinor) {
      throw unprocessable("amount_too_small", "The amount is below the minimum contribution.", { minimumMinor: this.config.minContributionMinor.toString() });
    }

    const nowMs = this.now();
    const funded = bill.initialFundedMinor + this.store.confirmedMinor(bill.id);
    const reserved = this.store.reservedMinor(bill.id, nowMs);
    const remaining = bill.totalMinor - funded - reserved;
    if (amountMinor > remaining) {
      throw conflict("exceeds_remaining", "The amount is more than this bill still needs.", { remainingMinor: (remaining < 0n ? 0n : remaining).toString() });
    }
    if (!bill.acceptsPartialFunding && amountMinor !== bill.totalMinor - bill.initialFundedMinor) {
      throw unprocessable("partial_funding_not_allowed", "This bill must be settled in full.");
    }

    const provider = this.directory.provider(bill.providerId);
    if (!provider) throw new ApiError(500, "provider_missing", "The provider for this bill is unavailable.");
    const rate = this.config.rates[bill.currency];
    if (!rate) throw new ApiError(500, "rate_unavailable", "No rate is available for this currency.");

    const usdcStroops = fiatMinorToUsdcStroops(amountMinor, rate);

    let account: Awaited<ReturnType<ChainClient["loadAccount"]>>;
    try {
      account = await this.chain.loadAccount(sourceAccount, { code: this.config.assetCode, issuer: this.config.assetIssuer });
    } catch {
      throw new ApiError(502, "upstream_unavailable", "The Stellar network could not be reached. Try again shortly.");
    }
    if (!account) throw conflict("source_account_not_found", "The supporter account does not exist on the Stellar testnet yet. Fund it first.");
    if (!account.hasTrustline) throw conflict("trustline_missing", `The supporter account has no ${this.config.assetCode} trustline for this issuer.`);
    if (account.assetBalanceStroops < usdcStroops) {
      throw conflict("insufficient_balance", `The supporter account does not hold enough ${this.config.assetCode}.`, {
        requiredStroops: usdcStroops.toString(),
        availableStroops: account.assetBalanceStroops.toString(),
      });
    }
    if (account.nativeBalanceStroops < BigInt(this.config.baseFeeStroops)) {
      throw conflict("insufficient_native_balance", "The supporter account has too little XLM to pay the network fee.");
    }

    const quoteId = newId("q");
    const memo = memoFor();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAtMs = nowMs + this.config.quoteTtlSeconds * 1000;
    const expiresAt = new Date(expiresAtMs).toISOString();

    const transaction = new TransactionBuilder(new Account(sourceAccount, account.sequence), {
      fee: String(this.config.baseFeeStroops),
      networkPassphrase: this.config.networkPassphrase,
      timebounds: { minTime: 0, maxTime: Math.floor(expiresAtMs / 1000) },
    })
      .addOperation(
        Operation.payment({
          destination: provider.destination,
          asset: toAsset(this.config.assetCode, this.config.assetIssuer),
          amount: stroopsToDecimal(usdcStroops),
        }),
      )
      .addMemo(Memo.text(memo))
      .build();

    const quote: QuoteRecord = {
      id: quoteId,
      memo,
      billId: bill.id,
      providerId: provider.id,
      destination: provider.destination,
      assetCode: this.config.assetCode,
      assetIssuer: this.config.assetIssuer,
      usdcAmountStroops: usdcStroops.toString(),
      fiatAmountMinor: amountMinor.toString(),
      fiatCurrency: bill.currency,
      rate: { usdMicroPerMajor: rate.usdMicroPerMajor.toString(), minorPerMajor: rate.minorPerMajor.toString(), source: this.config.rateSource },
      fees: { networkFeeStroops: String(this.config.baseFeeStroops), platformFeeBps: 0 },
      source: sourceAccount,
      sequence: transaction.sequence,
      networkPassphrase: this.config.networkPassphrase,
      unsignedXdr: transaction.toXDR(),
      unsignedHash: hex(transaction.hash()),
      createdAt,
      expiresAt,
      state: "open",
    };
    this.store.putQuote(quote);
    this.store.save(nowMs);
    this.log({ event: "quote_created", quoteId, billId: bill.id });
    return this.quoteView(quote);
  }

  private quoteView(quote: QuoteRecord): Record<string, unknown> {
    const nowMs = this.now();
    const state = quote.state === "open" && Date.parse(quote.expiresAt) <= nowMs ? "expired" : quote.state;
    const provider = this.directory.provider(quote.providerId);
    return {
      // The fields the Settle client's `SettlementQuote` type consumes, verbatim.
      quoteId: quote.id,
      usdcAmountStroops: quote.usdcAmountStroops,
      assetIssuer: quote.assetIssuer,
      destination: quote.destination,
      memo: quote.memo,
      expiresAt: quote.expiresAt,
      // Everything a supporter needs to understand what they are signing.
      state,
      network: "testnet",
      networkPassphrase: quote.networkPassphrase,
      billId: quote.billId,
      provider: { id: quote.providerId, displayName: provider?.displayName ?? "Provider", fixture: provider?.fixture ?? true },
      fiat: { amountMinor: quote.fiatAmountMinor, currency: quote.fiatCurrency },
      usdc: { amountStroops: quote.usdcAmountStroops, amount: stroopsToDecimal(BigInt(quote.usdcAmountStroops)), assetCode: quote.assetCode, assetIssuer: quote.assetIssuer },
      rate: { usdMicroPerMajor: quote.rate.usdMicroPerMajor, source: quote.rate.source, lockedUntil: quote.expiresAt },
      fees: {
        network: { asset: "XLM", stroops: quote.fees.networkFeeStroops, paidBy: "supporter" },
        platform: { bps: quote.fees.platformFeeBps },
      },
      source: quote.source,
      unsignedXdr: quote.unsignedXdr,
    };
  }

  getQuote(id: string): Record<string, unknown> {
    const quote = this.store.getQuote(id);
    if (!quote) throw notFound("quote_not_found", "No such quote.");
    return this.quoteView(quote);
  }

  // ── Payments ────────────────────────────────────────────────────────────

  submitPayment(input: unknown, idempotencyKey: string): Promise<HandlerResult> {
    return this.idempotent("payment", idempotencyKey, input, () => this.doSubmitPayment(input));
  }

  private async doSubmitPayment(input: unknown): Promise<HandlerResult> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw badRequest("invalid_body", "The request body must be a JSON object.");
    }
    const { quoteId, signedXdr, ...rest } = input as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw badRequest("unknown_fields", `Unknown fields: ${Object.keys(rest).join(", ")}.`);
    if (typeof quoteId !== "string" || quoteId === "") throw badRequest("invalid_quote_id", "quoteId is required.");
    if (typeof signedXdr !== "string" || signedXdr === "" || signedXdr.length > 16_384) {
      throw badRequest("invalid_xdr", "signedXdr is required.");
    }

    const quote = this.store.getQuote(quoteId);
    if (!quote) throw notFound("quote_not_found", "No such quote.");
    if (quote.state === "submitted" || quote.state === "confirmed") {
      throw conflict("quote_already_used", "This quote was already submitted. Quotes are single-use.", { paymentId: quote.paymentId });
    }
    if (quote.state === "failed") throw conflict("quote_failed", "A payment for this quote failed. Request a new quote.");
    const nowMs = this.now();
    if (Date.parse(quote.expiresAt) <= nowMs) throw new ApiError(410, "quote_expired", "This quote has expired. Request a new quote before signing.");

    // Refuse anything that is not exactly what was quoted, before the network sees it.
    verifySignedPayment(quote, signedXdr, this.config.maxFeeStroops);

    // Write ahead: the payment is durable as `submitted` before it is sent, so a
    // crash mid-flight is resolved by the observer instead of being forgotten.
    const payment: PaymentRecord = {
      id: newId("p"),
      quoteId: quote.id,
      billId: quote.billId,
      status: "submitted",
      txHash: quote.unsignedHash,
      submittedAt: new Date(nowMs).toISOString(),
    };
    quote.state = "submitted";
    quote.paymentId = payment.id;
    this.store.putQuote(quote);
    this.store.putPayment(payment);
    this.store.save(nowMs);

    let outcome: SubmitOutcome;
    try {
      outcome = await this.chain.submitTransaction(signedXdr, quote.networkPassphrase);
    } catch {
      // Whatever went wrong, the transaction may or may not have reached the network.
      outcome = { kind: "unknown", message: "The submission call failed." };
    }
    this.log({ event: "payment_submitted", paymentId: payment.id, outcome: outcome.kind });

    if (outcome.kind === "rejected") {
      this.fail(payment, quote, outcome.code, outcome.message);
    } else if (outcome.kind === "unknown") {
      payment.outcomeUnknown = true;
      this.store.putPayment(payment);
      this.store.save(this.now());
    } else {
      await this.confirm(payment.id);
    }
    const settled = this.store.getPayment(payment.id)!;
    return { status: settled.status === "submitted" ? 202 : 200, body: this.paymentView(settled) };
  }

  /**
   * Independently confirm a submitted payment: ask the network for the recorded
   * transaction and compare it to the quote. Only a match produces a receipt.
   * Returns without change when the network does not (yet) know the transaction.
   */
  async confirm(paymentId: string): Promise<PaymentRecord> {
    const payment = this.store.getPayment(paymentId);
    if (!payment) throw notFound("payment_not_found", "No such payment.");
    if (payment.status !== "submitted") return payment;
    const quote = this.store.getQuote(payment.quoteId)!;

    const recorded = await this.chain.fetchTransaction(payment.txHash);
    if (!recorded) return payment;

    const reason = verifyConfirmedTransaction(quote, recorded);
    if (reason !== null) {
      this.fail(payment, quote, reason === "transaction_not_successful" ? "transaction_not_successful" : "confirmation_mismatch", "The recorded transaction does not match the quote, so no receipt was issued. This needs human review.");
      this.log({ event: "confirmation_mismatch", paymentId, reason });
      return this.store.getPayment(paymentId)!;
    }

    const confirmedAt = new Date(this.now()).toISOString();
    const receipt = this.ledger.append({
      paymentId: payment.id,
      quoteId: quote.id,
      billId: quote.billId,
      providerId: quote.providerId,
      network: "testnet",
      usdc: { amountStroops: quote.usdcAmountStroops, code: quote.assetCode, issuer: quote.assetIssuer },
      fiat: { amountMinor: quote.fiatAmountMinor, currency: quote.fiatCurrency },
      destination: quote.destination,
      source: quote.source,
      txHash: payment.txHash,
      stellarLedger: recorded.ledger,
      confirmedAt,
    });
    payment.status = "confirmed";
    payment.confirmedAt = confirmedAt;
    payment.stellarLedger = recorded.ledger;
    payment.receiptId = receipt.id;
    delete payment.outcomeUnknown;
    quote.state = "confirmed";
    this.store.putPayment(payment);
    this.store.putQuote(quote);
    this.store.save(this.now());
    this.log({ event: "payment_confirmed", paymentId, receiptId: receipt.id });
    return payment;
  }

  private fail(payment: PaymentRecord, quote: QuoteRecord, code: string, message: string): void {
    payment.status = "failed";
    payment.failureCode = code;
    payment.failureMessage = message;
    delete payment.outcomeUnknown;
    quote.state = "failed";
    this.store.putPayment(payment);
    this.store.putQuote(quote);
    this.store.save(this.now());
  }

  /**
   * The observer. For every payment still `submitted` it asks the network what
   * happened. A transaction carries a `maxTime` equal to its quote's expiry, so
   * once that time (plus a ledger-close grace) has passed an unseen transaction
   * can never be included — and the payment is safely marked failed, releasing
   * the amount for a new quote.
   */
  async reconcile(): Promise<{ checked: number; confirmed: number; failed: number }> {
    let confirmed = 0;
    let failed = 0;
    const pending = this.store.paymentsWithStatus("submitted");
    for (const payment of pending) {
      try {
        const after = await this.confirm(payment.id);
        if (after.status === "confirmed") confirmed += 1;
        else if (after.status === "failed") failed += 1;
        else {
          const quote = this.store.getQuote(payment.quoteId)!;
          const deadline = Date.parse(quote.expiresAt) + this.config.expiryGraceSeconds * 1000;
          if (this.now() > deadline) {
            this.fail(payment, quote, "expired_unseen", "The transaction was never included before its time bound expired, so it can no longer succeed. Request a new quote.");
            failed += 1;
          }
        }
      } catch (error) {
        this.log({ event: "reconcile_error", paymentId: payment.id, message: error instanceof Error ? error.message : "unknown" });
      }
    }
    return { checked: pending.length, confirmed, failed };
  }

  async getPayment(id: string): Promise<Record<string, unknown>> {
    let payment = this.store.getPayment(id);
    if (!payment) throw notFound("payment_not_found", "No such payment.");
    if (payment.status === "submitted") {
      // A client polling for status also drives confirmation forward.
      try {
        payment = await this.confirm(id);
      } catch {
        // The network being unreachable must not turn a status read into an error.
      }
    }
    return this.paymentView(payment);
  }

  private paymentView(payment: PaymentRecord): Record<string, unknown> {
    const receipt = payment.receiptId ? this.ledger.get(payment.receiptId) : undefined;
    return {
      paymentId: payment.id,
      quoteId: payment.quoteId,
      billId: payment.billId,
      /** Mirrors the client's `PaymentLifecycle`: submitted → confirmed | failed. */
      status: payment.status,
      txHash: payment.txHash,
      explorerUrl: explorerUrl(payment.txHash),
      submittedAt: payment.submittedAt,
      ...(payment.confirmedAt ? { confirmedAt: payment.confirmedAt } : {}),
      ...(payment.stellarLedger === undefined ? {} : { stellarLedger: payment.stellarLedger }),
      ...(payment.outcomeUnknown ? { note: "The network did not give a definite answer yet. Settle is checking; this will resolve to confirmed or failed." } : {}),
      ...(payment.status === "failed" ? { failure: { code: payment.failureCode, message: payment.failureMessage } } : {}),
      ...(receipt ? { receipt } : {}),
    };
  }

  // ── Receipts and bills ──────────────────────────────────────────────────

  getReceipt(id: string) {
    const receipt = this.ledger.get(id);
    if (!receipt) throw notFound("receipt_not_found", "No such receipt.");
    return receipt;
  }

  ledgerStatus() {
    const verification = this.ledger.verify();
    return { ...this.ledger.head(), verified: verification.ok, ...(verification.ok ? {} : { brokenAt: verification.brokenAt, reason: verification.reason }) };
  }

  listBills(): Record<string, unknown>[] {
    return this.directory.bills().map((bill) => this.billView(bill.id));
  }

  billView(id: string): Record<string, unknown> {
    const bill = this.directory.bill(id);
    if (!bill) throw notFound("bill_not_found", "No such bill.");
    const provider = this.directory.provider(bill.providerId);
    const funded = bill.initialFundedMinor + this.store.confirmedMinor(bill.id);
    const reserved = this.store.reservedMinor(bill.id, this.now());
    const remaining = bill.totalMinor - funded - reserved;
    return {
      id: bill.id,
      status: bill.status,
      currency: bill.currency,
      totalMinor: bill.totalMinor.toString(),
      fundedMinor: funded.toString(),
      reservedMinor: reserved.toString(),
      remainingMinor: (remaining < 0n ? 0n : remaining).toString(),
      acceptsPartialFunding: bill.acceptsPartialFunding,
      provider: { id: bill.providerId, displayName: provider?.displayName ?? "Provider", verification: provider?.verification ?? "fixture" },
    };
  }

  config_(): Record<string, unknown> {
    return {
      network: this.config.network,
      networkPassphrase: this.config.networkPassphrase,
      asset: { code: this.config.assetCode, issuer: this.config.assetIssuer },
      quoteTtlSeconds: this.config.quoteTtlSeconds,
      rateSource: this.config.rateSource,
      mode: "testnet-only",
    };
  }
}
