import 'reflect-metadata';
import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const root = resolve(__dirname, '../..');
const envFile = resolve(root, '.local/isolated-postgres.env');
if (process.env.LRB_INTEGRATION_DB !== 'true' || (lstatSync(envFile).mode & 0o077)) {
  throw new Error('Explicit private loopback integration configuration required');
}
const values = Object.fromEntries(readFileSync(envFile, 'utf8').trim().split('\n').map(line => {
  const i = line.indexOf('=');
  return [line.slice(0, i), line.slice(i + 1)];
}));
for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
  const url = new URL(values[key]);
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== '55432'
    || url.pathname !== '/lrb_integration' || url.username !== 'lrb_integration' || !url.password) {
    throw new Error('Refusing a database outside the dedicated loopback identity');
  }
}
const docker = ['/usr/local/bin/docker', '--host', `unix://${process.env.HOME}/.docker/run/docker.sock`];
const container = 'lrb-integration-20261008';
const prefix = `ledger_migration_${randomBytes(8).toString('hex')}`;
const ownedSchemas: string[] = [];
const clients: PrismaClient[] = [];
let verified = false;
const schemaSql = (name: string) => {
  assert.match(name, /^ledger_migration_[a-f0-9]{16}_[a-z0-9]+$/);
  return `"${name}"`;
};
const clientFor = (schema = 'public') => {
  const url = new URL(values.DATABASE_URL);
  url.searchParams.set('schema', schema);
  const client = new PrismaClient({ datasources: { db: { url: url.toString() } }, log: [],
    __internal: { configOverride: config => ({ ...config, relativeEnvPaths: { rootEnvPath: null, schemaEnvPath: null } }) } } as any);
  clients.push(client);
  return client;
};
const prisma = clientFor();
const migration = readFileSync(resolve(root, 'prisma/migrations/20261008_payment_ledger/migration.sql'), 'utf8');
const baseline = ['20260120_baseline', '20261008_wechat_identity'].map(name =>
  readFileSync(resolve(root, 'prisma/migrations', name, 'migration.sql'), 'utf8')).join('\n');
function psql(schema: string, sql: string, success = true) {
  assert.ok(verified);
  const result = spawnSync(docker[0], [...docker.slice(1), 'exec', '--interactive', container,
    'psql', '-U', 'lrb_integration', '-d', 'lrb_integration', '--quiet', '--set', 'ON_ERROR_STOP=1',
    '--command', `SET search_path TO ${schemaSql(schema)}`, '--file', '-'], { input: sql, encoding: 'utf8' });
  // Never print raw database errors, SQL rows or connection strings.
  assert.equal(result.status === 0, success, 'Unexpected isolated migration result; raw details withheld');
}
async function oldSchema(suffix: string) {
  const name = `${prefix}_${suffix}`;
  await prisma.$executeRawUnsafe(`CREATE SCHEMA ${schemaSql(name)}`);
  ownedSchemas.push(name);
  psql(name, baseline);
  return name;
}
const legacyRows = `
INSERT INTO users(id,phone,name,"updatedAt") VALUES('child','test-child','synthetic child',NOW());
INSERT INTO angels(id,phone,name,balance,"updatedAt") VALUES('angel','test-angel','synthetic angel',12.34,NOW());
INSERT INTO service_types(id,name,icon,description,price,unit,duration,category,"updatedAt")
VALUES('service','synthetic','test','synthetic',123.45,'test','test','test',NOW());
INSERT INTO elderly(id,name,phone,relation,address,"inviteCode","userId","updatedAt")
VALUES('elder','synthetic','test-elder','test','synthetic','ABC123','child',NOW());
INSERT INTO orders(id,"orderNo",status,"serviceTypeId","serviceTime",address,price,"isPaid","userId","elderlyId","angelId","updatedAt")
VALUES('order','synthetic-order','PAID','service',NOW(),'synthetic',123.45,TRUE,'child','elder','angel',NOW());
INSERT INTO income_records(id,"angelId",amount,type,description,"orderId")
VALUES('income','angel',98.76,'订单收入','synthetic','order');`;

before(async () => {
  const inspected = spawnSync(docker[0], [...docker.slice(1), 'inspect', '--format',
    '{{index .Config.Labels "lrb.purpose"}}', container], { encoding: 'utf8' });
  assert.equal(inspected.status, 0);
  assert.equal(inspected.stdout.trim(), 'isolated-integration');
  const [identity]: any = await prisma.$queryRawUnsafe('SELECT current_database() AS db,current_user AS role');
  assert.equal(identity.db, 'lrb_integration');
  assert.equal(identity.role, 'lrb_integration');
  verified = true;
});
after(async () => {
  await Promise.all(clients.map(client => client.$disconnect()));
  if (!verified) return;
  const cleanup = clientFor();
  try {
    for (const name of ownedSchemas) await cleanup.$executeRawUnsafe(`DROP SCHEMA ${schemaSql(name)} CASCADE`);
  } finally { await cleanup.$disconnect(); }
});

