import { FeeBumpTransaction, Keypair, Operation, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { ApiError, badRequest, unprocessable } from "./errors.ts";
import { stroopsToDecimal } from "./money.ts";
import type { FetchedTransaction } from "./chain.ts";
import type { QuoteRecord } from "./store.ts";

/**
 * The two checks that make "the wallet signs only what the server produced" true.
 *
 * `verifySignedPayment` runs before anything is sent to the network: the
 * transaction the supporter signed must be exactly the one this service built for
 * the quote. `verifyConfirmedTransaction` runs after the network accepted it: the
 * transaction the ledger recorded must match the quote too, independently of what
 * the submission call said.
 */

const unixSeconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function mismatch(field: string): ApiError {
  return unprocessable(
    "signed_payload_mismatch",
    "The signed transaction is not the one this quote produced. Request a new quote and sign exactly what it returns.",
    { field },
  );
}

export function verifySignedPayment(quote: QuoteRecord, signedXdr: string, maxFeeStroops: number): Transaction {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(signedXdr, quote.networkPassphrase);
  } catch {
    throw badRequest("invalid_xdr", "The signed transaction could not be read as a Stellar transaction envelope.");
  }
  if (parsed instanceof FeeBumpTransaction) {
    throw unprocessable("fee_bump_not_accepted", "Fee-bump transactions are not accepted; sign the transaction as quoted.");
  }
  const tx = parsed;

  if (tx.source !== quote.source) throw mismatch("source");
  if (tx.sequence !== quote.sequence) throw mismatch("sequence");

  if (tx.operations.length !== 1) throw mismatch("operations");
  const op = tx.operations[0] as Operation.Payment | undefined;
  if (!op || op.type !== "payment") throw mismatch("operation_type");
  if (op.source !== undefined && op.source !== quote.source) throw mismatch("operation_source");
  if (op.destination !== quote.destination) throw mismatch("destination");
  if (!op.asset || op.asset.isNative() || op.asset.getCode() !== quote.assetCode || op.asset.getIssuer() !== quote.assetIssuer) {
    throw mismatch("asset");
  }
  if (op.amount !== stroopsToDecimal(BigInt(quote.usdcAmountStroops))) throw mismatch("amount");

  if (Number(tx.fee) > maxFeeStroops || tx.fee !== quote.fees.networkFeeStroops) throw mismatch("fee");

  if (tx.memo.type !== "text" || new TextDecoder().decode(tx.memo.value as Uint8Array) !== quote.memo) throw mismatch("memo");

  const bounds = tx.timeBounds;
  if (!bounds || bounds.minTime !== "0" || bounds.maxTime !== String(unixSeconds(quote.expiresAt))) throw mismatch("time_bounds");

  // The catch-all: whatever else a transaction can carry, the hash covers it.
  if (hex(tx.hash()) !== quote.unsignedHash) throw mismatch("transaction_body");

  const signer = Keypair.fromPublicKey(quote.source);
  const signed = tx.signatures.some((signature) => {
    try {
      // The SDK hands back an opaque `Signature` that `verify` accepts as-is; it is not a plain byte array.
      return signer.verify(Buffer.from(tx.hash()), signature.signature as unknown as Buffer);
    } catch {
      return false;
    }
  });
  if (!signed) {
    throw unprocessable("invalid_signature", "The transaction is not signed by the supporter account the quote was made for.");
  }
  return tx;
}

/** Does the transaction the ledger recorded match the quote? `null` when it does, otherwise why not. */
export function verifyConfirmedTransaction(quote: QuoteRecord, recorded: FetchedTransaction): string | null {
  if (recorded.hash !== quote.unsignedHash) return "transaction_hash";
  if (!recorded.successful) return "transaction_not_successful";
  if (recorded.source !== quote.source) return "source";
  if (recorded.memo !== quote.memo) return "memo";
  if (recorded.operations.length !== 1) return "operations";
  const op = recorded.operations[0]!;
  if (op.type !== "payment") return "operation_type";
  if (op.from !== quote.source) return "operation_source";
  if (op.to !== quote.destination) return "destination";
  if (op.assetCode !== quote.assetCode || op.assetIssuer !== quote.assetIssuer) return "asset";
  if (op.amount !== stroopsToDecimal(BigInt(quote.usdcAmountStroops))) return "amount";
  return null;
}
