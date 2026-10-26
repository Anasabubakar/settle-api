/**
 * Live testnet proof: the real Horizon client, the real network, no fakes.
 *
 *   npm run e2e:testnet
 *
 * It creates throwaway testnet accounts, issues its own test "USDC" (testnet USDC
 * from a faucet is not scriptable), then runs the settlement flow end to end and
 * checks the outcome against Horizon's own balances. Nothing here touches mainnet
 * and nothing is persisted: the keys exist for the length of the run.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { HorizonChainClient } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { createDirectory } from "../src/directory.ts";
import { ApiError } from "../src/errors.ts";
import { ReceiptLedger } from "../src/ledger.ts";
import { SettlementService } from "../src/service.ts";
import { Store } from "../src/store.ts";

const HORIZON = process.env.SETTLE_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const server = new Horizon.Server(HORIZON);
const results: Array<{ step: string; ok: boolean; detail: string }> = [];

function check(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? `: ${detail}` : ""}`);
  if (!ok) throw new Error(`step failed: ${step}`);
}

async function friendbot(publicKey: string): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`);
    if (response.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
  throw new Error(`friendbot would not fund ${publicKey}`);
}

async function send(signer: Keypair, operation: ReturnType<typeof Operation.changeTrust> | ReturnType<typeof Operation.payment>): Promise<void> {
  const account = await server.loadAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, { fee: "1000", networkPassphrase: Networks.TESTNET }).addOperation(operation).setTimeout(60).build();
  tx.sign(signer);
  await server.submitTransaction(tx);
}

async function balanceOf(publicKey: string, asset: Asset): Promise<bigint> {
  const account = await server.loadAccount(publicKey);
  const line = account.balances.find((b) => "asset_code" in b && b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer());
  if (!line) return 0n;
  const [whole = "0", fraction = ""] = line.balance.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0").slice(0, 7));
}

async function main(): Promise<void> {
  const issuer = Keypair.random();
  const supporter = Keypair.random();
  const providerAccount = Keypair.random();
  console.log("Funding three throwaway testnet accounts…");
  await Promise.all([issuer, supporter, providerAccount].map((account) => friendbot(account.publicKey())));
  const usdc = new Asset("USDC", issuer.publicKey());
  await send(supporter, Operation.changeTrust({ asset: usdc }));
  await send(providerAccount, Operation.changeTrust({ asset: usdc }));
  await send(issuer, Operation.payment({ destination: supporter.publicKey(), asset: usdc, amount: "500.0000000" }));
  check("test asset issued", (await balanceOf(supporter.publicKey(), usdc)) === 5_000_000_000n, "supporter holds 500 test USDC");

  const config = loadConfig({ SETTLE_USDC_ISSUER: issuer.publicKey(), SETTLE_HORIZON_URL: HORIZON, SETTLE_QUOTE_TTL_SECONDS: "120" });
  const directory = createDirectory({
    supportedCurrencies: Object.keys(config.rates),
    providers: [{ id: "prov-e2e", displayName: "E2E provider", category: "test", country: "XX", destination: providerAccount.publicKey(), verification: "fixture", fixture: true }],
    bills: [{ id: "bill-e2e", providerId: "prov-e2e", currency: "USD", totalMinor: 10_000, fundedMinor: 0, acceptsPartialFunding: true, status: "open" }],
  });
  const dir = mkdtempSync(join(tmpdir(), "settle-e2e-"));
  const ledger = new ReceiptLedger(join(dir, "receipts.jsonl"));
  const service = new SettlementService({ config, directory, store: new Store(join(dir, "state.json")), ledger, chain: new HorizonChainClient(HORIZON) });

  const request = { billId: "bill-e2e", amountMinor: 1_234, currency: "USD", sourceAccount: supporter.publicKey() };
  const quoteResult = await service.createQuote(request, "e2e-quote-0001");
  const quote = quoteResult.body as { quoteId: string; unsignedXdr: string; usdcAmountStroops: string; destination: string; expiresAt: string };
  check("quote created", quoteResult.status === 201 && quote.destination === providerAccount.publicKey(), `${quote.usdcAmountStroops} stroops → server-resolved destination`);

  const replay = await service.createQuote(request, "e2e-quote-0001");
  check("quote request is idempotent", replay.replay === true && (replay.body as { quoteId: string }).quoteId === quote.quoteId, "same key returned the same quote");

  // A tampered transaction must be refused before it reaches the network.
  const tampered = TransactionBuilder.fromXDR(quote.unsignedXdr, Networks.TESTNET) as Transaction;
  const forged = new TransactionBuilder(await server.loadAccount(supporter.publicKey()), { fee: "100", networkPassphrase: Networks.TESTNET, timebounds: { minTime: 0, maxTime: Number(tampered.timeBounds?.maxTime) } })
    .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: usdc, amount: "12.3400000" }))
    .build();
  forged.sign(supporter);
  let refused = "";
  try {
    await service.submitPayment({ quoteId: quote.quoteId, signedXdr: forged.toXDR() }, "e2e-pay-forged-01");
  } catch (error) {
    refused = error instanceof ApiError ? error.code : String(error);
  }
  check("a forged destination is refused before submission", refused === "signed_payload_mismatch", refused);

  const before = { supporter: await balanceOf(supporter.publicKey(), usdc), provider: await balanceOf(providerAccount.publicKey(), usdc) };
  tampered.sign(supporter);
  const payment = await service.submitPayment({ quoteId: quote.quoteId, signedXdr: tampered.toXDR() }, "e2e-pay-0001");
  let view = payment.body as { paymentId: string; status: string; txHash: string; explorerUrl: string; receipt?: { id: string; stellarLedger: number } };
  for (let attempt = 0; attempt < 20 && view.status === "submitted"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    view = (await service.getPayment(view.paymentId)) as typeof view;
  }
  check("payment confirmed independently", view.status === "confirmed" && Boolean(view.receipt), `${view.explorerUrl}`);

  const after = { supporter: await balanceOf(supporter.publicKey(), usdc), provider: await balanceOf(providerAccount.publicKey(), usdc) };
  const amount = BigInt(quote.usdcAmountStroops);
  check("provider received exactly the quoted amount", after.provider - before.provider === amount, `+${amount} stroops`);
  check("supporter paid exactly the quoted amount", before.supporter - after.supporter === amount, `-${amount} stroops`);

  const again = await service.submitPayment({ quoteId: quote.quoteId, signedXdr: tampered.toXDR() }, "e2e-pay-0001");
  check("a retry returns the original result", again.replay === true, "no second submission");
  let reused = "";
  try {
    await service.submitPayment({ quoteId: quote.quoteId, signedXdr: tampered.toXDR() }, "e2e-pay-0002");
  } catch (error) {
    reused = error instanceof ApiError ? error.code : String(error);
  }
  check("a quote cannot be spent twice", reused === "quote_already_used", reused);

  const bill = service.billView("bill-e2e") as { fundedMinor: string; remainingMinor: string };
  check("bill accounting follows the confirmed payment", bill.fundedMinor === "1234" && bill.remainingMinor === "8766", `funded ${bill.fundedMinor}, remaining ${bill.remainingMinor}`);
  check("receipt ledger verifies", ledger.verify().ok && ledger.head().count === 1, `head ${ledger.head().headHash.slice(0, 16)}…`);

  console.log("\nTestnet explorer:", view.explorerUrl);
  console.log(`\nAll ${results.length} checks passed.`);
}

main().catch((error: unknown) => {
  console.error("\nE2E FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
