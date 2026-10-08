import 'reflect-metadata';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { BadRequestException, ForbiddenException, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { PaymentService } from '../src/modules/payment/payment.service';
import { PaymentController } from '../src/modules/payment/payment.controller';
import { OrderService } from '../src/modules/order/order.service';
import { OrderController } from '../src/modules/order/order.controller';
import { CreateOrderDto } from '../src/modules/order/dto/order.dto';
import { WithdrawMethod } from '../src/modules/payment/dto/payment.dto';

const sampleOrder = (changes: Record<string, any> = {}) => ({
  id: 'order-1', orderNo: 'test-order-1', userId: 'child-1', elderlyId: 'elderly-1',
  angelId: 'angel-1', serviceTypeId: 'medical', status: 'PENDING_CONFIRM', price: 100,
  serviceTime: new Date('2030-01-01T10:00:00.000Z'),
  address: 'PRIVATE detailed address', remark: 'PRIVATE service remark', lat: 39.904234, lng: 116.407488,
  elderly: { name: 'PRIVATE elder name', phone: 'PRIVATE phone', healthNote: 'PRIVATE health' },
  user: { phone: 'PRIVATE child phone' },
  serviceType: { id: 'medical', name: '陪同就医', icon: 'medical', description: '服务说明', unit: '次', duration: '2小时', category: '生活照料', internalField: 'PRIVATE catalog field' },
  isPaid: false, paidAt: null, completedAt: null, paymentMethod: null, rating: null, ...changes,
});

function matches(row: any, where: Record<string, any> = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((condition: any) => matches(row, condition));
    if (value && typeof value === 'object') {
      if ('in' in value) return value.in.includes(row[key]);
      if ('not' in value) return row[key] !== value.not;
      if ('gte' in value || 'lte' in value) return (!('gte' in value) || row[key] >= value.gte) && (!('lte' in value) || row[key] <= value.lte);
    }
    return row[key] === value;
  });
}

/** Read committed fake: reads can race; the first write holds a lock until commit.
 * Waiting updateMany calls recheck their predicates against the committed state.
 * A failure discards every staged write, including ledger entries and timelines.
 */
class FakePrisma {
  state: any;
  gate: Promise<void> = Promise.resolve();
  transactions = 0;
  attemptedWrites = 0;
  claims: number[] = [];
  failAt?: string;
  order: any;
  angel: any;
  nearbyQueries: any[] = [];

  constructor(order = sampleOrder()) {
    this.state = {
      orders: [order],
      angels: [
        { id: 'angel-1', balance: 0, completedOrders: 0, isVerified: true, status: 'APPROVED', isOnline: true },
        { id: 'angel-2', balance: 0, completedOrders: 0, isVerified: true, status: 'APPROVED', isOnline: true },
      ],
      elderly: [{ id: 'elderly-1', userId: 'child-1' }],
      services: [{ id: 'medical', price: 100, isActive: true }, { id: 'custom', price: 0, isActive: true }],
      income: [], timelines: [],
    };
    this.order = {
      findUnique: async ({ where }: any) => structuredClone(this.state.orders.find((row: any) => matches(row, where)) ?? null),
      findMany: async ({ where, take }: any) => {
        this.nearbyQueries.push(structuredClone(where));
        return structuredClone(this.state.orders.filter((row: any) => matches(row, where)).slice(0, take));
      },
    };
    this.angel = { findUnique: async ({ where }: any) => structuredClone(this.state.angels.find((row: any) => matches(row, where)) ?? null) };
  }

