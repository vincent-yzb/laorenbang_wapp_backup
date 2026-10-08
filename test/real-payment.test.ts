import 'reflect-metadata';
import { test, TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { PaymentService } from '../src/modules/payment/payment.service';
import { PaymentController } from '../src/modules/payment/payment.controller';
import { PaymentOperatorGuard } from '../src/modules/payment/payment-operator.guard';
import { serializeMoney } from '../src/modules/payment/money-serialization.interceptor';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const appId = 'wx0123456789abcdef';
const merchantId = '1900000001';
const payer = 'offline-synthetic-payer';
const clone = <T>(value: T): T => structuredClone(value);

function environment(t: TestContext, overrides: Record<string, string | undefined> = {}) {
  const values = { NODE_ENV: 'production', ALLOW_MOCK_PAYMENT: 'false', WECHAT_PAY_ENABLED: 'true',
    WECHAT_APPID: appId, WECHAT_PAY_MCH_ID: merchantId, PAYMENT_OPERATOR_TOKEN: undefined, ...overrides };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
}

function matches(row: any, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((item: any) => matches(row, item));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(row[key]);
      if ('lte' in value) return row[key] !== null && row[key] <= value.lte;
      if ('gte' in value) return row[key] >= value.gte;
    }
    return row[key] === value;
  });
}

/** Transactional test double for business validation/rollback. Real contention is tested with PostgreSQL. */
class MemoryDatabase {
  state: Record<string, any[]>;
  gate = Promise.resolve();
  reads = 0;
  writes = 0;
  failAt?: string;
  user: any; order: any; paymentAttempt: any; paymentEvent: any; incomeRecord: any; angel: any; orderTimeline: any; refund: any;

  constructor() {
    this.state = {
      user: [{ id: 'child', wechatOpenId: payer }],
      order: [{ id: 'order', orderNo: 'synthetic-order', userId: 'child', elderlyId: 'elder', angelId: 'angel',
        status: 'PENDING_CONFIRM', isPaid: false, price: 123.45, priceCents: 12345n,
        paidAttemptId: null, paymentOrigin: null, paymentMethod: null, completedAt: null }],
      angel: [{ id: 'angel', balance: 12.34, balanceCents: 1234n, openingBalanceCents: 1234n,
        nonWithdrawableBalanceCents: 1234n, frozenBalanceCents: 0n, completedOrders: 0 }],
      paymentAttempt: [], paymentEvent: [], incomeRecord: [], orderTimeline: [], refund: [],
    };
    Object.assign(this, this.models(() => this.state));
  }

  private models(state: () => Record<string, any[]>, transactional = false) {
    return Object.fromEntries(Object.keys(this.state).map(name => {
      const find = ({ where = {}, orderBy, skip = 0, take, select }: any = {}) => {
        this.reads++;
        let rows = state()[name].filter(row => matches(row, where));
        if (orderBy) {
          const [key, direction] = Object.entries(orderBy)[0];
          rows = rows.slice().sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (direction === 'desc' ? -1 : 1));
        }
        rows = rows.slice(skip, take === undefined ? undefined : skip + take);
        return clone(select ? rows.map(row => Object.fromEntries(Object.keys(select).filter(key => select[key]).map(key => [key, row[key]]))) : rows);
      };
      const change = (row: any, data: any) => {
        for (const [key, value] of Object.entries(data)) row[key] = value && typeof value === 'object' && 'increment' in value
          ? row[key] + (value as any).increment : clone(value);
      };
      const write = async (operation: string) => {
        if (!transactional) await this.gate;
        this.writes++;
        if (this.failAt === `${name}.${operation}`) { this.failAt = undefined; throw new Error('Injected local database failure'); }
      };
      return [name, {
        findUnique: async (args: any) => find(args)[0] ?? null,
        findFirst: async (args: any) => find(args)[0] ?? null,
        findMany: async (args: any) => find(args),
        count: async (args: any) => find(args).length,
        create: async ({ data }: any) => {
          await write('create');
          const rows = state()[name];
          const unique = name === 'paymentAttempt' ? ['outTradeNo', 'activeOrderId', 'transactionId']
            : name === 'paymentEvent' ? ['eventId'] : name === 'incomeRecord' ? ['entryKey'] : ['id'];
          if (unique.some(key => data[key] != null && rows.some(row => row[key] === data[key]))) throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
          const row = { id: `${name}-${rows.length + 1}`, createdAt: new Date(), prepayId: null, transactionId: null, ...clone(data) };
          rows.push(row); return clone(row);
        },
        updateMany: async ({ where, data }: any) => {
          await write('updateMany');
          const rows = state()[name].filter(row => matches(row, where)); rows.forEach(row => change(row, data)); return { count: rows.length };
        },
        update: async ({ where, data }: any) => {
          await write('update');
          const row = state()[name].find(item => matches(item, where)); if (!row) throw new Error('Missing row');
          change(row, data); return clone(row);
        },
      }];
    }));
  }

  async $transaction<T>(operation: (tx: any) => Promise<T>): Promise<T> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const draft = clone(this.state);
    try {
      const result = await operation({ ...this.models(() => draft, true), $queryRaw: async () => [] });
      this.state = draft; return result;
    } finally { release(); }
  }
}

