import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as crypto from 'node:crypto';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { WechatPayGateway, WechatPayGatewayError } from '../src/modules/payment/wechat-pay.gateway';

// Ephemeral keys exist only in this process. No merchant credentials or network are used.
const merchant = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyId = 'PUB_KEY_ID_1000000001';
const appId = 'wx1234567890abcdef';
const mchId = '1900000001';
const apiKey = 'k'.repeat(32);
const configured: Record<string, string> = {
  WECHAT_PAY_ENABLED: 'true', WECHAT_APPID: appId, WECHAT_PAY_MCH_ID: mchId,
  WECHAT_PAY_API_V3_KEY: apiKey, WECHAT_PAY_MERCHANT_SERIAL: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
  WECHAT_PAY_PRIVATE_KEY_BASE64: Buffer.from(merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).toString('base64'),
  WECHAT_PAY_PLATFORM_KEY_ID: keyId,
  WECHAT_PAY_PLATFORM_PUBLIC_KEY_BASE64: Buffer.from(platform.publicKey.export({ type: 'spki', format: 'pem' }) as string).toString('base64'),
  WECHAT_PAY_NOTIFY_URL: 'https://example.test/api/payment/notify',
  WECHAT_REFUND_NOTIFY_URL: 'https://example.test/api/payment/refund-notify',
  WECHAT_TRANSFER_ENABLED: 'false', WECHAT_TRANSFER_SCENE_ID: '1006',
  WECHAT_TRANSFER_USER_RECV_PERCEPTION: '劳务报酬',
  WECHAT_TRANSFER_SCENE_REPORT_INFOS_JSON: JSON.stringify([{ info_type: '报酬类型', info_content: '测试服务' }]),
  WECHAT_TRANSFER_NOTIFY_URL: 'https://example.test/api/payment/transfer-notify',
};