  async $transaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
    this.transactions++;
    let draft: any;
    let release: (() => void) | undefined;
    const lock = async () => {
      if (draft) return;
      const previous = this.gate;
      this.gate = new Promise<void>(resolve => { release = resolve; });
      await previous;
      draft = structuredClone(this.state);
    };
    const read = () => draft ?? this.state;
    const write = async (operation: string) => {
      await lock();
      this.attemptedWrites++;
      if (this.failAt === operation) {
        this.failAt = undefined;
        throw new Error(`Injected failure at ${operation}`);
      }
    };
    const tx = {
      order: {
        findUnique: async ({ where }: any) => structuredClone(read().orders.find((row: any) => matches(row, where)) ?? null),
        create: async ({ data }: any) => {
          await write('order.create');
          const row = sampleOrder({ id: `created-${draft.orders.length}`, angelId: null, ...data });
          draft.orders.push(row);
          return structuredClone(row);
        },
        updateMany: async ({ where, data }: any) => {
          await write('order.updateMany');
          const rows = draft.orders.filter((row: any) => matches(row, where));
          rows.forEach((row: any) => Object.assign(row, data));
          this.claims.push(rows.length);
          return { count: rows.length };
        },
        aggregate: async ({ where }: any) => {
          const values = read().orders.filter((row: any) => matches(row, where)).map((row: any) => row.rating);
          return { _avg: { rating: values.length ? values.reduce((sum: number, value: number) => sum + value, 0) / values.length : null } };
        },
      },
      elderly: { findFirst: async ({ where }: any) => structuredClone(read().elderly.find((row: any) => matches(row, where)) ?? null) },
      serviceType: { findUnique: async ({ where }: any) => structuredClone(read().services.find((row: any) => matches(row, where)) ?? null) },
      incomeRecord: {
        findFirst: async ({ where }: any) => structuredClone(read().income.find((row: any) => matches(row, where)) ?? null),
        create: async ({ data }: any) => {
          await write('incomeRecord.create');
          draft.income.push(structuredClone(data));
          return data;
        },
      },
      angel: {
        findUnique: async ({ where }: any) => structuredClone(read().angels.find((row: any) => matches(row, where)) ?? null),
        update: async ({ where, data }: any) => {
          await write('angel.update');
          const angel = draft.angels.find((row: any) => matches(row, where));
          if (!angel) throw new Error('Angel not found');
          for (const [key, value] of Object.entries(data)) {
            angel[key] = value && typeof value === 'object' && 'increment' in value
              ? angel[key] + (value as any).increment : value;
          }
          return structuredClone(angel);
        },
      },
      orderTimeline: { create: async ({ data }: any) => { await write('orderTimeline.create'); draft.timelines.push(structuredClone(data)); return data; } },
    };
    try {
      const result = await callback(tx);
      if (draft) this.state = draft;
      return result;
    } finally {
      release?.();
    }
  }
}

function services(order = sampleOrder()) {
  const db = new FakePrisma(order);
  return { db, payment: new PaymentService(db as any, { isDevelopment: true } as any), orders: new OrderService(db as any, {} as any) };
}

async function withEnvironment(nodeEnv: string | undefined, mock: string | undefined, run: () => Promise<void>) {
  const previousEnv = process.env.NODE_ENV;
  const previousMock = process.env.ALLOW_MOCK_PAYMENT;
  if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
  if (mock === undefined) delete process.env.ALLOW_MOCK_PAYMENT; else process.env.ALLOW_MOCK_PAYMENT = mock;
  try { await run(); } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
    if (previousMock === undefined) delete process.env.ALLOW_MOCK_PAYMENT; else process.env.ALLOW_MOCK_PAYMENT = previousMock;
  }
}

const mockEnabled = (run: () => Promise<void>) => withEnvironment('development', 'true', run);
const createDto = (changes: Record<string, any> = {}): CreateOrderDto => ({
  serviceTypeId: 'medical', elderlyId: 'elderly-1', address: 'Test address', serviceTime: '2030-01-01T10:00:00.000Z', ...changes,
});

test('mock requires the exact development environment and explicit opt-in; blocked calls never access a transaction', async () => {
  for (const [env, mock] of [['production', 'true'], ['test', 'true'], [undefined, 'true'], ['development', undefined], ['development', 'false']]) {
    await withEnvironment(env, mock, async () => {
      const { db, payment } = services();
      const before = structuredClone(db.state);
      await assert.rejects(payment.createPayment('child-1', { orderId: 'order-1' }), ServiceUnavailableException);
      assert.equal(db.transactions, 0);
      assert.deepEqual(db.state, before);
    });
  }
});

test('new orders reject prepayment without changing the order or ledger', async () => mockEnabled(async () => {
  const { db, payment } = services(sampleOrder({ status: 'PENDING', angelId: null }));
  const before = structuredClone(db.state);
  await assert.rejects(payment.createPayment('child-1', { orderId: 'order-1' }), BadRequestException);
  assert.deepEqual(db.state, before);
}));

test('unpaid confirmation is rejected, including a corrupt unpaid COMPLETED order', async () => {
  for (const status of ['PENDING_CONFIRM', 'COMPLETED']) {
    const { db, orders } = services(sampleOrder({ status }));
    const before = structuredClone(db.state);
    await assert.rejects(orders.confirmComplete('order-1', 'child-1'), BadRequestException);
    assert.deepEqual(db.state, before);
  }
});

