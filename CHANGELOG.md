# Changelog

## v0.2.1 — 2026-10-30

- Validate `SETTLE_CORS_ORIGINS` at startup: a malformed origin now stops the server with a clear error instead of silently never matching.
- Expose `Retry-After`, `Idempotent-Replay` and `X-Request-Id` to browsers.
- Add a Dockerfile (Node 24, non-root, health check) and container notes in `docs/docker.md`. The image has not been built in CI.
- 145 passing tests.

## v0.2.0 — 2026-10-26

- Added a separate localhost-only evidence service with encrypted originals, a human review decision, restricted redacted summaries, audit entries, and retention purge support.
- Added a closed testnet pilot runbook and reran the 11-step live network proof.
- Expanded the automated suite to 143 passing tests.

## v0.1.0 — 2026-10-26

- Settlement API: verified quotes, signed-payment verification, submission, independent confirmation and hash-chained receipts (testnet only).
- OpenAPI 3.1 contract with a drift test.
- 140 tests and a live Stellar testnet end-to-end script.
