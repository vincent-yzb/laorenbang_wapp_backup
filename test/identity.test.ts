import 'reflect-metadata';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CacheService } from '../src/cache/cache.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { IdentityService } from '../src/modules/auth/identity.service';
import { BindPhoneDto, UserType, WechatLoginDto } from '../src/modules/auth/dto/auth.dto';
import { UserTypeGuard, RequireUserType } from '../src/modules/auth/user-type.guard';
import { UserService } from '../src/modules/user/user.service';
import { AngelService } from '../src/modules/angel/angel.service';
import { ElderlyService } from '../src/modules/elderly/elderly.service';

function fixture() {
  const config: any = { wechatAppId: 'test-app', wechatAppSecret: 'test-secret', jwtSecret: 'test-jwt' };
  const rows = { user: [] as any[], angel: [] as any[] };
  const writes: any[] = [];
  const table = (kind: 'user' | 'angel') => ({
    async upsert({ where, create, update }) {
      let row = rows[kind].find(row => Object.entries(where).every(([key, value]) => row[key] === value));
      if (!row) { row = { id: `${kind}-${rows[kind].length + 1}`, ...create }; rows[kind].push(row); }
      else Object.assign(row, update);
      writes.push({ kind, operation: 'upsert', where, create, update });
      return row;
    },
    async findUnique({ where }) { return rows[kind].find(row => Object.entries(where).every(([key, value]) => row[key] === value)) || null; },
    async update({ where, data }) {
      const row = rows[kind].find(row => row.id === where.id);
      if (!row) throw new Error('missing row');
      if (data.phone && rows[kind].some(other => other.id !== row.id && other.phone === data.phone)) {
        throw Object.assign(new Error('unique conflict'), { code: 'P2002' });
      }
      writes.push({ kind, operation: 'update', data });
      Object.assign(row, data);
      return row;
    },
  });
  const prisma: any = { user: table('user'), angel: table('angel'), elderly: {
    async findUnique() { return { id: 'elder-1', userId: 'user-1' }; },
    async update(args) { writes.push(args); return args.data; },
  } };
  const cache = new CacheService(config);
  const identity = new IdentityService(cache, config);
  const jwt: any = { sign: payload => `token-${payload.sub}` };
  return { config, rows, writes, prisma, cache, identity, auth: new AuthService(prisma, jwt, identity, config),
    user: new UserService(prisma, identity), angel: new AngelService(prisma, identity), elderly: new ElderlyService(prisma) };
}

function mockWechat(t: any, handler: (url: string, options?: any) => any) {
  t.mock.method(globalThis, 'fetch', async (url: any, options: any) => ({ ok: true, json: async () => handler(String(url), options) }));
}