test('concurrent mock payments, retries and confirmation create exactly one settlement', async () => mockEnabled(async () => {
  const { db, payment, orders } = services();
  assert.equal((await payment.getStatus('child-1', 'order-1')).data.paymentMethod, null);
  const result = await Promise.all([
    payment.createPayment('child-1', { orderId: 'order-1' }),
    payment.createPayment('child-1', { orderId: 'order-1' }),
  ]);
  assert.ok(result.every(item => item.success && item.mode === 'mock'));
  assert.ok(db.claims.includes(0), 'the second payment must lose the conditional claim');
  await payment.createPayment('child-1', { orderId: 'order-1' });
  await orders.confirmComplete('order-1', 'child-1');
  await orders.confirmComplete('order-1', 'child-1');
  assert.equal(db.state.orders[0].status, 'COMPLETED');
  assert.equal(db.state.orders[0].isPaid, true);
  assert.equal((await payment.getStatus('child-1', 'order-1')).data.paymentMethod, 'mock');
  assert.equal(db.state.income.length, 1);
  assert.equal(db.state.angels[0].balance, 80);
  assert.equal(db.state.angels[0].completedOrders, 1);
  assert.equal(db.state.timelines.length, 1);
}));

test('legacy prepaid orders complete and settle once under concurrent confirmation', async () => {
  const { db, orders } = services(sampleOrder({ isPaid: true, paymentMethod: 'wechat' }));
  await Promise.all([orders.confirmComplete('order-1', 'child-1'), orders.confirmComplete('order-1', 'child-1')]);
  await orders.confirmComplete('order-1', 'child-1');
  assert.equal(db.state.orders[0].status, 'COMPLETED');
  assert.equal(db.state.income.length, 1);
  assert.equal(db.state.angels[0].balance, 80);
  assert.equal(db.state.timelines.length, 1);
});

test('a legacy existing income record is not credited twice', async () => {
  const { db, orders } = services(sampleOrder({ isPaid: true }));
  db.state.income.push({ orderId: 'order-1', type: '订单收入', amount: 80, angelId: 'angel-1' });
  db.state.angels[0].balance = 80;
  db.state.angels[0].completedOrders = 1;
  await orders.confirmComplete('order-1', 'child-1');
  assert.equal(db.state.income.length, 1);
  assert.equal(db.state.angels[0].balance, 80);
  assert.equal(db.state.angels[0].completedOrders, 1);
});

test('ledger/balance and timeline failures roll back payment; a later retry settles once', async () => mockEnabled(async () => {
  for (const failure of ['angel.update', 'orderTimeline.create']) {
    const { db, payment } = services();
    db.failAt = failure;
    const before = structuredClone(db.state);
    await assert.rejects(payment.createPayment('child-1', { orderId: 'order-1' }), /Injected failure/);
    assert.deepEqual(db.state, before);
    await payment.createPayment('child-1', { orderId: 'order-1' });
    assert.equal(db.state.income.length, 1);
    assert.equal(db.state.angels[0].balance, 80);
  }
}));

