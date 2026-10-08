-- Additive operator review audit; never rewrites payment/ledger history.
ALTER TABLE "refunds"
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "rejectedBy" TEXT,
  ADD COLUMN "rejectionReason" TEXT;

ALTER TABLE "withdrawals"
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "rejectedBy" TEXT,
  ADD COLUMN "rejectionReason" TEXT;
