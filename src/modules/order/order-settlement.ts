import { BadRequestException } from '@nestjs/common';
import { Order, Prisma } from '@prisma/client';

export function validateMoney(amount: number): void {
  const cents = amount * 100;
  if (!Number.isFinite(amount) || amount < 0.01 || amount > 1_000_000 || Math.abs(cents - Math.round(cents)) > 1e-6) {
    throw new BadRequestException('金额必须为0.01至1000000元，最多两位小数');
  }
}

/** Caller must claim the order state inside the same transaction before settling. */
export async function settleOrderIncome(tx: Prisma.TransactionClient, order: Order): Promise<void> {
  validateMoney(order.price);
  if (!order.angelId) throw new BadRequestException('订单未分配天使');
  // Preserve legacy settlements while moving old prepaid orders through confirmation.
  const existing = await tx.incomeRecord.findFirst({ where: { orderId: order.id, type: '订单收入' } });
  if (existing) return;
  const income = Math.round(Math.round(order.price * 100) * 0.8) / 100;
  await tx.incomeRecord.create({
    data: { angelId: order.angelId, amount: income, type: '订单收入', description: `订单 ${order.orderNo} 收入`, orderId: order.id },
  });
  await tx.angel.update({
    where: { id: order.angelId },
    data: { balance: { increment: income }, completedOrders: { increment: 1 } },
  });
}