test('only one angel wins a concurrent claim and the loser cannot overwrite it', async () => {
  const { db, orders } = services(sampleOrder({ status: 'PENDING', angelId: null }));
  const results = await Promise.allSettled([orders.accept('order-1', 'angel-1'), orders.accept('order-1', 'angel-2')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(db.state.orders[0].status, 'ACCEPTED');
  assert.equal(db.state.orders[0].angelId, 'angel-1');
  assert.equal(db.state.timelines.length, 1);
});

test('service completion uses a conditional transition and cannot duplicate its timeline', async () => {
  const { db, orders } = services(sampleOrder({ status: 'IN_PROGRESS' }));
  const results = await Promise.allSettled([orders.completeService('order-1', 'angel-1', {}), orders.completeService('order-1', 'angel-1', {})]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(db.state.orders[0].status, 'PENDING_CONFIRM');
  assert.equal(db.state.timelines.length, 1);
  await assert.rejects(orders.startService('order-1', 'angel-1'), BadRequestException);
});

test('acceptance requires approval, verification and online status and rejects expired orders', async () => {
  for (const changes of [{ isVerified: false }, { status: 'PENDING' }, { status: 'SUSPENDED' }, { isOnline: false }]) {
    const { db, orders } = services(sampleOrder({ status: 'PENDING', angelId: null }));
    Object.assign(db.state.angels[0], changes);
    const before = structuredClone(db.state);
    await assert.rejects(orders.accept('order-1', 'angel-1'), ForbiddenException);
    assert.deepEqual(db.state, before);
  }
  const { db, orders } = services(sampleOrder({ status: 'PENDING', angelId: null, serviceTime: new Date(Date.now() - 31 * 60 * 1000) }));
  const before = structuredClone(db.state);
  await assert.rejects(orders.accept('order-1', 'angel-1'), BadRequestException);
  assert.deepEqual(db.state, before);
});

test('an angel must arrive before beginning service', async () => {
  for (const status of ['ACCEPTED', 'ON_WAY']) {
    const { db, orders } = services(sampleOrder({ status }));
    const before = structuredClone(db.state);
    await assert.rejects(orders.startService('order-1', 'angel-1'), BadRequestException);
    assert.deepEqual(db.state, before);
  }
});

test('the full post-service flow and the legacy PAID flow reach one paid completion', async () => mockEnabled(async () => {
  for (const prepaid of [false, true]) {
    const { db, orders, payment } = services(sampleOrder({ status: prepaid ? 'PAID' : 'PENDING', isPaid: prepaid, angelId: null }));
    await orders.accept('order-1', 'angel-1');
    await orders.startDepart('order-1', 'angel-1');
    await orders.arrive('order-1', 'angel-1');
    await orders.startService('order-1', 'angel-1');
    await orders.completeService('order-1', 'angel-1', {});
    if (prepaid) await orders.confirmComplete('order-1', 'child-1');
    else await payment.createPayment('child-1', { orderId: 'order-1' });
    assert.equal((await payment.getStatus('child-1', 'order-1')).data.completed, true);
    assert.equal(db.state.income.length, 1);
    assert.equal(db.state.angels[0].balance, 80);
  }
}));

test('unready refunds, withdrawals and callbacks never deduct balances or write records', async () => mockEnabled(async () => {
  const { db, payment } = services();
  const before = structuredClone(db.state);
  await assert.rejects(payment.refund('child-1', { orderId: 'order-1', reason: 'Test' }), ServiceUnavailableException);
  await assert.rejects(payment.withdraw('angel-1', { amount: 10, method: WithdrawMethod.WECHAT }), ServiceUnavailableException);
  await assert.rejects(payment.handleWechatCallback({} as any), ServiceUnavailableException);
  assert.equal(db.transactions, 0);
  assert.equal(db.attemptedWrites, 0);
  assert.deepEqual(db.state, before);
}));

test('payment, status, confirmation and service transitions enforce order ownership', async () => mockEnabled(async () => {
  const { db, payment, orders } = services();
  const before = structuredClone(db.state);
  await assert.rejects(payment.createPayment('child-2', { orderId: 'order-1' }), ForbiddenException);
  await assert.rejects(payment.getStatus('child-2', 'order-1'), ForbiddenException);
  await assert.rejects(orders.confirmComplete('order-1', 'child-2'), ForbiddenException);
  await assert.rejects(orders.completeService('order-1', 'angel-2', {}), ForbiddenException);
  assert.deepEqual(db.state, before);
}));

test('custom quotes reject invalid money; catalog pricing cannot be overridden by the client', async () => {
  for (const price of [undefined, NaN, Infinity, -1, 0, 0.001, 1000001]) {
    const { db, orders } = services();
    const before = structuredClone(db.state);
    await assert.rejects(orders.create('child-1', createDto({ serviceTypeId: 'custom', price })), BadRequestException);
    assert.deepEqual(db.state, before);
  }
  const { orders } = services();
  assert.equal((await orders.create('child-1', createDto({ price: 1 }))).data.price, 100);
  assert.equal((await orders.create('child-1', createDto({ serviceTypeId: 'custom', price: 12.34 }))).data.price, 12.34);
});

test('creating an order checks elderly ownership and active service configuration', async () => {
  const { db, orders } = services();
  const before = structuredClone(db.state);
  await assert.rejects(orders.create('child-2', createDto()), BadRequestException);
  assert.deepEqual(db.state, before);
  db.state.services[0].isActive = false;
  await assert.rejects(orders.create('child-1', createDto()), BadRequestException);
  assert.equal(db.state.orders.length, 1);
});

test('DTO validation rejects non-finite quotes and unexpected fields before service invocation', async () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  for (const data of [createDto({ price: 'NaN' }), createDto({ price: -5 }), createDto({ price: 1.001 }), createDto({ isPaid: true })]) {
    await assert.rejects(pipe.transform(data, { type: 'body', metatype: CreateOrderDto }), BadRequestException);
  }
});

test('controllers reject cross-role payment and order mutations before touching the service', async () => {
  const payment = new PaymentController({} as any);
  const orders = new OrderController({} as any);
  const child = { user: { id: 'child-1', userType: 'child' } };
  const angel = { user: { id: 'angel-1', userType: 'angel' } };
  await assert.rejects(payment.createPayment(angel, { orderId: 'order-1' }), ForbiddenException);
  await assert.rejects(payment.getStatus(angel, 'order-1'), ForbiddenException);
  await assert.rejects(payment.withdraw(child, { amount: 10, method: WithdrawMethod.WECHAT }), ForbiddenException);
  await assert.rejects(orders.accept(child, 'order-1'), ForbiddenException);
  await assert.rejects(orders.complete(child, 'order-1', {}), ForbiddenException);
  await assert.rejects(orders.create(angel, createDto()), ForbiddenException);
  await assert.rejects(orders.confirm(angel, 'order-1'), ForbiddenException);
});

test('nearby and unassigned detail use a safe explicit preview without private fields', async () => {
  const { db, orders } = services(sampleOrder({ status: 'PENDING', angelId: null }));
  db.state.angels[0].isOnline = false; // Approval permits browsing; online is required only for acceptance.
  const nearby = await orders.getNearbyOrders('angel-1', { lat: 39.904234, lng: 116.407488, radius: 10 });
  const detail = await orders.getDetail('order-1', 'angel-1', 'angel');
  assert.equal(nearby.data.length, 1);
  for (const preview of [nearby.data[0], detail.data]) {
    assert.equal(preview.isPreview, true);
    assert.equal(preview.address, '接单后查看详细地址');
    assert.equal(preview.lat, 39.9);
    assert.equal(preview.lng, 116.41);
    for (const key of ['userId', 'elderlyId', 'angelId', 'remark', 'phone', 'healthNote', 'elderly', 'user', 'angel', 'timelines']) {
      assert.equal(Object.hasOwn(preview, key), false, `preview must omit ${key}`);
    }
    assert.equal(JSON.stringify(preview).includes('PRIVATE'), false);
    assert.equal(preview.price, 100);
    assert.equal(preview.serviceType.name, '陪同就医');
  }
  await assert.rejects(orders.accept('order-1', 'angel-1'), ForbiddenException);
});

test('unapproved or unverified angels cannot browse nearby orders or unassigned details', async () => {
  for (const changes of [{ isVerified: false }, { status: 'PENDING' }, { status: 'SUSPENDED' }]) {
    const { db, orders } = services(sampleOrder({ status: 'PENDING', angelId: null }));
    Object.assign(db.state.angels[0], changes);
    await assert.rejects(orders.getNearbyOrders('angel-1', { lat: 39.9, lng: 116.4 }), ForbiddenException);
    await assert.rejects(orders.getDetail('order-1', 'angel-1', 'angel'), ForbiddenException);
    assert.equal(db.nearbyQueries.length, 0);
  }
});

test('expired orders are excluded in the database query before the nearby candidate limit', async () => {
  const { db, orders } = services(sampleOrder({ status: 'PENDING', angelId: null }));
  const expired = Array.from({ length: 50 }, (_, index) => sampleOrder({
    id: `expired-${index}`, status: 'PENDING', angelId: null, serviceTime: new Date(Date.now() - 31 * 60 * 1000),
  }));
  db.state.orders.unshift(...expired);
  const nearby = await orders.getNearbyOrders('angel-1', { lat: 39.9, lng: 116.4, radius: 10 });
  assert.deepEqual(nearby.data.map(order => order.id), ['order-1']);
  assert.ok(db.nearbyQueries[0].serviceTime.gte instanceof Date);
  await assert.rejects(orders.getDetail('expired-0', 'angel-1', 'angel'), BadRequestException);
});

test('assigned details remain restricted to the actual angel and owning family', async () => {
  const { orders } = services(sampleOrder({ status: 'ACCEPTED' }));
  await assert.rejects(orders.getDetail('order-1', 'angel-2', 'angel'), ForbiddenException);
  await assert.rejects(orders.getDetail('order-1', 'child-2', 'child'), ForbiddenException);
  const detail = await orders.getDetail('order-1', 'angel-1', 'angel');
  assert.equal(detail.data.address, 'PRIVATE detailed address');
  assert.equal((detail.data as any).isPreview, undefined);
});
