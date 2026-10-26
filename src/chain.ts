import { Asset, Horizon, TransactionBuilder } from "@stellar/stellar-sdk";

/**
 * The Stellar network, behind an interface. Everything the service needs from
 * Horizon is these three calls, so the business logic is tested with a fake and
 * the real client is exercised by `scripts/e2e-testnet.ts` against the live
 * testnet.
 */

export interface AccountInfo {
  sequence: string;
  hasTrustline: boolean;
  /** Balance of the quoted asset, in stroops. */
  assetBalanceStroops: bigint;
  /** Native XLM available for the network fee, in stroops. */
  nativeBalanceStroops: bigint;
}

export type SubmitOutcome =
  | { kind: "success"; hash: string; ledger: number }
  /** The network refused it. It will not land; the reason is safe to show. */
  | { kind: "rejected"; code: string; message: string }
  /** No definite answer (timeout, 5xx). It may still land; the observer resolves it. */
  | { kind: "unknown"; message: string };

export interface FetchedOperation {
  type: string;
  from?: string;
  to?: string;
  assetCode?: string;
  assetIssuer?: string;
  amount?: string;
}

export interface FetchedTransaction {
  hash: string;
  successful: boolean;
  ledger: number;
  createdAt: string;
  source: string;
  memo: string | null;
  operations: FetchedOperation[];
}

export interface ChainClient {
  /** `null` when the account does not exist on the network. */
  loadAccount(publicKey: string, asset: { code: string; issuer: string }): Promise<AccountInfo | null>;
  submitTransaction(signedXdr: string, networkPassphrase: string): Promise<SubmitOutcome>;
  /** `null` when the network has no such transaction (yet, or ever). */
  fetchTransaction(hash: string): Promise<FetchedTransaction | null>;
}

const toStroops = (decimal: string): bigint => {
  const [whole = "0", fraction = ""] = decimal.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0").slice(0, 7));
};

interface HorizonErrorShape {
  response?: { status?: number; data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } };
  message?: string;
}

const statusOf = (error: unknown): number | undefined => (error as HorizonErrorShape).response?.status;

export class HorizonChainClient implements ChainClient {
  private readonly server: Horizon.Server;

  constructor(horizonUrl: string) {
    this.server = new Horizon.Server(horizonUrl);
  }

  async loadAccount(publicKey: string, asset: { code: string; issuer: string }): Promise<AccountInfo | null> {
    try {
      const account = await this.server.loadAccount(publicKey);
      let assetBalance = 0n;
      let hasTrustline = false;
      let native = 0n;
      for (const balance of account.balances) {
        if (balance.asset_type === "native") native = toStroops(balance.balance);
        else if (
          "asset_code" in balance &&
          balance.asset_code === asset.code &&
          balance.asset_issuer === asset.issuer
        ) {
          hasTrustline = true;
          assetBalance = toStroops(balance.balance);
        }
      }
      return {
        sequence: account.sequenceNumber(),
        hasTrustline,
        assetBalanceStroops: assetBalance,
        nativeBalanceStroops: native,
      };
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw error;
    }
  }

  async submitTransaction(signedXdr: string, networkPassphrase: string): Promise<SubmitOutcome> {
    const transaction = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
    try {
      const result = await this.server.submitTransaction(transaction);
      return { kind: "success", hash: result.hash, ledger: result.ledger };
    } catch (error) {
      const status = statusOf(error);
      const codes = (error as HorizonErrorShape).response?.data?.extras?.result_codes;
      if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        const code = [codes?.transaction, ...(codes?.operations ?? [])].filter(Boolean).join(",") || `http_${status}`;
        return { kind: "rejected", code, message: `The network rejected the payment (${code}).` };
      }
      // Timeouts, 5xx and rate limits say nothing about whether it landed.
      return { kind: "unknown", message: "The network did not give a definite answer." };
    }
  }

  async fetchTransaction(hash: string): Promise<FetchedTransaction | null> {
    try {
      const record = await this.server.transactions().transaction(hash).call();
      const operations = await this.server.operations().forTransaction(hash).limit(50).call();
      return {
        hash: record.hash,
        successful: record.successful,
        ledger: record.ledger_attr,
        createdAt: record.created_at,
        source: record.source_account,
        memo: record.memo_type === "text" && typeof record.memo === "string" ? record.memo : null,
        operations: operations.records.map((operation) => {
          const raw = operation as unknown as Record<string, string | undefined>;
          return {
            type: operation.type,
            ...(raw.from === undefined ? {} : { from: raw.from }),
            ...(raw.to === undefined ? {} : { to: raw.to }),
            ...(raw.asset_code === undefined ? {} : { assetCode: raw.asset_code }),
            ...(raw.asset_issuer === undefined ? {} : { assetIssuer: raw.asset_issuer }),
            ...(raw.amount === undefined ? {} : { amount: raw.amount }),
          };
        }),
      };
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw error;
    }
  }
}

/** The quoted asset as an SDK `Asset`. */
export const toAsset = (code: string, issuer: string): Asset => new Asset(code, issuer);
