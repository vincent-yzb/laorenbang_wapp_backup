import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PaymentAttempt, Prisma, Refund, Withdrawal } from '@prisma/client';
import * as crypto from 'node:crypto';
import { ConfigService } from '../../config/config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { moneyToCents } from '../order/order-settlement';
import { VerifiedNotification, WechatPayGateway } from './wechat-pay.gateway';

const refundPending = ['PROCESSING', 'UNKNOWN', 'ABNORMAL'];
const transferPending = ['PROCESSING', 'WAIT_USER_CONFIRM', 'UNKNOWN'];
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const later = () => new Date(Date.now() + 30_000);
type Json = Record<string, any>;
type Tx = Prisma.TransactionClient;

/** Provider descriptions have a byte limit; the full application reason remains in the audit row. */
function providerReason(value: string): string {
  let result = '';
  for (const character of value.replace(/[\u0000-\u001f\u007f]/g, ' ')) {
    if (Buffer.byteLength(result + character, 'utf8') > 80) break;
    result += character;
  }
  return result.trim() || '服务订单全额退款';
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max;
}
function amountEquals(value: unknown, expected: bigint): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && BigInt(value) === expected;
}
function safeDate(value: unknown): Date {
  const parts = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value) : null;
  if (parts && Number(parts[2]) >= 1 && Number(parts[2]) <= 12 && Number(parts[3]) >= 1 &&
    Number(parts[3]) <= new Date(Date.UTC(Number(parts[1]), Number(parts[2]), 0)).getUTCDate() &&
    Number(parts[4]) < 24 && Number(parts[5]) < 60 && Number(parts[6]) < 60 &&
    Number(parts[7] ?? 0) < 24 && Number(parts[8] ?? 0) < 60) {
    const date = new Date(value as string);
    if (Number.isFinite(date.getTime()) && date.getTime() > 0 && date.getTime() <= Date.now() + 300_000) return date;
  }
  throw new BadRequestException('成功凭证缺少有效完成时间');
}

@Injectable()
export class FundsService {
  constructor(private prisma: PrismaService, private config: ConfigService, private gateway: WechatPayGateway) {}

  async requestRefund(userId: string, dto: { orderId: string; reason: string }) {
    this.requireRefundConfigured();
    this.whitelist(dto, ['orderId', 'reason']);
    if (!text(dto.orderId, 128) || !text(dto.reason, 500)) throw new BadRequestException('退款订单或原因无效');
    const order = await this.prisma.order.findUnique({ where: { id: dto.orderId } });
    this.owned(order, userId);
    const attempt = order!.paidAttemptId ? await this.prisma.paymentAttempt.findUnique({ where: { id: order!.paidAttemptId } }) : null;
    this.trustedPayment(order!, attempt);
    const existing = await this.prisma.refund.findUnique({ where: { paymentAttemptId: attempt!.id } });
    if (existing) return this.refundResult(existing);
    if (order!.status !== 'COMPLETED') throw new BadRequestException('只有已完成且真实支付的订单可申请退款');
    try {
      const refund = await this.prisma.refund.create({ data: {
        orderId: order!.id, userId, paymentAttemptId: attempt!.id,
        outRefundNo: 'R' + crypto.randomBytes(15).toString('hex'), amountCents: attempt!.amountCents,
        angelReversalCents: attempt!.angelAmountCents, platformReversalCents: attempt!.platformAmountCents,
        currency: 'CNY', reason: dto.reason.trim(), status: 'REQUESTED',
      } });
      return this.refundResult(refund);
    } catch (error) {
      if ((error as any)?.code !== 'P2002') throw error;
      const refund = await this.prisma.refund.findUnique({ where: { paymentAttemptId: attempt!.id } });
      if (!refund || refund.userId !== userId) throw new BadRequestException('退款请求冲突，请查询结果');
      return this.refundResult(refund);
    }
  }

  async listRefunds(userId: string, orderId?: string) {
    const list = await this.prisma.refund.findMany({ where: { userId, ...(orderId ? { orderId } : {}) }, orderBy: { requestedAt: 'desc' }, take: 100 });
    return { success: true, data: { list: list.map(row => this.refundView(row)) } };
  }