function fixture(t: TestContext, overrides: Record<string, string | undefined> = {}) {
  environment(t, overrides);
  const db = new MemoryDatabase();
  const calls = { create: 0, query: 0, close: 0, sign: 0 };
  let configured = true;
  let createError = false;
  let queryError = false;
  let queryResource: Record<string, any> | undefined;
  const payParams = { appId, timeStamp: '1', nonceStr: 'synthetic', package: 'prepay_id=synthetic', signType: 'RSA' as const, paySign: 'synthetic' };
  const gateway = {
    isConfigured: () => configured,
    createJsapiPayment: async () => { calls.create++; if (createError) throw new Error('Synthetic timeout'); return { prepayId: 'synthetic', payParams }; },
    buildMiniProgramPayParams: () => { calls.sign++; return payParams; },
    queryPayment: async () => { calls.query++; if (queryError) throw new Error('Synthetic timeout'); return clone(queryResource ?? success()); },
    closePayment: async () => { calls.close++; },
    verifyNotification: (body: Buffer) => JSON.parse(body.toString()), // Cryptography is tested in wechat-pay.gateway.test.ts.
  };
  const service = new PaymentService(db as any, {} as any, gateway as any);
  const success = (changes: Record<string, any> = {}) => ({ out_trade_no: db.state.paymentAttempt[0]?.outTradeNo,
    appid: appId, mchid: merchantId, trade_state: 'SUCCESS', transaction_id: '42000000000000000001',
    amount: { total: 12345, currency: 'CNY' }, payer: { openid: payer }, success_time: new Date().toISOString(), ...changes });
  const notify = (resource = success(), id = 'synthetic-event', digest = hash(JSON.stringify(resource))) =>
    service.handleWechatCallback(Buffer.from(JSON.stringify({ id, digest, eventType: 'TRANSACTION.SUCCESS', resource })));
  const due = () => { db.state.paymentAttempt[0].nextQueryAt = new Date(0); };
  return { db, service, calls, success, notify, due, gateway,
    configured: (value: boolean) => { configured = value; },
    createError: (value: boolean) => { createError = value; },
    query: (value: Record<string, any>) => { queryResource = value; },
    queryError: (value: boolean) => { queryError = value; } };
}

test('未配置真实网关在生产或未显式development mock时零读写、零商户调用', async t => {
  const f = fixture(t, { WECHAT_PAY_ENABLED: 'false', ALLOW_MOCK_PAYMENT: 'true' });
  f.configured(false);
  await assert.rejects(f.service.createPayment('child', { orderId: 'order' }), ServiceUnavailableException);
  assert.equal(f.db.reads, 0); assert.equal(f.db.writes, 0); assert.equal(f.calls.create, 0);
  process.env.NODE_ENV = 'test';
  await assert.rejects(f.service.createPayment('child', { orderId: 'order' }), ServiceUnavailableException);
  assert.equal(f.db.writes, 0);
});

test('并发创建复用唯一attempt和prepay，不以预付单受理冒充订单完成', async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => f.service.createPayment('child', { orderId: 'order' })));
  assert.equal(f.calls.create, 1); assert.equal(f.db.state.paymentAttempt.length, 1);
  const attempt = f.db.state.paymentAttempt[0];
  assert.equal(attempt.amountCents, 12345n); assert.equal(attempt.angelAmountCents, 9876n);
  assert.equal(attempt.payerIdentityHash, hash(payer));
  assert.equal(JSON.stringify(serializeMoney(attempt)).includes(payer), false);
  assert.equal(f.db.state.order[0].isPaid, false); assert.equal(f.db.state.incomeRecord.length, 0);
  assert.ok(results.every(result => result.mode === 'real' && result.paid !== true));
  const repeat = await f.service.createPayment('child', { orderId: 'order' });
  assert.equal(repeat.data?.package, 'prepay_id=synthetic'); assert.equal(f.calls.create, 1);
});

