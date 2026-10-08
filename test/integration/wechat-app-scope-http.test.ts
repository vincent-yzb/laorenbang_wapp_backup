import 'reflect-metadata';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { IdentityService } from '../../src/modules/auth/identity.service';

// Generated task-only loopback credentials must be injected; normal .env discovery is disabled.
const databaseUrl = process.env.DATABASE_URL ?? '';
const url = new URL(databaseUrl || 'postgresql://invalid');
if (process.env.LRB_INTEGRATION_DB !== 'true' || url.protocol !== 'postgresql:' ||
  url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/lrb_integration' ||
  url.username !== 'lrb_integration' || !url.password || (url.searchParams.get('schema') ?? 'public') !== 'public') {
  throw new Error('AppID HTTP regression requires the dedicated loopback PostgreSQL');
}

test('真实 HTTP + JWT + PG：新 AppID 登录可用，旧身份/JWT/refresh 拒绝且不认领旧行', async () => {
  const inspection = spawnSync('/usr/local/bin/docker', ['--host', `unix://${process.env.HOME}/.docker/run/docker.sock`,
    'inspect', '--format', '{{index .Config.Labels "lrb.purpose"}}', 'lrb-integration-20261008'], { encoding: 'utf8' });
  assert.equal(inspection.status, 0); assert.equal(inspection.stdout.trim(), 'isolated-integration');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [],
    __internal: { configOverride: config => ({ ...config, relativeEnvPaths: { rootEnvPath: null, schemaEnvPath: null } }) } } as any);
  const appId = 'wx0123456789abcdef', oldAppId = 'wxfedcba9876543210';
  const prefix = 'app-http-' + randomBytes(10).toString('hex');
  const jwtSecret = randomBytes(32).toString('hex');
  const settings = { NODE_ENV: 'production', WECHAT_APPID: appId, WECHAT_APP_SECRET: '', JWT_SECRET: jwtSecret,
    WECHAT_PAY_ENABLED: 'false', WECHAT_TRANSFER_ENABLED: 'false', ALLOW_MOCK_PAYMENT: 'false' };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  let app: any, verified = false, checks = 0;
  try {
    const [identity]: any = await prisma.$queryRawUnsafe('SELECT current_database() AS db,current_user AS role');
    assert.deepEqual(identity, { db: 'lrb_integration', role: 'lrb_integration' });
    const [migration]: any = await prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE migration_name=$1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL', '20261008_wechat_app_scope');
    assert.equal(migration.count, 1); verified = true;
    Object.assign(process.env, settings);
    globalThis.fetch = async () => { throw new Error('External HTTP is forbidden; test requests use the exact loopback URL'); };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(prisma)
      .overrideProvider(IdentityService).useValue({ getWechatOpenId: async (code: string) => `${prefix}-${code}` })
      .compile();
    app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl(); assert.equal(new URL(base).hostname, '127.0.0.1');
    const request = async (path: string, expected: number, options: { method?: string; body?: any; token?: string } = {}) => {
      const response = await previousFetch(`${base}/api${path}`, {
        method: options.method ?? 'GET', headers: { 'content-type': 'application/json',
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}), signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, expected, `${path} unexpected status`); checks++;
      return response.json() as Promise<any>;
    };
    await request('/health', 200);
    const child = await request('/auth/wechat-login', 200, { method: 'POST', body: { code: 'child', userType: 'child' } });
    const angel = await request('/auth/wechat-login', 200, { method: 'POST', body: { code: 'angel', userType: 'angel' } });
    const jwt = new JwtService({ secret: jwtSecret });
    for (const [result, endpoint] of [[child, '/user/profile'], [angel, '/angel/profile']] as const) {
      assert.equal(jwt.verify(result.data.token).appId, appId);
      await request(endpoint, 200, { token: result.data.token });
      const refreshed = await request('/auth/refresh', 200, { method: 'POST', body: { refreshToken: result.data.refreshToken } });
      assert.equal(jwt.verify(refreshed.data.token).appId, appId);
      for (const scope of [{}, { appId: oldAppId }]) {
        const payload = { sub: result.data.user.id, userType: endpoint === '/user/profile' ? 'child' : 'angel', ...scope };
        await request(endpoint, 401, { token: jwt.sign(payload) });
        await request('/auth/refresh', 401, { method: 'POST', body: { refreshToken: jwt.sign(payload, { secret: jwtSecret + '_refresh' }) } });
      }
    }
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: child.data.user.id } })).wechatAppId, appId);
    assert.equal((await prisma.angel.findUniqueOrThrow({ where: { id: angel.data.user.id } })).wechatAppId, appId);
    const legacy = await prisma.user.create({ data: { id: `${prefix}-legacy`, phone: `${prefix}-legacy-phone`,
      wechatOpenId: `${prefix}-legacy`, name: '隔离虚构旧身份' } });
    await request('/auth/wechat-login', 401, { method: 'POST', body: { code: 'legacy', userType: 'child' } });
    assert.deepEqual(await prisma.user.findUniqueOrThrow({ where: { id: legacy.id } }), legacy);
    process.env.WECHAT_APPID = oldAppId;
    await request('/user/profile', 401, { token: child.data.token });
    await request('/auth/refresh', 401, { method: 'POST', body: { refreshToken: child.data.refreshToken } });
    assert.equal(checks, 18);
  } finally {
    if (app) await app.close();
    if (verified) {
      // Exact random identity namespace created by this test only. No reset or legacy-row deletion.
      const openids = ['child', 'angel', 'legacy'].map(code => `${prefix}-${code}`);
      await prisma.user.deleteMany({ where: { wechatOpenId: { in: openids } } });
      await prisma.angel.deleteMany({ where: { wechatOpenId: { in: openids } } });
    }
    await prisma.$disconnect(); globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
