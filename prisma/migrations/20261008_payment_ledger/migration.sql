-- Additive payment ledger migration. No old column, row or merchant receipt is removed.
-- Quiesce old money writers before deployment; see README.md for the controlled rollout.
BEGIN;

-- Reject ambiguous legacy amounts before ANY schema change or conversion.
DO $$
DECLARE
  target RECORD;
  invalid_count BIGINT;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('service_types', 'price', FALSE), ('orders', 'price', FALSE),
    ('angels', 'balance', TRUE), ('income_records', 'amount', FALSE)
  ) AS inputs(table_name, column_name, reject_negative)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE CASE WHEN %I::text IN (''NaN'', ''Infinity'', ''-Infinity'') THEN TRUE ELSE %I::numeric * 100 <> round(%I::numeric * 100) OR abs(%I::numeric * 100) > 9223372036854775807 OR (%L AND %I < 0) END',
      target.table_name, target.column_name, target.column_name, target.column_name,
      target.column_name, target.reject_negative, target.column_name
    ) INTO invalid_count;
    IF invalid_count > 0 THEN
      RAISE EXCEPTION 'Payment ledger preflight rejected legacy money in %.%; inspect privately, do not round, reset or delete rows automatically', target.table_name, target.column_name;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM "service_types" WHERE price < 0)
     OR EXISTS (SELECT 1 FROM "orders" WHERE price <= 0) THEN
    RAISE EXCEPTION 'Payment ledger preflight rejected invalid legacy service/order prices';
  END IF;
END $$;

-- AlterTable
ALTER TABLE "angels" ADD COLUMN     "balanceCents" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "frozenBalanceCents" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "nonWithdrawableBalanceCents" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "openingBalanceCents" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "service_types" ADD COLUMN     "priceCents" BIGINT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "paidAttemptId" TEXT,
ADD COLUMN     "paymentOrigin" TEXT,
ADD COLUMN     "priceCents" BIGINT;

-- AlterTable
ALTER TABLE "income_records" ADD COLUMN     "amountCents" BIGINT,
ADD COLUMN     "entryKey" TEXT,
ADD COLUMN     "entryType" TEXT NOT NULL DEFAULT 'LEGACY',
ADD COLUMN     "paymentAttemptId" TEXT,
ADD COLUMN     "refundId" TEXT,
ADD COLUMN     "withdrawalId" TEXT;

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATING',
    "outTradeNo" TEXT NOT NULL,
    "activeOrderId" TEXT,
    "transactionId" TEXT,
    "prepayId" TEXT,
    "amountCents" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "commissionBps" INTEGER NOT NULL DEFAULT 2000,
    "angelAmountCents" BIGINT NOT NULL,
    "platformAmountCents" BIGINT NOT NULL,
    "appId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "payerIdentityHash" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "lastQueryAt" TIMESTAMP(3),
    "nextQueryAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "paymentAttemptId" TEXT,
    "refundId" TEXT,
    "withdrawalId" TEXT,
    "payloadDigest" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "errorCode" TEXT,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentAttemptId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "outRefundNo" TEXT NOT NULL,
    "providerRefundId" TEXT,
    "amountCents" BIGINT NOT NULL,
    "angelReversalCents" BIGINT NOT NULL,
    "platformReversalCents" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "frozenAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "successAt" TIMESTAMP(3),
    "lastQueryAt" TIMESTAMP(3),
    "nextQueryAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" TEXT NOT NULL,
    "angelId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "outBillNo" TEXT NOT NULL,
    "providerTransferId" TEXT,
    "amountCents" BIGINT NOT NULL,
    "payeeIdentityHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "packageInfo" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "frozenAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "successAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "lastQueryAt" TIMESTAMP(3),
    "nextQueryAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_outTradeNo_key" ON "payment_attempts"("outTradeNo");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_activeOrderId_key" ON "payment_attempts"("activeOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_transactionId_key" ON "payment_attempts"("transactionId");

