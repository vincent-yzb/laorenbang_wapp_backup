import 'reflect-metadata';
import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { PaymentService } from '../../src/modules/payment/payment.service';

// Explicitly injected generated local credentials only. Prisma's normal .env discovery is disabled below.
const databaseUrl = process.env.DATABASE_URL ?? '';
const parsed = new URL(databaseUrl || 'postgresql://invalid');
if (process.env.LRB_INTEGRATION_DB !== 'true' || parsed.protocol !== 'postgresql:' ||
  parsed.hostname !== '127.0.0.1' || parsed.port !== '55432' || parsed.pathname !== '/lrb_integration' ||
  parsed.username !== 'lrb_integration' || !parsed.password || (parsed.searchParams.get('schema') ?? 'public') !== 'public') {
  throw new Error('Real-payment tests require the explicitly enabled dedicated loopback database');
}
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [],
  __internal: { configOverride: config => ({ ...config, relativeEnvPaths: { rootEnvPath: null, schemaEnvPath: null } }) } } as any);
const prefix = `rp-${randomBytes(10).toString('hex')}-`;
const appId = 'wx0123456789abcdef';
const merchantId = '1900000001';
const originalEnv = Object.fromEntries(['NODE_ENV', 'WECHAT_PAY_ENABLED', 'ALLOW_MOCK_PAYMENT', 'WECHAT_APPID', 'WECHAT_PAY_MCH_ID'].map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let verified = false;
let sequence = 0;
const owned = { users: [] as string[], angels: [] as string[], elders: [] as string[], services: [] as string[], orders: [] as string[] };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

before(async () => {
  const inspected = spawnSync('/usr/local/bin/docker', ['--host', `unix://${process.env.HOME}/.docker/run/docker.sock`,
    'inspect', '--format', '{{index .Config.Labels "lrb.purpose"}}', 'lrb-integration-20261008'], { encoding: 'utf8' });
  assert.equal(inspected.status, 0, 'Dedicated Docker PostgreSQL must exist');
  assert.equal(inspected.stdout.trim(), 'isolated-integration');
  const [identity]: any = await prisma.$queryRawUnsafe('SELECT current_database() AS db,current_user AS role');
  assert.deepEqual(identity, { db: 'lrb_integration', role: 'lrb_integration' });
  const [migration]: any = await prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL', '20261008_payment_ledger');
  assert.equal(migration.count, 1, 'Reviewed ledger migration must already be deployed');
  verified = true;
  process.env.NODE_ENV = 'production'; process.env.WECHAT_PAY_ENABLED = 'true'; process.env.ALLOW_MOCK_PAYMENT = 'false';
  process.env.WECHAT_APPID = appId; process.env.WECHAT_PAY_MCH_ID = merchantId;
  // A regression cannot silently issue a real merchant HTTP call from this test process.
  globalThis.fetch = async () => { throw new Error('External HTTP is forbidden in isolated payment integration tests'); };
});

after(async () => {
  try {
    if (verified) {
      // Exact IDs created by this run only; never truncate, reset schema or delete another run's data.
      const attempts = await prisma.paymentAttempt.findMany({ where: { orderId: { in: owned.orders } }, select: { id: true } });
      await prisma.paymentEvent.deleteMany({ where: { paymentAttemptId: { in: attempts.map(row => row.id) } } });
      await prisma.incomeRecord.deleteMany({ where: { orderId: { in: owned.orders } } });
      await prisma.paymentAttempt.deleteMany({ where: { orderId: { in: owned.orders } } });
      await prisma.orderTimeline.deleteMany({ where: { orderId: { in: owned.orders } } });
      await prisma.order.deleteMany({ where: { id: { in: owned.orders } } });
      await prisma.elderly.deleteMany({ where: { id: { in: owned.elders } } });
      await prisma.angel.deleteMany({ where: { id: { in: owned.angels } } });
      await prisma.user.deleteMany({ where: { id: { in: owned.users } } });
      await prisma.serviceType.deleteMany({ where: { id: { in: owned.services } } });
      assert.equal(await prisma.order.count({ where: { id: { startsWith: prefix } } }), 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await prisma.$disconnect();
  }
});

async function fixture() {
  assert.equal(verified, true);
  const base = `${prefix}${++sequence}-`;
  const userId = base + 'child'; owned.users.push(userId);
  const payer = base + 'synthetic-payer';
  const user = await prisma.user.create({ data: { id: userId, phone: base + 'phone-child', wechatOpenId: payer, name: '隔离虚构付款人' } });
  const angelId = base + 'angel'; owned.angels.push(angelId);
  const angel = await prisma.angel.create({ data: { id: angelId, phone: base + 'phone-angel', name: '隔离虚构服务者',
    isVerified: true, status: 'APPROVED', balance: 12.34, balanceCents: 1234n, openingBalanceCents: 1234n, nonWithdrawableBalanceCents: 1234n } });
  const elderId = base + 'elder'; owned.elders.push(elderId);
  const elder = await prisma.elderly.create({ data: { id: elderId, userId, name: '隔离虚构老人', phone: base + 'phone-elder',
    relation: '家人', address: '隔离虚构地址', inviteCode: randomBytes(10).toString('hex').toUpperCase() } });
  const serviceId = base + 'service'; owned.services.push(serviceId);
  const catalog = await prisma.serviceType.create({ data: { id: serviceId, name: '隔离虚构服务', icon: 'test', description: '本机测试',
    price: 123.45, priceCents: 12345n, unit: '次', duration: '1小时', category: 'integration' } });
  const orderId = base + 'order'; owned.orders.push(orderId);
  const order = await prisma.order.create({ data: { id: orderId, orderNo: base + 'number', userId, elderlyId: elder.id, angelId,
    serviceTypeId: catalog.id, serviceTime: new Date(Date.now() + 3600_000), address: '隔离虚构地址',
    price: 123.45, priceCents: 12345n, status: 'PENDING_CONFIRM' } });
  let createCalls = 0, queryCalls = 0;
  let createThrows = false, configured = true;
  let queryResource: any;
  const payParams = { appId, timeStamp: '1', nonceStr: 'synthetic', package: 'prepay_id=synthetic', signType: 'RSA' as const, paySign: 'synthetic' };
  const gateway = {
    isConfigured: () => configured,
    createJsapiPayment: async () => { createCalls++; await new Promise<void>(resolve => setImmediate(resolve));
      if (createThrows) throw new Error('Synthetic transport uncertainty'); return { prepayId: 'synthetic', payParams }; },
    buildMiniProgramPayParams: () => payParams,
    queryPayment: async () => { queryCalls++; return queryResource; },
    closePayment: async () => {},
    verifyNotification: (raw: Buffer) => JSON.parse(raw.toString()), // Real signature/AES boundary has separate offline cryptographic tests.
  };
  const payment = new PaymentService(prisma as any, {} as any, gateway as any);
  const attempt = () => prisma.paymentAttempt.findFirstOrThrow({ where: { orderId }, orderBy: { createdAt: 'desc' } });
  const resource = async (changes: Record<string, any> = {}) => ({ out_trade_no: (await attempt()).outTradeNo,
    appid: appId, mchid: merchantId, amount: { total: 12345, currency: 'CNY' }, payer: { openid: payer },
    trade_state: 'SUCCESS', transaction_id: '420000' + randomBytes(10).readBigUInt64BE().toString().padStart(20, '0'),
    success_time: new Date().toISOString(), ...changes });
  const notify = (transaction: any, suffix = 'event', digest = hash(JSON.stringify(transaction))) => payment.handleWechatCallback(
    Buffer.from(JSON.stringify({ id: base + suffix, digest, eventType: 'TRANSACTION.SUCCESS', resource: transaction })));
  const due = async () => prisma.paymentAttempt.update({ where: { id: (await attempt()).id }, data: { nextQueryAt: new Date(0) } });
  const snapshot = async () => ({
    order: await prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
    angel: await prisma.angel.findUniqueOrThrow({ where: { id: angelId } }),
    attempts: await prisma.paymentAttempt.findMany({ where: { orderId }, orderBy: { id: 'asc' } }),
    events: await prisma.paymentEvent.findMany({ where: { paymentAttempt: { orderId } }, orderBy: { id: 'asc' } }),
    incomes: await prisma.incomeRecord.findMany({ where: { orderId }, orderBy: { id: 'asc' } }),
    timeline: await prisma.orderTimeline.findMany({ where: { orderId }, orderBy: { id: 'asc' } }),
  });
  return { order, user, angel, payer, payment, attempt, resource, notify, due, snapshot,
    counts: () => ({ createCalls, queryCalls }), query: (value: any) => { queryResource = value; },
    createThrows: (value: boolean) => { createThrows = value; }, configured: (value: boolean) => { configured = value; } };
}

test('真实PG八路创建只有一个商户下单与active attempt，预付响应不结算', async () => {
  const f = await fixture();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.payment.createPayment(f.user.id, { orderId: f.order.id })));
  assert.equal(f.counts().createCalls, 1);
  assert.equal(await prisma.paymentAttempt.count({ where: { orderId: f.order.id } }), 1);
  assert.ok(results.every(result => result.mode === 'real' && !result.paid));
  const attempt = await f.attempt(); assert.equal(attempt.payerIdentityHash, hash(f.payer));
  assert.equal(attempt.amountCents, 12345n); assert.equal(attempt.status, 'PREPAY');
  assert.equal((await f.snapshot()).order.isPaid, false);
  assert.equal((await f.snapshot()).incomes.length, 0);
  assert.equal((await f.payment.createPayment(f.user.id, { orderId: f.order.id })).data?.package, 'prepay_id=synthetic');
  assert.equal(f.counts().createCalls, 1);
});

test('真实PG重复/并发通知与query只结算一次，旧余额保持不可提现', async () => {
  const f = await fixture(); await f.payment.createPayment(f.user.id, { orderId: f.order.id });
  const resource = await f.resource(); f.query(resource); await f.due();
  const concurrent = await Promise.allSettled([f.payment.getStatus(f.user.id, f.order.id), ...Array.from({ length: 8 }, (_, i) => f.notify(resource, i < 4 ? 'event' : `event-${i}`))]);
  assert.ok(concurrent.every(result => result.status === 'fulfilled'), 'All concurrent valid callbacks/query must safely observe the single committed receipt');
  const state = await f.snapshot();
  assert.equal(state.order.status, 'COMPLETED'); assert.equal(state.order.paymentOrigin, 'WECHAT');
  assert.equal(state.order.paidAttemptId, state.attempts[0].id); assert.equal(state.attempts[0].transactionId, resource.transaction_id);
  assert.equal(state.attempts[0].activeOrderId, null); assert.equal(state.incomes.length, 1); assert.equal(state.timeline.length, 1);
  assert.equal(state.incomes[0].amountCents, 9876n); assert.equal(state.angel.balanceCents, 11110n);
  assert.equal(state.angel.nonWithdrawableBalanceCents, 1234n); assert.equal(state.angel.completedOrders, 1);
  assert.equal((await f.payment.getIncomeRecords(f.angel.id)).data.availableCents, 9876n);
  const conflicts = await Promise.allSettled([
    f.notify(resource, 'event', hash('different-digest')),
    f.notify({ ...resource, transaction_id: resource.transaction_id + '1' }, 'changed-transaction'),
  ]);
  assert.ok(conflicts.every(result => result.status === 'rejected'));
  assert.deepEqual(await f.snapshot(), state);
});

test('真实SQL唯一账目冲突回滚通知、订单与attempt，修复冲突后同通知可重试', async () => {
  const f = await fixture(); await f.payment.createPayment(f.user.id, { orderId: f.order.id });
  const collision = await prisma.incomeRecord.create({ data: { angelId: f.angel.id, orderId: f.order.id,
    amount: 0, amountCents: 0n, type: '测试唯一键冲突', entryType: 'LEGACY', entryKey: `income:${f.order.id}`, description: '隔离冲突' } });
  const before = await f.snapshot(); const resource = await f.resource();
  await assert.rejects(f.notify(resource), error => (error as any).code === 'P2002');
  assert.deepEqual(await f.snapshot(), before);
  await prisma.incomeRecord.delete({ where: { id: collision.id } });
  await f.notify(resource);
  const state = await f.snapshot(); assert.equal(state.incomes.length, 1); assert.equal(state.events.length, 1);
  assert.equal(state.order.isPaid, true); assert.equal(state.angel.balanceCents, 11110n);
});

test('真实PG拒绝跨商户、付款人、金额与订单快照篡改，已验签不能绕过业务核验', async () => {
  const f = await fixture(); await f.payment.createPayment(f.user.id, { orderId: f.order.id });
  const resource = await f.resource();
  for (const change of [{ mchid: 'other-merchant' }, { appid: 'other-app' }, { payer: { openid: 'other-payer' } },
    { amount: { total: 12344, currency: 'CNY' } }, { amount: { total: 12345.01, currency: 'CNY' } }, { amount: { total: 12345, currency: 'USD' } }]) {
    const before = await f.snapshot(); await assert.rejects(f.notify({ ...resource, ...change }), BadRequestException);
    assert.deepEqual(await f.snapshot(), before);
  }
  await prisma.order.update({ where: { id: f.order.id }, data: { price: 123.46, priceCents: 12346n } });
  const before = await f.snapshot(); await assert.rejects(f.notify(resource), BadRequestException);
  assert.deepEqual(await f.snapshot(), before);
});

test('真实PG未知预付结果不重下单，轮询SUCCESS补结算；陌生人查状态不触发商户请求', async () => {
  const f = await fixture(); f.createThrows(true);
  assert.equal((await f.payment.createPayment(f.user.id, { orderId: f.order.id })).paymentState, 'UNKNOWN');
  assert.equal((await f.payment.createPayment(f.user.id, { orderId: f.order.id })).paymentState, 'UNKNOWN');
  assert.equal(f.counts().createCalls, 1);
  f.query(await f.resource()); await f.due();
  await assert.rejects(f.payment.getStatus('stranger', f.order.id), ForbiddenException); assert.equal(f.counts().queryCalls, 0);
  const status = await f.payment.getStatus(f.user.id, f.order.id);
  assert.equal(status.data.completed, true); assert.equal(status.data.paymentState, 'SUCCEEDED');
  assert.equal((await f.snapshot()).incomes.length, 1);
});

test('真实PG合法CLOSED省略金额仍可释放唯一active键，再付款创建新单且不结算', async () => {
  const f = await fixture(); await f.payment.createPayment(f.user.id, { orderId: f.order.id });
  const first = await f.attempt();
  f.query({ appid: appId, mchid: merchantId, out_trade_no: first.outTradeNo, trade_state: 'CLOSED' }); await f.due();
  const status = await f.payment.getStatus(f.user.id, f.order.id);
  assert.equal(status.data.paymentState, 'CLOSED'); assert.equal(status.data.completed, false);
  assert.equal((await f.attempt()).activeOrderId, null);
  const fresh = await f.payment.createPayment(f.user.id, { orderId: f.order.id });
  assert.equal(fresh.paymentState, 'PREPAY'); assert.equal(f.counts().createCalls, 2);
  const attempts = await prisma.paymentAttempt.findMany({ where: { orderId: f.order.id } });
  assert.equal(attempts.length, 2); assert.equal(attempts.filter(row => row.activeOrderId === f.order.id).length, 1);
  assert.notEqual((await f.attempt()).outTradeNo, first.outTradeNo);
  assert.equal((await f.snapshot()).incomes.length, 0);
});

test('真实PG退款后不同ID支付成功重试仅ACK，不恢复已退款订单或重复收入', async () => {
  const f = await fixture(); await f.payment.createPayment(f.user.id, { orderId: f.order.id });
  const resource = await f.resource(); await f.notify(resource);
  await prisma.order.update({ where: { id: f.order.id }, data: { status: 'REFUNDED', isPaid: false } });
  const before = await f.snapshot(); await f.notify(resource, 'late-different-id');
  const after = await f.snapshot();
  assert.deepEqual(after.order, before.order); assert.deepEqual(after.angel, before.angel); assert.deepEqual(after.incomes, before.incomes);
  assert.equal(after.events.length, before.events.length + 1);
});

test('真实PG生产mock即使被误开也无写入；开发mock不得抢未决真实attempt', async () => {
  const f = await fixture(); f.configured(false);
  const before = await f.snapshot();
  const prior = { NODE_ENV: process.env.NODE_ENV, WECHAT_PAY_ENABLED: process.env.WECHAT_PAY_ENABLED, ALLOW_MOCK_PAYMENT: process.env.ALLOW_MOCK_PAYMENT };
  try {
    process.env.WECHAT_PAY_ENABLED = 'false'; process.env.ALLOW_MOCK_PAYMENT = 'true';
    await assert.rejects(f.payment.createPayment(f.user.id, { orderId: f.order.id }), ServiceUnavailableException);
    assert.deepEqual(await f.snapshot(), before);
    process.env.WECHAT_PAY_ENABLED = 'true'; f.configured(true);
    await f.payment.createPayment(f.user.id, { orderId: f.order.id });
    process.env.NODE_ENV = 'development'; process.env.WECHAT_PAY_ENABLED = 'false';
    const reserved = await f.snapshot();
    await assert.rejects(f.payment.createPayment(f.user.id, { orderId: f.order.id }), BadRequestException);
    assert.deepEqual(await f.snapshot(), reserved); assert.equal(f.counts().createCalls, 1);
  } finally { Object.assign(process.env, prior); }
});
