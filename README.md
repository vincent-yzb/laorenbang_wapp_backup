# 老人帮微信小程序后端

本目录是老人帮微信小程序唯一维护与部署入口，使用 NestJS、TypeScript、Prisma 和 PostgreSQL。它是独立 Git 子仓库；父目录 `backend/` 为历史副本，不再独立维护。

## 本轮能力

老人管理、订单流转和收入记账已有实现。新订单统一服务后付款，订单完成与收入、余额、时间线原子更新。重复付款或确认不重复入账；只有通过审核和实名认证的在线天使可接单。

真实微信支付、退款、提现、消息投递和服务轨迹尚未接通，对应接口明确返回 503。生产模式不会生成模拟支付参数，不会先扣余额再宣称转账成功。

## 环境和检查

使用 Node.js 22 LTS。`.node-version` 与 `engines: 22.x` 限制主版本；依赖安装使用本目录的锁文件。下列检查不会启动服务或连接数据库：

```bash
npm run prisma:generate
npm test
npm run type-check
npm run build
```

`npm test` 使用 Node 内置测试运行器和已有 ts-node，包含资金状态、并发条件更新、事务回滚、身份绑定、字段与角色权限以及本地 HTTP 契约检查。服务测试使用数据库替身；生产发布前仍需隔离 PostgreSQL 的真实并发测试。

## 本地开发

通过安全的服务端配置机制提供环境变量。`env.p0.example` 仅包含占位值，内测必须使用隔离数据库：

| 配置 | 用途 |
|---|---|
| `DATABASE_URL` | 隔离的 PostgreSQL 数据库 |
| `DIRECT_URL` | Prisma schema 校验和迁移使用的数据库直连地址 |
| `JWT_SECRET` | 独立随机签名密钥，开发和测试之外必须配置 |
| `WECHAT_APPID` / `WECHAT_APP_SECRET` | 微信身份和授权手机号接口 |
| `ALLOW_MOCK_PAYMENT` | 默认关闭，仅显式 development 环境可模拟付款 |
| `ALLOW_MOCK_SMS` | 默认关闭，仅显式 development 环境可返回内测验证码 |
| `PORT` | 服务监听端口，默认 3001 |
| `AMAP_KEY` | 可选服务端地址解析 |

```bash
npm run start:dev
```

API 前缀为 `/api`，开发文档为 `/api/docs`。未配置微信账号时登录和授权手机号明确失败；没有真实短信供应商时不声称短信已发送。配置文件必须由运行环境加载，源码不自动携带真实凭证。

生产启动采用 `npm run start:prod`，显式设置 production；模拟开关在此环境不能生效。当前版本不具备真实资金通道，不能直接用于收款试运营。

## 关键接口

- 子女与天使微信登录：`POST /api/auth/wechat-login`。
- 健康检查：`GET /api/health`，实际验证数据库连接。
- 服务目录和当前价格：`GET /api/services/types`、`GET /api/services/types/:id`。
- 老人邀请码登录：`POST /api/auth/elderly-login`。
- 手机绑定：`POST /api/user/bind-phone`、`POST /api/angel/bind-phone`；必须验证并消费有效验证码。
- 微信授权手机号：`POST /api/user/wechat-phone`、`POST /api/angel/wechat-phone`。
- 天使申请状态：`GET /api/angel/apply/status`。
- 订单主线：`/api/orders`、`/:id/accept`、`/:id/depart`、`/:id/arrive`、`/:id/start`、`/:id/complete`。
- 开发模拟付款：`POST /api/payment/create`；仅本人待付款订单，在显式开发开关下原子完成结算。
- 付款核实：`GET /api/payment/status/:orderId`；只有服务端 `isPaid && completed` 才表示完成。
- 历史预付款兼容确认：`POST /api/orders/:id/confirm`；未付款拒绝。

浏览未分配订单使用脱敏预览；已分配详情有角色和归属限制。服务结束后不再向历史客户返回天使新位置，缺失位置不替换为虚构坐标。

## 数据库升级

新增 User、Angel 的可空唯一 `wechatOpenId` 字段。应用新代码前，必须审阅 [微信身份迁移说明](prisma/migrations/20261008_wechat_identity/README.md) 和增量 SQL，并完成备份、现有 schema 核对与迁移基线准备。本轮没有连接或迁移业务数据库。

已新增从仓库旧 schema 重建的初始基线，独立空测试库可依次执行基线与身份增量。现有非空库须先核对实际结构，不能直接首次执行 `migrate deploy` 或未经 diff 就标记基线已应用；旧版 `init.sql` 也不应当作当前 schema 的发布依据。以实际数据库结构、当前 Prisma schema 和经过审阅的迁移历史为准。Prisma [基线说明](https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining) 解释了现有数据库接入迁移管理的步骤。

独立本地 PostgreSQL 的启动、真实并发测试和迁移检查见 [数据库联调说明](scripts/db/README.md)。完成隔离配置后，`npm run seed:isolated` 创建 9 个明确 ID 的示例服务目录，`npm run start:isolated` 启动 `127.0.0.1:3101`，`npm run test:isolated:http` 验证真实 JWT、HTTP 与数据库业务流程。这三个命令仅允许专属回环测试库，不回退本目录 `.env`；不要运行旧 `prisma/seed.ts` 作为生产初始化脚本。

旧代码只保留微信身份后八位，无法安全恢复完整身份。历史账号需要受信任恢复与重新绑定，不能按截断值或重复手机号自动认领、合并。旧版非事务结算产生的流水和余额也需发布前只读对账，不自动补差。

## 项目交付文档

- [开发计划](../docs/WEAPP_DEVELOPMENT_PLAN.md)
- [专业提示词](../docs/WEAPP_DEVELOPMENT_PROMPT.md)
- [本轮交付和验收](../docs/WEAPP_P0_DELIVERY.md)


## 微信支付链路（2026-10-08）

已实现普通商户 APIv3 预下单、raw-body 回调验签/解密、主动查单与补偿、全额退款审批和微信用户确认模式提现。金额使用 BigInt 分记账，历史余额和模拟收入不可提现。`WECHAT_PAY_ENABLED`、`WECHAT_TRANSFER_ENABLED` 默认关闭；当前运营主体尚无商户号，真实扣款/退款/到账尚未验收。

- [支付计划](docs/WEAPP_PAYMENT_PLAN.md)、[实施提示词](docs/WEAPP_PAYMENT_PROMPT.md)
- [商户开通、私密配置与真机验收](docs/WECHAT_PAY_ACTIVATION.md)，服务端模板 `env.payment.example`
- `npm test`：离线业务、加密和 HTTP 边界验证。
- `node scripts/test-financial.cjs`：仅本机专属 PG 的迁移、真实支付状态机、退款/提现竞争与回滚验证；先按 `scripts/db/README.md` 配置隔离库。所有微信资金接口均用虚构网关，不进行真实交易。

现有数据库必须先备份，再执行增量迁移。不要 reset/db push 或跳过失败迁移；不可将旧 Float 钱包写入器与新分记账系统并行运行。
