# Closed testnet pilot runbook

Status: **ready for an internal synthetic-data rehearsal**, not a participant pilot or mainnet launch.

## Scope

Run the payment service and private evidence service on one controlled machine. Use throwaway Stellar testnet accounts, self-issued test assets, synthetic provider records, and synthetic bills only. The evidence service binds to loopback and has separate upload and reviewer credentials.

## Setup

1. `npm ci && npm run check && npm run e2e:testnet`.
2. Copy `.env.example` to a private `.env`; set the testnet asset issuer deliberately. The service refuses mainnet.
3. Generate three independent 32-byte random values: an evidence encryption key and two role tokens. Keep them in an external secret store, not in the repository. Back up the encryption key before collecting evidence.
4. Start `npm start` for settlement and `npm run evidence` for the private vault. Keep both bound to loopback behind an authenticated pilot gateway.
5. Confirm `/healthz` reports `testnet`, then test an invalid bearer token against the evidence service and expect `401`.

## Rehearsal sequence

1. Upload one synthetic PNG/PDF to `POST /internal/evidence` as base64 with the upload role token. Confirm only an opaque ID and pending state return.
2. Open `/internal/evidence/{id}/raw` as a named reviewer. Confirm the audit log records access.
3. Approve or reject through `/internal/evidence/{id}/review`; approved summaries are limited to provider, amount, currency, due date, and the final four reference characters. Confirm `/summary` contains no original image, address, full account number, or notes.
4. Run the testnet quote → wallet signature → submit → independent confirmation → receipt sequence.
5. Repeat the submission with the same idempotency key and confirm there is still one payment and one receipt.
6. Exercise expiry, wrong destination, wrong issuer, duplicate quote, Horizon outage, and network failure. Record expected error codes and recovery steps.
7. Purge reviewed originals after the retention period; verify audit entry and backup expiry.

## Stop conditions

- Any original evidence becomes accessible to an unprivileged role.
- A receipt is issued without independent network confirmation.
- The payment destination, issuer, rate, or fee can be chosen by the client.
- A second submission changes the funded total.
- The observer cannot resolve an ambiguous submission after the transaction expires.

## Exit criteria for a real closed pilot

The internal rehearsal does **not** enroll users. Before a real participant pilot, add authentication and reviewer authorization, a verified provider onboarding process with destination ownership proof, an audited rate source, external encrypted object storage/backups, redaction/malware processing, informed consent and retention notices, incident response, and legal/compliance review for the chosen jurisdictions. Name the pilot operator and participants, and document opt-out and dispute handling.

## Mainnet decision

No mainnet decision is made by this repository. The responsible operator must review the pilot evidence, security findings, provider contracts, rate source, wallet/mobile experience, fraud controls, and applicable law. A separate audited production configuration and deployment plan would be required; this testnet service has no mainnet path.
