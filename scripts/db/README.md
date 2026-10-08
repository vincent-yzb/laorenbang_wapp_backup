# 独立本地 PostgreSQL 联调

此工具只允许 `127.0.0.1:55432/lrb_integration` 和专属角色 `lrb_integration`。它创建全新 PostgreSQL 16 容器 `lrb-integration-20261008`，绑定本机回环地址，数据存放在 `.local/postgres-data`；不使用已有卷、业务数据库、项目 `.env` 或真实业务数据。

```sh
python3 scripts/db/isolated_postgres.py start
python3 scripts/db/isolated_postgres.py migrate
python3 scripts/db/isolated_postgres.py test
python3 scripts/db/isolated_postgres.py check
```

需先启动本机 Docker Desktop，并有 `postgres:16-alpine` 镜像与本地 Node 22。可用 `LRB_NODE_BIN` 指定其他本机 Node 22 可执行文件。脚本不自动安装软件或下载依赖。

随机数据库密码只保存于 `.local/isolated-postgres.env` 与 Docker 初始化文件 `.local/postgres-container.env`，文件权限为 `600`、目录为 `700`，全部被本地忽略规则排除。不要打印、粘贴或提交这些文件。API 启动器应从连接 env 文件加载两条数据库 URL，并另行注入运行时配置；本工具不保存微信凭据。

首次运行时，迁移流程在独立空库先部署重建基线，写入三条明确虚构的旧版本数据，再部署身份增量，检查迁移历史与 canonical Prisma schema 无差异。再次运行会复用本任务隔离库和已复制的迁移目录，保持幂等；不会再次重演新增身份列之前插入旧记录的首次验证。基线来自仓库旧 schema 重建，**并非线上数据库已验证结构**；不能用本工具迁移现有业务库，也不能未经结构 diff 就将现有库标记为已应用基线。

## 实际 Docker 镜像运行验证

已构建 `laorenbang-backend:staging` 后运行：

```sh
python3 scripts/db/verify_staging_image.py
```

此脚本创建本任务专属 Docker bridge 网络，把现隔离数据库以 `db:5432` 接入，并启动独立生产模式 API 容器 `lrb-staging-api-20261008`，仅发布 `127.0.0.1:3102`。连接设置和全新随机 JWT 密钥保存在 `.local/docker-staging.env`（600）；没有真实微信配置，模拟短信与付款均关闭。它实测健康端点、9项服务目录、鉴权及生产付款拒绝，再核对 PID 1 非 root 与 Docker health 状态。脚本不改 schema，不删除或替换已有容器、网络或卷；完成后保持容器运行。请先完成集成测试，避免测试临时服务目录影响9项目录数量断言。

集成测试调用实际 OrderService/PaymentService 和真实 PostgreSQL，验证并发接单、8路并发付款唯一结算、历史 PAID 流程、真实 SQL 约束失败后的事务回滚、身份唯一索引及迁移保留数据。付款通道仍为显式开发模拟；这些测试没有验证真实微信商户收款。每次测试只清理本次生成的虚构 fixtures，保留三条迁移验证记录，容器继续运行供本机 API 使用。


支付账务阶段新增 `20261008_payment_ledger` 与 `20261008_payment_review_audit`，继续使用 additive migrate deploy，保留既有隔离 fixtures。新迁移专属验证在 `test/integration/payment-ledger-migration.test.ts`；真实支付业务与资金服务测试使用虚构网关和严格 loopback PG，不访问真实微信资金接口。各专属测试通过明确 `LRB_INTEGRATION_DB=true` 和私有连接环境运行；不能把 normal .env 或云数据库 URL 传入。
