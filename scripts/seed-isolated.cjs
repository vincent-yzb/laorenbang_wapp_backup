const { loadIsolatedEnvironment } = require('./isolated-env.cjs');
Object.assign(process.env, loadIsolatedEnvironment(process.argv[2]));
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Sample prices for a new isolated test database; these are not production tariffs.
const rows = [
  ['medical', '陪同就医', '🏥', 80, '生活照料', '2-4小时'],
  ['shopping', '日常采购', '🛒', 35, '生活照料', '1-2小时'],
  ['housework', '家务帮助', '🧹', 60, '生活照料', '2-3小时'],
  ['errand', '代办事务', '📋', 40, '生活照料', '1-2小时'],
  ['health', '用药看护', '💊', 45, '健康关怀', '30分钟'],
  ['massage', '按摩理疗', '💆', 120, '健康关怀', '1小时'],
  ['companion', '陪伴散步', '🚶', 40, '精神陪伴', '1小时'],
  ['emergency', '紧急上门', '🚨', 100, '紧急服务', '按需'],
  ['custom', '定制服务', '✨', 0, '定制服务', '按需'],
];

async function main() {
  for (const [sortOrder, row] of rows.entries()) {
    const [id, name, icon, price, category, duration] = row;
    const data = { id, name, icon, price, category, duration, unit: '次',
      description: `隔离内测示例：${name}`, sortOrder, isActive: true };
    await prisma.serviceType.upsert({ where: { id }, create: data, update: {} });
  }
  console.log('Isolated service catalog ready: 9 explicit service IDs; no real accounts or balances seeded.');
}
main().catch(() => { console.error('Isolated catalog seed failed'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
