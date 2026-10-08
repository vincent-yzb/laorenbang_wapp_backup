import { Injectable, BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException, Optional, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PaymentAttempt } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '../../config/config.service';
import { CreatePaymentDto, RefundDto, WithdrawDto, MiniProgramPayParams } from './dto/payment.dto';
import { settleOrderIncome, moneyToCents } from '../order/order-settlement';
import { WechatPayGateway } from './wechat-pay.gateway';
import { FundsService } from './funds.service';
import * as crypto from 'crypto';

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const pendingStates = ['CREATING', 'PREPAY', 'NOTPAY', 'USERPAYING', 'UNKNOWN'];

@Injectable()
export class PaymentService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private reconciling = false;
  constructor(private prisma: PrismaService, private configService: ConfigService,
    @Optional() private gateway: WechatPayGateway = new WechatPayGateway(),
    @Optional() private funds?: FundsService) {}

  onModuleInit() {
    this.timer = setInterval(() => { void this.reconcilePending().catch(() => console.error('Payment reconciliation deferred')); }, 30_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async createPayment(userId: string, dto: CreatePaymentDto): Promise<{
    success: true; mode: 'mock' | 'real'; data?: MiniProgramPayParams; paid?: boolean; paymentState?: string; message?: string;
  }> {
    if (process.env.WECHAT_PAY_ENABLED !== 'true' && process.env.NODE_ENV === 'development' && process.env.ALLOW_MOCK_PAYMENT === 'true') {
      return this.createMockPayment(userId, dto);
    }
    this.requireConfigured(); // Disabled gateways must make no database writes or provider calls.
    const payer = await this.prisma.user.findUnique({ where: { id: userId }, select: { wechatOpenId: true, wechatAppId: true } });
    if (!payer?.wechatOpenId || !process.env.WECHAT_APPID || payer.wechatAppId !== process.env.WECHAT_APPID) {
      throw new BadRequestException('请使用当前小程序微信登录后付款');
    }
    let reserved: { attempt?: PaymentAttempt; created?: boolean; paid?: boolean };
    try {
      reserved = await this.prisma.$transaction(async tx => {
        const order = await tx.order.findUnique({ where: { id: dto.orderId } });
        this.requireOwned(order, userId);
        if (order!.isPaid && order!.status === 'COMPLETED') return { paid: true };
        if (order!.isPaid || order!.status !== 'PENDING_CONFIRM' || !order!.angelId) throw new BadRequestException('请在服务完成后付款');
        const amount = moneyToCents(order!.price);
        if (order!.priceCents !== null && order!.priceCents !== undefined && amount !== order!.priceCents) throw new BadRequestException('订单金额不一致，请联系客服');
        const existing = await tx.paymentAttempt.findUnique({ where: { activeOrderId: order!.id } });
        if (existing) return { attempt: existing, created: false };
        const angelAmountCents = (amount * 80n + 50n) / 100n;
        const attempt = await tx.paymentAttempt.create({ data: {
          orderId: order!.id, userId, mode: 'WECHAT', status: 'CREATING', activeOrderId: order!.id,
          outTradeNo: 'P' + crypto.randomBytes(15).toString('hex'), amountCents: amount,
          angelAmountCents, platformAmountCents: amount - angelAmountCents, currency: 'CNY', commissionBps: 2000,
          appId: process.env.WECHAT_APPID!, merchantId: process.env.WECHAT_PAY_MCH_ID!, payerIdentityHash: sha256(payer.wechatOpenId!),
          expiresAt: new Date(Date.now() + 15 * 60_000), nextQueryAt: new Date(Date.now() + 20_000),
        } });
        return { attempt, created: true };
      });
    } catch (error) {
      if ((error as any)?.code !== 'P2002') throw error;
      const attempt = await this.prisma.paymentAttempt.findUnique({ where: { activeOrderId: dto.orderId } });
      if (!attempt || attempt.userId !== userId) throw error;
      reserved = { attempt, created: false };
    }
    if (reserved.paid) return { success: true, mode: 'real', paid: true, paymentState: 'SUCCEEDED' };
    let attempt = reserved.attempt!;
    if (attempt.payerIdentityHash !== sha256(payer.wechatOpenId)) throw new BadRequestException('支付身份已变化，请联系客服');
    if (reserved.created) {
      try {
        const result = await this.gateway.createJsapiPayment({ outTradeNo: attempt.outTradeNo, amountCents: Number(attempt.amountCents),
          description: '老人帮服务订单', payerOpenId: payer.wechatOpenId, expiresAt: attempt.expiresAt! });
        await this.prisma.paymentAttempt.updateMany({ where: { id: attempt.id, status: { in: ['CREATING', 'UNKNOWN'] } },
          data: { prepayId: result.prepayId, status: 'PREPAY', nextQueryAt: new Date(Date.now() + 5_000), lastErrorCode: null } });
        const current = await this.prisma.paymentAttempt.findUnique({ where: { id: attempt.id } });
        if (current?.status === 'SUCCEEDED') return { success: true, mode: 'real', paid: true, paymentState: 'SUCCEEDED' };
        return { success: true, mode: 'real', data: result.payParams, paymentState: 'PREPAY' };
      } catch {
        await this.prisma.paymentAttempt.updateMany({ where: { id: attempt.id, status: { in: ['CREATING', 'PREPAY', 'UNKNOWN'] } },
          data: { status: 'UNKNOWN', lastErrorCode: 'PREPAY_RESULT_UNKNOWN', nextQueryAt: new Date(Date.now() + 5_000) } });
        return { success: true, mode: 'real', paymentState: 'UNKNOWN', message: '支付订单正在核实，请稍后查询，勿重复付款' };
      }
    }
    await this.reconcileAttempt(attempt);
    attempt = (await this.prisma.paymentAttempt.findUnique({ where: { id: attempt.id } }))!;
    if (attempt.status === 'SUCCEEDED') return { success: true, mode: 'real', paid: true, paymentState: attempt.status };
    if (attempt.prepayId && ['PREPAY', 'NOTPAY'].includes(attempt.status) && attempt.expiresAt!.getTime() > Date.now()) {
      return { success: true, mode: 'real', paymentState: attempt.status, data: this.gateway.buildMiniProgramPayParams(attempt.prepayId) };
    }
    return { success: true, mode: 'real', paymentState: attempt.status, message: attempt.status === 'CLOSED' ? '原支付单已关闭，请重新发起付款' : '支付结果正在核实，请稍后查询' };
  }

  async getStatus(userId: string, orderId: string) {
    let order = await this.prisma.order.findUnique({ where: { id: orderId } });
    this.requireOwned(order, userId);
    let attempt: PaymentAttempt | null = null;
    let refundStatus: string | undefined;
    if (this.gateway.isConfigured()) {
      attempt = await this.prisma.paymentAttempt.findFirst({ where: { orderId, userId }, orderBy: { createdAt: 'desc' } });
      if (attempt && pendingStates.includes(attempt.status)) {
        await this.reconcileAttempt(attempt);
        attempt = await this.prisma.paymentAttempt.findUnique({ where: { id: attempt.id } });
        order = await this.prisma.order.findUnique({ where: { id: orderId } });
      }
      refundStatus = (await this.prisma.refund.findFirst({ where: { orderId, userId }, orderBy: { createdAt: 'desc' }, select: { status: true } }))?.status;
    }
    return { success: true, data: { orderId: order!.id, status: order!.status, isPaid: order!.isPaid, paymentMethod: order!.paymentMethod,
      completed: order!.status === 'COMPLETED' && order!.isPaid, paymentState: attempt?.status ?? (order!.isPaid ? order!.paymentOrigin ?? 'LEGACY_UNVERIFIED' : 'UNPAID'), refundStatus } };
  }

  async handleWechatCallback(rawBody: Buffer, headers: Record<string, string | string[] | undefined> = {}) {
    const event = this.gateway.verifyNotification(rawBody, headers);
    if (event.eventType !== 'TRANSACTION.SUCCESS') throw new BadRequestException('支付通知类型无效');
    await this.applyVerifiedPayment(event.resource, { id: event.id, digest: event.digest, source: 'NOTIFY' });
    return { code: 'SUCCESS', message: '成功' }; // Sent only after the database commit.
  }

  async reconcilePending(limit = 20) {
    if (this.reconciling || !this.gateway.isConfigured()) return;
    this.reconciling = true;
    try {
      const attempts = await this.prisma.paymentAttempt.findMany({ where: { status: { in: pendingStates },
        OR: [{ nextQueryAt: null }, { nextQueryAt: { lte: new Date() } }] }, orderBy: { createdAt: 'asc' }, take: Math.min(limit, 100) });
      for (const attempt of attempts) await this.reconcileAttempt(attempt);
      await this.funds?.reconcilePending(limit);
    } finally { this.reconciling = false; }
  }

  private async reconcileAttempt(attempt: PaymentAttempt) {
    if (!pendingStates.includes(attempt.status) || !this.gateway.isConfigured()) return;
    // A single CAS limits simultaneous polling across requests and app instances.
    const now = new Date();
    const claim = await this.prisma.paymentAttempt.updateMany({ where: { id: attempt.id, status: { in: pendingStates },
      OR: [{ nextQueryAt: null }, { nextQueryAt: { lte: now } }] }, data: { lastQueryAt: now, nextQueryAt: new Date(Date.now() + 5_000) } });
    if (claim.count !== 1) return;
    try {
      let resource = await this.gateway.queryPayment(attempt.outTradeNo);
      if (resource.trade_state === 'NOTPAY' && attempt.expiresAt && attempt.expiresAt.getTime() <= Date.now()) {
        await this.gateway.closePayment(attempt.outTradeNo);
        resource = await this.gateway.queryPayment(attempt.outTradeNo);
      }
      if (resource.trade_state === 'SUCCESS') {
        const digest = sha256(JSON.stringify(resource));
        await this.applyVerifiedPayment(resource, { id: 'query:' + attempt.id + ':' + digest, digest, source: 'QUERY' });
      } else {
        this.assertTransaction(attempt, resource, false);
        const state = resource.trade_state === 'CLOSED' ? 'CLOSED' : ['NOTPAY', 'USERPAYING'].includes(resource.trade_state) ? resource.trade_state : 'UNKNOWN';
        await this.prisma.paymentAttempt.updateMany({ where: { id: attempt.id, status: { in: pendingStates } }, data: {
          status: state, ...(state === 'CLOSED' ? { activeOrderId: null } : {}), lastErrorCode: null, nextQueryAt: new Date(Date.now() + 30_000),
        } });
      }
    } catch {
      await this.prisma.paymentAttempt.updateMany({ where: { id: attempt.id, status: { in: pendingStates } }, data: {
        lastErrorCode: 'QUERY_RESULT_UNKNOWN', nextQueryAt: new Date(Date.now() + 30_000),
      } });
    }
  }

  private assertTransaction(attempt: PaymentAttempt, resource: Record<string, any>, success: boolean) {
    const amount = resource.amount;
    const invalidAmount = success
      ? !amount || amount.currency !== 'CNY' || !Number.isSafeInteger(amount.total) || BigInt(amount.total) !== attempt.amountCents
      : amount !== undefined && (!amount || typeof amount !== 'object' || Array.isArray(amount) ||
          (amount.total !== undefined && (!Number.isSafeInteger(amount.total) || BigInt(amount.total) !== attempt.amountCents)) ||
          (amount.currency !== undefined && amount.currency !== 'CNY'));
    const invalidPayer = resource.payer !== undefined && (typeof resource.payer?.openid !== 'string' || sha256(resource.payer.openid) !== attempt.payerIdentityHash);
    if (resource.out_trade_no !== attempt.outTradeNo || resource.appid !== attempt.appId || resource.mchid !== attempt.merchantId ||
      invalidAmount || invalidPayer || (success && (resource.trade_state !== 'SUCCESS' || !/^\d{10,64}$/.test(resource.transaction_id ?? '') ||
        typeof resource.payer?.openid !== 'string' || !Number.isFinite(Date.parse(resource.success_time))))) {
      throw new BadRequestException('微信支付凭证与订单不一致');
    }
  }

  private async applyVerifiedPayment(resource: Record<string, any>, event: { id: string; digest: string; source: 'NOTIFY' | 'QUERY' }) {
    const attempt = await this.prisma.paymentAttempt.findUnique({ where: { outTradeNo: resource.out_trade_no ?? '' } });
    if (!attempt || attempt.mode !== 'WECHAT') throw new BadRequestException('支付单不存在');
    this.assertTransaction(attempt, resource, true);
    try {
      await this.prisma.$transaction(async tx => {
        // Lock before inserting FK-linked events: avoids FK KEY SHARE/order/attempt upgrade deadlocks.
        await tx.$queryRaw`SELECT id FROM payment_attempts WHERE id=${attempt.id} FOR UPDATE`;
        const previous = await tx.paymentEvent.findUnique({ where: { eventId: event.id } });
        if (previous) {
          if (previous.payloadDigest !== event.digest || previous.paymentAttemptId !== attempt.id || previous.status !== 'PROCESSED') throw new BadRequestException('支付通知冲突');
          return;
        }
        await tx.paymentEvent.create({ data: { eventId: event.id, source: event.source, eventType: 'TRANSACTION.SUCCESS', paymentAttemptId: attempt.id,
          payloadDigest: event.digest, verifiedAt: new Date(), processedAt: new Date(), status: 'PROCESSED' } });
        const order = await tx.order.findUnique({ where: { id: attempt.orderId } });
        if (!order || order.userId !== attempt.userId || !order.angelId || moneyToCents(order.price) !== attempt.amountCents ||
          (order.priceCents != null && order.priceCents !== attempt.amountCents)) throw new BadRequestException('订单金额或归属已变化');
        const claim = await tx.order.updateMany({ where: { id: order.id, userId: attempt.userId, status: 'PENDING_CONFIRM', isPaid: false }, data: {
          status: 'COMPLETED', isPaid: true, priceCents: attempt.amountCents, paidAt: new Date(resource.success_time), paymentMethod: 'wechat',
          paymentOrigin: 'WECHAT', paidAttemptId: attempt.id, completedAt: order.completedAt ?? new Date(),
        } });
        if (claim.count !== 1) {
          const current = await tx.order.findUnique({ where: { id: order.id } });
          if (!current || current.paidAttemptId !== attempt.id || !((current.status === 'COMPLETED' && current.isPaid) || current.status === 'REFUNDED')) throw new BadRequestException('订单已由其他支付结算，请人工核实');
          const settledAttempt = await tx.paymentAttempt.findUnique({ where: { id: attempt.id } });
          if (!settledAttempt || settledAttempt.transactionId !== resource.transaction_id || settledAttempt.status !== 'SUCCEEDED') throw new BadRequestException('微信交易号冲突');
          return;
        }
        await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'SUCCEEDED', activeOrderId: null,
          transactionId: resource.transaction_id, paidAt: new Date(resource.success_time), nextQueryAt: null, lastErrorCode: null } });
        await settleOrderIncome(tx, order, { verifiedPaymentAttemptId: attempt.id });
        await tx.orderTimeline.create({ data: { orderId: order.id, event: 'PAID', content: '微信付款已核验，订单完成', operator: '微信支付' } });
      });
    } catch (error) {
      if ((error as any)?.code !== 'P2002') throw error;
      const duplicate = await this.prisma.paymentEvent.findUnique({ where: { eventId: event.id } });
      if (!duplicate || duplicate.payloadDigest !== event.digest || duplicate.paymentAttemptId !== attempt.id || duplicate.status !== 'PROCESSED') throw error;
    }
  }

  async refund(userId: string, dto: RefundDto) {
    if (!this.funds) throw new ServiceUnavailableException('退款通道尚未开通，请联系客服');
    return this.funds.requestRefund(userId, dto);
  }
  async withdraw(angelId: string, dto: WithdrawDto) {
    if (!this.funds) throw new ServiceUnavailableException('提现通道尚未开通，余额未扣减');
    return this.funds.requestWithdrawal(angelId, dto as WithdrawDto & { requestKey: string });
  }

  async getIncomeRecords(angelId: string, page = 1, pageSize = 20) {
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new BadRequestException('分页参数无效');
    const [records, total, angel] = await Promise.all([
      this.prisma.incomeRecord.findMany({ where: { angelId }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.incomeRecord.count({ where: { angelId } }),
      this.prisma.angel.findUnique({ where: { id: angelId }, select: { balance: true, balanceCents: true, frozenBalanceCents: true, nonWithdrawableBalanceCents: true } }),
    ]);
    if (!angel) throw new NotFoundException('天使不存在');
    return { success: true, data: { balance: angel.balance, balanceCents: angel.balanceCents, frozenBalanceCents: angel.frozenBalanceCents,
      nonWithdrawableBalanceCents: angel.nonWithdrawableBalanceCents, availableCents: angel.balanceCents - angel.frozenBalanceCents - angel.nonWithdrawableBalanceCents,
      availableBalanceCents: angel.balanceCents - angel.frozenBalanceCents - angel.nonWithdrawableBalanceCents,
      list: records, total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  }

  private requireConfigured() { if (!this.gateway.isConfigured()) throw new ServiceUnavailableException('微信支付通道尚未开通，请稍后再试'); }
  private requireOwned(order: { userId: string } | null, userId: string) {
    if (!order) throw new NotFoundException('订单不存在');
    if (order.userId !== userId) throw new ForbiddenException('无权操作该订单');
  }

  private async createMockPayment(userId: string, dto: CreatePaymentDto) {
    await this.prisma.$transaction(async tx => {
      const order = await tx.order.findUnique({ where: { id: dto.orderId } });
      this.requireOwned(order, userId);
      if (order!.status === 'COMPLETED' && order!.isPaid) return;
      if (order!.status !== 'PENDING_CONFIRM' || order!.isPaid) throw new BadRequestException('请在服务完成后付款');
      if (tx.paymentAttempt && await tx.paymentAttempt.findUnique({ where: { activeOrderId: order!.id } })) throw new BadRequestException('订单有待核实的真实支付，不能模拟结算');
      const priceCents = moneyToCents(order!.price);
      if (!order!.angelId) throw new BadRequestException('订单未分配天使，无法付款');
      const claimed = await tx.order.updateMany({ where: { id: order!.id, userId, status: 'PENDING_CONFIRM', isPaid: false },
        data: { status: 'COMPLETED', isPaid: true, paidAt: new Date(), paymentMethod: 'mock', paymentOrigin: 'MOCK', priceCents, completedAt: new Date() } });
      if (claimed.count !== 1) {
        const current = await tx.order.findUnique({ where: { id: order!.id } });
        if (current?.status === 'COMPLETED' && current.isPaid && current.userId === userId) return;
        throw new BadRequestException('订单状态已更新，请刷新后重试');
      }
      await settleOrderIncome(tx, { ...order!, paymentOrigin: 'MOCK' });
      await tx.orderTimeline.create({ data: { orderId: order!.id, event: 'PAID', content: '内测模拟付款完成，订单已结算', operator: '子女' } });
    });
    return { success: true as const, mode: 'mock' as const, data: { appId: 'mock_appid', timeStamp: Math.floor(Date.now() / 1000).toString(),
      nonceStr: crypto.randomBytes(16).toString('hex'), package: 'prepay_id=mock_prepay_id', signType: 'RSA' as const, paySign: 'mock_sign' } };
  }
}
