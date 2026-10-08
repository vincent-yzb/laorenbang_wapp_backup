# Payment ledger increment

This migration expands the existing schema without dropping old Float columns or any business rows. It adds BIGINT cents, verified-payment attempt/event records, full-refund requests and withdrawal requests. Existing paid orders become `LEGACY_UNVERIFIED`; no merchant transaction, payment event or receipt is invented. Historical income remains `entryType=LEGACY` and is not credited again. Existing angel balance is copied to `balanceCents`, `openingBalanceCents` and `nonWithdrawableBalanceCents`; none of this unverified opening balance is available for real withdrawal.

The preflight rejects non-finite values, sub-cent values, negative balances and out-of-BIGINT-range amounts before schema writes. Resolve discrepancies privately with an approved reconciliation; do not round, clip, delete or reset them automatically. The migration is atomic. Unique merchant IDs, active-order claims, event IDs and ledger entry keys provide database backstops; gateway verification and business transactions remain required.

## Controlled deployment

1. Back up and test restore. Confirm the current schema and migration history match the two already-reviewed repository migrations; existing databases must not be reset or blindly baseline-resolved.
2. Pause old order/payment/balance writers while applying this increment and switching all money writers to cents. Otherwise an old process could write a Float-only row after backfill. Keep real payment/transfer activation closed until the new code is deployed and checks pass.
3. Apply only through a reviewed migration deployment against the intended existing database; this change does not authorize a cloud migration. No production or cloud database was used to develop this increment.
4. Confirm legacy row counts are unchanged, cents are populated consistently, old paid rows remain unverified, new receipt/event tables contain no fabricated history, and full Prisma schema diff is empty. `CHECK` constraints need separate database inspection because Prisma 5 does not model them in schema.prisma.
5. Resume only cents-aware writers. Nullable legacy price/amount cents remain an expand-phase compatibility concession: new financial paths must fail closed for missing cents and must not silently trust Float values. Float response mirrors are derived from authoritative cents.

Available cents are `balanceCents - frozenBalanceCents - nonWithdrawableBalanceCents`. Frozen amounts are reserved liabilities, not expenses or transfers. Only a verified provider SUCCESS may create a refund/withdrawal debit ledger entry and reduce balance. UNKNOWN/ABNORMAL retain reservations; reliable terminal failures release them. Reconciliation is `openingBalanceCents + sum(non-LEGACY ledger amountCents)`; legacy rows must never be summed a second time. New MOCK_INCOME/LEGACY_INCOME must increase non-withdrawable balance along with total balance.

Keep cloud staging data and all user-created rows untouched while validating this increment in the dedicated loopback PostgreSQL database.
