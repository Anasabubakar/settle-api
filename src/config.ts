import { StrKey } from "@stellar/stellar-sdk";
import { Networks } from "@stellar/stellar-sdk";
import type { FiatRate } from "./money.ts";

export interface Config {
  /** The only network this build will run on. */
  network: "testnet";
  networkPassphrase: string;
  horizonUrl: string;
  assetCode: "USDC";
  /** Issuer of the USDC this service quotes and verifies. Never taken from a client. */
  assetIssuer: string;
  port: number;
  host: string;
  quoteTtlSeconds: number;
  /** Fee in stroops (of XLM) per operation; a transaction here has exactly one. */
  baseFeeStroops: number;
  /** Highest fee a signed transaction may carry before it is refused. */
  maxFeeStroops: number;
  minContributionMinor: bigint;
  dataDir: string;
  corsOrigins: readonly string[];
  rateLimitPerMinute: number;
  /** How long after a quote's expiry an unseen transaction is treated as dead. */
  expiryGraceSeconds: number;
  rates: Readonly<Record<string, FiatRate>>;
  rateSource: "testnet-fixture";
}

/**
 * Testnet fixture rates, NOT market data. They exist so the quote flow can be
 * exercised end to end; a mainnet deployment needs a real, audited rate source
 * with a rate lock, which this service deliberately does not pretend to have.
 */
export const TESTNET_FIXTURE_RATES: Readonly<Record<string, FiatRate>> = {
  USD: { minorPerMajor: 100n, usdMicroPerMajor: 1_000_000n },
  GBP: { minorPerMajor: 100n, usdMicroPerMajor: 1_300_000n },
  CAD: { minorPerMajor: 100n, usdMicroPerMajor: 720_000n },
  NGN: { minorPerMajor: 100n, usdMicroPerMajor: 650n },
  KES: { minorPerMajor: 100n, usdMicroPerMajor: 7_700n },
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function integer(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${key} must be a whole number`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`${key} must be between ${min} and ${max}`);
  return value;
}

/**
 * A browser sends the bare origin ("https://app.example.com"), so an allow-list entry with a trailing slash, a path
 * or a wildcard would silently never match and the web app would fail with an opaque CORS error. Refuse it at
 * startup instead. Plain http is accepted only for localhost.
 */
export function parseCorsOrigins(raw: string): string[] {
  const origins = raw.split(",").map((origin) => origin.trim()).filter(Boolean);
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new ConfigError(`SETTLE_CORS_ORIGINS entry "${origin}" is not a valid origin (expected e.g. https://app.example.com).`);
    }
    if (url.origin !== origin || origin.endsWith("/") || origin.includes("*")) {
      throw new ConfigError(`SETTLE_CORS_ORIGINS entry "${origin}" must be a bare origin with no path, trailing slash or wildcard (expected ${url.origin}).`);
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      throw new ConfigError(`SETTLE_CORS_ORIGINS entry "${origin}" must use https (http is allowed only for localhost).`);
    }
  }
  return origins;
}

/**
 * Read and validate configuration. It throws rather than guessing: a payment
 * service that starts with a half-valid configuration is worse than one that
 * refuses to start.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const network = (env.SETTLE_NETWORK ?? "testnet").toLowerCase();
  if (network !== "testnet") {
    throw new ConfigError(
      "settle-api is testnet-only. Mainnet needs verified providers, a real rate source, compliance review and an audit; none of that exists here.",
    );
  }

  const assetIssuer = env.SETTLE_USDC_ISSUER?.trim() ?? "";
  if (!assetIssuer) {
    throw new ConfigError("SETTLE_USDC_ISSUER is required. Set the testnet USDC issuer explicitly; it is never defaulted.");
  }
  if (!StrKey.isValidEd25519PublicKey(assetIssuer)) {
    throw new ConfigError("SETTLE_USDC_ISSUER is not a valid Stellar public key.");
  }

  const horizonUrl = env.SETTLE_HORIZON_URL?.trim() || "https://horizon-testnet.stellar.org";
  let parsedHorizon: URL;
  try {
    parsedHorizon = new URL(horizonUrl);
  } catch {
    throw new ConfigError("SETTLE_HORIZON_URL is not a valid URL.");
  }
  if (parsedHorizon.protocol !== "https:" && parsedHorizon.hostname !== "localhost" && parsedHorizon.hostname !== "127.0.0.1") {
    throw new ConfigError("SETTLE_HORIZON_URL must use https.");
  }

  const baseFeeStroops = integer(env, "SETTLE_BASE_FEE_STROOPS", 100, 100, 100_000);
  const maxFeeStroops = integer(env, "SETTLE_MAX_FEE_STROOPS", Math.max(baseFeeStroops, 10_000), baseFeeStroops, 1_000_000);

  return {
    network: "testnet",
    networkPassphrase: Networks.TESTNET,
    horizonUrl,
    assetCode: "USDC",
    assetIssuer,
    port: integer(env, "PORT", 8787, 0, 65535),
    host: env.HOST?.trim() || "127.0.0.1",
    quoteTtlSeconds: integer(env, "SETTLE_QUOTE_TTL_SECONDS", 300, 30, 3600),
    baseFeeStroops,
    maxFeeStroops,
    minContributionMinor: BigInt(integer(env, "SETTLE_MIN_CONTRIBUTION_MINOR", 100, 1, 1_000_000)),
    dataDir: env.SETTLE_DATA_DIR?.trim() || "./data",
    corsOrigins: parseCorsOrigins(env.SETTLE_CORS_ORIGINS ?? "http://localhost:8081,http://localhost:19006"),
    rateLimitPerMinute: integer(env, "SETTLE_RATE_LIMIT_PER_MINUTE", 60, 1, 100_000),
    expiryGraceSeconds: integer(env, "SETTLE_EXPIRY_GRACE_SECONDS", 120, 0, 3600),
    rates: TESTNET_FIXTURE_RATES,
    rateSource: "testnet-fixture",
  };
}
