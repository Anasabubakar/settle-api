import { createServer } from "node:http";
import { join } from "node:path";
import { HorizonChainClient } from "./chain.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { loadDirectory } from "./directory.ts";
import { createApp } from "./http.ts";
import { ReceiptLedger } from "./ledger.ts";
import { SettlementService } from "./service.ts";
import { Store } from "./store.ts";

const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

try {
  const config = loadConfig();
  const directory = loadDirectory("./data", Object.keys(config.rates));
  const store = new Store(join(config.dataDir, "state.json"));
  const ledger = new ReceiptLedger(join(config.dataDir, "receipts.jsonl"));
  const service = new SettlementService({ config, directory, store, ledger, chain: new HorizonChainClient(config.horizonUrl), log });

  const server = createServer(createApp({ config, service, log }));
  const observer = setInterval(() => {
    service.reconcile().catch((error: unknown) => log({ event: "observer_error", message: error instanceof Error ? error.message : "unknown" }));
  }, 15_000);
  observer.unref();

  server.listen(config.port, config.host, () => {
    log({ event: "listening", host: config.host, port: config.port, network: config.network, receipts: ledger.head().count });
  });

  const shutdown = () => {
    clearInterval(observer);
    store.save();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} catch (error) {
  log({ event: "startup_failed", message: error instanceof Error ? error.message : "unknown" });
  process.exit(error instanceof ConfigError ? 78 : 1);
}
