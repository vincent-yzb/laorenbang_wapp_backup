# 微信支付商户开通与小额验收

更新：2026-10-08。用户已开通商户并提供商户号；商户号已写入本机私有配置。用户已选择复用已认证企业小程序作为目标，商户与小程序主体一致；目标AppID为 `wxdd2e919828dc8482`。前后端微信登录与支付签名须同步使用此AppID，实际发布状态以交付记录和本机发布收据为准。目标小程序绑定及API安全材料仍待完成，真实收款与转账保持关闭。


## 企业小程序替换准备

目标企业小程序已认证，尚未发布；用户确认其主体与支付商户号主体一致。复用该账号承载老人帮，不办理原个人小程序的主体变更。先在企业小程序后台按实际业务申请名称、简介、图标、服务类目、隐私说明和备案；当前“工具 > 信息查询”不能作为老人帮实际服务类目的验收结果。名称和类目以平台审核结果为准。

新小程序的AppSecret只在主仓 `.local/wechat-enterprise.env`（600）填写，不发聊天、不提交Git。小程序项目配置与构建产物已指向新AppID；新AppSecret已通过官方稳定令牌接口验证。后端发布须同时使用匹配的AppID/AppSecret，并轮换登录签名密钥，再验收新预览。不得只改客户端AppID就视为切换完成。

切换准备记录为 `.local/wechat-enterprise-switch.json`，原项目配置备份在 `.local/wechat-app-switch-before/`。切换不重置数据库。旧测试账号与订单保留；User/Angel新增可空wechatAppId，不从旧openid猜测归属。新微信登录绑定当前AppID，JWT与刷新令牌包含AppID，旧/无归属令牌失效；资金入口再次核对数据库中的微信AppID。新AppID下重新微信登录，不覆盖旧openid，不自动认领旧账号。发布工具要求先备份，确认没有未决资金记录，再增量迁移与同步配置。

## 你现在可以办理的步骤

