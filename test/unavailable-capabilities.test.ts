import 'reflect-metadata';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MessageService } from '../src/modules/message/message.service';
import { LocationService } from '../src/modules/location/location.service';
import { LocationController } from '../src/modules/location/location.controller';
import { ConfigService } from '../src/config/config.service';

test('unimplemented messages and SOS reject instead of reporting delivery', async () => {
  const messages = new MessageService();
  for (const operation of [
    () => messages.getMessages('child-1', 'child'),
    () => messages.getUnreadCount('child-1', 'child'),
    () => messages.markAsRead('message-1', 'child-1'),
    () => messages.sendSOSNotify('elderly-1'),
    () => messages.sendOrderMessage({ orderId: 'order-1', senderId: 'child-1', senderType: 'child', content: 'hello' }),
  ]) {
    await assert.rejects(operation, (error: any) => error.getStatus() === 503);
  }
});

test('track endpoint preserves ownership checks and does not fabricate coordinates', async () => {
  const location = new LocationService({
    order: { findUnique: async () => ({ userId: 'child-1', elderlyId: 'elderly-1', angelId: 'angel-1' }) },
  } as any, {} as any, {} as any);
  await assert.rejects(() => location.getTrack('order-1', 'stranger'), (error: any) => error.getStatus() === 403);
  await assert.rejects(() => location.getTrack('order-1', 'child-1'), (error: any) => error.getStatus() === 503);
});

test('child tokens cannot report angel locations', async () => {
  let writes = 0;
  const controller = new LocationController({ reportLocation: async () => { writes++; } } as any);
  await assert.rejects(() => controller.reportLocation({ user: { id: 'child-1', userType: 'child' } }, { lat: 20, lng: 30 }),
    (error: any) => error.getStatus() === 403);
  assert.equal(writes, 0);
});

test('closed orders cannot expose an angel location from a later service', async () => {
  let cacheReads = 0;
  const location = new LocationService({
    order: { findUnique: async () => ({ userId: 'child-1', status: 'COMPLETED', angelId: 'angel-1' }) },
  } as any, { getAngelLocation: async () => { cacheReads++; return { lat: 20, lng: 30, time: Date.now() }; } } as any, {} as any);
  assert.equal((await location.getAngelLocation('old-order', 'child-1')).data, null);
  assert.equal(cacheReads, 0);
});

test('missing or stale position reports are not replaced by fake fresh coordinates', async () => {
  for (const report of [null, { lat: 20, lng: 30, time: Date.now() - 700_000 }]) {
    const location = new LocationService({
      order: { findUnique: async () => ({ userId: 'child-1', status: 'IN_PROGRESS', angelId: 'angel-1', angel: { lat: null, lng: null } }) },
    } as any, { getAngelLocation: async () => report } as any, {} as any);
    assert.equal((await location.getAngelLocation('order-1', 'child-1')).data, null);
  }
});

test('valid current reports preserve their actual measurement time', async () => {
  const report = { lat: 0, lng: 30, time: Date.now() - 1000 };
  const location = new LocationService({
    order: { findUnique: async () => ({ userId: 'child-1', status: 'IN_PROGRESS', angelId: 'angel-1' }) },
  } as any, { getAngelLocation: async () => report } as any, {} as any);
  const response = await location.getAngelLocation('order-1', 'child-1');
  assert.equal(response.data?.lat, 0);
  assert.equal(response.data?.time, report.time);
});

test('invalid coordinates never reach the database', async () => {
  let writes = 0;
  const location = new LocationService({ angel: { update: async () => { writes++; } } } as any, {} as any, {} as any);
  await assert.rejects(() => location.reportLocation('angel-1', NaN, 10), (error: any) => error.getStatus() === 400);
  await assert.rejects(() => location.reportLocation('angel-1', 20, 181), (error: any) => error.getStatus() === 400);
  assert.equal(writes, 0);
});

test('production cannot use the development JWT signing secret', () => {
  const previousEnv = process.env.NODE_ENV;
  const previousSecret = process.env.JWT_SECRET;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;
    assert.throws(() => new ConfigService().jwtSecret, /JWT_SECRET/);
    delete process.env.NODE_ENV;
    assert.throws(() => new ConfigService().jwtSecret, /JWT_SECRET/);
    process.env.JWT_SECRET = 'test-only-secret-not-a-real-credential';
    assert.equal(new ConfigService().jwtSecret, 'test-only-secret-not-a-real-credential');
  } finally {
    if (previousEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnv;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});
