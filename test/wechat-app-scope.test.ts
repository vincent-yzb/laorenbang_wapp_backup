import 'reflect-metadata';
import { test, TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../src/modules/auth/auth.service';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { UserType, JwtPayload } from '../src/modules/auth/dto/auth.dto';
import { FundsService } from '../src/modules/payment/funds.service';

const appId = 'wx0123456789abcdef';
const oldAppId = 'wxfedcba9876543210';
const openid = 'synthetic-app-scoped-openid';
const jwtSecret = 'offline-app-scope-test-signing-secret';
const rejected = (status: number) => (error: any) => error.getStatus?.() === status;

function environment(t: TestContext, values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

function fixture(currentAppId = appId) {
  const rows: Record<string, any[]> = { user: [], angel: [], elderly: [] };
  let reads = 0, writes = 0, phoneProofs = 0;
  const table = (kind: string) => ({
    async upsert({ where, create, update }: any) {
      writes++;
      let row = rows[kind].find(item => Object.entries(where).every(([key, value]) => item[key] === value));
      if (!row) { row = { id: `${kind}-${rows[kind].length + 1}`, ...create }; rows[kind].push(row); }
      else Object.assign(row, update);
      return row;
    },
    async findUnique({ where }: any) {
      reads++;
      return rows[kind].find(item => Object.entries(where).every(([key, value]) => item[key] === value)) ?? null;
    },
  });
  const prisma: any = { user: table('user'), angel: table('angel'), elderly: table('elderly') };
  const config: any = { wechatAppId: currentAppId, jwtSecret };
  const jwt = new JwtService({ secret: jwtSecret, signOptions: { expiresIn: '7d' } });
  const identity: any = {
    getWechatOpenId: async () => openid,
    consumePhoneCode: async () => { phoneProofs++; },
  };
  return { rows, config, jwt, prisma, auth: new AuthService(prisma, jwt, identity, config),
    strategy: new JwtStrategy(prisma, config), counts: () => ({ reads, writes, phoneProofs }) };
}

test('微信注册保存 AppID，两个角色的新 access/refresh JWT 均绑定当前 AppID', async () => {
  const f = fixture();
  for (const userType of [UserType.CHILD, UserType.ANGEL]) {
    const first = await f.auth.wechatLogin({ code: 'synthetic-code', userType });
    const kind = userType === UserType.CHILD ? 'user' : 'angel';
    assert.equal(f.rows[kind][0].wechatAppId, appId);
    assert.equal(f.rows[kind][0].wechatOpenId, openid);
    f.rows[kind][0].phone = '13800138000';
    const repeated = await f.auth.wechatLogin({ code: 'different-code', userType });
    assert.equal(repeated.data!.user.id, first.data!.user.id);
    assert.equal(repeated.data!.user.phone, '13800138000');
    const access = f.jwt.verify<JwtPayload>(repeated.data!.token);
    const refresh = f.jwt.verify<JwtPayload>(repeated.data!.refreshToken, { secret: jwtSecret + '_refresh' });
    assert.equal(access.appId, appId); assert.equal(refresh.appId, appId);
    assert.equal((await f.strategy.validate(access)).id, first.data!.user.id);
    assert.equal((await f.auth.refreshToken(repeated.data!.refreshToken)).data!.user.id, first.data!.user.id);
  }
});

test('旧空归属与其他 AppID 的相同 openid 均拒绝认领；资料和数量保持不变', async () => {
  for (const userType of [UserType.CHILD, UserType.ANGEL]) {
    for (const wechatAppId of [null, oldAppId]) {
      const f = fixture(); const kind = userType === UserType.CHILD ? 'user' : 'angel';
      f.rows[kind].push({ id: 'legacy', wechatOpenId: openid, wechatAppId, phone: 'legacy-placeholder', name: '旧资料' });
      const before = structuredClone(f.rows);
      await assert.rejects(f.auth.wechatLogin({ code: 'synthetic-code', userType }), rejected(401));
      assert.deepEqual(f.rows, before);
    }
  }
});

test('不同 AppID 的手机号占位哈希不同，不能用旧 openid 哈希碰撞关联账号', async () => {
  const current = fixture(); const other = fixture(oldAppId);
  await current.auth.wechatLogin({ code: 'synthetic-code', userType: UserType.CHILD });
  await other.auth.wechatLogin({ code: 'synthetic-code', userType: UserType.CHILD });
  assert.notEqual(current.rows.user[0].phone, other.rows.user[0].phone);
  assert.match(current.rows.user[0].phone, /^wx_[a-f0-9]{64}$/);
});

test('正确签名的旧 JWT/refresh 及其他 AppID JWT 在读取用户前失效', async () => {
  const f = fixture(); f.rows.user.push({ id: 'child', phone: 'synthetic' });
  for (const scope of [{}, { appId: oldAppId }]) {
    const payload: JwtPayload = { sub: 'child', userType: UserType.CHILD, ...scope };
    const token = f.jwt.sign(payload);
    const refresh = f.jwt.sign(payload, { secret: jwtSecret + '_refresh' });
    assert.equal(await f.auth.validateToken(token), null);
    await assert.rejects(f.auth.refreshToken(refresh), rejected(401));
    await assert.rejects(f.strategy.validate(f.jwt.verify(token)), rejected(401));
  }
  assert.equal(f.counts().reads, 0);
  assert.equal(f.counts().writes, 0);
});

test('所有角色均可使用当前 AppID JWT；配置切换后此前 access 和 refresh 立即拒绝', async () => {
  const f = fixture();
  for (const [kind, userType] of [['user', UserType.CHILD], ['angel', UserType.ANGEL], ['elderly', UserType.ELDERLY]] as const) {
    f.rows[kind].push({ id: kind, phone: 'synthetic' });
    const payload: JwtPayload = { sub: kind, userType, appId };
    const token = f.jwt.sign(payload), refresh = f.jwt.sign(payload, { secret: jwtSecret + '_refresh' });
    assert.equal((await f.auth.validateToken(token))?.appId, appId);
    assert.equal((await f.strategy.validate(payload)).userType, userType);
    assert.equal(f.jwt.verify<JwtPayload>((await f.auth.refreshToken(refresh)).data!.token).appId, appId);
    f.config.wechatAppId = oldAppId;
    assert.equal(await f.auth.validateToken(token), null);
    await assert.rejects(f.strategy.validate(payload), rejected(401));
    await assert.rejects(f.auth.refreshToken(refresh), rejected(401));
    f.config.wechatAppId = appId;
  }
});

test('生产缺 AppID 拒绝签发和验证，即便设置本地标记；普通 development 也不兼容', async t => {
  environment(t, { NODE_ENV: 'production', LRB_INTEGRATION_DB: 'true', LRB_ISOLATED_ENV: 'true' });
  const f = fixture(''); const payload: JwtPayload = { sub: 'child', userType: UserType.CHILD };
  await assert.rejects(f.auth.phoneLogin({ phone: '13800138000', code: '123456', userType: UserType.CHILD }), rejected(503));
  await assert.rejects(f.auth.elderlyLogin({ inviteCode: 'ABC123' }), rejected(503));
  await assert.rejects(f.auth.wechatLogin({ code: 'synthetic-code', userType: UserType.CHILD }), rejected(503));
  assert.equal(await f.auth.validateToken(f.jwt.sign(payload)), null);
  await assert.rejects(f.strategy.validate(payload), rejected(401));
  assert.deepEqual(f.counts(), { reads: 0, writes: 0, phoneProofs: 0 });
  process.env.NODE_ENV = 'development'; delete process.env.LRB_INTEGRATION_DB; delete process.env.LRB_ISOLATED_ENV;
  await assert.rejects(f.strategy.validate(payload), rejected(401));
  await assert.rejects(f.auth.phoneLogin({ phone: '13800138000', code: '123456', userType: UserType.CHILD }), rejected(503));
});

test('仅显式离线 test/隔离 development 可兼容无 AppID，配置 AppID 后不再放行', async t => {
  environment(t, { NODE_ENV: 'test', LRB_INTEGRATION_DB: undefined, LRB_ISOLATED_ENV: undefined });
  const f = fixture('');
  const result = await f.auth.phoneLogin({ phone: '13800138000', code: '123456', userType: UserType.CHILD });
  const payload = f.jwt.verify<JwtPayload>(result.data!.token);
  assert.equal(payload.appId, undefined);
  assert.equal((await f.strategy.validate(payload)).id, result.data!.user.id);
  process.env.NODE_ENV = 'development'; process.env.LRB_ISOLATED_ENV = 'true';
  assert.equal((await f.strategy.validate(payload)).id, result.data!.user.id);
  delete process.env.LRB_ISOLATED_ENV; process.env.LRB_INTEGRATION_DB = 'true';
  assert.equal((await f.strategy.validate(payload)).id, result.data!.user.id);
  f.config.wechatAppId = appId;
  await assert.rejects(f.strategy.validate(payload), rejected(401));
  assert.equal(await f.auth.validateToken(result.data!.token), null);
});

test('旧天使 AppID 或空归属在提现申请及审核前拒绝，不创建/冻结/请求上游', async () => {
  for (const wechatAppId of [null, oldAppId]) {
    const angel = { id: 'angel', status: 'APPROVED', isVerified: true, wechatOpenId: openid, wechatAppId,
      balanceCents: 8000n, frozenBalanceCents: 0n, nonWithdrawableBalanceCents: 0n };
    let writes = 0, providerCalls = 0;
    const row = { id: 'withdrawal', angel, angelId: angel.id, status: 'REQUESTED', amountCents: 8000n };
    const tx = { $queryRaw: async () => [], withdrawal: { findUnique: async () => row,
      update: async () => { writes++; } }, $executeRaw: async () => { writes++; } };
    const prisma: any = { angel: { findUnique: async () => angel }, withdrawal: { create: async () => { writes++; } },
      $transaction: async (operation: any) => operation(tx) };
    const gateway: any = { transferIsConfigured: () => true, createTransfer: async () => { providerCalls++; } };
    const funds = new FundsService(prisma, { wechatAppId: appId } as any, gateway);
    await assert.rejects(funds.requestWithdrawal('angel', { amount: 80, method: 'wechat', requestKey: 'synthetic_request_key' }), rejected(400));
    await assert.rejects(funds.approveWithdrawal('withdrawal', 'offline-operator'), rejected(400));
    assert.equal(writes, 0); assert.equal(providerCalls, 0); assert.equal(angel.frozenBalanceCents, 0n);
  }
});