-- CreateIndex
CREATE INDEX "payment_attempts_orderId_createdAt_idx" ON "payment_attempts"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "payment_attempts_userId_createdAt_idx" ON "payment_attempts"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "payment_attempts_status_nextQueryAt_idx" ON "payment_attempts"("status", "nextQueryAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_eventId_key" ON "payment_events"("eventId");

-- CreateIndex
CREATE INDEX "payment_events_status_nextRetryAt_idx" ON "payment_events"("status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_paymentAttemptId_key" ON "refunds"("paymentAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_outRefundNo_key" ON "refunds"("outRefundNo");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_providerRefundId_key" ON "refunds"("providerRefundId");

-- CreateIndex
CREATE INDEX "refunds_status_nextQueryAt_idx" ON "refunds"("status", "nextQueryAt");

-- CreateIndex
CREATE INDEX "refunds_userId_requestedAt_idx" ON "refunds"("userId", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_outBillNo_key" ON "withdrawals"("outBillNo");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_providerTransferId_key" ON "withdrawals"("providerTransferId");

-- CreateIndex
CREATE INDEX "withdrawals_status_nextQueryAt_idx" ON "withdrawals"("status", "nextQueryAt");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_angelId_requestKey_key" ON "withdrawals"("angelId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "income_records_entryKey_key" ON "income_records"("entryKey");

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "payment_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "withdrawals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_angelId_fkey" FOREIGN KEY ("angelId") REFERENCES "angels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Copy exact legacy cents; do not re-credit historical income or invent provider transactions.
UPDATE "service_types" SET "priceCents" = (price::numeric * 100)::bigint WHERE "priceCents" IS NULL;
UPDATE "orders" SET "priceCents" = (price::numeric * 100)::bigint WHERE "priceCents" IS NULL;
UPDATE "orders" SET "paymentOrigin" = 'LEGACY_UNVERIFIED' WHERE "isPaid" = TRUE AND "paymentOrigin" IS NULL;
UPDATE "income_records" SET "amountCents" = (amount::numeric * 100)::bigint WHERE "amountCents" IS NULL;
UPDATE "angels" SET
  "balanceCents" = (balance::numeric * 100)::bigint,
  "openingBalanceCents" = (balance::numeric * 100)::bigint,
  "nonWithdrawableBalanceCents" = (balance::numeric * 100)::bigint;

ALTER TABLE "angels" ADD CONSTRAINT "angels_cents_balance_check" CHECK (
  "balanceCents" >= 0 AND "frozenBalanceCents" >= 0 AND "openingBalanceCents" >= 0
  AND "nonWithdrawableBalanceCents" >= 0
  AND "frozenBalanceCents" <= "balanceCents" - "nonWithdrawableBalanceCents"
);
ALTER TABLE "service_types" ADD CONSTRAINT "service_types_price_cents_check" CHECK ("priceCents" IS NULL OR "priceCents" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_price_cents_check" CHECK ("priceCents" IS NULL OR "priceCents" > 0);
ALTER TABLE "income_records" ADD CONSTRAINT "income_records_cents_entry_check" CHECK (
  "entryType" = 'LEGACY' OR "amountCents" IS NOT NULL
);
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_money_check" CHECK (
  "amountCents" > 0 AND "amountCents" <= 100000000 AND "currency" = 'CNY'
  AND "commissionBps" = 2000 AND "angelAmountCents" >= 0 AND "platformAmountCents" >= 0
  AND "angelAmountCents" = "amountCents" - "platformAmountCents"
  AND ("activeOrderId" IS NULL OR "activeOrderId" = "orderId")
);
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_retry_count_check" CHECK ("retryCount" >= 0);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_money_check" CHECK (
  "amountCents" > 0 AND "amountCents" <= 100000000 AND "currency" = 'CNY'
  AND "angelReversalCents" >= 0 AND "platformReversalCents" >= 0
  AND "angelReversalCents" = "amountCents" - "platformReversalCents"
);
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_money_check" CHECK ("amountCents" > 0 AND "amountCents" <= 100000000);

COMMIT;