test('上游结果未知不换单重下，状态查询核验SUCCESS后才原子完成并保留旧余额隔离', async t => {
  const f = fixture(t); f.createError(true);
  assert.equal((await f.service.createPayment('child', { orderId: 'order' })).paymentState, 'UNKNOWN');
  assert.equal((await f.service.createPayment('child', { orderId: 'order' })).paymentState, 'UNKNOWN');
  assert.equal(f.calls.create, 1); assert.equal(f.db.state.incomeRecord.length, 0);
  f.due();
  const status = await f.service.getStatus('child', 'order');
  assert.equal(status.data.completed, true); assert.equal(status.data.paymentMethod, 'wechat');
  assert.equal(status.data.paymentState, 'SUCCEEDED');
  const angel = f.db.state.angel[0];
  assert.equal(angel.balanceCents, 11110n); assert.equal(angel.nonWithdrawableBalanceCents, 1234n);
  assert.equal((await f.service.getIncomeRecords('angel')).data.availableCents, 9876n);
  assert.equal(f.db.state.incomeRecord[0].entryType, 'WECHAT_INCOME');
});

test('已验签并不代表业务可信：错误金额、付款人、商户、订单或成功凭证不得写账', async t => {
  const f = fixture(t); await f.service.createPayment('child', { orderId: 'order' });
  for (const changes of [
    { amount: { total: 12344, currency: 'CNY' } }, { amount: { total: 12345.1, currency: 'CNY' } },
    { amount: { total: 12345, currency: 'USD' } }, { payer: { openid: 'other-synthetic-payer' } },
    { appid: 'other-app' }, { mchid: 'other-merchant' }, { out_trade_no: 'unknown-trade' },
    { transaction_id: 'not-a-wechat-id' }, { trade_state: 'NOTPAY' }, { success_time: 'invalid-date' },
  ]) {
    const before = clone(f.db.state);
    await assert.rejects(f.notify(f.success(changes)), BadRequestException);
    assert.deepEqual(f.db.state, before);
  }
  f.db.state.order[0].price = 123.46;
  const before = clone(f.db.state);
  await assert.rejects(f.notify(), BadRequestException); assert.deepEqual(f.db.state, before);
});

test('重复通知、不同通知ID及通知与查询交错只能入账一次，冲突digest或交易号必须拒绝', async t => {
  const f = fixture(t); await f.service.createPayment('child', { orderId: 'order' });
  const resource = f.success();
  await Promise.all([f.notify(resource), f.notify(resource), f.notify(resource, 'second-event', hash('second-digest'))]);
  await f.service.getStatus('child', 'order');
  assert.equal(f.db.state.incomeRecord.length, 1); assert.equal(f.db.state.angel[0].completedOrders, 1);
  assert.equal(f.db.state.orderTimeline.length, 1); assert.equal(f.db.state.paymentEvent.length, 2);
  const before = clone(f.db.state);
  await assert.rejects(f.notify(resource, 'synthetic-event', hash('different-digest')), BadRequestException);
  await assert.rejects(f.notify(f.success({ transaction_id: '42000000000000000002' }), 'third-event', hash('third-digest')), BadRequestException);
  assert.deepEqual(f.db.state, before);
});

test('退款后重发原支付成功通知只ACK，不恢复isPaid或再次入账', async t => {
  const f = fixture(t); await f.service.createPayment('child', { orderId: 'order' });
  const resource = f.success(); await f.notify(resource);
  Object.assign(f.db.state.order[0], { status: 'REFUNDED', isPaid: false });
  const before = clone(f.db.state);
  assert.deepEqual(await f.notify(resource, 'late-payment-event', hash('late-digest')), { code: 'SUCCESS', message: '成功' });
  assert.deepEqual(f.db.state.order, before.order); assert.deepEqual(f.db.state.angel, before.angel);
  assert.deepEqual(f.db.state.incomeRecord, before.incomeRecord); assert.equal(f.db.state.paymentEvent.length, 2);
});

test('收入、余额或时间线任一步失败不能ACK，订单与已处理事件一并回滚后允许同通知重试', async t => {
  const f = fixture(t); await f.service.createPayment('child', { orderId: 'order' });
  const resource = f.success();
  for (const failAt of ['incomeRecord.create', 'angel.update', 'orderTimeline.create']) {
    const before = clone(f.db.state); f.db.failAt = failAt;
    await assert.rejects(f.notify(resource)); assert.deepEqual(f.db.state, before);
  }
  await f.notify(resource);
  assert.equal(f.db.state.order[0].isPaid, true); assert.equal(f.db.state.incomeRecord.length, 1);
});