function setup(t: any, overrides: Record<string, string | undefined> = {}) {
  const previous = Object.fromEntries(Object.keys(configured).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries({ ...configured, ...overrides })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let responder = async (_url: string, _init: RequestInit): Promise<Response> => { throw new Error('No response fixture installed'); };
  globalThis.fetch = (async (url: any, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return { gateway: new WechatPayGateway(), calls, respond: (callback: typeof responder) => { responder = callback; } };
}

function signedHeaders(body: Buffer, changes: { timestamp?: number; serial?: string; signer?: crypto.KeyObject } = {}) {
  const timestamp = String(changes.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto.sign('RSA-SHA256', Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), body, Buffer.from('\n')]), changes.signer ?? platform.privateKey).toString('base64');
  return { 'Wechatpay-Timestamp': timestamp, 'Wechatpay-Nonce': nonce, 'Wechatpay-Serial': changes.serial ?? keyId, 'Wechatpay-Signature': signature };
}
function response(data: any, status = 200, changes = {}) {
  const raw = data === undefined ? Buffer.alloc(0) : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  return new Response(status === 204 ? null : raw, { status, headers: signedHeaders(raw, changes) });
}
function notification(resource = { appid: appId, mchid: mchId, out_trade_no: 'ORDER1', transaction_id: 'WX1', trade_state: 'SUCCESS', amount: { total: 100, currency: 'CNY' } }) {
  const nonce = 'nonce1234567';
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(apiKey), Buffer.from(nonce));
  cipher.setAAD(Buffer.from('transaction'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(resource)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const body = Buffer.from(JSON.stringify({ id: 'event-under-test', event_type: 'TRANSACTION.SUCCESS', resource_type: 'encrypt-resource',
    resource: { algorithm: 'AEAD_AES_256_GCM', associated_data: 'transaction', nonce, ciphertext } }));
  return { body, headers: signedHeaders(body), resource };
}
const paymentInput = { outTradeNo: 'ORDER1', amountCents: 100, description: '测试服务', payerOpenId: 'synthetic-openid' };
const refundResult = { out_refund_no: 'REFUND1', refund_id: 'wx-refund-1', out_trade_no: 'ORDER1', transaction_id: 'WX1', status: 'PROCESSING', amount: { total: 100, refund: 100 } };

test('默认关闭、缺失或无效配置均503且零fetch，配置状态仅包含变量名', async t => {
  const f = setup(t, { WECHAT_PAY_ENABLED: undefined, WECHAT_PAY_API_V3_KEY: undefined });
  assert.equal(f.gateway.isConfigured(), false);
  assert.deepEqual(f.gateway.configurationStatus(), { enabled: false, missing: ['WECHAT_PAY_API_V3_KEY'] });
  await assert.rejects(f.gateway.createJsapiPayment(paymentInput), ServiceUnavailableException);
  assert.equal(f.calls.length, 0);
  process.env.WECHAT_PAY_ENABLED = 'TRUE';
  process.env.WECHAT_PAY_API_V3_KEY = apiKey;
  assert.equal(f.gateway.isConfigured(), false);
  await assert.rejects(f.gateway.queryPayment('ORDER1'), ServiceUnavailableException);
  process.env.WECHAT_PAY_ENABLED = 'true';
  process.env.WECHAT_PAY_PRIVATE_KEY_BASE64 = 'not-base64';
  assert.deepEqual(f.gateway.configurationStatus().missing, ['WECHAT_PAY_PRIVATE_KEY_BASE64']);
  assert.equal(f.calls.length, 0);
});

test('拒绝错误回调URL、长度错误APIv3密钥及把私钥误配为平台公钥', t => {
  const f = setup(t, { WECHAT_PAY_API_V3_KEY: '短密钥', WECHAT_PAY_NOTIFY_URL: 'http://localhost/api/payment/notify',
    WECHAT_REFUND_NOTIFY_URL: 'https://example.test/api/payment/refund-notify?token=example',
    WECHAT_PAY_PLATFORM_PUBLIC_KEY_BASE64: configured.WECHAT_PAY_PRIVATE_KEY_BASE64 });
  assert.deepEqual(new Set(f.gateway.configurationStatus().missing), new Set([
    'WECHAT_PAY_API_V3_KEY', 'WECHAT_PAY_PLATFORM_PUBLIC_KEY_BASE64', 'WECHAT_PAY_NOTIFY_URL', 'WECHAT_REFUND_NOTIFY_URL',
  ]));
  assert.equal(f.gateway.isConfigured(), false);
  assert.equal(f.calls.length, 0);
});

test('JSAPI请求及小程序参数分别使用正确RSA签名，配置金额为整数分', async t => {
  const f = setup(t);
  assert.equal(f.gateway.isConfigured(), true);
  f.respond(async (url, init) => {
    assert.equal(url, 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal);
    const headers = init.headers as Record<string, string>;
    const auth = Object.fromEntries([...headers.Authorization.matchAll(/([a-z_]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    assert.equal(auth.mchid, mchId);
    assert.equal(auth.serial_no, configured.WECHAT_PAY_MERCHANT_SERIAL);
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`POST\n/v3/pay/transactions/jsapi\n${auth.timestamp}\n${auth.nonce_str}\n${init.body}\n`), merchant.publicKey, Buffer.from(auth.signature, 'base64')));
    const body = JSON.parse(init.body as string);
    assert.deepEqual(body.amount, { total: 100, currency: 'CNY' });
    assert.deepEqual(body.payer, { openid: 'synthetic-openid' });
    assert.equal(body.appid, appId);
    return response({ prepay_id: 'synthetic-prepay' });
  });
  const result = await f.gateway.createJsapiPayment({ ...paymentInput, expiresAt: new Date(Date.now() + 60_000) });
  assert.equal(result.prepayId, 'synthetic-prepay');
  const p = result.payParams;
  assert.equal(p.package, 'prepay_id=synthetic-prepay');
  assert.equal(p.signType, 'RSA');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${p.appId}\n${p.timeStamp}\n${p.nonceStr}\n${p.package}\n`), merchant.publicKey, Buffer.from(p.paySign, 'base64')));
  assert.equal(f.calls.length, 1);
});

test('非法金额、单号或过期时间在发请求前拒绝', async t => {
  const f = setup(t);
  for (const amountCents of [NaN, Infinity, 0, -1, 1.01, 100_000_001, '100']) {
    await assert.rejects(f.gateway.createJsapiPayment({ ...paymentInput, amountCents } as any), BadRequestException);
  }
  await assert.rejects(f.gateway.createJsapiPayment({ ...paymentInput, outTradeNo: '../another/path' }), BadRequestException);
  await assert.rejects(f.gateway.createJsapiPayment({ ...paymentInput, expiresAt: new Date(0) }), BadRequestException);
  assert.equal(f.calls.length, 0);
});

test('复用持久化prepayId仅本地重签，禁用配置或非法标识仍拒绝', t => {
  const f = setup(t);
  const first = f.gateway.buildMiniProgramPayParams('existing-prepay');
  const second = f.gateway.buildMiniProgramPayParams('existing-prepay');
  assert.equal(first.package, 'prepay_id=existing-prepay');
  assert.notEqual(first.nonceStr, second.nonceStr);
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${first.appId}\n${first.timeStamp}\n${first.nonceStr}\n${first.package}\n`), merchant.publicKey, Buffer.from(first.paySign, 'base64')));
  assert.throws(() => f.gateway.buildMiniProgramPayParams('prepay\ninvalid'), BadRequestException);
  process.env.WECHAT_PAY_ENABLED = 'false';
  assert.throws(() => f.gateway.buildMiniProgramPayParams('existing-prepay'), ServiceUnavailableException);
  assert.equal(f.calls.length, 0);
});

