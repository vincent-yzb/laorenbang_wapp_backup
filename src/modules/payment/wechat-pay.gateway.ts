import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { isIP } from 'node:net';
import { MiniProgramPayParams } from './dto/payment.dto';

// Ordinary direct merchants: official APIv3, not the partner or legacy batch-transfer API.
// https://pay.wechatpay.cn/doc/v3/merchant/4012791897 (JSAPI)
// https://pay.wechatpay.cn/doc/v3/merchant/4012791903 (refund)
// https://pay.wechatpay.cn/doc/v3/merchant/4012716434 (user-confirmed transfer)
const ORIGIN = 'https://api.mch.weixin.qq.com';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 300;
type Operation = 'create-payment' | 'query-payment' | 'close-payment' | 'create-refund' | 'query-refund' | 'create-transfer' | 'query-transfer';
type HeadersInput = Record<string, string | string[] | undefined>;
type JsonObject = Record<string, any>;
type FailureKind = 'TRANSPORT' | 'UNTRUSTED_RESPONSE' | 'INVALID_RESPONSE' | 'UPSTREAM_ERROR';

/** No upstream body, message, request URL, key or authorization header escapes this boundary. */
export class WechatPayGatewayError extends ServiceUnavailableException {
  constructor(
    public readonly operation: Operation,
    public readonly kind: FailureKind,
    public readonly upstreamStatus?: number,
    public readonly upstreamCode?: string,
  ) {
    super('微信支付服务暂时不可用，请稍后查询结果');
  }
}

export interface JsapiPaymentInput {
  outTradeNo: string;
  amountCents: number;
  description: string;
  payerOpenId: string;
  expiresAt?: Date;
}
export interface RefundInput {
  outRefundNo: string;
  outTradeNo: string;
  transactionId?: string;
  totalCents: number;
  reason: string;
}
export interface TransferInput {
  outBillNo: string;
  openid: string;
  amountCents: number;
  remark: string;
}
export interface VerifiedNotification {
  id: string;
  eventType: string;
  resource: JsonObject;
  digest: string;
}
interface MerchantConfig {
  appId: string;
  mchId: string;
  apiV3Key: Buffer;
  serial: string;
  privateKey: crypto.KeyObject;
  platformKeyId: string;
  platformKey: crypto.KeyObject;
  notifyUrl: string;
  refundNotifyUrl: string;
}
interface TransferConfig {
  sceneId: string;
  perception: string;
  reportInfos: Array<{ info_type: string; info_content: string }>;
  notifyUrl: string;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}
