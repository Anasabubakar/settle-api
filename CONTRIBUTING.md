# Contributing

Thanks for helping. This service moves value, so changes are held to a higher bar than usual.

## Setup

```bash
npm install
cp .env.example .env
npm run check     # typecheck + tests
```

## Rules

- Testnet only. Do not add a mainnet code path.
- The client must never supply a destination, issuer, rate, fee or memo.
- Every behaviour change needs a test; every API change needs an `openapi.yaml` change (a test fails on drift).
- No new runtime dependencies without a reason in the PR.
- Small commits with clear messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Pull requests

Describe what changed and why, link the issue, and confirm `npm run check` passes. Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).