test('查询超时或业务金额不符维持未付款且不释放active单号；明确CLOSED才允许新attempt', async t => {
  const f = fixture(t); await f.service.createPayment('child', { orderId: 'order' });
  const originalTrade = f.db.state.paymentAttempt[0].outTradeNo;
  f.due(); f.queryError(true);
  assert.equal((await f.service.getStatus('child', 'order')).data.completed, false);
  assert.equal(f.db.state.paymentAttempt[0].activeOrderId, 'order');
  f.queryError(false); f.query(f.success({ amount: { total: 1, currency: 'CNY' } })); f.due();
  assert.equal((await f.service.getStatus('child', 'order')).data.completed, false);
  assert.equal(f.db.state.paymentEvent.length, 0);
  const closed: Record<string, any> = f.success({ trade_state: 'CLOSED' }); delete closed.amount; delete closed.payer;
  f.query(closed); f.due();
  assert.equal((await f.service.getStatus('child', 'order')).data.paymentState, 'CLOSED');
  assert.equal(f.db.state.paymentAttempt[0].activeOrderId, null);
  await f.service.createPayment('child', { orderId: 'order' });
  assert.equal(f.db.state.paymentAttempt.length, 2); assert.notEqual(f.db.state.paymentAttempt[1].outTradeNo, originalTrade);
  assert.equal(f.db.state.incomeRecord.length, 0);
});

test('已过期NOTPAY查询省略金额时仍可安全关单，只有再次核验CLOSED才释放active', async t => {
  const f = fixture(t); await f.service.createPayment('child', { orderId: 'order' });
  const attempt = f.db.state.paymentAttempt[0]; attempt.expiresAt = new Date(0); f.due();
  let polls = 0;
  f.gateway.queryPayment = async () => ({ out_trade_no: attempt.outTradeNo, appid: appId, mchid: merchantId,
    trade_state: ++polls === 1 ? 'NOTPAY' : 'CLOSED' });
  assert.equal((await f.service.getStatus('child', 'order')).data.paymentState, 'CLOSED');
  assert.equal(f.calls.close, 1); assert.equal(polls, 2);
  assert.equal(f.db.state.paymentAttempt[0].activeOrderId, null); assert.equal(f.db.state.order[0].isPaid, false);
});

test('真实attempt未决时开发模拟付款不能抢结算；正常mock收入全部不可提现', async t => {
  const f = fixture(t); await f.service.createPayment('child', { orderId: 'order' });
  process.env.NODE_ENV = 'development'; process.env.WECHAT_PAY_ENABLED = 'false'; process.env.ALLOW_MOCK_PAYMENT = 'true';
  const before = clone(f.db.state);
  await assert.rejects(f.service.createPayment('child', { orderId: 'order' }), BadRequestException);
  assert.deepEqual(f.db.state, before);
  f.db.state.paymentAttempt = [];
  assert.equal((await f.service.createPayment('child', { orderId: 'order' })).mode, 'mock');
  assert.equal(f.db.state.angel[0].nonWithdrawableBalanceCents, 11110n);
  assert.equal((await f.service.getIncomeRecords('angel')).data.availableCents, 0n);
});

test('状态查询归属验证先于商户查询；通知controller保留原始字节而不重建JSON', async t => {
  const f = fixture(t); await f.service.createPayment('child', { orderId: 'order' }); f.due();
  await assert.rejects(f.service.getStatus('stranger', 'order'), ForbiddenException); assert.equal(f.calls.query, 0);
  const raw = Buffer.from('{ "synthetic" : true }\n'); const headers = { 'wechatpay-serial': 'synthetic' };
  const controller = new PaymentController({ handleWechatCallback: async (body: Buffer, actual: any) => {
    assert.strictEqual(body, raw); assert.strictEqual(actual, headers); return { code: 'SUCCESS' };
  } } as any);
  assert.deepEqual(await controller.wechatNotify({ rawBody: raw, headers }), { code: 'SUCCESS' });
  await assert.rejects(controller.createPayment({ user: { id: 'angel', userType: 'angel' } }, { orderId: 'order' }), ForbiddenException);
});

test('资金审核凭据独立于用户JWT且缺失即关闭，BigInt对外字符串不丢精度', t => {
  environment(t); const guard = new PaymentOperatorGuard();
  const request: any = { headers: {}, user: { userType: 'child' } };
  const context: any = { switchToHttp: () => ({ getRequest: () => request }) };
  assert.throws(() => guard.canActivate(context), ServiceUnavailableException);
  process.env.PAYMENT_OPERATOR_TOKEN = 'synthetic-operator-token-with-strong-length';
  request.headers.authorization = 'Bearer synthetic-customer-jwt'; request.headers['x-payment-operator'] = 'operator1';
  assert.throws(() => guard.canActivate(context), ForbiddenException);
  request.headers.authorization = `Bearer ${process.env.PAYMENT_OPERATOR_TOKEN}`;
  request.headers['x-payment-operator'] = 'invalid operator'; assert.throws(() => guard.canActivate(context), ForbiddenException);
  request.headers['x-payment-operator'] = 'operator1'; assert.equal(guard.canActivate(context), true); assert.equal(request.paymentOperator, 'operator1');
  const date = new Date();
  assert.deepEqual(serializeMoney({ cents: 9007199254740993n, list: [{ amountCents: -9876n }], date }),
    { cents: '9007199254740993', list: [{ amountCents: '-9876' }], date });
});
