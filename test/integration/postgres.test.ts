import 'reflect-metadata';
import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { OrderService } from '../../src/modules/order/order.service';
import { PaymentService } from '../../src/modules/payment/payment.service';

// Never use the project's normal .env or accept arbitrary database targets.
const databaseUrl = process.env.DATABASE_URL || '';
const parsed = new URL(databaseUrl || 'postgresql://invalid');
if (process.env.LRB_INTEGRATION_DB !== 'true' || parsed.protocol !== 'postgresql:' ||
    parsed.hostname !== '127.0.0.1' || parsed.port !== '55432' || parsed.pathname !== '/lrb_integration' ||
    parsed.username !== 'lrb_integration' || !parsed.password) {
  throw new Error('Integration tests require the explicitly enabled, dedicated loopback database');
}
if (process.env.NODE_ENV !== 'development' || process.env.ALLOW_MOCK_PAYMENT !== 'true') {
  throw new Error('The isolated database payment tests require explicit development mock payment');
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [] });
const orders = new OrderService(prisma as any, {} as any);
const payment = new PaymentService(prisma as any, {} as any);
const runId = randomBytes(6).toString('hex');
const prefix = `it-${runId}-`;
const phoneBase = randomBytes(4).readUInt32BE() % 100000000;
let sequence = 0;
let verifiedDatabase = false;
const phone = (offset: number) => `139${String((phoneBase + offset) % 100000000).padStart(8, '0')}`;

before(async () => {
  await prisma.$connect();
  const [identity] = await prisma.$queryRaw<Array<{ database: string; role: string }>>`
    SELECT current_database() AS database, current_user AS role`;
  assert.deepEqual(identity, { database: 'lrb_integration', role: 'lrb_integration' });
  verifiedDatabase = true;
});

after(async () => {
  if (!verifiedDatabase) {
    await prisma.$disconnect();
    return;
  }
  try {
    // Only this run's synthetic fixtures are removed; legacy migration evidence remains.
    await prisma.incomeRecord.deleteMany({ where: { orderId: { startsWith: prefix } } });
    await prisma.orderTimeline.deleteMany({ where: { orderId: { startsWith: prefix } } });
    await prisma.order.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.elderly.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.angel.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.serviceType.deleteMany({ where: { id: { startsWith: prefix } } });
  } finally {
    await prisma.$disconnect();
  }
});

async function fixture(status = 'PENDING_CONFIRM', prepaid = false) {
  const index = ++sequence;
  const base = `${prefix}${index}-`;
  const user = await prisma.user.create({ data: { id: base + 'child', phone: phone(index * 10), name: '隔离集成虚构子女' } });
  const elderly = await prisma.elderly.create({ data: {
    id: base + 'elderly', userId: user.id, name: '隔离集成虚构老人', phone: phone(index * 10 + 1),
    relation: '父亲', address: '仅用于本地隔离测试的虚构地址', inviteCode: randomBytes(4).toString('hex').toUpperCase(),
  } });
  const angels = await Promise.all([2, 3].map(offset => prisma.angel.create({ data: {
    id: base + `angel-${offset}`, phone: phone(index * 10 + offset), name: '隔离集成虚构天使',
    isVerified: true, status: 'APPROVED', isOnline: true,
  } })));
  const service = await prisma.serviceType.create({ data: {
    id: base + 'service', name: '隔离集成服务', icon: 'test', description: '虚构测试服务', price: 123.45,
    unit: '次', duration: '1小时', category: 'integration',
  } });
  const order = await prisma.order.create({ data: {
    id: base + 'order', orderNo: base + 'number', userId: user.id, elderlyId: elderly.id,
    angelId: status === 'PENDING' || status === 'PAID' ? null : angels[0].id,
    serviceTypeId: service.id, serviceTime: new Date(Date.now() + 3600000),
    address: '仅用于本地隔离测试的虚构地址', price: 123.45, status, isPaid: prepaid,
    ...(prepaid ? { paymentMethod: 'wechat', paidAt: new Date() } : {}),
  } });
  return { user, elderly, angels, service, order };
}

async function settlementState(orderId: string, angelId: string) {
  const [order, angel, income, timeline] = await Promise.all([
    prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
    prisma.angel.findUniqueOrThrow({ where: { id: angelId } }),
    prisma.incomeRecord.findMany({ where: { orderId } }),
    prisma.orderTimeline.findMany({ where: { orderId } }),
  ]);
  return { status: order.status, isPaid: order.isPaid, paymentMethod: order.paymentMethod,
    balance: angel.balance, completedOrders: angel.completedOrders, income, timeline };
}

test('真实迁移保留基线旧数据，新增身份列可空且迁移均成功', async () => {
  const [user, angel, elderly, migrations] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: 'migration-legacy-child' } }),
    prisma.angel.findUniqueOrThrow({ where: { id: 'migration-legacy-angel' } }),
    prisma.elderly.findUniqueOrThrow({ where: { id: 'migration-legacy-elderly' } }),
    prisma.$queryRaw<Array<{ migration_name: string; finished: boolean }>>`
      SELECT migration_name, finished_at IS NOT NULL AS finished FROM "_prisma_migrations" ORDER BY migration_name`,
  ]);
  assert.equal(user.name, '隔离迁移虚构子女');
  assert.equal(angel.name, '隔离迁移虚构天使');
  assert.equal(user.wechatOpenId, null);
  assert.equal(angel.wechatOpenId, null);
  assert.equal(elderly.inviteCode, 'C859FD56');
  assert.deepEqual(migrations.map(row => [row.migration_name, row.finished]), [
    ['20260120_baseline', true], ['20261008_payment_ledger', true],
    ['20261008_payment_review_audit', true], ['20261008_wechat_identity', true],
  ]);
});

