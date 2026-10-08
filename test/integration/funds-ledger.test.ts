import 'reflect-metadata';
import { before, after, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync, lstatSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { FundsService } from '../../src/modules/payment/funds.service';
import { ConfigService } from '../../src/config/config.service';

// Financial logic runs against genuine PostgreSQL. Only the verified provider boundary is offline.
const root = resolve(__dirname, '../..');
const envFile = resolve(root, '.local/isolated-postgres.env');
if (process.env.LRB_INTEGRATION_DB !== 'true' || (lstatSync(envFile).mode & 0o077)) throw new Error('Private isolated integration configuration required');
const values = Object.fromEntries(readFileSync(envFile, 'utf8').trim().split('\n').map(line => {
  const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
}));
for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
  const url = new URL(values[key]);
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/lrb_integration'
    || url.username !== 'lrb_integration' || !url.password) throw new Error('Refusing non-task database');
}
const docker = ['/usr/local/bin/docker', '--host', `unix://${process.env.HOME}/.docker/run/docker.sock`];
const schema = `funds_ledger_${randomBytes(8).toString('hex')}`;
assert.match(schema, /^funds_ledger_[a-f0-9]{16}$/);
function clientFor(name = 'public') {
  const url = new URL(values.DATABASE_URL); url.searchParams.set('schema', name);
  return new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [],
    __internal: { configOverride: config => ({ ...config, relativeEnvPaths: { rootEnvPath: null, schemaEnvPath: null } }) } } as any);
}
const admin = clientFor();
const db = clientFor(schema);
let verified = false;
let owned = false;
let counter = 0;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const stamp = () => new Date().toISOString();
const originalApp = process.env.WECHAT_APPID;
const originalMch = process.env.WECHAT_PAY_MCH_ID;