  async getRefundStatus(userId: string, id: string, options: { reconcile?: boolean } = {}) {
    let row = await this.prisma.refund.findUnique({ where: { id } });
    this.owned(row, userId);
    if (options.reconcile && this.gateway.isConfigured()) {
      await this.reconcileRefund(row!);
      row = await this.prisma.refund.findUnique({ where: { id } });
    }
    return this.refundResult(row!);
  }

  async approveRefund(id: string, operatorIdentity: string) {
    this.requireRefundConfigured();
    this.operator(operatorIdentity);
    const submission = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM refunds WHERE id=${id} FOR UPDATE`;
      const row = await tx.refund.findUnique({ where: { id }, include: { order: true, paymentAttempt: true } });
      if (!row) throw new NotFoundException('退款申请不存在');
      if (row.status !== 'REQUESTED') return null;
      this.trustedPayment(row.order, row.paymentAttempt);
      if (row.order.status !== 'COMPLETED') throw new BadRequestException('订单当前状态不能审批退款');
      this.refundSnapshot(row, row.paymentAttempt);
      providerReason(row.reason); // Validate/derive the provider input before reservation.
      const credit = await tx.incomeRecord.findFirst({ where: { paymentAttemptId: row.paymentAttemptId,
        angelId: row.order.angelId!, entryType: 'WECHAT_INCOME', amountCents: row.angelReversalCents } });
      if (!credit) throw new BadRequestException('退款缺少已核验收入账目，请人工核实');
      await this.freeze(tx, row.order.angelId!, row.angelReversalCents);
      const now = new Date();
      await tx.refund.update({ where: { id }, data: { status: 'PROCESSING', approvedAt: now, approvedBy: operatorIdentity,
        frozenAt: now, submittedAt: now, nextQueryAt: later(), lastErrorCode: null } });
      return { row, attempt: row.paymentAttempt };
    });
    if (submission) {
      try {
        const resource = await this.gateway.createRefund({ outRefundNo: submission.row.outRefundNo,
          outTradeNo: submission.attempt.outTradeNo, transactionId: submission.attempt.transactionId!,
          totalCents: Number(submission.row.amountCents), reason: providerReason(submission.row.reason) });
        await this.applyRefund(submission.row.id, resource, 'CREATE');
      } catch { await this.refundUnknown(id, 'REFUND_RESULT_UNKNOWN'); }
    }
    return this.refundResult(await this.prisma.refund.findUniqueOrThrow({ where: { id } }));
  }

  async rejectRefund(id: string, operatorIdentity: string, reason: string) {
    this.operator(operatorIdentity);
    this.rejectReason(reason);
    const result = await this.prisma.refund.updateMany({ where: { id, status: 'REQUESTED' }, data: {
      status: 'REJECTED', rejectedAt: new Date(), rejectedBy: operatorIdentity, rejectionReason: reason.trim(), lastErrorCode: 'OPERATOR_REJECTED',
    } });
    const row = await this.prisma.refund.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('退款申请不存在');
    if (!result.count && row.status !== 'REJECTED') throw new BadRequestException('退款已进入处理，不能拒绝');
    return this.refundResult(row);
  }

  async handleRefundNotification(event: VerifiedNotification) {
    this.requireRefundConfigured();
    if (!['REFUND.SUCCESS', 'REFUND.CLOSED', 'REFUND.ABNORMAL'].includes(event.eventType)) throw new BadRequestException('退款通知类型无效');
    const row = await this.prisma.refund.findUnique({ where: { outRefundNo: event.resource?.out_refund_no ?? '' } });
    if (!row) throw new BadRequestException('退款通知没有对应申请');
    if (event.eventType !== `REFUND.${event.resource.refund_status}`) throw new BadRequestException('退款通知状态不一致');
    await this.applyRefund(row.id, event.resource, 'NOTIFY', event);
  }

  async requestWithdrawal(angelId: string, dto: { amount: number; method: string; requestKey: string }) {
    this.requireTransferConfigured();
    this.whitelist(dto, ['amount', 'method', 'requestKey']);
    if (dto.method !== 'wechat' || !/^[A-Za-z0-9_-]{16,64}$/.test(dto.requestKey ?? '')) throw new BadRequestException('仅支持微信钱包提现，请提供有效请求标识');
    const amount = moneyToCents(dto.amount);
    if (amount < 1000n || amount >= 200000n) throw new BadRequestException('提现金额须为10元至不足2000元');
    const angel = await this.prisma.angel.findUnique({ where: { id: angelId } });
    this.payee(angel);
    const existing = await this.prisma.withdrawal.findUnique({ where: { angelId_requestKey: { angelId, requestKey: dto.requestKey } } });
    if (existing) {
      if (existing.amountCents !== amount) throw new BadRequestException('同一提现请求标识不能变更金额');
      return this.withdrawalResult(existing);
    }
    if (angel!.balanceCents - angel!.frozenBalanceCents - angel!.nonWithdrawableBalanceCents < amount) throw new BadRequestException('可提现余额不足');
    try {
      return this.withdrawalResult(await this.prisma.withdrawal.create({ data: {
        angelId, requestKey: dto.requestKey, outBillNo: 'W' + crypto.randomBytes(15).toString('hex'),
        amountCents: amount, payeeIdentityHash: sha256(angel!.wechatOpenId!), status: 'REQUESTED',
      } }));
    } catch (error) {
      if ((error as any)?.code !== 'P2002') throw error;
      const row = await this.prisma.withdrawal.findUnique({ where: { angelId_requestKey: { angelId, requestKey: dto.requestKey } } });
      if (!row || row.amountCents !== amount) throw new BadRequestException('提现请求冲突，请查询结果');
      return this.withdrawalResult(row);
    }
  }

  async listWithdrawals(angelId: string) {
    const list = await this.prisma.withdrawal.findMany({ where: { angelId }, orderBy: { requestedAt: 'desc' }, take: 100 });
    return { success: true, data: { list: list.map(row => this.withdrawalView(row)) } };
  }

  async getWithdrawalStatus(angelId: string, id: string, options: { reconcile?: boolean } = {}) {
    let row = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('提现申请不存在');
    if (row.angelId !== angelId) throw new ForbiddenException('无权查看此提现');
    if (options.reconcile && this.gateway.transferIsConfigured()) {
      await this.reconcileWithdrawal(row);
      row = await this.prisma.withdrawal.findUnique({ where: { id } });
    }
    return this.withdrawalResult(row!);
  }

  async approveWithdrawal(id: string, operatorIdentity: string) {
    this.requireTransferConfigured();
    this.operator(operatorIdentity);
    const submission = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM withdrawals WHERE id=${id} FOR UPDATE`;
      const row = await tx.withdrawal.findUnique({ where: { id }, include: { angel: true } });
      if (!row) throw new NotFoundException('提现申请不存在');
      if (row.status !== 'REQUESTED') return null;
      this.payee(row.angel);
      if (sha256(row.angel.wechatOpenId!) !== row.payeeIdentityHash) throw new BadRequestException('收款身份已变化，请拒绝原申请后重新申请');
      if (row.amountCents < 1000n || row.amountCents >= 200000n) throw new BadRequestException('提现金额超出已开通能力');
      await this.freeze(tx, row.angelId, row.amountCents);
      const now = new Date();
      await tx.withdrawal.update({ where: { id }, data: { status: 'PROCESSING', approvedAt: now, approvedBy: operatorIdentity,
        frozenAt: now, submittedAt: now, nextQueryAt: later(), lastErrorCode: null } });
      return { row, openid: row.angel.wechatOpenId! };
    });
    if (submission) {
      try {
        const resource = await this.gateway.createTransfer({ outBillNo: submission.row.outBillNo,
          openid: submission.openid, amountCents: Number(submission.row.amountCents), remark: '老人帮服务收入提现' });
        await this.applyWithdrawal(submission.row.id, resource, 'CREATE');
      } catch { await this.withdrawalUnknown(id, 'TRANSFER_RESULT_UNKNOWN'); }
    }
    return this.withdrawalResult(await this.prisma.withdrawal.findUniqueOrThrow({ where: { id } }));
  }

  async rejectWithdrawal(id: string, operatorIdentity: string, reason: string) {
    this.operator(operatorIdentity);
    this.rejectReason(reason);
    const result = await this.prisma.withdrawal.updateMany({ where: { id, status: 'REQUESTED' }, data: {
      status: 'REJECTED', rejectedAt: new Date(), rejectedBy: operatorIdentity, rejectionReason: reason.trim(), lastErrorCode: 'OPERATOR_REJECTED',
    } });
    const row = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('提现申请不存在');
    if (!result.count && row.status !== 'REJECTED') throw new BadRequestException('提现已进入处理，不能拒绝');
    return this.withdrawalResult(row);
  }

  async handleTransferNotification(event: VerifiedNotification) {
    this.requireTransferConfigured();
    if (event.eventType !== 'MCHTRANSFER.BILL.FINISHED') throw new BadRequestException('转账通知类型无效');
    if (!['SUCCESS', 'FAIL', 'CANCELLED'].includes(event.resource?.state)) throw new BadRequestException('转账完成通知不是终态');
    const row = await this.prisma.withdrawal.findUnique({ where: { outBillNo: event.resource?.out_bill_no ?? '' } });
    if (!row) throw new BadRequestException('转账通知没有对应申请');
    await this.applyWithdrawal(row.id, event.resource, 'NOTIFY', event);
  }

  async reconcilePending(limit = 20) {
    const take = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 20;
    const due = { OR: [{ nextQueryAt: null }, { nextQueryAt: { lte: new Date() } }] };
    if (this.gateway.isConfigured()) {
      const rows = await this.prisma.refund.findMany({ where: { status: { in: refundPending }, frozenAt: { not: null }, ...due }, orderBy: { requestedAt: 'asc' }, take });
      for (const row of rows) await this.reconcileRefund(row);
    }
    if (this.gateway.transferIsConfigured()) {
      const rows = await this.prisma.withdrawal.findMany({ where: { status: { in: transferPending }, frozenAt: { not: null }, ...due }, orderBy: { requestedAt: 'asc' }, take });
      for (const row of rows) await this.reconcileWithdrawal(row);
    }
  }

  private async reconcileRefund(row: Refund) {
    if (!this.gateway.isConfigured() || !refundPending.includes(row.status)) return;
    const claim = await this.prisma.refund.updateMany({ where: { id: row.id, status: { in: refundPending }, frozenAt: { not: null },
      OR: [{ nextQueryAt: null }, { nextQueryAt: { lte: new Date() } }] }, data: { lastQueryAt: new Date(), nextQueryAt: later() } });
    if (!claim.count) return;
    try { await this.applyRefund(row.id, await this.gateway.queryRefund(row.outRefundNo), 'QUERY'); }
    catch { await this.refundUnknown(row.id, 'REFUND_QUERY_UNKNOWN'); }
  }

  private async reconcileWithdrawal(row: Withdrawal) {
    if (!this.gateway.transferIsConfigured() || !transferPending.includes(row.status)) return;
    const claim = await this.prisma.withdrawal.updateMany({ where: { id: row.id, status: { in: transferPending }, frozenAt: { not: null },
      OR: [{ nextQueryAt: null }, { nextQueryAt: { lte: new Date() } }] }, data: { lastQueryAt: new Date(), nextQueryAt: later() } });
    if (!claim.count) return;
    try { await this.applyWithdrawal(row.id, await this.gateway.queryTransfer(row.outBillNo), 'QUERY'); }
    catch { await this.withdrawalUnknown(row.id, 'TRANSFER_QUERY_UNKNOWN'); }
  }

  private async applyRefund(id: string, resource: Json, source: string, notification?: VerifiedNotification) {
    const snapshot = await this.prisma.refund.findUniqueOrThrow({ where: { id }, include: { paymentAttempt: true, order: true } });
    this.trustedPayment(snapshot.order, snapshot.paymentAttempt);
    this.refundSnapshot(snapshot, snapshot.paymentAttempt);
    const status = resource.refund_status ?? resource.status;
    if (!['SUCCESS', 'PROCESSING', 'CLOSED', 'ABNORMAL'].includes(status) || resource.out_refund_no !== snapshot.outRefundNo ||
      resource.out_trade_no !== snapshot.paymentAttempt.outTradeNo || resource.transaction_id !== snapshot.paymentAttempt.transactionId ||
      !text(resource.refund_id, 128) || !amountEquals(resource.amount?.total, snapshot.amountCents) || !amountEquals(resource.amount?.refund, snapshot.amountCents) ||
      (resource.amount?.currency !== undefined && resource.amount.currency !== 'CNY') ||
      (source === 'NOTIFY' && resource.mchid !== snapshot.paymentAttempt.merchantId) ||
      (resource.mchid !== undefined && resource.mchid !== snapshot.paymentAttempt.merchantId) ||
      (resource.appid !== undefined && resource.appid !== snapshot.paymentAttempt.appId) ||
      (snapshot.providerRefundId && resource.refund_id !== snapshot.providerRefundId)) throw new BadRequestException('退款凭证与申请不一致');
    if (status === 'SUCCESS') safeDate(resource.success_time);
    const event = await this.inbox(source, `REFUND.${status}`, resource, { refundId: id, paymentAttemptId: snapshot.paymentAttemptId }, notification);
    try {
      await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM refunds WHERE id=${id} FOR UPDATE`;
        const row = await tx.refund.findUniqueOrThrow({ where: { id } });
        if (row.providerRefundId && row.providerRefundId !== resource.refund_id) throw new BadRequestException('退款凭证冲突');
        if (row.status === 'SUCCESS') { await this.processed(tx, event.id); return; }
        if (['CLOSED', 'REJECTED'].includes(row.status)) {
          if (row.status === status) { await this.processed(tx, event.id); return; }
          throw new BadRequestException('退款终态冲突，请人工核实');
        }
        if (!row.frozenAt || !refundPending.includes(row.status)) throw new BadRequestException('退款尚未审批');
        const data: Prisma.RefundUpdateInput = { status, providerRefundId: resource.refund_id, nextQueryAt: ['SUCCESS', 'CLOSED'].includes(status) ? null : later(), lastErrorCode: null };
        if (status === 'SUCCESS') {
          await this.debit(tx, snapshot.order.angelId!, row.angelReversalCents);
          await tx.incomeRecord.create({ data: { angelId: snapshot.order.angelId!, amount: -Number(row.angelReversalCents) / 100,
            amountCents: -row.angelReversalCents, entryType: 'REFUND_REVERSAL', entryKey: `refund:${row.id}`,
            paymentAttemptId: row.paymentAttemptId, refundId: row.id, orderId: row.orderId, type: '退款冲回', description: '已核验微信全额退款冲回' } });
          await tx.order.updateMany({ where: { id: row.orderId, paidAttemptId: row.paymentAttemptId, paymentOrigin: 'WECHAT', isPaid: true }, data: { status: 'REFUNDED' } });
          data.successAt = safeDate(resource.success_time);
        } else if (status === 'CLOSED') await this.release(tx, snapshot.order.angelId!, row.angelReversalCents);
        await tx.refund.update({ where: { id }, data });
        await this.processed(tx, event.id);
      });
    } catch (error) { await this.failedEvent(event.id); throw error; }
  }

  private async applyWithdrawal(id: string, resource: Json, source: string, notification?: VerifiedNotification) {
    const snapshot = await this.prisma.withdrawal.findUniqueOrThrow({ where: { id } });
    const state = resource.state;
    const allowed = ['ACCEPTED', 'PROCESSING', 'TRANSFERING', 'WAIT_USER_CONFIRM', 'CANCELING', 'SUCCESS', 'FAIL', 'CANCELLED'];
    if (!allowed.includes(state) || resource.out_bill_no !== snapshot.outBillNo || !text(resource.transfer_bill_no, 128) ||
      (resource.transfer_amount !== undefined && !amountEquals(resource.transfer_amount, snapshot.amountCents)) ||
      (source !== 'CREATE' && !amountEquals(resource.transfer_amount, snapshot.amountCents)) ||
      (source !== 'CREATE' && resource.mch_id !== this.merchantId()) ||
      (source === 'QUERY' && resource.appid !== this.config.wechatAppId) ||
      (source === 'NOTIFY' && (!text(resource.openid, 128) || sha256(resource.openid) !== snapshot.payeeIdentityHash)) ||
      (resource.openid !== undefined && (!text(resource.openid, 128) || sha256(resource.openid) !== snapshot.payeeIdentityHash)) ||
      (resource.mch_id !== undefined && resource.mch_id !== this.merchantId()) ||
      (resource.appid !== undefined && resource.appid !== this.config.wechatAppId) ||
      (snapshot.providerTransferId && resource.transfer_bill_no !== snapshot.providerTransferId)) throw new BadRequestException('转账凭证与申请不一致');
    if (state === 'SUCCESS') safeDate(resource.update_time);
    const event = await this.inbox(source, `TRANSFER.${state}`, resource, { withdrawalId: id }, notification);
    try {
      await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM withdrawals WHERE id=${id} FOR UPDATE`;
        const row = await tx.withdrawal.findUniqueOrThrow({ where: { id } });
        if (row.providerTransferId && row.providerTransferId !== resource.transfer_bill_no) throw new BadRequestException('转账凭证冲突');
        if (row.status === 'SUCCESS') { await this.processed(tx, event.id); return; }
        if (['FAIL', 'CANCELLED', 'REJECTED'].includes(row.status)) {
          if (row.status === state) { await this.processed(tx, event.id); return; }
          throw new BadRequestException('转账终态冲突，请人工核实');
        }
        if (!row.frozenAt || !transferPending.includes(row.status)) throw new BadRequestException('提现尚未审批');
        let status = ['SUCCESS', 'FAIL', 'CANCELLED', 'WAIT_USER_CONFIRM'].includes(state) ? state : 'PROCESSING';
        let packageInfo = row.packageInfo;
        if (state === 'WAIT_USER_CONFIRM' && source === 'CREATE') {
          if (!text(resource.package_info, 2048) || /[\u0000-\u001f\u007f]/.test(resource.package_info)) throw new BadRequestException('转账确认参数无效');
          packageInfo = resource.package_info;
        }
        // Query/notification cannot reconstruct the package from a lost create response.
        if (status === 'WAIT_USER_CONFIRM' && !packageInfo) status = 'UNKNOWN';
        const data: Prisma.WithdrawalUpdateInput = { status, providerTransferId: resource.transfer_bill_no, packageInfo,
          nextQueryAt: ['SUCCESS', 'FAIL', 'CANCELLED'].includes(status) ? null : later(),
          lastErrorCode: status === 'UNKNOWN' ? 'CONFIRM_PACKAGE_UNAVAILABLE' : null };
        if (status === 'SUCCESS') {
          await this.debit(tx, row.angelId, row.amountCents);
          await tx.incomeRecord.create({ data: { angelId: row.angelId, amount: -Number(row.amountCents) / 100,
            amountCents: -row.amountCents, entryType: 'WITHDRAWAL', entryKey: `withdrawal:${row.id}`, withdrawalId: row.id,
            type: '提现', description: '已核验微信商家转账扣账' } });
          data.successAt = safeDate(resource.update_time);
        } else if (['FAIL', 'CANCELLED'].includes(status)) await this.release(tx, row.angelId, row.amountCents);
        await tx.withdrawal.update({ where: { id }, data });
        await this.processed(tx, event.id);
      });
    } catch (error) { await this.failedEvent(event.id); throw error; }
  }

  /** Inbox commits before financial application; ACK is only returned after the caller finishes. */
  private async inbox(source: string, eventType: string, resource: Json,
    links: { refundId?: string; withdrawalId?: string; paymentAttemptId?: string }, notification?: VerifiedNotification) {
    eventType = notification?.eventType ?? eventType;
    const digest = notification?.digest ?? sha256(JSON.stringify(resource));
    const eventId = notification?.id ?? `${source}:${eventType}:${sha256(JSON.stringify(links) + digest)}`;
    if (!text(eventId, 128) || !/^[a-f0-9]{64}$/.test(digest)) throw new BadRequestException('资金事件标识无效');
    try {
      return await this.prisma.paymentEvent.create({ data: { eventId, source, eventType, payloadDigest: digest,
        verifiedAt: new Date(), ...links } });
    } catch (error) {
      if ((error as any)?.code !== 'P2002') throw error;
      const existing = await this.prisma.paymentEvent.findUnique({ where: { eventId } });
      if (!existing || existing.payloadDigest !== digest || existing.refundId !== (links.refundId ?? null) ||
        existing.withdrawalId !== (links.withdrawalId ?? null) || existing.paymentAttemptId !== (links.paymentAttemptId ?? null) ||
        existing.eventType !== eventType || existing.source !== source) throw new BadRequestException('资金事件重复且内容不一致');
      return existing;
    }
  }

  private async processed(tx: Tx, id: string) {
    await tx.paymentEvent.update({ where: { id }, data: { status: 'PROCESSED', processedAt: new Date(), nextRetryAt: null, errorCode: null } });
  }
  private async failedEvent(id: string) {
    await this.prisma.paymentEvent.updateMany({ where: { id, status: { not: 'PROCESSED' } },
      data: { status: 'RETRY', retryCount: { increment: 1 }, nextRetryAt: later(), errorCode: 'FUNDS_APPLY_DEFERRED' } });
  }
  private async freeze(tx: Tx, angelId: string, amount: bigint) {
    const changed = await tx.$executeRaw`UPDATE angels SET "frozenBalanceCents"="frozenBalanceCents"+${amount}, "updatedAt"=NOW()
      WHERE id=${angelId} AND "balanceCents"-"frozenBalanceCents"-"nonWithdrawableBalanceCents">=${amount}`;
    if (changed !== 1) throw new BadRequestException('可提现余额不足，无法冻结本次资金');
  }
  private async release(tx: Tx, angelId: string, amount: bigint) {
    const changed = await tx.$executeRaw`UPDATE angels SET "frozenBalanceCents"="frozenBalanceCents"-${amount}, "updatedAt"=NOW()
      WHERE id=${angelId} AND "frozenBalanceCents">=${amount}`;
    if (changed !== 1) throw new BadRequestException('冻结账目不一致，请人工核实');
  }
  private async debit(tx: Tx, angelId: string, amount: bigint) {
    const changed = await tx.$executeRaw`UPDATE angels SET
      balance=(("balanceCents"-${amount})::numeric/100)::double precision,
      "balanceCents"="balanceCents"-${amount}, "frozenBalanceCents"="frozenBalanceCents"-${amount}, "updatedAt"=NOW()
      WHERE id=${angelId} AND "frozenBalanceCents">=${amount}
        AND "balanceCents"-"nonWithdrawableBalanceCents">=${amount}`;
    if (changed !== 1) throw new BadRequestException('扣账条件不满足，请人工核实');
  }

  private trustedPayment(order: any, attempt: PaymentAttempt | null): asserts attempt is PaymentAttempt {
    if (!attempt || order.paymentOrigin !== 'WECHAT' || !order.isPaid || !order.angelId || order.paidAttemptId !== attempt.id ||
      attempt.mode !== 'WECHAT' || attempt.status !== 'SUCCEEDED' || !attempt.transactionId || attempt.orderId !== order.id ||
      attempt.userId !== order.userId || order.priceCents == null || attempt.amountCents !== order.priceCents ||
      attempt.currency !== 'CNY' || attempt.commissionBps !== 2000 || attempt.angelAmountCents + attempt.platformAmountCents !== attempt.amountCents ||
      attempt.angelAmountCents !== (attempt.amountCents * 80n + 50n) / 100n ||
      attempt.appId !== this.config.wechatAppId || attempt.merchantId !== this.merchantId()) throw new BadRequestException('退款需要已核验微信付款凭证，模拟或历史余额不可退款出款');
  }
  private refundSnapshot(row: Refund, attempt: PaymentAttempt) {
    if (row.amountCents !== attempt.amountCents || row.angelReversalCents !== attempt.angelAmountCents ||
      row.platformReversalCents !== attempt.platformAmountCents || row.currency !== 'CNY' || row.userId !== attempt.userId || row.orderId !== attempt.orderId) throw new BadRequestException('退款金额快照不一致');
  }
  private payee(angel: any) {
    if (!angel || angel.status !== 'APPROVED' || !angel.isVerified || !text(angel.wechatOpenId, 64) ||
      !this.config.wechatAppId || angel.wechatAppId !== this.config.wechatAppId) {
      throw new BadRequestException('请先完成天使审核并使用当前小程序微信登录');
    }
  }
  private merchantId() { return process.env.WECHAT_PAY_MCH_ID ?? ''; }
  private requireRefundConfigured() {
    if (!this.gateway.isConfigured()) throw new ServiceUnavailableException('真实微信退款尚未开通，未创建申请或冻结资金');
  }
  private requireTransferConfigured() {
    if (!this.gateway.transferIsConfigured()) throw new ServiceUnavailableException('真实微信商家转账尚未开通，未创建申请或冻结资金');
  }
  private owned(row: any, userId: string) {
    if (!row) throw new NotFoundException('记录不存在');
    if (row.userId !== userId) throw new ForbiddenException('无权操作此记录');
  }
  private whitelist(value: any, keys: string[]) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new BadRequestException('请求包含无效字段');
  }
  private operator(identity: string) {
    if (!text(identity, 128) || /[\u0000-\u001f\u007f]/.test(identity)) throw new ForbiddenException('独立审核身份无效');
  }
  private rejectReason(reason: string) {
    if (!text(reason, 500)) throw new BadRequestException('请填写有效拒绝原因');
  }
  private async refundUnknown(id: string, code: string) {
    await this.prisma.refund.updateMany({ where: { id, status: { in: refundPending } }, data: { status: 'UNKNOWN', lastErrorCode: code, nextQueryAt: later() } });
  }
  private async withdrawalUnknown(id: string, code: string) {
    await this.prisma.withdrawal.updateMany({ where: { id, status: { in: transferPending } }, data: { status: 'UNKNOWN', lastErrorCode: code, nextQueryAt: later() } });
  }
  private refundView(row: Refund) {
    return { id: row.id, orderId: row.orderId, status: row.status, amountCents: row.amountCents.toString(),
      angelReversalCents: row.angelReversalCents.toString(), platformReversalCents: row.platformReversalCents.toString(),
      currency: row.currency, reason: row.reason, requestedAt: row.requestedAt, approvedAt: row.approvedAt,
      rejectedAt: row.rejectedAt, rejectionReason: row.rejectionReason, successAt: row.successAt, lastErrorCode: row.lastErrorCode };
  }
  private withdrawalView(row: Withdrawal) {
    return { id: row.id, status: row.status, amountCents: row.amountCents.toString(), requestedAt: row.requestedAt,
      approvedAt: row.approvedAt, rejectedAt: row.rejectedAt, rejectionReason: row.rejectionReason, successAt: row.successAt,
      lastErrorCode: row.lastErrorCode, ...(row.status === 'WAIT_USER_CONFIRM' && row.packageInfo ? {
        transferConfirmParams: { mchId: this.merchantId(), appId: this.config.wechatAppId, package: row.packageInfo },
      } : {}) };
  }
  private refundResult(row: Refund) { return { success: true, data: this.refundView(row) }; }
  private withdrawalResult(row: Withdrawal) { return { success: true, data: this.withdrawalView(row) }; }
}
