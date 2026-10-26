# Testnet evidence

`npm run e2e:testnet` runs the service against the real Stellar testnet with throwaway accounts and a self-issued test asset (so it never depends on a public issuer). It passed 11 of 11 checks.

Recorded settlement transaction:

`a16dc9c266ca37d3e699efef9718daa94bb2fb6545627a2ee7b3fbe125606e85`

View it: https://stellar.expert/explorer/testnet/tx/a16dc9c266ca37d3e699efef9718daa94bb2fb6545627a2ee7b3fbe125606e85

The script checks that the quote resolves the destination server-side, a tampered signed transaction is rejected, the real payment is accepted and independently confirmed, the receipt chain verifies, a repeated submission is idempotent, and balances on Horizon moved by exactly the quoted amount.

Testnet is reset periodically, so the transaction link may stop resolving; rerun the script to reproduce.

Rerun on October 26, 2026: all 11 checks passed again. Transaction `3d73b3d59ae8ae2edb84d1d412639ceb229551adcd1662ce9aab0312a8fe4b9e` ([testnet explorer](https://stellar.expert/explorer/testnet/tx/3d73b3d59ae8ae2edb84d1d412639ceb229551adcd1662ce9aab0312a8fe4b9e)).