function cents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 100_000_000;
}
function identifier(value: unknown, max = 32): value is string {
  return typeof value === 'string' && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
}
function validNotifyUrl(value: string, path: string): boolean {
  try {
    const url = new URL(value);
    return value === value.trim() && value.length <= 256 && url.protocol === 'https:' &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === path &&
      isIP(url.hostname.replace(/^\[|\]$/g, '')) === 0 && url.hostname.includes('.') &&
      !url.hostname.endsWith('.local') && !url.hostname.endsWith('.localhost');
  } catch { return false; }
}
function decodeBase64(value: string, maximum = 65_536): Buffer | undefined {
  if (!value || value.length > maximum || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : undefined;
}
function rsaKey(value: string, privateKey: boolean): crypto.KeyObject | undefined {
  try {
    const pem = decodeBase64(value);
    if (!pem) return;
    const label = privateKey ? /-----BEGIN (?:RSA )?PRIVATE KEY-----/ : /-----BEGIN (?:RSA )?PUBLIC KEY-----/;
    if (!label.test(pem.toString('utf8'))) return;
    const key = privateKey ? crypto.createPrivateKey(pem) : crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return;
    return key;
  } catch { return; }
}
function parseObject(body: Buffer): JsonObject {
  const value: unknown = JSON.parse(body.toString('utf8'));
  if (!isObject(value)) throw new Error('shape');
  return value;
}

@Injectable()
export class WechatPayGateway {
  configurationStatus(): { enabled: boolean; missing: string[] } {
    const { enabled, missing } = this.readConfiguration();
    return { enabled, missing };
  }

  isConfigured(): boolean {
    const status = this.readConfiguration();
    return status.enabled && status.missing.length === 0;
  }

  transferIsConfigured(): boolean {
    return this.isConfigured() && process.env.WECHAT_TRANSFER_ENABLED === 'true' && this.readTransferConfiguration().missing.length === 0;
  }

  async createJsapiPayment(input: JsapiPaymentInput): Promise<{ prepayId: string; payParams: MiniProgramPayParams }> {
    const config = this.requireConfiguration();
    if (!identifier(input.outTradeNo) || !cents(input.amountCents) || !nonempty(input.description, 127) ||
      Buffer.byteLength(input.description, 'utf8') > 127 || !nonempty(input.payerOpenId, 128)) {
      throw new BadRequestException('支付订单参数无效');
    }
    if (input.expiresAt !== undefined && (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= Date.now())) {
      throw new BadRequestException('支付有效期无效');
    }
    const body: JsonObject = {
      appid: config.appId, mchid: config.mchId, out_trade_no: input.outTradeNo,
      description: input.description, notify_url: config.notifyUrl,
      amount: { total: input.amountCents, currency: 'CNY' }, payer: { openid: input.payerOpenId },
    };
    if (input.expiresAt) body.time_expire = input.expiresAt.toISOString();
    const response = await this.request('create-payment', 'POST', '/v3/pay/transactions/jsapi', body, config);
    if (!identifier(response.prepay_id, 64)) throw new WechatPayGatewayError('create-payment', 'INVALID_RESPONSE');
    return { prepayId: response.prepay_id, payParams: this.buildMiniProgramPayParams(response.prepay_id) };
  }

  /** Re-sign a persisted prepay ID locally; never creates another upstream payment. */
  buildMiniProgramPayParams(prepayId: string): MiniProgramPayParams {
    const config = this.requireConfiguration();
    if (!identifier(prepayId, 64)) throw new BadRequestException('预支付标识无效');
    const timeStamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = crypto.randomBytes(16).toString('hex');
    const packageValue = `prepay_id=${prepayId}`;
    const paySign = crypto.sign('RSA-SHA256', Buffer.from(`${config.appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`), config.privateKey).toString('base64');
    return { appId: config.appId, timeStamp, nonceStr, package: packageValue, signType: 'RSA', paySign };
  }

  async queryPayment(outTradeNo: string): Promise<JsonObject> {
    const config = this.requireConfiguration();
    if (!identifier(outTradeNo)) throw new BadRequestException('支付单号无效');
    const response = await this.request('query-payment', 'GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(config.mchId)}`, undefined, config);
    const amount = response.amount;
    // Official NOTPAY/CLOSED responses may omit amount and payer. A SUCCESS receipt must carry money.
    const invalidAmount = amount !== undefined && (!isObject(amount) ||
      (amount.total !== undefined && !cents(amount.total)) || (amount.currency !== undefined && amount.currency !== 'CNY') ||
      (amount.payer_total !== undefined && (!Number.isSafeInteger(amount.payer_total) || amount.payer_total < 0 ||
        (amount.total !== undefined && amount.payer_total > amount.total))));
    if (response.out_trade_no !== outTradeNo || response.appid !== config.appId || response.mchid !== config.mchId ||
      !nonempty(response.trade_state, 64) || invalidAmount ||
      (response.trade_state === 'SUCCESS' && (!isObject(amount) || !cents(amount.total) || amount.currency !== 'CNY'))) {
      throw new WechatPayGatewayError('query-payment', 'INVALID_RESPONSE');
    }
    return response;
  }

  async closePayment(outTradeNo: string): Promise<void> {
    const config = this.requireConfiguration();
    if (!identifier(outTradeNo)) throw new BadRequestException('支付单号无效');
    await this.request('close-payment', 'POST', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`, { mchid: config.mchId }, config, true);
  }

  async createRefund(input: RefundInput): Promise<JsonObject> {
    const config = this.requireConfiguration();
    if (!identifier(input.outRefundNo, 64) || !identifier(input.outTradeNo) ||
      (input.transactionId !== undefined && !identifier(input.transactionId)) || !cents(input.totalCents) ||
      !nonempty(input.reason, 80) || Buffer.byteLength(input.reason, 'utf8') > 80) {
      throw new BadRequestException('退款参数无效');
    }
    const body: JsonObject = {
      out_refund_no: input.outRefundNo, reason: input.reason, notify_url: config.refundNotifyUrl,
      amount: { total: input.totalCents, refund: input.totalCents, currency: 'CNY' },
      ...(input.transactionId ? { transaction_id: input.transactionId } : { out_trade_no: input.outTradeNo }),
    };
    const response = await this.request('create-refund', 'POST', '/v3/refund/domestic/refunds', body, config);
    this.assertRefund(response, input.outRefundNo, 'create-refund');
    if (response.out_trade_no !== input.outTradeNo || (input.transactionId && response.transaction_id !== input.transactionId) ||
      response.amount.total !== input.totalCents || response.amount.refund !== input.totalCents) {
      throw new WechatPayGatewayError('create-refund', 'INVALID_RESPONSE');
    }
    return response;
  }

  async queryRefund(outRefundNo: string): Promise<JsonObject> {
    const config = this.requireConfiguration();
    if (!identifier(outRefundNo, 64)) throw new BadRequestException('退款单号无效');
    const response = await this.request('query-refund', 'GET', `/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`, undefined, config);
    this.assertRefund(response, outRefundNo, 'query-refund');
    return response;
  }

  async createTransfer(input: TransferInput): Promise<JsonObject> {
    const config = this.requireConfiguration();
    const transfer = this.requireTransferConfiguration();
    // This interface has no verified recipient name. Large transfers require encrypted user_name.
    if (!identifier(input.outBillNo) || !/^[A-Za-z0-9]+$/.test(input.outBillNo) || !nonempty(input.openid, 64) ||
      !cents(input.amountCents) || input.amountCents >= 200_000 || !nonempty(input.remark, 32) || [...input.remark].length > 32) {
      throw new BadRequestException('转账参数无效，当前仅支持小于2000元的转账');
    }
    const response = await this.request('create-transfer', 'POST', '/v3/fund-app/mch-transfer/transfer-bills', {
      appid: config.appId, out_bill_no: input.outBillNo, transfer_scene_id: transfer.sceneId,
      openid: input.openid, transfer_amount: input.amountCents, transfer_remark: input.remark,
      user_recv_perception: transfer.perception, transfer_scene_report_infos: transfer.reportInfos, notify_url: transfer.notifyUrl,
    }, config);
    this.assertTransfer(response, input.outBillNo, 'create-transfer');
    if (response.transfer_amount !== undefined && response.transfer_amount !== input.amountCents) throw new WechatPayGatewayError('create-transfer', 'INVALID_RESPONSE');
    return response;
  }

  async queryTransfer(outBillNo: string): Promise<JsonObject> {
    const config = this.requireConfiguration();
    this.requireTransferConfiguration();
    if (!identifier(outBillNo) || !/^[A-Za-z0-9]+$/.test(outBillNo)) throw new BadRequestException('转账单号无效');
    const response = await this.request('query-transfer', 'GET', `/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/${encodeURIComponent(outBillNo)}`, undefined, config);
    this.assertTransfer(response, outBillNo, 'query-transfer');
    if (!cents(response.transfer_amount) || response.appid !== config.appId ||
      response.mch_id !== config.mchId) throw new WechatPayGatewayError('query-transfer', 'INVALID_RESPONSE');
    return response;
  }

  /** Stateless cryptographic verification. The durable business inbox deduplicates id/digest. */
  verifyNotification(rawBody: Buffer, headers: HeadersInput): VerifiedNotification {
    const config = this.requireConfiguration();
    try {
      if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > MAX_BODY_BYTES) throw new Error('body');
      this.verifySignature(rawBody, headers, config);
      const envelope = parseObject(rawBody);
      if (!nonempty(envelope.id, 128) || !nonempty(envelope.event_type, 128) || envelope.resource_type !== 'encrypt-resource' ||
        !isObject(envelope.resource) || envelope.resource.algorithm !== 'AEAD_AES_256_GCM') throw new Error('shape');
      const resource = envelope.resource;
      const cipherBytes = typeof resource.ciphertext === 'string' ? decodeBase64(resource.ciphertext, MAX_BODY_BYTES) : undefined;
      if (!cipherBytes || cipherBytes.length <= 16 || !nonempty(resource.nonce, 32) ||
        (resource.associated_data !== undefined && (typeof resource.associated_data !== 'string' || resource.associated_data.length > 256))) throw new Error('cipher');
      const decipher = crypto.createDecipheriv('aes-256-gcm', config.apiV3Key, Buffer.from(resource.nonce, 'utf8'));
      decipher.setAuthTag(cipherBytes.subarray(-16));
      decipher.setAAD(Buffer.from(resource.associated_data ?? '', 'utf8'));
      const decrypted = Buffer.concat([decipher.update(cipherBytes.subarray(0, -16)), decipher.final()]);
      return { id: envelope.id, eventType: envelope.event_type, resource: parseObject(decrypted), digest: crypto.createHash('sha256').update(rawBody).digest('hex') };
    } catch {
      throw new BadRequestException('微信支付通知验签或解密失败');
    }
  }

  private readConfiguration(): { enabled: boolean; missing: string[]; config?: MerchantConfig } {
    const env = process.env;
    const missing: string[] = [];
    const appId = env.WECHAT_APPID ?? '', mchId = env.WECHAT_PAY_MCH_ID ?? '';
    const apiV3Key = Buffer.from(env.WECHAT_PAY_API_V3_KEY ?? '', 'utf8');
    const serial = env.WECHAT_PAY_MERCHANT_SERIAL ?? '', platformKeyId = env.WECHAT_PAY_PLATFORM_KEY_ID ?? '';
    const privateKey = rsaKey(env.WECHAT_PAY_PRIVATE_KEY_BASE64 ?? '', true);
    const platformKey = rsaKey(env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_BASE64 ?? '', false);
    const notifyUrl = env.WECHAT_PAY_NOTIFY_URL ?? '', refundNotifyUrl = env.WECHAT_REFUND_NOTIFY_URL ?? '';
    if (!/^wx[a-fA-F0-9]{16}$/.test(appId)) missing.push('WECHAT_APPID');
    if (!/^\d{8,32}$/.test(mchId)) missing.push('WECHAT_PAY_MCH_ID');
    if (apiV3Key.length !== 32) missing.push('WECHAT_PAY_API_V3_KEY');
    if (!/^[a-fA-F0-9]{1,64}$/.test(serial)) missing.push('WECHAT_PAY_MERCHANT_SERIAL');
    if (!privateKey) missing.push('WECHAT_PAY_PRIVATE_KEY_BASE64');
    if (!/^PUB_KEY_ID_\d+$/.test(platformKeyId)) missing.push('WECHAT_PAY_PLATFORM_KEY_ID');
    if (!platformKey) missing.push('WECHAT_PAY_PLATFORM_PUBLIC_KEY_BASE64');
    if (!validNotifyUrl(notifyUrl, '/api/payment/notify')) missing.push('WECHAT_PAY_NOTIFY_URL');
    if (!validNotifyUrl(refundNotifyUrl, '/api/payment/refund-notify')) missing.push('WECHAT_REFUND_NOTIFY_URL');
    return { enabled: env.WECHAT_PAY_ENABLED === 'true', missing,
      config: missing.length === 0 ? { appId, mchId, apiV3Key, serial, privateKey: privateKey!, platformKeyId, platformKey: platformKey!, notifyUrl, refundNotifyUrl } : undefined };
  }

  private requireConfiguration(): MerchantConfig {
    const { enabled, missing, config } = this.readConfiguration();
    if (!enabled || missing.length || !config) throw new ServiceUnavailableException('微信支付尚未配置或未启用');
    return config;
  }

  private readTransferConfiguration(): { missing: string[]; config?: TransferConfig } {
    const env = process.env, missing: string[] = [];
    const sceneId = env.WECHAT_TRANSFER_SCENE_ID ?? '', perception = env.WECHAT_TRANSFER_USER_RECV_PERCEPTION ?? '';
    const notifyUrl = env.WECHAT_TRANSFER_NOTIFY_URL ?? '';
    let reportInfos: unknown;
    try { reportInfos = JSON.parse(env.WECHAT_TRANSFER_SCENE_REPORT_INFOS_JSON ?? ''); } catch { /* missing below */ }
    if (!/^\d{1,36}$/.test(sceneId)) missing.push('WECHAT_TRANSFER_SCENE_ID');
    if (!nonempty(perception, 64)) missing.push('WECHAT_TRANSFER_USER_RECV_PERCEPTION');
    if (!validNotifyUrl(notifyUrl, '/api/payment/transfer-notify')) missing.push('WECHAT_TRANSFER_NOTIFY_URL');
    if (!Array.isArray(reportInfos) || reportInfos.length === 0 || reportInfos.length > 20 || reportInfos.some(info =>
      !isObject(info) || Object.keys(info).some(key => !['info_type', 'info_content'].includes(key)) ||
      !nonempty(info.info_type, 15) || !nonempty(info.info_content, 32))) missing.push('WECHAT_TRANSFER_SCENE_REPORT_INFOS_JSON');
    return { missing, config: missing.length === 0 ? { sceneId, perception, notifyUrl, reportInfos: reportInfos as TransferConfig['reportInfos'] } : undefined };
  }

  private requireTransferConfiguration(): TransferConfig {
    const { missing, config } = this.readTransferConfiguration();
    if (process.env.WECHAT_TRANSFER_ENABLED !== 'true' || missing.length || !config) throw new ServiceUnavailableException('商家转账尚未配置或未启用');
    return config;
  }

  private verifySignature(body: Buffer, headers: HeadersInput, config: MerchantConfig): void {
    const header = (name: string): string => {
      const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
      if (entries.length !== 1 || typeof entries[0][1] !== 'string') throw new Error('header');
      return entries[0][1];
    };
    const timestamp = header('wechatpay-timestamp'), nonce = header('wechatpay-nonce');
    const serial = header('wechatpay-serial'), signature = header('wechatpay-signature');
    const signatureBytes = decodeBase64(signature);
    if (!/^\d{10,12}$/.test(timestamp) || !nonempty(nonce, 128) || serial !== config.platformKeyId || !signatureBytes ||
      Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) throw new Error('signature');
    const message = Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), body, Buffer.from('\n')]);
    if (!crypto.verify('RSA-SHA256', message, config.platformKey, signatureBytes)) throw new Error('signature');
  }

  private async request(operation: Operation, method: 'GET' | 'POST', path: string, data: JsonObject | undefined, config: MerchantConfig, noContent = false): Promise<JsonObject> {
    const body = data === undefined ? '' : JSON.stringify(data);
    const timestamp = Math.floor(Date.now() / 1000).toString(), nonce = crypto.randomBytes(16).toString('hex');
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`), config.privateKey).toString('base64');
    let response: Response, raw: Buffer;
    try {
      response = await fetch(`${ORIGIN}${path}`, {
        method, redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Wechatpay-Serial': config.platformKeyId,
          Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${config.serial}"` },
        ...(data === undefined ? {} : { body }),
      });
      if (response.status >= 300 && response.status < 400) throw new Error('redirect');
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const result = await reader.read();
            if (result.done) break;
            size += result.value.length;
            if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('body'); }
            chunks.push(result.value);
          }
        } finally { reader.releaseLock(); }
      }
      raw = Buffer.concat(chunks);
    } catch {
      throw new WechatPayGatewayError(operation, 'TRANSPORT');
    }
    try { this.verifySignature(raw, Object.fromEntries(response.headers.entries()), config); }
    catch { throw new WechatPayGatewayError(operation, 'UNTRUSTED_RESPONSE', response.status); }
    let parsed: JsonObject;
    try { parsed = raw.length === 0 ? {} : parseObject(raw); }
    catch { throw new WechatPayGatewayError(operation, 'INVALID_RESPONSE', response.status); }
    if (!response.ok) {
      const code = typeof parsed.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(parsed.code) ? parsed.code : undefined;
      throw new WechatPayGatewayError(operation, 'UPSTREAM_ERROR', response.status, code);
    }
    if (noContent ? response.status !== 204 || raw.length !== 0 : response.status !== 200 || raw.length === 0) {
      throw new WechatPayGatewayError(operation, 'INVALID_RESPONSE', response.status);
    }
    return parsed;
  }

  private assertRefund(response: JsonObject, outRefundNo: string, operation: Operation): void {
    if (response.out_refund_no !== outRefundNo || !nonempty(response.refund_id, 64) || !nonempty(response.status, 64) ||
      !isObject(response.amount) || !cents(response.amount.total) || !cents(response.amount.refund) ||
      response.amount.refund > response.amount.total || (response.amount.currency !== undefined && response.amount.currency !== 'CNY')) {
      throw new WechatPayGatewayError(operation, 'INVALID_RESPONSE');
    }
  }

  private assertTransfer(response: JsonObject, outBillNo: string, operation: Operation): void {
    if (response.out_bill_no !== outBillNo || !nonempty(response.transfer_bill_no, 64) || !nonempty(response.state, 64) ||
      // Official query responses omit package_info, even while awaiting user confirmation.
      (operation === 'create-transfer' && response.state === 'WAIT_USER_CONFIRM' && !nonempty(response.package_info, 4096))) throw new WechatPayGatewayError(operation, 'INVALID_RESPONSE');
  }
}
