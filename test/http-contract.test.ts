import 'reflect-metadata';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

test('HTTP routes enforce the P0 response contract and reject unsafe writes', async () => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  let writes = 0;
  const prisma = {
    order: {
      findUnique: async () => ({ id: 'order-1', userId: 'child-1', status: 'PENDING_CONFIRM', isPaid: false, paymentMethod: null }),
    },
    user: { update: async () => { writes++; } },
    angel: { update: async () => { writes++; } },
  };
  let app: any;
  try {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(prisma)
      .overrideGuard(AuthGuard('jwt')).useValue({
        canActivate(context: any) {
          const request = context.switchToHttp().getRequest();
          request.user = { id: request.headers['x-test-user'] || 'child-1', userType: request.headers['x-test-role'] || 'child' };
          return true;
        },
      }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const request = (path: string, method = 'GET', data?: unknown, extraHeaders: Record<string, string> = {}) =>
      fetch(`${base}/api${path}`, {
        method, headers: { 'Content-Type': 'application/json', ...extraHeaders },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });

    const status = await request('/payment/status/order-1');
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { success: true, data: { orderId: 'order-1', status: 'PENDING_CONFIRM', isPaid: false, completed: false, paymentMethod: null } });
    assert.equal((await request('/payment/status/order-1', 'GET', undefined, { 'x-test-user': 'stranger' })).status, 403);
    assert.equal((await request('/payment/status/order-1', 'GET', undefined, { 'x-test-role': 'angel' })).status, 403);
    assert.equal((await request('/payment/create', 'POST', { orderId: 'order-1' })).status, 503);
    assert.equal((await request('/payment/create', 'POST', { orderId: 'order-1', isPaid: true })).status, 400);
    assert.equal((await request('/user/profile', 'PUT', { name: '家人', balance: 100000 })).status, 400);
    assert.equal((await request('/angel/profile', 'PUT', { name: '天使', isVerified: true }, { 'x-test-role': 'angel' })).status, 400);
    assert.equal((await request('/angel/apply/status')).status, 403);
    assert.equal((await request('/auth/send-code', 'POST', { phone: '13800138000', type: 'child' })).status, 503);
    assert.equal((await request('/messages')).status, 503);
    assert.equal(writes, 0);
  } finally {
    if (app) await app.close();
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
  }
});