test('查询签名包含query string，返回跨商户、跨订单或金额形状错误都拒绝', async t => {
  const f = setup(t);
  const valid = { appid: appId, mchid: mchId, out_trade_no: 'ORDER1', trade_state: 'SUCCESS', amount: { total: 100, payer_total: 80, currency: 'CNY' } };
  f.respond(async (url, init) => {
    const u = new URL(url);
    assert.equal(u.search, `?mchid=${mchId}`);
    const auth = Object.fromEntries([...(init.headers as any).Authorization.matchAll(/([a-z_]+)="([^"]*)"/g)].map((match: any) => [match[1], match[2]]));
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`GET\n${u.pathname}${u.search}\n${auth.timestamp}\n${auth.nonce_str}\n\n`), merchant.publicKey, Buffer.from(auth.signature as string, 'base64')));
    return response(valid);
  });
  assert.equal((await f.gateway.queryPayment('ORDER1')).trade_state, 'SUCCESS');
  for (const changes of [{ mchid: 'other' }, { appid: 'other' }, { out_trade_no: 'other' }, { amount: { total: '100', currency: 'CNY' } }, { amount: { total: 100, payer_total: 101, currency: 'CNY' } }]) {
    f.respond(async () => response({ ...valid, ...changes }));
    await assert.rejects(f.gateway.queryPayment('ORDER1'), error => error instanceof WechatPayGatewayError && error.kind === 'INVALID_RESPONSE');
  }
});

test('合法NOTPAY/CLOSED查询可省略金额，SUCCESS缺金额或未付款返回错误货币仍拒绝', async t => {
  const f = setup(t);
  for (const trade_state of ['NOTPAY', 'CLOSED']) {
    const unpaid = { appid: appId, mchid: mchId, out_trade_no: 'ORDER1', trade_state };
    f.respond(async () => response(unpaid));
    assert.deepEqual(await f.gateway.queryPayment('ORDER1'), unpaid);
    f.respond(async () => response({ ...unpaid, amount: { currency: 'USD' } }));
    await assert.rejects(f.gateway.queryPayment('ORDER1'), WechatPayGatewayError);
  }
  f.respond(async () => response({ appid: appId, mchid: mchId, out_trade_no: 'ORDER1', trade_state: 'SUCCESS' }));
  await assert.rejects(f.gateway.queryPayment('ORDER1'), WechatPayGatewayError);
});

test('HTTP错误也必须验签，仅可信安全错误码可交业务处理，不暴露raw body', async t => {
  const f = setup(t);
  f.respond(async () => response({ code: 'ORDERPAID', message: 'synthetic-private-detail' }, 400));
  await assert.rejects(f.gateway.createJsapiPayment(paymentInput), error => {
    assert.ok(error instanceof WechatPayGatewayError);
    assert.equal(error.kind, 'UPSTREAM_ERROR');
    assert.equal(error.upstreamCode, 'ORDERPAID');
    assert.equal(error.upstreamStatus, 400);
    assert.doesNotMatch(JSON.stringify(error), /synthetic-private-detail/);
    return true;
  });
  f.respond(async () => new Response(JSON.stringify({ code: 'ORDERPAID' }), { status: 400 }));
  await assert.rejects(f.gateway.createJsapiPayment(paymentInput), error => error instanceof WechatPayGatewayError && error.kind === 'UNTRUSTED_RESPONSE' && error.upstreamCode === undefined);
});

test('坏签名、未知平台key、过旧应答、非法JSON不能产生支付参数', async t => {
  const f = setup(t);
  for (const options of [{ signer: merchant.privateKey }, { serial: 'PUB_KEY_ID_999' }, { timestamp: Math.floor(Date.now() / 1000) - 301 }]) {
    f.respond(async () => response({ prepay_id: 'synthetic-prepay' }, 200, options));
    await assert.rejects(f.gateway.createJsapiPayment(paymentInput), error => error instanceof WechatPayGatewayError && error.kind === 'UNTRUSTED_RESPONSE');
  }
  f.respond(async () => response('not json'));
  await assert.rejects(f.gateway.createJsapiPayment(paymentInput), error => error instanceof WechatPayGatewayError && error.kind === 'INVALID_RESPONSE');
});

