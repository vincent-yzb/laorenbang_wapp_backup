const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loadIsolatedEnvironment } = require('../../scripts/isolated-env.cjs');
const environment = loadIsolatedEnvironment(process.argv[2]);
Object.assign(process.env, environment);
const { PrismaClient } = require('@prisma/client');
const { JwtService } = require('@nestjs/jwt');
const prisma = new PrismaClient();
const jwt = new JwtService({ secret: environment.JWT_SECRET });
const prefix = `http_${randomUUID()}`;
const ids = { child: `${prefix}_child`, outsider: `${prefix}_outsider`, angel: `${prefix}_angel` };
const elderlyIds = [], orderIds = [];
let checks = 0;

async function request(path, { method = 'GET', body, role, expected = 200 } = {}) {
  const token = role && jwt.sign({ sub: ids[role], userType: role === 'outsider' ? 'child' : role }, { expiresIn: '10m' });
  const response = await fetch(`http://127.0.0.1:3101/api${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, expected, `${method} ${path}: unexpected HTTP status`);
  checks++;
  return response.json();
}

async function main() {
  assert.equal((await request('/health')).status, 'ok');
  const catalog = await request('/services/types');
  const service = catalog.data.find(row => row.id === 'medical');
  assert.ok(service && service.price > 0);
  assert.equal((await request('/services/types/medical')).data.price, service.price);
  await request('/services/types/does-not-exist', { expected: 404 });
  await request('/orders', { expected: 401 });

  await prisma.user.createMany({ data: [
    { id: ids.child, phone: `${prefix}_phone_child`, name: '隔离HTTP测试子女' },
    { id: ids.outsider, phone: `${prefix}_phone_outsider`, name: '隔离HTTP无关用户' },
  ] });
  await prisma.angel.create({ data: { id: ids.angel, phone: `${prefix}_phone_angel`,
    name: '隔离HTTP测试天使', isVerified: true, status: 'APPROVED', isOnline: true } });
  await request('/user/profile', { method: 'PUT', role: 'child', body: { balance: 99999 }, expected: 400 });
  await request('/angel/toggle-online', { method: 'POST', role: 'child', body: { isOnline: true }, expected: 403 });

  const elderly = await request('/elderly', { method: 'POST', role: 'child', expected: 201, body: {
    name: '隔离虚构老人', phone: '19900000001', relation: '其他', address: '隔离测试虚构地址', lat: 31.23, lng: 121.47,
  } });
  assert.ok(elderly.success && elderly.data.id);
  elderlyIds.push(elderly.data.id);
  const elderlyLogin = await request('/auth/elderly-login', { method: 'POST', body: { inviteCode: elderly.data.inviteCode } });
  assert.ok(elderlyLogin.success && elderlyLogin.data.token);

  const created = await request('/orders', { method: 'POST', role: 'child', expected: 201, body: {
    elderlyId: elderly.data.id, serviceTypeId: 'medical', address: '隔离测试虚构地址',
    serviceTime: new Date(Date.now() + 3600000).toISOString(), lat: 31.23, lng: 121.47, price: 0.01,
  } });
  const order = created.data;
  orderIds.push(order.id);
  assert.equal(order.price, service.price, 'ordinary service ignores client-supplied quote');
  assert.equal(order.status, 'PENDING');
  await request(`/orders/${order.id}`, { role: 'outsider', expected: 403 });
  await request('/payment/create', { method: 'POST', role: 'child', body: { orderId: order.id }, expected: 400 });
  await request(`/orders/${order.id}/accept`, { method: 'POST', role: 'angel', expected: 201 });
  await request(`/orders/${order.id}/start`, { method: 'POST', role: 'angel', expected: 400 });
  for (const action of ['depart', 'arrive', 'start']) {
    await request(`/orders/${order.id}/${action}`, { method: 'POST', role: 'angel', expected: 201 });
  }
  await request(`/orders/${order.id}/complete`, { method: 'POST', role: 'angel', body: { remark: '离线隔离联调' }, expected: 201 });
  await request(`/orders/${order.id}/confirm`, { method: 'POST', role: 'child', expected: 400 });
  await request(`/payment/status/${order.id}`, { role: 'outsider', expected: 403 });
  const before = await prisma.angel.findUnique({ where: { id: ids.angel } });
  const payments = await Promise.all(Array.from({ length: 8 }, () => request('/payment/create', {
    method: 'POST', role: 'child', body: { orderId: order.id }, expected: 201,
  })));
  assert.ok(payments.every(result => result.mode === 'mock'));
  const status = (await request(`/payment/status/${order.id}`, { role: 'child' })).data;
  assert.ok(status.isPaid && status.completed && status.status === 'COMPLETED' && status.paymentMethod === 'mock');
  await request(`/orders/${order.id}/confirm`, { method: 'POST', role: 'child', expected: 201 });
  const income = await prisma.incomeRecord.findMany({ where: { orderId: order.id } });
  const after = await prisma.angel.findUnique({ where: { id: ids.angel } });
  assert.equal(income.length, 1);
  assert.equal(after.balance, before.balance + Math.round(service.price * 80) / 100);
  assert.equal(after.completedOrders, before.completedOrders + 1);
  assert.equal(await prisma.orderTimeline.count({ where: { orderId: order.id, event: 'PAID' } }), 1);
  await request('/payment/refund', { method: 'POST', role: 'child', body: { orderId: order.id, reason: '隔离验证' }, expected: 503 });
  await request('/payment/withdraw', { method: 'POST', role: 'angel', body: { amount: 10, method: 'wechat', requestKey: 'http_test_' + prefix }, expected: 503 });
  assert.equal((await prisma.angel.findUnique({ where: { id: ids.angel } })).balance, after.balance);
  await request('/auth/send-code', { method: 'POST', body: { phone: '19900000001', type: 'child' }, expected: 503 });
  console.log(`Isolated HTTP flow passed: ${checks} requests; real JWT + PostgreSQL; eight payments produced one income and one balance increment.`);
}

async function cleanup() {
  await prisma.orderTimeline.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.incomeRecord.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.elderly.deleteMany({ where: { id: { in: elderlyIds } } });
  await prisma.angel.deleteMany({ where: { id: ids.angel } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.child, ids.outsider] } } });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(async () => { try { await cleanup(); } finally { await prisma.$disconnect(); } });
