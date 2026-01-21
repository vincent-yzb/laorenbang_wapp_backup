# 老人帮后端 API

> 让关爱跨越山海的居家养老服务平台 - 后端服务

## 技术栈

- **框架**: NestJS 10.x
- **语言**: TypeScript 5.x
- **ORM**: Prisma 5.x
- **数据库**: PostgreSQL
- **缓存**: Redis (可选)
- **文档**: Swagger/OpenAPI

## 快速开始

### 1. 环境准备

```bash
# 安装 Node.js 18+
# 安装 PostgreSQL 14+

# 进入目录
cd backend

# 安装依赖
npm install
```

### 2. 配置环境变量

```bash
# 复制环境配置模板
cp env.example .env

# 编辑 .env 文件，填写实际配置
# 至少需要配置 DATABASE_URL
```

### 3. 初始化数据库

```bash
# 生成 Prisma Client
npm run prisma:generate

# 同步数据库结构
npm run prisma:push

# 填充种子数据（服务类型等）
npm run prisma:seed
```

### 4. 启动服务

```bash
# 开发模式
npm run start:dev

# 生产模式
npm run build
npm run start:prod
```

### 5. 访问服务

- API 地址: http://localhost:3001/api
- Swagger 文档: http://localhost:3001/api/docs

## 项目结构

```
backend/
├── prisma/
│   ├── schema.prisma    # 数据库模型定义
│   └── seed.ts          # 种子数据
├── src/
│   ├── cache/           # 缓存服务
│   ├── config/          # 配置服务
│   ├── prisma/          # Prisma 服务
│   ├── modules/
│   │   ├── auth/        # 认证模块
│   │   ├── user/        # 用户模块
│   │   ├── elderly/     # 老人管理模块
│   │   ├── angel/       # 天使模块
│   │   ├── order/       # 订单模块
│   │   ├── payment/     # 支付模块
│   │   ├── message/     # 消息模块
│   │   └── location/    # 位置服务模块
│   ├── app.module.ts    # 应用主模块
│   └── main.ts          # 入口文件
├── env.example          # 环境变量模板
├── package.json
└── tsconfig.json
```

## API 模块

### 认证 (`/api/auth`)
- `POST /send-code` - 发送验证码
- `POST /phone-login` - 手机号登录
- `POST /wechat-login` - 微信登录
- `POST /elderly-login` - 老人邀请码登录
- `POST /refresh` - 刷新 Token

### 用户 (`/api/user`)
- `GET /profile` - 获取用户信息
- `PUT /profile` - 更新用户信息
- `POST /verify` - 实名认证
- `GET /order-stats` - 订单统计

### 老人管理 (`/api/elderly`)
- `POST /` - 添加老人
- `GET /` - 老人列表
- `GET /:id` - 老人详情
- `PUT /:id` - 更新老人信息
- `DELETE /:id` - 删除老人
- `POST /:id/refresh-invite-code` - 刷新邀请码

### 天使 (`/api/angel`)
- `POST /apply` - 入驻申请
- `GET /apply/status` - 申请状态
- `GET /profile` - 天使信息
- `PUT /profile` - 更新信息
- `POST /toggle-online` - 切换在线状态
- `GET /order-stats` - 订单统计
- `GET /reviews` - 评价列表

### 订单 (`/api/orders`)
- `POST /` - 创建订单
- `GET /` - 订单列表
- `GET /nearby` - 附近订单（天使）
- `GET /:id` - 订单详情
- `POST /:id/accept` - 接单
- `POST /:id/depart` - 出发
- `POST /:id/arrive` - 到达
- `POST /:id/start` - 开始服务
- `POST /:id/complete` - 完成服务
- `POST /:id/confirm` - 确认完成
- `POST /:id/cancel` - 取消订单
- `POST /:id/rate` - 评价

### 支付 (`/api/payment`)
- `POST /create` - 创建支付
- `POST /notify` - 微信回调
- `POST /refund` - 申请退款
- `POST /withdraw` - 天使提现
- `GET /income` - 收入明细

### 消息 (`/api/messages`)
- `GET /` - 消息列表
- `GET /unread-count` - 未读数
- `POST /:id/read` - 标记已读
- `GET /order/:orderId` - 订单消息
- `POST /order/:orderId` - 发送消息

### 位置 (`/api/location`)
- `POST /report` - 上报位置
- `GET /angel/:orderId` - 天使位置
- `GET /track/:orderId` - 服务轨迹
- `GET /reverse-geocode` - 逆地理编码
- `GET /geocode` - 地理编码
- `GET /distance` - 计算距离

## 开发指南

### 数据库迁移

```bash
# 创建迁移
npm run prisma:migrate

# 重置数据库
npm run db:reset

# 查看数据库
npm run prisma:studio
```

### 测试

```bash
# 单元测试
npm run test

# 测试覆盖率
npm run test:cov
```

## 部署

### Docker 部署

```bash
# 构建镜像
docker build -t laorenbang-backend .

# 运行容器
docker run -d -p 3001:3001 --env-file .env laorenbang-backend
```

### 环境变量说明

| 变量 | 说明 | 必填 |
|------|------|------|
| DATABASE_URL | PostgreSQL 连接字符串 | ✅ |
| JWT_SECRET | JWT 密钥 | ✅ |
| WECHAT_APPID | 微信小程序 AppID | ⚠️ |
| WECHAT_APP_SECRET | 微信小程序密钥 | ⚠️ |
| WECHAT_MCH_ID | 微信支付商户号 | ⚠️ |
| AMAP_KEY | 高德地图 Key | 可选 |

## License

MIT