test('真实PostgreSQL唯一索引拒绝重复openid，空值与子女/天使角色分别允许', async () => {
  const f = await fixture();
  const openid = `${prefix}wechat-identity`;
  await prisma.user.update({ where: { id: f.user.id }, data: { wechatOpenId: openid } });
  await assert.rejects(prisma.user.create({ data: { id: prefix + 'duplicate-user', phone: phone(999), wechatOpenId: openid } }),
    error => (error as any).code === 'P2002');
  await prisma.angel.update({ where: { id: f.angels[0].id }, data: { wechatOpenId: openid } });
  await assert.rejects(prisma.angel.update({ where: { id: f.angels[1].id }, data: { wechatOpenId: openid } }),
    error => (error as any).code === 'P2002');
  await prisma.user.update({ where: { id: f.user.id }, data: { phone: phone(998) } });
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { wechatOpenId: openid } })).id, f.user.id);
  const nullIdentity = await prisma.user.create({ data: { id: prefix + 'null-identity', phone: phone(997) } });
  assert.equal(nullIdentity.wechatOpenId, null);
  assert.equal((await prisma.angel.findUniqueOrThrow({ where: { id: f.angels[1].id } })).wechatOpenId, null);
});

test('真实数据库并发抢单只有一个天使成功且不覆盖赢家', async () => {
  const f = await fixture('PENDING');
  const attempts = await Promise.allSettled(f.angels.map(angel => orders.accept(f.order.id, angel.id)));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
  const claimed = await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } });
  assert.equal(claimed.status, 'ACCEPTED');
  assert.ok(f.angels.some(angel => angel.id === claimed.angelId));
  assert.equal(await prisma.orderTimeline.count({ where: { orderId: f.order.id, event: 'ACCEPT' } }), 1);
  const winner = attempts.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<any>;
  assert.equal(winner.value.data.angelId, claimed.angelId);
});

test('真实数据库同订单8路并发付款与重复确认只产生一次收入和余额', async () => {
  const f = await fixture();
  const attempts = await Promise.all(Array.from({ length: 8 }, () => payment.createPayment(f.user.id, { orderId: f.order.id })));
  assert.ok(attempts.every(result => result.success && result.mode === 'mock'));
  await Promise.all([payment.createPayment(f.user.id, { orderId: f.order.id }), orders.confirmComplete(f.order.id, f.user.id)]);
  const state = await settlementState(f.order.id, f.angels[0].id);
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.isPaid, true);
  assert.equal(state.paymentMethod, 'mock');
  assert.equal(state.income.length, 1);
  assert.equal(state.income[0].amount, 98.76);
  assert.equal(state.balance, 98.76);
  assert.equal(state.completedOrders, 1);
  assert.equal(state.timeline.length, 1);
});

test('真实数据库历史PAID完成后并发确认保持账目唯一', async () => {
  const f = await fixture('PAID', true);
  await orders.accept(f.order.id, f.angels[0].id);
  await orders.startDepart(f.order.id, f.angels[0].id);
  await orders.arrive(f.order.id, f.angels[0].id);
  await orders.startService(f.order.id, f.angels[0].id);
  await orders.completeService(f.order.id, f.angels[0].id, {});
  await Promise.all(Array.from({ length: 4 }, () => orders.confirmComplete(f.order.id, f.user.id)));
  const state = await settlementState(f.order.id, f.angels[0].id);
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.isPaid, true);
  assert.equal(state.paymentMethod, 'wechat');
  assert.equal(state.balance, 98.76);
  assert.equal(state.income.length, 1);
  assert.equal(state.completedOrders, 1);
  assert.equal(state.timeline.filter(row => row.event === 'CONFIRMED').length, 1);
});

test('真实SQL约束在账目写入后失败使订单、收入、余额一起回滚，随后可重试', async () => {
  const f = await fixture();
  const constraint = `lrb_it_${runId}`;
  // The constraint affects only this generated fixture, never other local API orders.
  assert.match(f.order.id, /^[a-z0-9-]+$/);
  await prisma.$executeRawUnsafe(`ALTER TABLE "order_timelines" ADD CONSTRAINT "${constraint}" CHECK (NOT ("event" = 'PAID' AND "orderId" = '${f.order.id}'))`);
  try {
    const beforeState = await settlementState(f.order.id, f.angels[0].id);
    await assert.rejects(payment.createPayment(f.user.id, { orderId: f.order.id }));
    assert.deepEqual(await settlementState(f.order.id, f.angels[0].id), beforeState);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "order_timelines" DROP CONSTRAINT "${constraint}"`);
  }
  await payment.createPayment(f.user.id, { orderId: f.order.id });
  const state = await settlementState(f.order.id, f.angels[0].id);
  assert.equal(state.status, 'COMPLETED');
  assert.equal(state.income.length, 1);
  assert.equal(state.balance, 98.76);
  assert.equal(state.completedOrders, 1);
});