test('拒绝重定向；传输错误不自动重试下单或退款', async t => {
  const f = setup(t);
  f.respond(async () => new Response(null, { status: 302, headers: { Location: 'https://example.test/other' } }));
  await assert.rejects(f.gateway.createJsapiPayment(paymentInput), WechatPayGatewayError);
  assert.equal(f.calls.length, 1);
  f.respond(async () => { throw new Error('synthetic timeout'); });
  await assert.rejects(f.gateway.createRefund({ outRefundNo: 'REFUND1', outTradeNo: 'ORDER1', totalCents: 100, reason: '服务退款' }), WechatPayGatewayError);
  assert.equal(f.calls.length, 2);
});

test('关单只接受已验签204；全额退款使用唯一退款单号，受理PROCESSING原样保留', async t => {
  const f = setup(t);
  f.respond(async (url, init) => {
    assert.match(url, /\/ORDER1\/close$/);
    assert.deepEqual(JSON.parse(init.body as string), { mchid: mchId });
    return response(undefined, 204);
  });
  await f.gateway.closePayment('ORDER1');
  f.respond(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    assert.equal(body.transaction_id, 'WX1');
    assert.equal(body.out_trade_no, undefined);
    assert.equal(body.out_refund_no, 'REFUND1');
    assert.deepEqual(body.amount, { total: 100, refund: 100, currency: 'CNY' });
    return response(refundResult);
  });
  const created = await f.gateway.createRefund({ outRefundNo: 'REFUND1', outTradeNo: 'ORDER1', transactionId: 'WX1', totalCents: 100, reason: '服务退款' });
  assert.equal(created.status, 'PROCESSING');
  f.respond(async url => { assert.match(url, /\/refunds\/REFUND1$/); return response({ ...refundResult, status: 'SUCCESS' }); });
  assert.equal((await f.gateway.queryRefund('REFUND1')).status, 'SUCCESS');
});

test('退款应答金额不符和未签名关单204均不能当成功', async t => {
  const f = setup(t);
  f.respond(async () => response({ ...refundResult, amount: { total: 100, refund: 99 } }));
  await assert.rejects(f.gateway.createRefund({ outRefundNo: 'REFUND1', outTradeNo: 'ORDER1', totalCents: 100, reason: '退款' }), WechatPayGatewayError);
  f.respond(async () => new Response(null, { status: 204 }));
  await assert.rejects(f.gateway.closePayment('ORDER1'), error => error instanceof WechatPayGatewayError && error.kind === 'UNTRUSTED_RESPONSE');
});

test('通知按原始字节验签再AESGCM解密；合法重试提供相同id/digest供durable inbox幂等', t => {
  const f = setup(t), n = notification();
  const verified = f.gateway.verifyNotification(n.body, n.headers);
  assert.equal(verified.id, 'event-under-test');
  assert.equal(verified.eventType, 'TRANSACTION.SUCCESS');
  assert.deepEqual(verified.resource, n.resource);
  assert.equal(verified.digest, crypto.createHash('sha256').update(n.body).digest('hex'));
  assert.deepEqual(f.gateway.verifyNotification(n.body, n.headers), verified);
  assert.throws(() => f.gateway.verifyNotification(Buffer.concat([n.body, Buffer.from(' ')]), n.headers), BadRequestException);
  assert.equal(f.calls.length, 0);
});

test('通知拒绝过期/未来重放、key ID或签名不符、重复header和签名探测流量', t => {
  const f = setup(t), n = notification();
  for (const header of [
    signedHeaders(n.body, { timestamp: Math.floor(Date.now() / 1000) - 301 }),
    signedHeaders(n.body, { timestamp: Math.floor(Date.now() / 1000) + 301 }),
    signedHeaders(n.body, { serial: 'PUB_KEY_ID_999' }),
    signedHeaders(n.body, { signer: merchant.privateKey }),
    { ...n.headers, 'wechatpay-serial': keyId },
    { ...n.headers, 'Wechatpay-Signature': 'WECHATPAY/SIGNTEST/test' },
    { ...n.headers, 'Wechatpay-Nonce': [n.headers['Wechatpay-Nonce']] },
  ]) assert.throws(() => f.gateway.verifyNotification(n.body, header), BadRequestException);
});

