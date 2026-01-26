-- 老人帮数据库初始化 SQL
-- 在 Supabase SQL Editor 中执行

-- 用户表（子女）
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar TEXT,
  id_card TEXT,
  is_verified BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 老人表
CREATE TABLE IF NOT EXISTS elderly (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  avatar TEXT,
  id_card TEXT,
  relation TEXT NOT NULL,
  address TEXT NOT NULL,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  invite_code TEXT UNIQUE NOT NULL,
  health_note TEXT,
  angel_note TEXT,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 天使状态枚举
DO $$ BEGIN
  CREATE TYPE angel_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 天使表
CREATE TABLE IF NOT EXISTS angels (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  phone TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT,
  id_card TEXT,
  id_card_front TEXT,
  id_card_back TEXT,
  is_verified BOOLEAN DEFAULT false,
  status angel_status DEFAULT 'PENDING',
  rating DOUBLE PRECISION DEFAULT 5.0,
  completed_orders INTEGER DEFAULT 0,
  balance DOUBLE PRECISION DEFAULT 0,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  is_online BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 服务类型表
CREATE TABLE IF NOT EXISTS service_types (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  icon TEXT NOT NULL,
  description TEXT NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL,
  duration TEXT NOT NULL,
  category TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 订单状态枚举
DO $$ BEGIN
  CREATE TYPE order_status AS ENUM (
    'PENDING', 'PAID', 'ACCEPTED', 'ON_WAY', 'ARRIVED', 
    'IN_PROGRESS', 'PENDING_CONFIRM', 'COMPLETED', 'CANCELLED', 'REFUNDED'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 订单表
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  order_no TEXT UNIQUE NOT NULL,
  status order_status DEFAULT 'PENDING',
  service_type_id TEXT NOT NULL REFERENCES service_types(id),
  service_time TIMESTAMP NOT NULL,
  address TEXT NOT NULL,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  remark TEXT,
  price DOUBLE PRECISION NOT NULL,
  is_paid BOOLEAN DEFAULT false,
  paid_at TIMESTAMP,
  payment_method TEXT,
  user_id TEXT NOT NULL REFERENCES users(id),
  elderly_id TEXT NOT NULL REFERENCES elderly(id),
  angel_id TEXT REFERENCES angels(id),
  accepted_at TIMESTAMP,
  arrived_at TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  cancel_reason TEXT,
  rating DOUBLE PRECISION,
  comment TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 订单时间线表
CREATE TABLE IF NOT EXISTS order_timelines (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  order_id TEXT NOT NULL REFERENCES orders(id),
  event TEXT NOT NULL,
  content TEXT NOT NULL,
  operator TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 天使收入记录表
CREATE TABLE IF NOT EXISTS income_records (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  angel_id TEXT NOT NULL REFERENCES angels(id),
  amount DOUBLE PRECISION NOT NULL,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  order_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 插入默认服务类型
INSERT INTO service_types (id, name, icon, description, price, unit, duration, category, sort_order) VALUES
  ('srv_medical', '陪同就医', '🏥', '陪同老人去医院挂号、看病、取药', 80, '次', '2-4小时', '生活照料', 1),
  ('srv_shopping', '日常采购', '🛒', '帮助老人购买日用品、蔬菜水果等', 40, '次', '1-2小时', '生活照料', 2),
  ('srv_housework', '家务帮助', '🧹', '帮助老人打扫卫生、做饭、洗衣等', 60, '次', '2-3小时', '生活照料', 3),
  ('srv_errand', '代办事务', '📋', '代缴水电费、取快递、银行业务等', 30, '次', '1小时', '生活照料', 4),
  ('srv_health', '健康监测', '💊', '帮助测量血压、血糖等健康指标', 50, '次', '30分钟', '健康关怀', 5),
  ('srv_medicine', '用药提醒', '⏰', '提醒老人按时吃药，确认用药情况', 20, '次', '15分钟', '健康关怀', 6),
  ('srv_chat', '聊天陪伴', '💬', '陪老人聊天解闷，提供精神慰藉', 40, '小时', '按需', '精神陪伴', 7),
  ('srv_walk', '陪同散步', '🚶', '陪老人在小区或公园散步锻炼', 30, '小时', '按需', '精神陪伴', 8),
  ('srv_emergency', '紧急上门', '🚨', '紧急情况上门查看老人状况', 100, '次', '30分钟内', '紧急服务', 9),
  ('srv_custom', '自定义服务', '✨', '根据需求自定义服务内容和价格', 0, '次', '按需', '自定义', 10)
ON CONFLICT (id) DO NOTHING;

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_elderly_user_id ON elderly(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_elderly_id ON orders(elderly_id);
CREATE INDEX IF NOT EXISTS idx_orders_angel_id ON orders(angel_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_timelines_order_id ON order_timelines(order_id);
CREATE INDEX IF NOT EXISTS idx_income_records_angel_id ON income_records(angel_id);

-- 完成
SELECT '✅ 数据库初始化完成！' as result;