1. 在[微信支付商户平台](https://pay.weixin.qq.com/)「产品中心 → JSAPI支付」确认产品已开通；小程序支付使用该权限。[官方权限说明](https://pay.wechatpay.cn/doc/v3/merchant/4012791895)。
2. 在商户平台「产品中心 → APPID授权管理（或AppID账号管理）→ 关联AppID」关联 `wxdd2e919828dc8482`；再登录该小程序的[公众平台](https://mp.weixin.qq.com/)「微信支付 → 商户号管理」确认同一商户号。管理员本人阅读并确认相关协议，两侧确认后核对已绑定状态。[官方绑定流程](https://pay.wechatpay.cn/doc/v3/merchant/4013287504)。
3. 在商户平台「账户中心 → API安全」设置32位数字/大小写字母的 APIv3 密钥，申请普通RSA商户 API 证书并保管同一套 `apiclient_cert.pem` 与 `apiclient_key.pem`。从「微信支付公钥 → 管理公钥」下载微信支付公钥及完整 `PUB_KEY_ID_...`。本实现采用公钥验签，不接受平台证书模式；新商户从未接入平台证书可直接使用公钥，如果曾接入其他系统须先核对切换状态。[证书](https://pay.wechatpay.cn/doc/v3/merchant/4012072428)、[APIv3密钥](https://pay.wechatpay.cn/doc/v3/merchant/4012072195)、[公钥获取](https://pay.wechatpay.cn/doc/v3/merchant/4013038816)、[新商户接入说明](https://pay.wechatpay.cn/doc/v3/merchant/4012154180)。
4. 需要向天使微信零钱出款时，另申请商家转账用户确认模式及实际适用场景权限，按商户平台配置场景、收款感知与报备字段。没有转账权限时，收款与退款可以独立验收，提现保持关闭。
5. 在微信公众平台配置小程序 request 合法 HTTPS 域名；真机验收关闭“开发调试”后重试。现有手机开启调试才能登录的结果不能替代正式合法域名验收。

## 私有服务端配置

配置模板为后端 `env.payment.example`。实际值仅放主仓 `.local/wechat-pay.env`（权限600）或云端受控环境变量；请勿在聊天中发送密码、APIv3 密钥、私钥或运营审核 token。不要提交 `.env`，不要把私钥放到小程序。

| 配置 | 作用 |
| --- | --- |
| WECHAT_APPID | 当前已绑定的小程序 AppID |
| WECHAT_PAY_ENABLED | 首次配置保持 false，完成核查后再开启 |
| WECHAT_PAY_MCH_ID | 普通商户号 |
| WECHAT_PAY_API_V3_KEY | 32字节 APIv3 密钥，用于通知解密 |
| WECHAT_PAY_MERCHANT_SERIAL | 商户 API 证书序列号 |
| WECHAT_PAY_PRIVATE_KEY_BASE64 | 商户私钥 PEM 的 Base64 |
| WECHAT_PAY_PLATFORM_KEY_ID | 微信支付公钥 ID，PUB_KEY_ID_... |
| WECHAT_PAY_PLATFORM_PUBLIC_KEY_BASE64 | 对应微信支付公钥 PEM 的 Base64 |
| WECHAT_PAY_NOTIFY_URL | HTTPS `/api/payment/notify` |
| WECHAT_REFUND_NOTIFY_URL | HTTPS `/api/payment/refund-notify` |
| PAYMENT_OPERATOR_TOKEN | 至少32字符的独立随机审核凭证，不下发客户端 |
| WECHAT_TRANSFER_ENABLED | 独立开关，初始 false |
| WECHAT_TRANSFER_SCENE_ID | 商户获批的真实转账场景 ID |
| WECHAT_TRANSFER_USER_RECV_PERCEPTION | 商户获批的收款感知 |
| WECHAT_TRANSFER_SCENE_REPORT_INFOS_JSON | 按场景要求填写的 info_type/info_content 数组 |
| WECHAT_TRANSFER_NOTIFY_URL | HTTPS `/api/payment/transfer-notify` |

### 本机导入准备

主仓已建立私密目录 `.local/wechat-pay-materials/`（700），说明及 `input.env` 均为600。放入以下文件，材料文件权限设为600：

- `apiclient_cert.pem`：此商户的API证书。
- `apiclient_key.pem`：同一套商户私钥。
- `wechatpay_public_key.pem`：官方下载的微信支付公钥，可复制后改为此文件名。
- `input.env`：仅在本机填写 APIv3 密钥与完整公钥ID，不加引号。

从主仓执行 `node .local/prepare-wechat-pay.cjs status` 查看缺项和目标/当前服务端AppID；该工具已锁新企业AppID，服务端身份尚未同步时拒绝导入。身份同步、材料齐全后执行 `node .local/prepare-wechat-pay.cjs import`。导入检查证书商户号、有效期、私钥匹配、RSA强度、密钥格式及固定测试回调地址，自动提取序列号与Base64，并准备独立运营凭证；只写本机 `.local/wechat-pay.env`，两个资金开关仍为false，不访问网络、不更改云端、不产生交易。证书归属检查依据[官方证书排错说明](https://pay.wechatpay.cn/doc/v3/merchant/4012365345)。

导入成功不能证明APIv3密钥正确、公钥ID与文件来源相符、AppID已绑定或产品权限已开通；这些仍需核对商户后台并进行签名接口与真机验收。当前本机工具已通过12项临时证书验证，不使用真实密钥、不产生资金操作。

当前 staging 基址为 `https://laorenbang-staging-20261008.onrender.com`。该免费实例与免费数据库只用于测试，不自动升级付费配置。正式收款前需安排持续运行、数据库备份及到期处理；当前测试数据库到期时间为 2026-11-07 13:48 UTC。

## 资金状态与运营操作

- 付款：服务完成后发起，手机调起微信支付；支付通知或主动查单核验成功后订单完成并记收入。未决状态只查原支付单。
- 退款：用户申请全额退款并填原因，运营审核通过后提交微信；“申请已提交”不表示钱已到账。ABNORMAL 需要在商户平台人工核实，保留冻结。
- 提现：天使仅能提现核验真实收入扣除冻结与不可提现部分；先申请、再运营审核，然后本人确认微信收款。首次支持10元至小于2000元；当前没有大额收款姓名核验能力。
- 运营审核端点在 `/api/payment/operator/` 下，使用独立 `Authorization: Bearer ...` 和 `X-Payment-Operator` 审核人员标识。先查询本人资金申请获取 ID，经实际负责人审核后再调用 `refunds/:id/approve` 或 `withdrawals/:id/approve`；拒绝使用对应 `/reject` 并提供 `reason`。不要自动批准测试或真实资金操作。
- 查询 `/operator/configuration` 仅返回开关与缺项名称；`POST /operator/reconcile` 查询未决记录，不自动审核申请。

## 商户开通后的真机验收表

用专门可追踪的小额测试订单，先明确金额和实际付款/收款人，再执行资金操作。不自动使用80元等现有服务目录价格作为测试扣款。

| 场景 | 期望结果 |
| --- | --- |
| 手机关闭开发调试后登录与查订单 | 合法域名配置生效，真实微信身份一致 |
| 服务后付款成功 | 微信账单、订单、支付单、天使80%收入与平台20%份额相符 |
| 取消付款与断网 | 不误报付款成功；重新进入可查询原单 |
| SDK成功但回调延迟 | 查单可补偿，只有后端核验后显示完成 |
| 重复请求、重复/乱序通知 | 仅一个收入账目与一次余额增加 |
| 过期支付 | 确认原单 CLOSED 后才允许新支付单 |
| 申请退款、拒绝、批准、到账 | 申请不当作到账；核验SUCCESS才冲账；全额一致 |
| 真实提现与用户确认 | WAIT_USER_CONFIRM调起本人确认；查单SUCCESS才扣余额 |
| 失败、异常、未知出款 | 不重复转账；未知保留冻结，可靠失败释放冻结 |
| 日终对账 | 商户支付/退款/转账记录与本地单号、交易号、账目、余额一致 |

真实验收结果应补入交付记录，并保留脱敏单号证据。对账单下载自动化、运营管理界面、大额提现、部分退款及商户外部手动资金操作同步为后续工作，当前不得声称覆盖。

## 官方技术依据

- [JSAPI/小程序下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791897)
- [退款开发指引](https://pay.wechatpay.cn/doc/v3/merchant/4013071031)
- [退款通知](https://pay.wechatpay.cn/doc/v3/merchant/4012791906)
- [商家转账](https://pay.wechatpay.cn/doc/v3/merchant/4012716434)
- [小程序调起用户确认收款](https://pay.wechatpay.cn/doc/v3/merchant/4012716430)
