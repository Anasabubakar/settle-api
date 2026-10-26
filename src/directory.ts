import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StrKey } from "@stellar/stellar-sdk";

/**
 * The provider directory and the bill registry: the only place a destination
 * account or a bill total comes from. A client may name a bill; it can never
 * name who gets paid or how much the bill is worth.
 */

export interface Provider {
  id: string;
  displayName: string;
  category: string;
  country: string;
  destination: string;
  /** `fixture` on testnet. `verified` is reserved for a real onboarding process. */
  verification: "fixture" | "verified";
  fixture: boolean;
}

export type BillStatus = "open" | "settled" | "paused" | "under_review";

export interface BillRecord {
  id: string;
  providerId: string;
  currency: string;
  totalMinor: bigint;
  /** Amount already funded before this service started tracking contributions. */
  initialFundedMinor: bigint;
  acceptsPartialFunding: boolean;
  status: BillStatus;
}

export interface Directory {
  provider(id: string): Provider | undefined;
  bill(id: string): BillRecord | undefined;
  bills(): BillRecord[];
  providers(): Provider[];
}

export class DirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectoryError";
  }
}

interface RawProvider {
  id?: unknown;
  displayName?: unknown;
  category?: unknown;
  country?: unknown;
  destination?: unknown;
  verification?: unknown;
  fixture?: unknown;
}

interface RawBill {
  id?: unknown;
  providerId?: unknown;
  currency?: unknown;
  totalMinor?: unknown;
  fundedMinor?: unknown;
  acceptsPartialFunding?: unknown;
  status?: unknown;
}

const str = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new DirectoryError(`${what} must be a non-empty string`);
  return value;
};

const nonNegativeInt = (value: unknown, what: string): bigint => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DirectoryError(`${what} must be a non-negative whole number`);
  }
  return BigInt(value);
};

/** Build and validate a directory. Throws on anything inconsistent: it never half-loads. */
export function createDirectory(input: {
  providers: readonly RawProvider[];
  bills: readonly RawBill[];
  supportedCurrencies: readonly string[];
}): Directory {
  const providers = new Map<string, Provider>();
  const destinations = new Set<string>();

  for (const raw of input.providers) {
    const id = str(raw.id, "provider id");
    if (providers.has(id)) throw new DirectoryError(`duplicate provider id ${id}`);
    const destination = str(raw.destination, `provider ${id} destination`);
    if (!StrKey.isValidEd25519PublicKey(destination)) throw new DirectoryError(`provider ${id} has an invalid destination`);
    if (destinations.has(destination)) throw new DirectoryError(`provider ${id} reuses a destination`);
    destinations.add(destination);
    const verification = raw.verification === "verified" ? "verified" : "fixture";
    providers.set(id, {
      id,
      displayName: str(raw.displayName, `provider ${id} displayName`),
      category: str(raw.category, `provider ${id} category`),
      country: str(raw.country, `provider ${id} country`),
      destination,
      verification,
      fixture: raw.fixture === true || verification === "fixture",
    });
  }

  const bills = new Map<string, BillRecord>();
  for (const raw of input.bills) {
    const id = str(raw.id, "bill id");
    if (bills.has(id)) throw new DirectoryError(`duplicate bill id ${id}`);
    const providerId = str(raw.providerId, `bill ${id} providerId`);
    if (!providers.has(providerId)) throw new DirectoryError(`bill ${id} references unknown provider ${providerId}`);
    const currency = str(raw.currency, `bill ${id} currency`);
    if (!input.supportedCurrencies.includes(currency)) throw new DirectoryError(`bill ${id} uses unsupported currency ${currency}`);
    const totalMinor = nonNegativeInt(raw.totalMinor, `bill ${id} totalMinor`);
    const initialFundedMinor = nonNegativeInt(raw.fundedMinor ?? 0, `bill ${id} fundedMinor`);
    if (totalMinor === 0n) throw new DirectoryError(`bill ${id} must have a positive total`);
    if (initialFundedMinor > totalMinor) throw new DirectoryError(`bill ${id} is funded beyond its total`);
    const status = raw.status;
    if (status !== "open" && status !== "settled" && status !== "paused" && status !== "under_review") {
      throw new DirectoryError(`bill ${id} has an unknown status`);
    }
    bills.set(id, {
      id,
      providerId,
      currency,
      totalMinor,
      initialFundedMinor,
      acceptsPartialFunding: raw.acceptsPartialFunding === true,
      status,
    });
  }

  return {
    provider: (id) => providers.get(id),
    bill: (id) => bills.get(id),
    bills: () => [...bills.values()],
    providers: () => [...providers.values()],
  };
}

/** Load `providers.testnet.json` and `bills.testnet.json` from a directory. */
export function loadDirectory(dir: string, supportedCurrencies: readonly string[]): Directory {
  const read = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), "utf8"));
  const providerFile = read("providers.testnet.json") as { providers?: RawProvider[] };
  const billFile = read("bills.testnet.json") as { bills?: RawBill[] };
  return createDirectory({
    providers: providerFile.providers ?? [],
    bills: billFile.bills ?? [],
    supportedCurrencies,
  });
}
