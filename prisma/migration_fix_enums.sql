-- ===================================================
-- 老人帮数据库修复脚本
-- 将枚举类型转换为 TEXT，解决 Prisma 兼容性问题
-- 请在 Supabase SQL Editor 中执行此脚本
-- ===================================================

-- 1. 修复 angels 表的 status 列（从 enum 转为 TEXT）
DO $$ 
BEGIN
  -- 检查列类型是否为 enum
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'angels' AND column_name = 'status' 
    AND data_type = 'USER-DEFINED'
  ) THEN
    -- 添加临时列
    ALTER TABLE angels ADD COLUMN status_new TEXT;
    -- 复制数据
    UPDATE angels SET status_new = status::TEXT;
    -- 删除旧列
    ALTER TABLE angels DROP COLUMN status;
    -- 重命名新列
    ALTER TABLE angels RENAME COLUMN status_new TO status;
    -- 设置默认值
    ALTER TABLE angels ALTER COLUMN status SET DEFAULT 'PENDING';
    RAISE NOTICE 'angels.status 列已从 enum 转换为 TEXT';
  ELSE
    RAISE NOTICE 'angels.status 列已经是 TEXT 类型，无需转换';
  END IF;
END $$;

-- 2. 修复 orders 表的 status 列（从 enum 转为 TEXT）
DO $$ 
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'orders' AND column_name = 'status' 
    AND data_type = 'USER-DEFINED'
  ) THEN
    ALTER TABLE orders ADD COLUMN status_new TEXT;
    UPDATE orders SET status_new = status::TEXT;
    ALTER TABLE orders DROP COLUMN status;
    ALTER TABLE orders RENAME COLUMN status_new TO status;
    ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'PENDING';
    RAISE NOTICE 'orders.status 列已从 enum 转换为 TEXT';
  ELSE
    RAISE NOTICE 'orders.status 列已经是 TEXT 类型，无需转换';
  END IF;
END $$;

-- 3. 确保 income_records 表存在且列名正确
DO $$
BEGIN
  -- 检查 income_records 表是否存在
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'income_records') THEN
    CREATE TABLE income_records (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      angel_id TEXT NOT NULL REFERENCES angels(id),
      amount DOUBLE PRECISION NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      order_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_income_records_angel_id ON income_records(angel_id);
    RAISE NOTICE 'income_records 表已创建';
  ELSE
    RAISE NOTICE 'income_records 表已存在';
  END IF;
END $$;

-- 4. 删除旧的枚举类型（如果存在且不再使用）
DO $$
BEGIN
  -- 尝试删除 angel_status 枚举
  DROP TYPE IF EXISTS angel_status CASCADE;
  RAISE NOTICE '已清理旧的 angel_status 枚举类型';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE '清理 angel_status 时出错（可能不存在）: %', SQLERRM;
END $$;

DO $$
BEGIN
  -- 尝试删除 order_status 枚举
  DROP TYPE IF EXISTS order_status CASCADE;
  RAISE NOTICE '已清理旧的 order_status 枚举类型';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE '清理 order_status 时出错（可能不存在）: %', SQLERRM;
END $$;

-- 5. 验证修复结果
SELECT 
  table_name, 
  column_name, 
  data_type,
  column_default
FROM information_schema.columns 
WHERE table_name IN ('angels', 'orders', 'income_records') 
  AND column_name IN ('status', 'angel_id', 'order_id')
ORDER BY table_name, column_name;

SELECT '✅ 数据库修复脚本执行完成！' as result;

