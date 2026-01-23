import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '../../config/config.service';
import {
  CreatePaymentDto,
  RefundDto,
  WithdrawDto,
  MiniProgramPayParams,
  WechatPayCallback,
} from './dto/payment.dto';
import * as crypto from 'crypto';

@Injectable()
export class PaymentService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  /**
   * 创建微信支付订单
   * 支持两种模式：
   * 1. 预付款模式：订单状态为 PENDING 时支付
   * 2. 服务后付款模式：订单状态为 PENDING_CONFIRM 时支付（天使完成服务后）
   */
  async createPayment(userId: string, dto: CreatePaymentDto): Promise<{ success: boolean; data?: MiniProgramPayParams; message?: string }> {
    const { orderId } = dto;

    // 获取订单信息
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { serviceType: true },
    });

    if (!order) {
      throw new NotFoundException('订单不存在');
    }

    if (order.userId !== userId) {
      throw new BadRequestException('无权操作该订单');
    }

    // 允许 PENDING（预付款）或 PENDING_CONFIRM（服务后付款）状态的订单支付
    if (!['PENDING', 'PENDING_CONFIRM'].includes(order.status)) {
      throw new BadRequestException(`订单状态不允许支付，当前状态: ${order.status}`);
    }

    if (order.isPaid) {
      throw new BadRequestException('订单已支付');
    }

    // 开发环境模拟支付
    if (this.configService.isDevelopment) {
      // 判断是预付款还是服务后付款
      const isPostServicePayment = order.status === 'PENDING_CONFIRM';
      const newStatus = isPostServicePayment ? 'COMPLETED' : 'PAID';
      
      // 直接更新订单状态
      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          status: newStatus,
          isPaid: true,
          paidAt: new Date(),
          paymentMethod: 'wechat',
          completedAt: isPostServicePayment ? new Date() : undefined,
        },
      });

      // 记录时间线
      await this.prisma.orderTimeline.create({
        data: {
          orderId,
          event: 'PAID',
          content: isPostServicePayment ? '订单已支付，服务完成（开发模式）' : '订单已支付（开发模式）',
          operator: '系统',
        },
      });

      // 服务后付款模式：结算天使收入
      if (isPostServicePayment && order.angelId) {
        await this.settleAngelIncome(order);
      }

      return {
        success: true,
        message: isPostServicePayment ? '支付成功，订单已完成（开发模式）' : '支付成功（开发模式）',
        data: {
          appId: 'mock_appid',
          timeStamp: Math.floor(Date.now() / 1000).toString(),
          nonceStr: this.generateNonceStr(),
          package: 'prepay_id=mock_prepay_id',
          signType: 'RSA',
          paySign: 'mock_sign',
        },
      };
    }

    // 生产环境调用微信支付
    try {
      const prepayId = await this.createWechatPrepay(order);
      const payParams = this.generatePayParams(prepayId);

      return {
        success: true,
        data: payParams,
      };
    } catch (error) {
      console.error('创建支付失败:', error);
      throw new BadRequestException('创建支付失败，请重试');
    }
  }

  /**
   * 处理微信支付回调
   */
  async handleWechatCallback(body: WechatPayCallback): Promise<{ code: string; message: string }> {
    try {
      // 1. 验证签名（生产环境必须）
      // const isValid = this.verifyWechatSign(body);
      // if (!isValid) {
      //   return { code: 'FAIL', message: '签名验证失败' };
      // }

      // 2. 解密通知数据
      // const decrypted = this.decryptWechatNotify(body.resource);

      // 3. 模拟解密后的数据
      const paymentResult = {
        out_trade_no: 'mock_order_no', // 商户订单号
        transaction_id: 'wx_transaction_id', // 微信支付订单号
        trade_state: 'SUCCESS',
        payer: { openid: 'user_openid' },
        amount: { total: 6000, payer_total: 6000 },
      };

      // 4. 更新订单状态
      const order = await this.prisma.order.findUnique({
        where: { orderNo: paymentResult.out_trade_no },
      });

      if (order && !order.isPaid) {
        await this.prisma.order.update({
          where: { id: order.id },
          data: {
            status: 'PAID',
            isPaid: true,
            paidAt: new Date(),
            paymentMethod: 'wechat',
          },
        });

        // 记录时间线
        await this.prisma.orderTimeline.create({
          data: {
            orderId: order.id,
            event: 'PAID',
            content: '订单已支付',
            operator: '系统',
          },
        });

        // TODO: 发送通知给天使
      }

      return { code: 'SUCCESS', message: '成功' };
    } catch (error) {
      console.error('支付回调处理失败:', error);
      return { code: 'FAIL', message: '处理失败' };
    }
  }

  /**
   * 申请退款
   */
  async refund(userId: string, dto: RefundDto): Promise<{ success: boolean; message: string }> {
    const { orderId, reason } = dto;

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('订单不存在');
    }

    if (order.userId !== userId) {
      throw new BadRequestException('无权操作该订单');
    }

    // 只有已支付、已取消状态可以退款
    if (!['PAID', 'CANCELLED'].includes(order.status)) {
      throw new BadRequestException('当前状态不支持退款');
    }

    if (!order.isPaid) {
      throw new BadRequestException('订单未支付，无需退款');
    }

    // 开发环境模拟退款
    if (this.configService.isDevelopment) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: 'REFUNDED' },
      });

      await this.prisma.orderTimeline.create({
        data: {
          orderId,
          event: 'REFUND',
          content: `退款申请已提交：${reason}（开发模式）`,
          operator: '系统',
        },
      });

      return {
        success: true,
        message: '退款申请已提交，预计1-3个工作日原路退回（开发模式）',
      };
    }

    // 生产环境调用微信退款 API
    try {
      await this.createWechatRefund(order, reason);
      return {
        success: true,
        message: '退款申请已提交，预计1-3个工作日原路退回',
      };
    } catch (error) {
      console.error('退款失败:', error);
      throw new BadRequestException('退款申请失败，请联系客服');
    }
  }

  /**
   * 天使提现
   */
  async withdraw(angelId: string, dto: WithdrawDto): Promise<{ success: boolean; message: string }> {
    const { amount, method, bankCardId } = dto;

    // 查询天使信息
    const angel = await this.prisma.angel.findUnique({
      where: { id: angelId },
    });

    if (!angel) {
      throw new NotFoundException('用户不存在');
    }

    // MVP阶段：天使端无需预先认证，首次提现成功即视为已认证

    if (angel.balance < amount) {
      throw new BadRequestException(`余额不足，当前可提现 ¥${angel.balance.toFixed(2)}`);
    }

    // 银行卡提现需要验证银行卡
    if (method === 'bank' && !bankCardId) {
      throw new BadRequestException('请选择提现银行卡');
    }

    // 创建提现记录
    await this.prisma.incomeRecord.create({
      data: {
        angelId,
        amount: -amount,
        type: '提现',
        description: `提现到${this.getMethodName(method)}`,
      },
    });

    // 扣减余额，并标记为已认证（首次提现成功 = 已认证）
    await this.prisma.angel.update({
      where: { id: angelId },
      data: { 
        balance: { decrement: amount },
        isVerified: true, // MVP: 首次提现成功即视为已实名认证
      },
    });

    // 开发环境模拟
    if (this.configService.isDevelopment) {
      return {
        success: true,
        message: `提现 ¥${amount.toFixed(2)} 申请成功，预计1-3个工作日到账（开发模式）`,
      };
    }

    // 生产环境：调用企业付款到零钱/银行卡 API
    // TODO: 实现真实提现逻辑

    return {
      success: true,
      message: `提现 ¥${amount.toFixed(2)} 申请成功，预计1-3个工作日到账`,
    };
  }

  /**
   * 获取天使收入明细
   */
  async getIncomeRecords(angelId: string, page = 1, pageSize = 20) {
    const skip = (page - 1) * pageSize;

    const [records, total] = await Promise.all([
      this.prisma.incomeRecord.findMany({
        where: { angelId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.incomeRecord.count({ where: { angelId } }),
    ]);

    // 获取天使余额
    const angel = await this.prisma.angel.findUnique({
      where: { id: angelId },
      select: { balance: true },
    });

    return {
      success: true,
      data: {
        balance: angel?.balance || 0,
        list: records,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  // ============ 私有方法 ============

  /**
   * 创建微信预支付订单
   */
  private async createWechatPrepay(order: any): Promise<string> {
    // TODO: 调用微信统一下单 API
    // https://pay.weixin.qq.com/wiki/doc/apiv3/apis/chapter3_5_1.shtml

    const mchId = this.configService.wechatMchId;
    const appId = this.configService.wechatAppId;

    // 构建请求参数
    const params = {
      appid: appId,
      mchid: mchId,
      description: `老人帮-${order.serviceType.name}`,
      out_trade_no: order.orderNo,
      notify_url: 'https://your-domain.com/api/payment/notify',
      amount: {
        total: Math.round(order.price * 100), // 转为分
        currency: 'CNY',
      },
      payer: {
        openid: 'user_openid', // TODO: 从用户信息获取
      },
    };

    // 调用微信 API（需要实现签名和请求）
    // const response = await this.wechatPayRequest('POST', '/v3/pay/transactions/jsapi', params);

    // 模拟返回
    return `prepay_id_${Date.now()}`;
  }

  /**
   * 生成小程序支付参数
   */
  private generatePayParams(prepayId: string): MiniProgramPayParams {
    const appId = this.configService.wechatAppId;
    const timeStamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = this.generateNonceStr();
    const packageStr = `prepay_id=${prepayId}`;

    // 生成签名
    const signStr = `${appId}\n${timeStamp}\n${nonceStr}\n${packageStr}\n`;
    // TODO: 使用私钥签名
    const paySign = 'mock_sign';

    return {
      appId,
      timeStamp,
      nonceStr,
      package: packageStr,
      signType: 'RSA',
      paySign,
    };
  }

  /**
   * 创建微信退款
   */
  private async createWechatRefund(order: any, reason: string): Promise<void> {
    // TODO: 调用微信退款 API
    // https://pay.weixin.qq.com/wiki/doc/apiv3/apis/chapter3_5_9.shtml
    console.log(`[退款] 订单 ${order.orderNo} 退款原因: ${reason}`);
  }

  /**
   * 生成随机字符串
   */
  private generateNonceStr(length = 32): string {
    return crypto.randomBytes(length / 2).toString('hex');
  }

  /**
   * 获取提现方式名称
   */
  private getMethodName(method: string): string {
    const names = {
      wechat: '微信钱包',
      alipay: '支付宝',
      bank: '银行卡',
    };
    return names[method] || method;
  }

  /**
   * 结算天使收入
   */
  private async settleAngelIncome(order: any): Promise<void> {
    if (!order.angelId) {
      console.log('[settleAngelIncome] 订单没有天使ID，跳过结算');
      return;
    }

    // 计算天使收入（这里简化为订单金额的80%，实际可以根据平台规则计算）
    const platformFeeRate = 0.2; // 平台抽成20%
    const angelIncome = order.price * (1 - platformFeeRate);

    console.log(`[settleAngelIncome] 订单 ${order.orderNo} 结算天使收入: ¥${angelIncome.toFixed(2)}`);

    try {
      // 创建收入记录
      await this.prisma.incomeRecord.create({
        data: {
          angelId: order.angelId,
          amount: angelIncome,
          type: '订单收入',
          description: `订单 ${order.orderNo} 服务收入`,
          orderId: order.id,
        },
      });

      // 更新天使余额和完成订单数
      await this.prisma.angel.update({
        where: { id: order.angelId },
        data: {
          balance: { increment: angelIncome },
          completedOrders: { increment: 1 },
        },
      });

      console.log(`[settleAngelIncome] 天使 ${order.angelId} 余额已增加 ¥${angelIncome.toFixed(2)}`);
    } catch (error) {
      console.error('[settleAngelIncome] 结算失败:', error);
      // 不抛出异常，避免影响支付流程，但需要后续人工处理
    }
  }
}
