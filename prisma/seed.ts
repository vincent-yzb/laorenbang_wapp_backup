import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * 数据库种子数据
 */
async function main() {
  console.log('🌱 开始填充种子数据...');

  // 创建服务类型
  const serviceTypes = [
    // 生活照料
    { name: '陪同就医', icon: '🏥', description: '陪同老人前往医院就医，包括挂号、取药、陪诊等', price: 80, unit: '次', duration: '2-4小时', category: '生活照料', sortOrder: 1 },
    { name: '日常采购', icon: '🛒', description: '帮助老人购买日常生活用品、蔬菜水果等', price: 35, unit: '次', duration: '1-2小时', category: '生活照料', sortOrder: 2 },
    { name: '家务帮助', icon: '🧹', description: '帮助老人做饭、打扫卫生、整理房间等', price: 60, unit: '次', duration: '2-3小时', category: '生活照料', sortOrder: 3 },
    { name: '代办事务', icon: '📋', description: '帮助老人办理缴费、取件、银行业务等', price: 40, unit: '次', duration: '1-2小时', category: '生活照料', sortOrder: 4 },
    
    // 健康关怀
    { name: '健康监测', icon: '💊', description: '帮助老人测量血压、血糖等健康指标', price: 50, unit: '次', duration: '30-60分钟', category: '健康关怀', sortOrder: 5 },
    { name: '用药看护', icon: '💉', description: '提醒老人按时服药，协助药物管理', price: 45, unit: '次', duration: '30分钟', category: '健康关怀', sortOrder: 6 },
    { name: '康复陪护', icon: '🩺', description: '协助老人进行康复训练和日常护理', price: 100, unit: '小时', duration: '按需', category: '健康关怀', sortOrder: 7 },
    
    // 精神陪伴
    { name: '陪伴聊天', icon: '💬', description: '陪老人聊天、倾听，提供精神慰藉', price: 50, unit: '小时', duration: '1-2小时', category: '精神陪伴', sortOrder: 8 },
    { name: '陪同散步', icon: '🚶', description: '陪同老人外出散步、锻炼身体', price: 40, unit: '次', duration: '1小时', category: '精神陪伴', sortOrder: 9 },
    { name: '按摩理疗', icon: '💆', description: '为老人提供按摩、推拿等理疗服务', price: 120, unit: '次', duration: '1小时', category: '精神陪伴', sortOrder: 10 },
    
    // 紧急服务
    { name: '紧急上门', icon: '🚨', description: '紧急情况下快速上门查看老人状况', price: 100, unit: '次', duration: '30分钟内', category: '紧急服务', sortOrder: 11 },
    { name: '紧急事务', icon: '⚡', description: '紧急事务处理，如突发情况协调', price: 80, unit: '次', duration: '按需', category: '紧急服务', sortOrder: 12 },
    
    // 定制服务
    { name: '定制服务', icon: '✨', description: '根据您的需求定制专属服务，自定义服务内容和价格', price: 0, unit: '次', duration: '按需', category: '定制服务', sortOrder: 99 },
  ];

  for (const service of serviceTypes) {
    await prisma.serviceType.upsert({
      where: { id: service.name }, // 使用名称作为唯一标识（需要修改 schema）
      create: service,
      update: service,
    });
  }

  console.log(`✅ 创建了 ${serviceTypes.length} 个服务类型`);

  // 开发环境创建测试数据
  if (process.env.NODE_ENV === 'development') {
    // 创建测试用户（子女）
    const testUser = await prisma.user.upsert({
      where: { phone: '13800138000' },
      create: {
        phone: '13800138000',
        name: '张先生',
        isVerified: true,
      },
      update: {},
    });

    // 创建测试老人
    const testElderly = await prisma.elderly.upsert({
      where: { inviteCode: 'TEST1234' },
      create: {
        name: '张奶奶',
        phone: '13900139000',
        relation: '母亲',
        address: '北京市朝阳区建国路100号',
        lat: 39.9042,
        lng: 116.4074,
        inviteCode: 'TEST1234',
        userId: testUser.id,
      },
      update: {},
    });

    // 创建测试天使
    const testAngel = await prisma.angel.upsert({
      where: { phone: '13700137000' },
      create: {
        phone: '13700137000',
        name: '李天使',
        isVerified: true,
        status: 'APPROVED',
        rating: 4.9,
        completedOrders: 58,
        balance: 3680,
        lat: 39.9052,
        lng: 116.4084,
        isOnline: true,
      },
      update: {},
    });

    console.log('✅ 创建了测试数据');
    console.log(`   - 测试用户: ${testUser.phone}`);
    console.log(`   - 测试老人: ${testElderly.name} (邀请码: ${testElderly.inviteCode})`);
    console.log(`   - 测试天使: ${testAngel.name}`);
  }

  console.log('🎉 种子数据填充完成！');
}

main()
  .catch((e) => {
    console.error('❌ 种子数据填充失败:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

