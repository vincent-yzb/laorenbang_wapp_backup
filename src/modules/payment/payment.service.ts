import { Injectable, BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '../../config/config.service';
import { CreatePaymentDto, RefundDto, WithdrawDto, MiniProgramPayParams, WechatPayCallback } from './dto/payment.dto';
import { settleOrderIncome, validateMoney } from '../order/order-settlement';
import * as crypto from 'crypto';

@Injectable()
export class PaymentService {
  constructor(private prisma: PrismaService, private configService: ConfigService) {}

  /** Development-only settlement. The real merchant gateway is not connected. */
  async createPayment(userId: string, dto: CreatePaymentDto): Promise<{
    success: true;
    mode: 'mock';
    data: MiniProgramPayParams;
  }> {
    if (process.env.NODE_ENV !== 'development' || process.env.ALLOW_MOCK_PAYMENT !== 'true') {
      throw new ServiceUnavailableException('微信支付通道尚未开通，请稍后再试');
    }

    await this.prisma.$transaction(async tx => {
      const order = await tx.order.findUnique({ where: { id: dto.orderId } });
      if (!order) throw new NotFoundException('订单不存在');
      if (order.userId !== userId) throw new ForbiddenException('无权操作该订单');
      if (order.status === 'COMPLETED' && order.isPaid) return;
      if (order.status !== 'PENDING_CONFIRM' || order.isPaid) {
        throw new BadRequestException('请在服务完成后付款');
      }
      validateMoney(order.price);
      if (!order.angelId) throw new BadRequestException('订单未分配天使，无法付款');

      // PostgreSQL rechecks this predicate after waiting for a concurrent update.
      // Only the transaction that claims the unpaid order may settle its income.
      const claimed = await tx.order.updateMany({
        where: { id: order.id, userId, status: 'PENDING_CONFIRM', isPaid: false },
        data: { status: 'COMPLETED', isPaid: true, paidAt: new Date(), paymentMethod: 'mock', completedAt: new Date() },
      });
      if (claimed.count !== 1) {
        const current = await tx.order.findUnique({ where: { id: order.id } });
        if (current?.status === 'COMPLETED' && current.isPaid && current.userId === userId) return;
        throw new BadRequestException('订单状态已更新，请刷新后重试');
      }
      await settleOrderIncome(tx, order);
      await tx.orderTimeline.create({
        data: { orderId: order.id, event: 'PAID', content: '内测模拟付款完成，订单已结算', operator: '子女' },
      });
    });

    return {
      success: true,
      mode: 'mock',
      data: {
        appId: 'mock_appid',
        timeStamp: Math.floor(Date.now() / 1000).toString(),
        nonceStr: crypto.randomBytes(16).toString('hex'),
        package: 'prepay_id=mock_prepay_id',
        signType: 'RSA',
        paySign: 'mock_sign',
      },
    };
  }

  async getStatus(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true, status: true, isPaid: true, paymentMethod: true },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.userId !== userId) throw new ForbiddenException('无权访问该订单');
    return {
      success: true,
      data: { orderId: order.id, status: order.status, isPaid: order.isPaid, paymentMethod: order.paymentMethod, completed: order.status === 'COMPLETED' && order.isPaid },
    };
  }

  async handleWechatCallback(_body: WechatPayCallback): Promise<never> {
    throw new ServiceUnavailableException('微信支付回调通道尚未开通');
  }

  async refund(_userId: string, _dto: RefundDto): Promise<never> {
    throw new ServiceUnavailableException('退款通道尚未开通，请联系客服');
  }

  async withdraw(_angelId: string, _dto: WithdrawDto): Promise<never> {
    throw new ServiceUnavailableException('提现通道尚未开通，余额未扣减');
  }

  async getIncomeRecords(angelId: string, page = 1, pageSize = 20) {
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new BadRequestException('分页参数无效');
    }
    const [records, total, angel] = await Promise.all([
      this.prisma.incomeRecord.findMany({ where: { angelId }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.incomeRecord.count({ where: { angelId } }),
      this.prisma.angel.findUnique({ where: { id: angelId }, select: { balance: true } }),
    ]);
    if (!angel) throw new NotFoundException('天使不存在');
    return { success: true, data: { balance: angel.balance, list: records, total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }
}