function environment(t: any, values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

test('微信身份稳定：更换code及绑定手机号后仍返回原账号', async t => {
  const f = fixture();
  mockWechat(t, () => ({ openid: 'openid-original-12345678' }));
  const first = await f.auth.wechatLogin({ code: 'code-one', userType: UserType.CHILD });
  await f.cache.setVerificationCode('13800138001', '654321');
  await f.user.bindPhone(first.data!.user.id, '13800138001', '654321');
  const second = await f.auth.wechatLogin({ code: 'code-two', userType: UserType.CHILD });
  assert.equal(first.data!.user.id, second.data!.user.id);
  assert.equal(second.data!.user.phone, '13800138001');
  assert.equal(f.rows.user.length, 1);
  assert.equal(f.rows.user[0].wechatOpenId, 'openid-original-12345678');
  assert.equal(f.rows.user[0].wechatAppId, f.config.wechatAppId);
  assert.equal(f.writes[0].create.phone.length, 67);
  assert.deepEqual(f.writes[0].where, { wechatOpenId: 'openid-original-12345678' });
});

test('openid末8位相同仍创建不同账号，子女与天使角色独立', async t => {
  const f = fixture();
  mockWechat(t, url => ({ openid: url.includes('js_code=first') ? 'prefix-one-12345678' : 'prefix-two-12345678' }));
  const first = await f.auth.wechatLogin({ code: 'first', userType: UserType.CHILD });
  const second = await f.auth.wechatLogin({ code: 'second', userType: UserType.CHILD });
  const angel = await f.auth.wechatLogin({ code: 'second', userType: UserType.ANGEL });
  assert.notEqual(first.data!.user.id, second.data!.user.id);
  assert.notEqual(f.rows.user[0].phone, f.rows.user[1].phone);
  assert.equal(angel.data!.user.userType, UserType.ANGEL);
  assert.equal(f.rows.angel.length, 1);
  assert.equal(f.rows.angel[0].isOnline, undefined);
});

test('微信配置缺失、错误响应和网络异常均不创建任何账号', async t => {
  const missing = fixture();
  missing.config.wechatAppSecret = '';
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not call network'); });
  await assert.rejects(missing.auth.wechatLogin({ code: 'valid-code', userType: UserType.CHILD }), error => (error as any).getStatus() === 503);
  assert.equal(missing.writes.length, 0);
  t.mock.restoreAll();
  const rejected = fixture();
  mockWechat(t, () => ({ errcode: 40029, errmsg: 'invalid authorization' }));
  await assert.rejects(rejected.auth.wechatLogin({ code: 'valid-code', userType: UserType.CHILD }), error => (error as any).getStatus() === 401);
  assert.equal(rejected.writes.length, 0);
  t.mock.restoreAll();
  const offline = fixture();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network error containing sensitive request'); });
  await assert.rejects(offline.auth.wechatLogin({ code: 'valid-code', userType: UserType.CHILD }), error => (error as any).getStatus() === 503 && !(error as Error).message.includes('sensitive'));
  assert.equal(offline.writes.length, 0);
});

test('微信登录非法参数在调用微信或数据库前拒绝', async t => {
  const f = fixture();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not call'); });
  for (const dto of [{ code: '', userType: 'child' }, { code: 'space code', userType: 'child' }, { code: 'valid', userType: 'admin' }, { code: 'valid', userType: 'child', phone: '13800138000' }, { code: 'valid', userType: 'elderly' }]) {
    await assert.rejects(f.auth.wechatLogin(dto as any));
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(f.writes.length, 0);
});

test('短信未集成时503，开发验证码必须显式开启且不假称已发送', async t => {
  const f = fixture();
  environment(t, { NODE_ENV: 'production', ALLOW_MOCK_SMS: 'true' });
  await assert.rejects(f.identity.sendCode({ phone: '13800138001', type: UserType.CHILD }), error => (error as any).getStatus() === 503);
  delete process.env.NODE_ENV;
  await assert.rejects(f.identity.sendCode({ phone: '13800138001', type: UserType.CHILD }));
  process.env.NODE_ENV = 'development';
  delete process.env.ALLOW_MOCK_SMS;
  await assert.rejects(f.identity.sendCode({ phone: '13800138001', type: UserType.CHILD }));
  process.env.ALLOW_MOCK_SMS = 'true';
  const result = await f.identity.sendCode({ phone: '13800138001', type: UserType.CHILD });
  assert.match(result.devCode, /^\d{6}$/);
  assert.match(result.message, /未发送短信/);
  assert.equal((result as any).code, undefined);
});

test('用户和天使绑定手机号拒绝任意六位验证码且有效码只能消费一次', async () => {
  const f = fixture();
  f.rows.user.push({ id: 'user-1', phone: 'wx_placeholder', wechatOpenId: 'persistent-openid' });
  f.rows.angel.push({ id: 'angel-1', phone: 'wx_angel' });
  await assert.rejects(f.user.bindPhone('user-1', '13800138001', '123456'));
  await assert.rejects(f.angel.bindPhone('angel-1', '13800138002', '123456'));
  await f.cache.setVerificationCode('13800138001', '654321');
  await assert.rejects(f.user.bindPhone('user-1', '13800138001', '111111'));
  await f.user.bindPhone('user-1', '13800138001', '654321');
  await assert.rejects(f.user.bindPhone('user-1', '13800138001', '654321'));
  assert.equal(f.rows.user[0].wechatOpenId, 'persistent-openid');
  await f.cache.setVerificationCode('13800138002', '654322');
  await f.angel.bindPhone('angel-1', '13800138002', '654322');
  assert.equal(f.rows.angel[0].phone, '13800138002');
});

test('缓存验证码过期、跨手机号和并发重放均无法绕过', async () => {
  const f = fixture();
  await f.cache.setVerificationCode('13800138001', '654321', -1);
  assert.equal(await f.cache.consumeVerificationCode('13800138001', '654321'), false);
  await f.cache.setVerificationCode('13800138001', '654321');
  await assert.rejects(f.identity.consumePhoneCode('13800138002', '654321'));
  const attempts = await Promise.allSettled([f.identity.consumePhoneCode('13800138001', '654321'), f.identity.consumePhoneCode('13800138001', '654321')]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
});

test('手机号绑定冲突拒绝覆盖其他账号', async () => {
  const f = fixture();
  f.rows.user.push({ id: 'user-1', phone: 'wx_placeholder' }, { id: 'user-2', phone: '13800138001' });
  await f.cache.setVerificationCode('13800138001', '654321');
  await assert.rejects(f.user.bindPhone('user-1', '13800138001', '654321'));
  assert.equal(f.rows.user[0].phone, 'wx_placeholder');
});

test('微信授权手机号验证上游结果；缺配置不返回共享模拟手机号', async t => {
  const f = fixture();
  f.rows.angel.push({ id: 'angel-1', phone: 'wx_placeholder' });
  mockWechat(t, url => url.includes('/cgi-bin/token') ? { access_token: 'test-access-token' } : { errcode: 0, phone_info: { purePhoneNumber: '13800138002' } });
  await f.angel.bindWechatPhone('angel-1', 'phone-auth-code');
  assert.equal(f.rows.angel[0].phone, '13800138002');
  f.config.wechatAppId = '';
  await assert.rejects(f.angel.bindWechatPhone('angel-1', 'other-code'), error => (error as any).getStatus() === 503);
  assert.equal(f.rows.angel[0].phone, '13800138002');
});

test('用户、天使、老人更新在服务边界拒绝敏感字段及数据库映射字段', async () => {
  const f = fixture();
  for (const field of ['balance', 'isVerified', 'status', 'userId', 'wechatOpenId', 'wechatAppId', 'phone', 'id', 'createdAt']) {
    await assert.rejects(f.user.updateProfile('user-1', { name: '合法姓名', [field]: 'injected' } as any));
    await assert.rejects(f.angel.updateProfile('angel-1', { name: '合法姓名', [field]: 'injected' } as any));
  }
  for (const field of ['balance', 'isVerified', 'status', 'userId', 'inviteCode', 'id', 'createdAt', 'user']) {
    await assert.rejects(f.elderly.update('elder-1', 'user-1', { name: '合法姓名', [field]: 'injected' } as any));
  }
  assert.equal(f.writes.length, 0);
});

test('允许的资料更新只持久化白名单字段', async () => {
  const f = fixture();
  f.rows.user.push({ id: 'user-1', phone: '13800138001' });
  f.rows.angel.push({ id: 'angel-1', phone: '13800138002' });
  await f.user.updateProfile('user-1', { name: '家人', avatar: '/avatar.png' });
  await f.angel.updateProfile('angel-1', { name: '天使' });
  await f.elderly.update('elder-1', 'user-1', { address: '新地址', lat: 30, lng: 104 });
  assert.deepEqual(Object.keys(f.writes[0].data).sort(), ['avatar', 'name']);
  assert.deepEqual(Object.keys(f.writes[1].data), ['name']);
  assert.deepEqual(Object.keys(f.writes[2].data).sort(), ['address', 'lat', 'lng']);
});

test('严格HTTP白名单保留已装饰认证字段并拒绝额外字段', async () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const meta: any = { type: 'body', metatype: BindPhoneDto };
  const dto = await pipe.transform({ phone: '13800138001', code: '654321' }, meta);
  assert.equal(dto.phone, '13800138001');
  await assert.rejects(pipe.transform({ phone: '13800138001', code: '654321', isVerified: true }, meta));
  await assert.rejects(pipe.transform({ code: 'valid', userType: UserType.CHILD, wechatOpenId: 'injected' }, { type: 'body', metatype: WechatLoginDto }));
});

test('角色校验阻止child凭证执行angel操作', () => {
  class AngelEndpoint {}
  RequireUserType(UserType.ANGEL)(AngelEndpoint);
  const guard = new UserTypeGuard(new Reflector());
  const context = (userType: UserType): any => ({ getHandler: () => AngelEndpoint, getClass: () => AngelEndpoint, switchToHttp: () => ({ getRequest: () => ({ user: { id: 'same-id', userType } }) }) });
  assert.throws(() => guard.canActivate(context(UserType.CHILD)), error => (error as any).getStatus() === 403);
  assert.equal(guard.canActivate(context(UserType.ANGEL)), true);
});

test('未接入实名认证时不会将用户标记为已认证', async () => {
  const f = fixture();
  await assert.rejects(f.user.verifyIdentity('user-1', { name: '测试姓名', idCard: '110101199001011234' }), error => (error as any).getStatus() === 503);
  assert.equal(f.writes.length, 0);
});

test('老人邀请码登录保留家人信息与原6位邀请码', async () => {
  const f = fixture();
  let received: any;
  f.prisma.elderly.findUnique = async args => { received = args; return args.where.inviteCode === 'A1B2C3' ? { id: 'elder-1', name: '老人', phone: '13800138003', user: { name: '家人', phone: '13800138001' } } : null; };
  const result = await f.auth.elderlyLogin({ inviteCode: 'a1b2c3' });
  assert.equal(received.where.inviteCode, 'A1B2C3');
  assert.equal(result.data!.user.childName, '家人');
  assert.equal(result.data!.user.childPhone, '13800138001');
  assert.equal(result.data!.user.userType, UserType.ELDERLY);
});

test('历史8位邀请码仍可登录并按完整邀请码查询', async () => {
  const f = fixture();
  let received: any;
  f.prisma.elderly.findUnique = async args => {
    received = args;
    return args.where.inviteCode === 'C859FD56' ? { id: 'elder-legacy', name: '老人', phone: '13800138003', user: { name: '家人', phone: '13800138001' } } : null;
  };
  const result = await f.auth.elderlyLogin({ inviteCode: 'c859fd56' });
  assert.equal(received.where.inviteCode, 'C859FD56');
  assert.equal(result.data!.user.id, 'elder-legacy');
  assert.equal(result.data!.user.userType, UserType.ELDERLY);
});

test('历史小写邀请码优先精确匹配，不强制改写成另一个大写邀请码', async () => {
  const f = fixture();
  const lookups: string[] = [];
  f.prisma.elderly.findUnique = async args => {
    lookups.push(args.where.inviteCode);
    return args.where.inviteCode === 'c859fd56'
      ? { id: 'elder-lowercase', name: '老人', phone: '13800138003', user: { name: '家人' } }
      : { id: 'elder-uppercase', name: '另一位老人', phone: '13800138004', user: { name: '另一位家人' } };
  };
  const result = await f.auth.elderlyLogin({ inviteCode: 'c859fd56' });
  assert.equal(result.data!.user.id, 'elder-lowercase');
  assert.deepEqual(lookups, ['c859fd56']);
});
