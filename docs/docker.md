# Running settle-api in a container

This describes how to build and run the image locally. It is not deployed anywhere, and nothing here makes the
service production-ready: it is still testnet-only, unauthenticated, uses fixture providers and rates, and keeps
state in a snapshot file (see the README's "What is real, and what is not").

## Build

```bash
docker build -t settle-api:local .
```

The image is based on `node:24-slim`, installs production dependencies only, runs `node src/server.ts` (Node 24 runs
the TypeScript directly) as the unprivileged `node` user, and binds `0.0.0.0:8787` inside the container.

## Run

```bash
docker run --rm -p 127.0.0.1:8787:8787 \
  -e SETTLE_USDC_ISSUER=<testnet USDC issuer> \
  -e SETTLE_CORS_ORIGINS=http://localhost:8081 \
  -v settle-api-state:/var/lib/settle \
  settle-api:local
```

| Setting | Notes |
|---|---|
| `SETTLE_USDC_ISSUER` | Required, never defaulted. The container exits with code 78 if it is missing or invalid. |
| `SETTLE_CORS_ORIGINS` | Comma-separated browser origins allowed to call the API. Each must be a bare origin (`https://app.example.com`: no path, trailing slash or wildcard; `http` only for localhost). A bad entry stops startup. |
| `SETTLE_DATA_DIR` | Defaults to `/var/lib/settle` in the image. Mount a volume there to keep quotes, payments and the receipt ledger across restarts. |
| `PORT`, `HOST` | `8787` and `0.0.0.0` in the image. Publish the port on `127.0.0.1` only unless something in front of it adds authentication and TLS. |

All other variables in `.env.example` work unchanged.

The provider and bill fixtures in `data/providers.testnet.json` and `data/bills.testnet.json` are baked into the image.
Their destinations are accounts that belong to no provider and may not exist or trust your USDC issuer, so a quote can
succeed and the payment can still fail on the network. To exercise a payment that lands, mount your own fixtures over
`/app/data` (read-only) with destinations you control; the Settle app repository has `scripts/local-testnet/setup.mjs`,
which creates exactly that.

## Health

The image declares a `HEALTHCHECK` that calls `GET /healthz` using the Node runtime (the slim image has no `curl`):

```bash
docker ps                                  # STATUS shows (healthy)
docker inspect --format '{{.State.Health.Status}}' <container>
curl http://127.0.0.1:8787/healthz
```

`/healthz` reports liveness and whether the receipt ledger verifies. It does not check that Horizon is reachable.