before(async () => {
  const inspection = spawnSync(docker[0], [...docker.slice(1), 'inspect', '--format', '{{index .Config.Labels "lrb.purpose"}}', 'lrb-integration-20261008'], { encoding: 'utf8' });
  assert.equal(inspection.status, 0); assert.equal(inspection.stdout.trim(), 'isolated-integration');
  const [identity]: any = await admin.$queryRawUnsafe('SELECT current_database() AS db,current_user AS role');
  assert.equal(identity.db, 'lrb_integration'); assert.equal(identity.role, 'lrb_integration'); verified = true;
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`); owned = true;
  const migrations = readdirSync(resolve(root, 'prisma/migrations')).filter(name => /^\d{8}_/.test(name)).sort();
  assert.deepEqual(migrations, ['20260120_baseline', '20261008_payment_ledger', '20261008_payment_review_audit',
    '20261008_wechat_app_scope', '20261008_wechat_identity']);
  const sql = migrations.map(name => readFileSync(resolve(root, 'prisma/migrations', name, 'migration.sql'), 'utf8')).join('\n');
  const applied = spawnSync(docker[0], [...docker.slice(1), 'exec', '--interactive', 'lrb-integration-20261008', 'psql', '-U', 'lrb_integration', '-d', 'lrb_integration', '--quiet', '--set', 'ON_ERROR_STOP=1', '--command', `SET search_path TO "${schema}"`, '--file', '-'], { input: sql, encoding: 'utf8' });
  assert.equal(applied.status, 0, 'Fresh sorted migration application failed; raw database details withheld');
  process.env.WECHAT_APPID = 'synthetic-funds-app'; process.env.WECHAT_PAY_MCH_ID = 'synthetic-funds-merchant';
});
after(async () => {
  await db.$disconnect();
  if (verified && owned) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.$disconnect();
  if (originalApp === undefined) delete process.env.WECHAT_APPID; else process.env.WECHAT_APPID = originalApp;
  if (originalMch === undefined) delete process.env.WECHAT_PAY_MCH_ID; else process.env.WECHAT_PAY_MCH_ID = originalMch;
});

async function fixture(options: { balance?: bigint; nonWithdrawable?: bigint; origin?: string } = {}) {
  const key = `synthetic_${++counter}`;
  const balance = options.balance ?? 8000n;
  const child = await db.user.create({ data: { phone: `${key}_child`, wechatOpenId: `${key}_child_openid`, wechatAppId: process.env.WECHAT_APPID } });
  const angel = await db.angel.create({ data: { phone: `${key}_angel`, wechatOpenId: `${key}_angel_openid`, wechatAppId: process.env.WECHAT_APPID, name: 'synthetic',
    status: 'APPROVED', isVerified: true, balance: Number(balance) / 100, balanceCents: balance,
    nonWithdrawableBalanceCents: options.nonWithdrawable ?? 0n } });
  const service = await db.serviceType.create({ data: { name: 'synthetic', icon: 'test', description: 'synthetic', price: 100,
    priceCents: 10000n, unit: 'test', duration: 'test', category: 'test' } });
  const elder = await db.elderly.create({ data: { name: 'synthetic', phone: `${key}_elder`, relation: 'test', address: 'synthetic', inviteCode: key, userId: child.id } });
  let order = await db.order.create({ data: { orderNo: key, userId: child.id, angelId: angel.id, elderlyId: elder.id,
    serviceTypeId: service.id, serviceTime: new Date(), address: 'synthetic', status: 'COMPLETED', price: 100, priceCents: 10000n,
    isPaid: true, paymentOrigin: options.origin ?? 'WECHAT' } });
  const attempt = await db.paymentAttempt.create({ data: { orderId: order.id, userId: child.id, mode: 'WECHAT', status: 'SUCCEEDED',
    outTradeNo: `${key}trade`, transactionId: `${key}transaction`, amountCents: 10000n, angelAmountCents: 8000n, platformAmountCents: 2000n,
    appId: process.env.WECHAT_APPID!, merchantId: process.env.WECHAT_PAY_MCH_ID!, payerIdentityHash: hash(child.wechatOpenId!), paidAt: new Date() } });
  order = await db.order.update({ where: { id: order.id }, data: { paidAttemptId: attempt.id } });
  await db.incomeRecord.create({ data: { angelId: angel.id, amount: Number(balance) / 100, amountCents: balance,
    entryKey: `income:${order.id}`, entryType: options.nonWithdrawable ? 'MOCK_INCOME' : 'WECHAT_INCOME',
    paymentAttemptId: attempt.id, orderId: order.id, type: '订单收入', description: 'synthetic' } });
  return { child, angel, order, attempt };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
class Provider {
  enabled = true; transferEnabled = true;
  refundCalls = 0; transferCalls = 0; refundQueries = 0; transferQueries = 0;
  lastReason = ''; lastBill = ''; lastTrade = '';
  refundState = 'PROCESSING'; transferState = 'WAIT_USER_CONFIRM';
  failRefund = false; failTransfer = false;
  constructor(readonly f: Fixture) {}
  isConfigured() { return this.enabled; }
  transferIsConfigured() { return this.enabled && this.transferEnabled; }
  async refundResource(outNo: string, state = this.refundState, notify = false): Promise<any> {
    const row = await db.refund.findUniqueOrThrow({ where: { outRefundNo: outNo } });
    return { out_refund_no: outNo, refund_id: `synthetic_refund_${row.id}`, out_trade_no: this.f.attempt.outTradeNo,
      transaction_id: this.f.attempt.transactionId, ...(notify ? { mchid: process.env.WECHAT_PAY_MCH_ID, refund_status: state } : { status: state }),
      amount: { total: 10000, refund: 10000, ...(notify ? {} : { currency: 'CNY' }) }, ...(state === 'SUCCESS' ? { success_time: stamp() } : {}) };
  }
  async transferResource(outNo: string, state = this.transferState, source = 'QUERY'): Promise<any> {
    const row = await db.withdrawal.findUniqueOrThrow({ where: { outBillNo: outNo } });
    return { out_bill_no: outNo, transfer_bill_no: `synthetic_transfer_${row.id}`, state,
      ...(source === 'CREATE' ? {} : { mch_id: process.env.WECHAT_PAY_MCH_ID, transfer_amount: Number(row.amountCents),
        ...(source === 'QUERY' ? { appid: process.env.WECHAT_APPID } : { openid: this.f.angel.wechatOpenId }) }),
      ...(source === 'CREATE' && state === 'WAIT_USER_CONFIRM' ? { package_info: 'synthetic-confirmation-package' } : {}),
      ...(state === 'SUCCESS' ? { update_time: stamp() } : {}) };
  }
  async createRefund(input: any) { this.refundCalls++; this.lastReason = input.reason; this.lastTrade = input.outTradeNo;
    if (this.failRefund) throw new Error('synthetic transport ambiguity'); return this.refundResource(input.outRefundNo); }
  async queryRefund(outNo: string) { this.refundQueries++; return this.refundResource(outNo); }
  async createTransfer(input: any) { this.transferCalls++; this.lastBill = input.outBillNo;
    if (this.failTransfer) throw new Error('synthetic transport ambiguity'); return this.transferResource(input.outBillNo, this.transferState, 'CREATE'); }
  async queryTransfer(outNo: string) { this.transferQueries++; return this.transferResource(outNo); }
}
const serviceFor = (provider: Provider) => new FundsService(db as any, new ConfigService(), provider as any);
function event(resource: any, eventType: string, id = `synthetic_event_${randomBytes(8).toString('hex')}`) {
  return { id, eventType, resource, digest: hash(id + JSON.stringify(resource)) };
}
const refundRequest = (s: FundsService, f: Fixture, reason = 'synthetic refund') => s.requestRefund(f.child.id, { orderId: f.order.id, reason });
const withdrawalRequest = (s: FundsService, f: Fixture, suffix: string, amount = 80) => s.requestWithdrawal(f.angel.id, { amount, method: 'wechat', requestKey: `synthetic_request_${suffix}` });
async function wallet(f: Fixture) { return db.angel.findUniqueOrThrow({ where: { id: f.angel.id } }); }
async function dueWithdrawal(id: string) { await db.withdrawal.update({ where: { id }, data: { nextQueryAt: new Date(0) } }); }

test('未配置真实通道在写入前失败，读状态不查询提供商；服务额外字段拒绝', async () => {
  const f = await fixture(); const p = new Provider(f); const s = serviceFor(p); p.enabled = false;
  await assert.rejects(refundRequest(s, f), { status: 503 });
  await assert.rejects(withdrawalRequest(s, f, 'disabled'), { status: 503 });
  assert.equal(await db.refund.count({ where: { orderId: f.order.id } }), 0);
  assert.equal(await db.withdrawal.count({ where: { angelId: f.angel.id } }), 0);
  p.enabled = true;
  await assert.rejects(s.requestRefund(f.child.id, { orderId: f.order.id, reason: 'test', status: 'SUCCESS' } as any));
  await assert.rejects(s.requestWithdrawal(f.angel.id, { amount: 80, method: 'wechat', requestKey: 'synthetic_request_invalid', bankCardId: 'forbidden' } as any));
  const request = await withdrawalRequest(s, f, 'read_disabled'); p.enabled = false;
  const read = await s.getWithdrawalStatus(f.angel.id, request.data.id, { reconcile: true });
  assert.equal(read.data.status, 'REQUESTED'); assert.equal(p.transferQueries, 0);
});

test('历史或mock付款不能真实退款，mock/旧余额不可提现，非本人拒绝', async () => {
  for (const origin of ['MOCK', 'LEGACY_UNVERIFIED']) {
    const f = await fixture({ origin, nonWithdrawable: 8000n }); const s = serviceFor(new Provider(f));
    await assert.rejects(refundRequest(s, f)); await assert.rejects(withdrawalRequest(s, f, origin));
    assert.equal((await wallet(f)).frozenBalanceCents, 0n);
  }
  const f = await fixture(); const s = serviceFor(new Provider(f));
  await assert.rejects(s.requestRefund('other-child', { orderId: f.order.id, reason: 'test' }), { status: 403 });
});

test('并发退款请求和审核只有一次冻结/上游请求，未知保持冻结；重复verified成功只冲回一次', async () => {
  const f = await fixture(); const p = new Provider(f); p.failRefund = true; const s = serviceFor(p);
  const requests = await Promise.all([refundRequest(s, f, '原因'.repeat(200)), refundRequest(s, f)]);
  assert.equal(requests[0].data.id, requests[1].data.id);
  const id = requests[0].data.id;
  await Promise.all([s.approveRefund(id, 'synthetic-operator'), s.approveRefund(id, 'synthetic-operator')]);
  assert.equal(p.refundCalls, 1); assert.ok(Buffer.byteLength(p.lastReason, 'utf8') <= 80); assert.equal(p.lastReason.includes('\ufffd'), false);
  assert.equal((await wallet(f)).frozenBalanceCents, 8000n); assert.equal((await wallet(f)).balanceCents, 8000n);
  assert.equal((await db.refund.findUniqueOrThrow({ where: { id } })).status, 'UNKNOWN');
  const row = await db.refund.findUniqueOrThrow({ where: { id } });
  const resource = await p.refundResource(row.outRefundNo, 'SUCCESS', true);
  const receipt = event(resource, 'REFUND.SUCCESS');
  await Promise.all([s.handleRefundNotification(receipt), s.handleRefundNotification(receipt), s.handleRefundNotification(event(resource, 'REFUND.SUCCESS'))]);
  assert.equal((await wallet(f)).balanceCents, 0n); assert.equal((await wallet(f)).frozenBalanceCents, 0n);
  assert.equal(await db.incomeRecord.count({ where: { refundId: id } }), 1);
  const order = await db.order.findUniqueOrThrow({ where: { id: f.order.id } }); assert.equal(order.status, 'REFUNDED'); assert.equal(order.isPaid, true);
  await assert.rejects(s.handleRefundNotification({ ...receipt, digest: 'f'.repeat(64) }));
});

test('提现请求幂等键防超时重复且拒绝改金额，审批前不扣余额', async () => {
  const f = await fixture(); const p = new Provider(f); const s = serviceFor(p);
  const [a, b] = await Promise.all([withdrawalRequest(s, f, 'same_key'), withdrawalRequest(s, f, 'same_key')]);
  assert.equal(a.data.id, b.data.id); assert.equal(a.data.status, 'REQUESTED');
  await assert.rejects(withdrawalRequest(s, f, 'same_key', 10));
  assert.equal((await wallet(f)).balanceCents, 8000n); assert.equal((await wallet(f)).frozenBalanceCents, 0n); assert.equal(p.transferCalls, 0);
});

test('真实PG旧/null天使AppID在申请/审批前拒绝，没有申请或冻结及商户请求', async () => {
  for (const wechatAppId of [null, 'synthetic-old-app']) {
    const f = await fixture(); const p = new Provider(f); const s = serviceFor(p);
    await db.angel.update({ where: { id: f.angel.id }, data: { wechatAppId } });
    await assert.rejects(withdrawalRequest(s, f, `old_scope_${counter}`), { status: 400 });
    assert.equal(await db.withdrawal.count({ where: { angelId: f.angel.id } }), 0);
    await db.angel.update({ where: { id: f.angel.id }, data: { wechatAppId: process.env.WECHAT_APPID } });
    const request = await withdrawalRequest(s, f, `before_scope_change_${counter}`);
    await db.angel.update({ where: { id: f.angel.id }, data: { wechatAppId } });
    await assert.rejects(s.approveWithdrawal(request.data.id, 'synthetic-operator'), { status: 400 });
    assert.equal((await wallet(f)).frozenBalanceCents, 0n); assert.equal((await wallet(f)).balanceCents, 8000n);
    assert.equal((await db.withdrawal.findUniqueOrThrow({ where: { id: request.data.id } })).status, 'REQUESTED');
    assert.equal(p.transferCalls, 0);
  }
});

test('真实PG两笔提现并发审批只有一笔能占用同一余额', async () => {
  const f = await fixture(); const p = new Provider(f); p.failTransfer = true; const s = serviceFor(p);
  const a = await withdrawalRequest(s, f, 'race_one'); const b = await withdrawalRequest(s, f, 'race_two');
  const outcomes = await Promise.allSettled([s.approveWithdrawal(a.data.id, 'operator'), s.approveWithdrawal(b.data.id, 'operator')]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1); assert.equal(p.transferCalls, 1);
  assert.equal((await wallet(f)).frozenBalanceCents, 8000n); assert.equal((await wallet(f)).balanceCents, 8000n);
});

test('真实PG退款与提现竞争同angel行，不能双花可用余额', async () => {
  const f = await fixture(); const p = new Provider(f); p.failRefund = true; p.failTransfer = true; const s = serviceFor(p);
  const refund = await refundRequest(s, f); const withdrawal = await withdrawalRequest(s, f, 'refund_vs_withdraw');
  const results = await Promise.allSettled([s.approveRefund(refund.data.id, 'operator'), s.approveWithdrawal(withdrawal.data.id, 'operator')]);
  assert.equal(results.filter(o => o.status === 'fulfilled').length, 1); assert.equal(p.refundCalls + p.transferCalls, 1);
  assert.equal((await wallet(f)).frozenBalanceCents, 8000n); assert.equal((await wallet(f)).balanceCents, 8000n);
});

test('WAIT_USER_CONFIRM查询保留create确认包；只有verified成功才扣账且重复幂等', async () => {
  const f = await fixture(); const p = new Provider(f); const s = serviceFor(p);
  const request = await withdrawalRequest(s, f, 'confirm'); const id = request.data.id;
  const approved = await s.approveWithdrawal(id, 'operator'); assert.equal(approved.data.status, 'WAIT_USER_CONFIRM');
  assert.ok(approved.data.transferConfirmParams?.package); assert.equal((await wallet(f)).balanceCents, 8000n);
  await dueWithdrawal(id);
  const queried = await s.getWithdrawalStatus(f.angel.id, id, { reconcile: true });
  assert.equal(queried.data.transferConfirmParams?.package, approved.data.transferConfirmParams?.package); assert.equal(p.transferCalls, 1);
  const row = await db.withdrawal.findUniqueOrThrow({ where: { id } }); const resource = await p.transferResource(row.outBillNo, 'SUCCESS', 'NOTIFY');
  const receipt = event(resource, 'MCHTRANSFER.BILL.FINISHED');
  await Promise.all([s.handleTransferNotification(receipt), s.handleTransferNotification(receipt), s.handleTransferNotification(event(resource, 'MCHTRANSFER.BILL.FINISHED'))]);
  assert.equal((await wallet(f)).balanceCents, 0n); assert.equal((await wallet(f)).balance, 0); assert.equal((await wallet(f)).frozenBalanceCents, 0n);
  assert.equal(await db.incomeRecord.count({ where: { withdrawalId: id } }), 1);
  assert.equal((await s.getWithdrawalStatus(f.angel.id, id)).data.transferConfirmParams, undefined);
  await assert.rejects(s.getWithdrawalStatus('other-angel', id), { status: 403 });
});

test('create结果丢失且query无确认包保持UNKNOWN与原outBillNo，不再次转账', async () => {
  const f = await fixture(); const p = new Provider(f); p.failTransfer = true; const s = serviceFor(p);
  const { data } = await withdrawalRequest(s, f, 'lost_package'); await s.approveWithdrawal(data.id, 'operator'); await dueWithdrawal(data.id);
  const read = await s.getWithdrawalStatus(f.angel.id, data.id, { reconcile: true });
  assert.equal(read.data.status, 'UNKNOWN'); assert.equal(read.data.transferConfirmParams, undefined);
  assert.equal(read.data.lastErrorCode, 'CONFIRM_PACKAGE_UNAVAILABLE'); assert.equal((await wallet(f)).frozenBalanceCents, 8000n);
  await s.approveWithdrawal(data.id, 'operator'); assert.equal(p.transferCalls, 1);
});

test('已核验失败或关闭只解冻不扣账，重复与冲突终态不重复变动', async () => {
  for (const state of ['FAIL', 'CANCELLED']) {
    const f = await fixture(); const p = new Provider(f); p.failTransfer = true; const s = serviceFor(p);
    const { data } = await withdrawalRequest(s, f, state); await s.approveWithdrawal(data.id, 'operator');
    const row = await db.withdrawal.findUniqueOrThrow({ where: { id: data.id } });
    const resource = await p.transferResource(row.outBillNo, state, 'NOTIFY'); const receipt = event(resource, 'MCHTRANSFER.BILL.FINISHED');
    await s.handleTransferNotification(receipt); await s.handleTransferNotification(receipt);
    assert.equal((await wallet(f)).balanceCents, 8000n); assert.equal((await wallet(f)).frozenBalanceCents, 0n);
    await assert.rejects(s.handleTransferNotification(event(await p.transferResource(row.outBillNo, 'SUCCESS', 'NOTIFY'), 'MCHTRANSFER.BILL.FINISHED')));
  }
  const f = await fixture(); const p = new Provider(f); p.failRefund = true; const s = serviceFor(p);
  const { data } = await refundRequest(s, f); await s.approveRefund(data.id, 'operator');
  const row = await db.refund.findUniqueOrThrow({ where: { id: data.id } });
  await s.handleRefundNotification(event(await p.refundResource(row.outRefundNo, 'CLOSED', true), 'REFUND.CLOSED'));
  assert.equal((await wallet(f)).balanceCents, 8000n); assert.equal((await wallet(f)).frozenBalanceCents, 0n);
});

test('通知商户/金额/收款身份/完成时间错误不能出款；finished不接受待确认', async () => {
  const f = await fixture(); const p = new Provider(f); p.failTransfer = true; const s = serviceFor(p);
  const { data } = await withdrawalRequest(s, f, 'invalid_receipt'); await s.approveWithdrawal(data.id, 'operator');
  const row = await db.withdrawal.findUniqueOrThrow({ where: { id: data.id } });
  const resource = await p.transferResource(row.outBillNo, 'SUCCESS', 'NOTIFY');
  for (const patch of [{ mch_id: 'wrong' }, { transfer_amount: 7999 }, { openid: 'wrong' }, { update_time: undefined }, { update_time: 'invalid' }, { update_time: '2026-02-30T12:00:00Z' }, { state: 'WAIT_USER_CONFIRM' }]) {
    await assert.rejects(s.handleTransferNotification(event({ ...resource, ...patch }, 'MCHTRANSFER.BILL.FINISHED')));
  }
  assert.equal((await wallet(f)).balanceCents, 8000n); assert.equal((await wallet(f)).frozenBalanceCents, 8000n);
  assert.equal(await db.incomeRecord.count({ where: { withdrawalId: data.id } }), 0);
});

test('ledger写失败真实事务完整回滚，事件可补偿，重试只有一笔成功负账', async () => {
  const f = await fixture(); const p = new Provider(f); p.failRefund = true; const s = serviceFor(p);
  const { data } = await refundRequest(s, f); await s.approveRefund(data.id, 'operator');
  const injected = await db.incomeRecord.create({ data: { angelId: f.angel.id, amount: 0, amountCents: 0n, entryKey: `refund:${data.id}`,
    entryType: 'TEST_INJECTED', type: 'synthetic', description: 'synthetic failure injection' } });
  const row = await db.refund.findUniqueOrThrow({ where: { id: data.id } }); const receipt = event(await p.refundResource(row.outRefundNo, 'SUCCESS', true), 'REFUND.SUCCESS');
  await assert.rejects(s.handleRefundNotification(receipt));
  assert.equal((await wallet(f)).balanceCents, 8000n); assert.equal((await wallet(f)).frozenBalanceCents, 8000n);
  assert.equal((await db.refund.findUniqueOrThrow({ where: { id: data.id } })).status, 'UNKNOWN');
  assert.equal((await db.paymentEvent.findUniqueOrThrow({ where: { eventId: receipt.id } })).status, 'RETRY');
  await db.incomeRecord.delete({ where: { id: injected.id } }); // Owned synthetic row in this disposable schema only.
  await s.handleRefundNotification(receipt); assert.equal((await wallet(f)).balanceCents, 0n); assert.equal((await wallet(f)).frozenBalanceCents, 0n);
});

test('审核拒绝原因和独立operator留审计，不误写approval，不冻结', async () => {
  const f = await fixture(); const p = new Provider(f); const s = serviceFor(p);
  const refund = await refundRequest(s, f); const withdrawal = await withdrawalRequest(s, f, 'review');
  await s.rejectRefund(refund.data.id, 'synthetic-operator', 'synthetic review reason');
  await s.rejectWithdrawal(withdrawal.data.id, 'synthetic-operator', 'synthetic review reason');
  const r = await db.refund.findUniqueOrThrow({ where: { id: refund.data.id } });
  const w = await db.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.data.id } });
  for (const row of [r, w]) { assert.equal(row.status, 'REJECTED'); assert.equal(row.rejectedBy, 'synthetic-operator'); assert.ok(row.rejectedAt);
    assert.equal(row.rejectionReason, 'synthetic review reason'); assert.equal(row.approvedAt, null); assert.equal(row.approvedBy, null); }
  assert.equal((await wallet(f)).frozenBalanceCents, 0n); assert.equal(p.refundCalls + p.transferCalls, 0);
});

test('不同provider ID并发成功通知不能被SUCCESS快捷ACK，只允许一个收款凭证', async () => {
  const f = await fixture(); const p = new Provider(f); p.failTransfer = true; const s = serviceFor(p);
  const { data } = await withdrawalRequest(s, f, 'provider_id_race'); await s.approveWithdrawal(data.id, 'operator');
  const row = await db.withdrawal.findUniqueOrThrow({ where: { id: data.id } });
  const resource = await p.transferResource(row.outBillNo, 'SUCCESS', 'NOTIFY');
  const outcomes = await Promise.allSettled([
    s.handleTransferNotification(event(resource, 'MCHTRANSFER.BILL.FINISHED')),
    s.handleTransferNotification(event({ ...resource, transfer_bill_no: resource.transfer_bill_no + '_conflict' }, 'MCHTRANSFER.BILL.FINISHED')),
  ]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal((await wallet(f)).balanceCents, 0n); assert.equal((await wallet(f)).frozenBalanceCents, 0n);
  assert.equal(await db.incomeRecord.count({ where: { withdrawalId: data.id } }), 1);
});

test('ABNORMAL保留冻结，之后可信查单SUCCESS补偿通知丢失且不重复请求退款', async () => {
  const f = await fixture(); const p = new Provider(f); p.failRefund = true; const s = serviceFor(p);
  const { data } = await refundRequest(s, f); await s.approveRefund(data.id, 'operator');
  const row = await db.refund.findUniqueOrThrow({ where: { id: data.id } });
  await s.handleRefundNotification(event(await p.refundResource(row.outRefundNo, 'ABNORMAL', true), 'REFUND.ABNORMAL'));
  assert.equal((await wallet(f)).balanceCents, 8000n); assert.equal((await wallet(f)).frozenBalanceCents, 8000n);
  await db.refund.update({ where: { id: data.id }, data: { nextQueryAt: new Date(0) } }); p.refundState = 'SUCCESS';
  const result = await s.getRefundStatus(f.child.id, data.id, { reconcile: true });
  assert.equal(result.data.status, 'SUCCESS'); assert.equal(p.refundQueries, 1); assert.equal(p.refundCalls, 1);
  assert.equal((await wallet(f)).balanceCents, 0n); assert.equal((await wallet(f)).frozenBalanceCents, 0n);
});

test('所有本轮真实数据库钱包均等于opening加非LEGACY账目，冻结与不可提现子集不超总额', async () => {
  for (const angel of await db.angel.findMany()) {
    const sum = await db.incomeRecord.aggregate({ where: { angelId: angel.id, entryType: { not: 'LEGACY' } }, _sum: { amountCents: true } });
    assert.equal(angel.balanceCents, angel.openingBalanceCents + (sum._sum.amountCents ?? 0n));
    assert.ok(angel.balanceCents >= 0n && angel.frozenBalanceCents >= 0n && angel.nonWithdrawableBalanceCents >= 0n);
    assert.ok(angel.frozenBalanceCents + angel.nonWithdrawableBalanceCents <= angel.balanceCents);
  }
});