test('即使外层签名可信，密文/associated_data篡改、错误API密钥和错误JSON形状也不解密成功', t => {
  const f = setup(t), n = notification();
  for (const change of [{ associated_data: 'tampered' }, { algorithm: 'AES-CBC' }, { ciphertext: 'AAAA' }]) {
    const envelope = JSON.parse(n.body.toString());
    Object.assign(envelope.resource, change);
    const body = Buffer.from(JSON.stringify(envelope));
    assert.throws(() => f.gateway.verifyNotification(body, signedHeaders(body)), BadRequestException);
  }
  process.env.WECHAT_PAY_API_V3_KEY = 'z'.repeat(32);
  assert.throws(() => f.gateway.verifyNotification(n.body, n.headers), BadRequestException);
  process.env.WECHAT_PAY_API_V3_KEY = apiKey;
  const array = Buffer.from('[]');
  assert.throws(() => f.gateway.verifyNotification(array, signedHeaders(array)), BadRequestException);
});

test('转账独立关闭且零fetch；启用后仍拒绝>=2000元和缺失场景资料', async t => {
  const f = setup(t);
  const input = { outBillNo: 'TRANSFER1', openid: 'synthetic-openid', amountCents: 100, remark: '测试服务收入' };
  assert.equal(f.gateway.transferIsConfigured(), false);
  await assert.rejects(f.gateway.createTransfer(input), ServiceUnavailableException);
  process.env.WECHAT_TRANSFER_ENABLED = 'true';
  assert.equal(f.gateway.transferIsConfigured(), true);
  await assert.rejects(f.gateway.createTransfer({ ...input, amountCents: 200_000 }), BadRequestException);
  process.env.WECHAT_TRANSFER_SCENE_REPORT_INFOS_JSON = '[{"info_type":"报酬类型"}]';
  assert.equal(f.gateway.transferIsConfigured(), false);
  await assert.rejects(f.gateway.createTransfer(input), ServiceUnavailableException);
  assert.equal(f.calls.length, 0);
});

test('新版转账WAIT_USER_CONFIRM只保留待确认状态与package，不冒充到账，查询保留终态', async t => {
  const f = setup(t, { WECHAT_TRANSFER_ENABLED: 'true' });
  const pending = { out_bill_no: 'TRANSFER1', transfer_bill_no: 'wx-transfer-1', state: 'WAIT_USER_CONFIRM', package_info: 'synthetic-package' };
  f.respond(async (url, init) => {
    assert.equal(url, 'https://api.mch.weixin.qq.com/v3/fund-app/mch-transfer/transfer-bills');
    const body = JSON.parse(init.body as string);
    assert.equal(body.transfer_amount, 100);
    assert.equal(body.transfer_scene_id, '1006');
    assert.equal(body.user_name, undefined);
    return response(pending);
  });
  assert.deepEqual(await f.gateway.createTransfer({ outBillNo: 'TRANSFER1', openid: 'synthetic-openid', amountCents: 100, remark: '测试服务收入' }), pending);
  f.respond(async url => { assert.match(url, /\/out-bill-no\/TRANSFER1$/); return response({ ...pending, state: 'SUCCESS', transfer_amount: 100, appid: appId, mch_id: mchId }); });
  assert.equal((await f.gateway.queryTransfer('TRANSFER1')).state, 'SUCCESS');
});

test('转账查询待用户确认不要求创建时才返回的package_info，但必须绑定商户与AppID', async t => {
  const f = setup(t, { WECHAT_TRANSFER_ENABLED: 'true' });
  const pending = { out_bill_no: 'TRANSFER1', transfer_bill_no: 'wx-transfer-1', state: 'WAIT_USER_CONFIRM', transfer_amount: 100, appid: appId, mch_id: mchId };
  f.respond(async () => response(pending));
  assert.deepEqual(await f.gateway.queryTransfer('TRANSFER1'), pending);
  for (const missing of ['appid', 'mch_id']) {
    const invalid = { ...pending };
    delete invalid[missing];
    f.respond(async () => response(invalid));
    await assert.rejects(f.gateway.queryTransfer('TRANSFER1'), WechatPayGatewayError);
  }
  f.respond(async () => response(pending));
  await assert.rejects(f.gateway.createTransfer({ outBillNo: 'TRANSFER1', openid: 'synthetic-openid', amountCents: 100, remark: '测试服务收入' }), WechatPayGatewayError);
});