test('真实增量保留旧行和Float，仅回填整数分与隔离历史余额，不造商户流水', async () => {
  const name = await oldSchema('valid');
  psql(name, legacyRows);
  psql(name, migration);
  const db = clientFor(name);
  const angel = await db.angel.findUniqueOrThrow({ where: { id: 'angel' } });
  assert.equal(angel.balance, 12.34);
  assert.equal(angel.balanceCents, 1234n);
  assert.equal(angel.openingBalanceCents, 1234n);
  assert.equal(angel.nonWithdrawableBalanceCents, 1234n);
  assert.equal(angel.frozenBalanceCents, 0n);
  const order = await db.order.findUniqueOrThrow({ where: { id: 'order' } });
  assert.equal(order.price, 123.45);
  assert.equal(order.priceCents, 12345n);
  assert.equal(order.paymentOrigin, 'LEGACY_UNVERIFIED');
  assert.equal(order.paidAttemptId, null);
  const income = await db.incomeRecord.findUniqueOrThrow({ where: { id: 'income' } });
  assert.equal(income.amountCents, 9876n);
  assert.equal(income.entryType, 'LEGACY');
  assert.equal(income.entryKey, null);
  for (const model of ['paymentAttempt', 'paymentEvent', 'refund', 'withdrawal']) assert.equal(await db[model].count(), 0);
  assert.equal(await db.user.count(), 1);
  assert.equal(await db.elderly.count(), 1);
});

test('真实SQL拒绝NaN/Infinity/分以下/负余额，失败前没有新增字段或删行', async () => {
  const cases = [
    ['nan', "UPDATE angels SET balance='NaN'::double precision"],
    ['infinity', "UPDATE service_types SET price='Infinity'::double precision"],
    ['subcent', 'UPDATE orders SET price=12.345'],
    ['income', 'UPDATE income_records SET amount=0.001'],
    ['negative', 'UPDATE angels SET balance=-0.01'],
  ];
  for (const [suffix, sql] of cases) {
    const name = await oldSchema(suffix);
    psql(name, legacyRows + '\n' + sql + ';');
    psql(name, migration, false);
    const [result]: any = await prisma.$queryRawUnsafe(`SELECT
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema=$1 AND column_name='balanceCents') AS added,
      (SELECT count(*)::int FROM ${schemaSql(name)}.users) AS users`, name);
    assert.equal(result.added, 0);
    assert.equal(result.users, 1);
  }
});

test('真实唯一键与余额约束防重复账目，并发冻结仅一个成功，失败事务回滚', async () => {
  const name = await oldSchema('constraints');
  psql(name, legacyRows);
  psql(name, migration);
  const db = clientFor(name);
  const attempt = { id: 'attempt', orderId: 'order', userId: 'child', mode: 'WECHAT', outTradeNo: 'synthetictrade',
    activeOrderId: 'order', amountCents: 12345n, angelAmountCents: 9876n, platformAmountCents: 2469n,
    appId: 'synthetic-app', merchantId: 'synthetic-merchant', payerIdentityHash: 'synthetic-hash' };
  await db.paymentAttempt.create({ data: attempt });
  await assert.rejects(db.paymentAttempt.create({ data: { ...attempt, id: 'duplicate', outTradeNo: 'othertrade' } }));
  await db.paymentEvent.create({ data: { eventId: 'synthetic-event', source: 'NOTIFY', eventType: 'TRANSACTION.SUCCESS', payloadDigest: 'synthetic-digest', verifiedAt: new Date(), paymentAttemptId: 'attempt' } });
  await assert.rejects(db.paymentEvent.create({ data: { eventId: 'synthetic-event', source: 'NOTIFY', eventType: 'TRANSACTION.SUCCESS', payloadDigest: 'synthetic-digest', verifiedAt: new Date() } }));
  await db.incomeRecord.create({ data: { angelId: 'angel', amount: 100, amountCents: 10000n, type: 'test', description: 'synthetic', entryType: 'WECHAT_INCOME', entryKey: 'synthetic-credit' } });
  await db.angel.update({ where: { id: 'angel' }, data: { balanceCents: { increment: 10000n } } });
  const reserve = () => db.$executeRawUnsafe('UPDATE angels SET "frozenBalanceCents"="frozenBalanceCents"+8000 WHERE id=$1 AND "balanceCents"-"frozenBalanceCents"-"nonWithdrawableBalanceCents">=8000', 'angel');
  assert.deepEqual((await Promise.all([reserve(), reserve()])).sort(), [0, 1]);
  const before = await db.angel.findUniqueOrThrow({ where: { id: 'angel' } });
  assert.equal(before.frozenBalanceCents, 8000n);
  await assert.rejects(db.angel.update({ where: { id: 'angel' }, data: { frozenBalanceCents: 11000n } }));
  await assert.rejects(db.$transaction(async tx => {
    await tx.angel.update({ where: { id: 'angel' }, data: { frozenBalanceCents: { increment: 1n } } });
    await tx.incomeRecord.create({ data: { angelId: 'angel', amount: 1, amountCents: 100n, type: 'test', description: 'synthetic', entryType: 'WECHAT_INCOME', entryKey: 'synthetic-credit' } });
  }));
  assert.equal((await db.angel.findUniqueOrThrow({ where: { id: 'angel' } })).frozenBalanceCents, before.frozenBalanceCents);
});
