import { IsString, IsNotEmpty, IsNumber, IsEnum, IsOptional, Min } from 'class-validator';

/**
 * 提现方式枚举
 */
export enum WithdrawMethod {
  WECHAT = 'wechat',   // 微信钱包
  ALIPAY = 'alipay',   // 支付宝
  BANK = 'bank',       // 银行卡
}

/**
 * 创建支付 DTO
 */
export class CreatePaymentDto {
  @IsNotEmpty({ message: '订单ID不能为空' })
  @IsString()
  orderId: string;
}

/**
 * 退款申请 DTO
 */
export class RefundDto {
  @IsNotEmpty({ message: '订单ID不能为空' })
  @IsString()
  orderId: string;

  @IsNotEmpty({ message: '退款原因不能为空' })
  @IsString()
  reason: string;
}

/**
 * 天使提现 DTO
 */
export class WithdrawDto {
  @IsNotEmpty({ message: '提现金额不能为空' })
  @IsNumber()
  @Min(10, { message: '提现金额最低10元' })
  amount: number;

  @IsEnum(WithdrawMethod, { message: '提现方式无效' })
  method: WithdrawMethod;

  @IsOptional()
  @IsString()
  bankCardId?: string; // 银行卡ID（银行卡提现时必填）
}

/**
 * 微信支付回调
 */
export interface WechatPayCallback {
  id: string;
  create_time: string;
  resource_type: string;
  event_type: string;
  resource: {
    original_type: string;
    algorithm: string;
    ciphertext: string;
    associated_data: string;
    nonce: string;
  };
}

/**
 * 小程序支付参数
 */
export interface MiniProgramPayParams {
  appId: string;
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
}

