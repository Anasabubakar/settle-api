# Threat model

Scope: the testnet service in this repository. Assets: the integrity of who gets paid, how much, and the record that says so.

| # | Threat | Mitigation | Residual risk |
|---|---|---|---|
| 1 | Client redirects funds by supplying a destination, issuer, rate, fee or memo | These fields are rejected on input; the server derives all of them | None known |
| 2 | Wallet is shown one transaction, server submits another | Server verifies source, sequence, operation count and type, destination, asset, amount, fee, memo, time bounds, hash equality and signature before submitting | Wallet UX must show the operation (adapter responsibility) |
| 3 | Replay or double-spend via retry | Idempotency keys with request fingerprint; single-use quotes; write-ahead persistence | None known |
| 4 | Stale quote paid later | `maxTime` = expiry; `expired_unseen` resolution | A transaction submitted just before expiry is handled by the observer |
| 5 | Server says "paid" when it was not | Independent re-fetch and comparison before any receipt | Depends on Horizon being honest; a second source is future work |
| 6 | Overfunding a bill via concurrent quotes | Reservations against open quotes and in-flight payments | Single process only; needs transactional storage to scale out |
| 7 | Receipt history edited | Hash-chained ledger, fail-closed on load | Whole-file deletion is not detected |
| 8 | Memo or amount precision tricks | Integer maths, round up, memo generated server-side | None known |
| 9 | Abuse of unauthenticated endpoints | Rate limit, body limit, bounded bill totals, testnet only | **No authentication yet.** Do not expose to the public with real value |
| 10 | Secrets in config | Issuer required, never defaulted; `.env` ignored; the service holds no signing key | Operators must protect their environment |
| 11 | Mainnet used by accident | Refuses to start unless `SETTLE_NETWORK=testnet` | Removing this guard is a deliberate code change |
| 12 | Log leakage | Errors carry a request id, never signed XDR or keys | Review logs before adding fields |

## Not covered

Provider identity and destination ownership, rate integrity, sanctions and compliance obligations, denial of service at scale, and an external audit. These must be resolved before any mainnet decision.

The private evidence service uses two static role tokens and binds to loopback. It is suitable only for synthetic internal rehearsal: it lacks individual reviewer authorization, malware scanning, automated redaction, and externally managed backups. See [the evidence API](evidence-api.md) and [pilot runbook](pilot-runbook.md).
