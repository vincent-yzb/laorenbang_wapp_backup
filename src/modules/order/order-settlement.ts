import { BadRequestException } from '@nestjs/common';
import { Order, Prisma } from '@prisma/client';

export function validateMoney(amount: number): void { moneyToCents(amount); }
export function moneyToCents(amount: number): bigint {
  const cents = amount * 100;
  if (!Number.isFinite(amount) || amount < 0.01 || amount > 1_000_000 || Math.abs(cents - Math.round(cents)) > 1e-6) {
    throw new BadRequestException('金额必须为0.01至1000000元，最多两位小数');
  }
  return BigInt(Math.round(cents));
}

/** Caller must claim the order in this transaction. Only a verified receipt creates withdrawable income. */
export async function settleOrderIncome(tx: Prisma.TransactionClient, order: Order,
  options: { verifiedPaymentAttemptId?: string } = {}): Promise<void> {
  const gross = moneyToCents(order.price);
  if (order.priceCents != null && order.priceCents !== gross) throw new BadRequestException('订单金额不一致');
  if (!order.angelId) throw new BadRequestException('订单未分配天使');
  // Historical records are already reflected in opening balance; never credit them a second time.
  const existing = await tx.incomeRecord.findFirst({ where: { orderId: order.id, type: '订单收入' } });
  if (existing) return;
  let verified = false;
  let incomeCents = (gross * 80n + 50n) / 100n;
  if (options.verifiedPaymentAttemptId) {
    const attempt = await tx.paymentAttempt.findUnique({ where: { id: options.verifiedPaymentAttemptId } });
    if (!attempt || attempt.mode !== 'WECHAT' || attempt.status !== 'SUCCEEDED' || !attempt.transactionId ||
      attempt.orderId !== order.id || attempt.userId !== order.userId || attempt.amountCents !== gross ||
      attempt.angelAmountCents + attempt.platformAmountCents !== gross || attempt.angelAmountCents !== incomeCents) {
      throw new BadRequestException('收入缺少已核验支付凭证');
    }
    verified = true;
    incomeCents = attempt.angelAmountCents;
  }
  const amount = Number(incomeCents) / 100;
  await tx.incomeRecord.create({ data: { angelId: order.angelId, amount, amountCents: incomeCents,
    entryKey: `income:${order.id}`, entryType: verified ? 'WECHAT_INCOME' : order.paymentOrigin === 'MOCK' ? 'MOCK_INCOME' : 'LEGACY_INCOME',
    paymentAttemptId: options.verifiedPaymentAttemptId, type: '订单收入', description: `订单 ${order.orderNo} 收入`, orderId: order.id } });
  await tx.angel.update({ where: { id: order.angelId }, data: {
    balance: { increment: amount }, balanceCents: { increment: incomeCents },
    ...(verified ? {} : { nonWithdrawableBalanceCents: { increment: incomeCents } }), completedOrders: { increment: 1 },
  } });
}
