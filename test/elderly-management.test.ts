import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException, ValidationPipe } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ElderlyService } from '../src/modules/elderly/elderly.service';
import { CreateElderlyDto, UpdateElderlyDto } from '../src/modules/elderly/dto/elderly.dto';

function fixture(orders: Array<{ status: string }> = []) {
  const row = { id: 'elder-1', userId: 'child-1', lat: 30 as number | null, lng: 104 as number | null };
  let deleted = false;
  const updates: any[] = [];
  const prisma: any = {
    elderly: {
      findUnique: async () => row,
      update: async ({ data }) => { updates.push(data); Object.assign(row, data); return row; },
      delete: async () => { deleted = true; return row; },
    },
    order: { count: async ({ where }) => orders.filter(order => !where.status || where.status.in.includes(order.status)).length },
  };
  return { row, updates, prisma, service: new ElderlyService(prisma), deleted: () => deleted };
}

test('更新手动地址时可明确清空两坐标，省略坐标则保留定位', async () => {
  const f = fixture();
  await f.service.update('elder-1', 'child-1', { address: '手动新地址' });
  assert.equal(f.row.lat, 30);
  assert.equal(f.row.lng, 104);
  await f.service.update('elder-1', 'child-1', { address: '另一手动地址', lat: null, lng: null });
  assert.equal(f.row.lat, null);
  assert.equal(f.row.lng, null);
  assert.deepEqual({ ...f.updates[1] }, { address: '另一手动地址', lat: null, lng: null });
});

test('HTTP更新支持null但创建不接受null，数字范围和字段白名单仍校验', async () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true,
    transformOptions: { enableImplicitConversion: true } });
  const updateMeta: any = { type: 'body', metatype: UpdateElderlyDto };
  const cleared = await pipe.transform({ lat: null, lng: null }, updateMeta);
  assert.equal(cleared.lat, null);
  assert.equal(cleared.lng, null);
  for (const input of [{ lat: 91 }, { lng: -181 }, { lat: NaN }, { lat: null, userId: 'other-child' }]) {
    await assert.rejects(pipe.transform(input, updateMeta), BadRequestException);
  }
  for (const coordinates of [{ lat: null }, { lng: null }]) {
    await assert.rejects(pipe.transform({ name: '测试老人', phone: '13800138003', relation: '父亲', address: '测试地址', ...coordinates },
      { type: 'body', metatype: CreateElderlyDto }), BadRequestException);
  }
});

test('有任意历史订单都返回业务400并保留老人和订单记录', async () => {
  for (const status of ['PENDING', 'PAID', 'ACCEPTED', 'ON_WAY', 'ARRIVED', 'IN_PROGRESS', 'PENDING_CONFIRM', 'COMPLETED', 'CANCELLED', 'REFUNDED']) {
    const f = fixture([{ status }]);
    await assert.rejects(f.service.delete('elder-1', 'child-1'), error => error instanceof BadRequestException && /关联订单记录/.test(error.message));
    assert.equal(f.deleted(), false);
  }
});

test('查询后并发新建订单触发外键限制也转换为业务400，其他数据库错误不掩盖', async () => {
  const f = fixture();
  f.prisma.elderly.delete = async () => { throw new Prisma.PrismaClientKnownRequestError('foreign key', { code: 'P2003', clientVersion: 'test' }); };
  await assert.rejects(f.service.delete('elder-1', 'child-1'), BadRequestException);
  const unavailable = new Error('database unavailable');
  f.prisma.elderly.delete = async () => { throw unavailable; };
  await assert.rejects(f.service.delete('elder-1', 'child-1'), error => error === unavailable);
});

test('没有关联订单可删除，陌生子女不能删除或清空坐标', async () => {
  const own = fixture();
  await own.service.delete('elder-1', 'child-1');
  assert.equal(own.deleted(), true);
  const foreign = fixture();
  await assert.rejects(foreign.service.delete('elder-1', 'child-2'), ForbiddenException);
  await assert.rejects(foreign.service.update('elder-1', 'child-2', { lat: null, lng: null }), ForbiddenException);
  assert.equal(foreign.deleted(), false);
  assert.equal(foreign.updates.length, 0);
});
