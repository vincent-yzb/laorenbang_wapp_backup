# 微信支付商户开通与小额验收

更新：2026-10-08。当前用户具备营业执照，尚未申请微信支付商户号。代码准备不等于微信已允许收款。

## 你现在可以办理的步骤

1. 在[微信支付商户平台](https://pay.weixin.qq.com/)按真实营业执照主体申请普通商户，按页面提交主体、经营、联系人和结算账户资料，完成平台要求的审核、验证和签约。不要申请与实际业务无关的主体或类目。支持主体与绑定要求见[官方说明](https://pay.wechatpay.cn/doc/v3/partner/4012081990)。
2. 商户通过后，开通小程序支付，并将商户号绑定到本项目现有小程序 AppID，完成两侧需要的确认。不要把公众号 AppID 或其他小程序身份混入本项目。
3. 商户平台 API 安全中设置 APIv3 密钥，生成/下载商户 API 证书和商户私钥，取得证书序列号。取得微信支付公钥与对应 `PUB_KEY_ID_...`。本实现采用微信支付公钥验签；平台证书模式尚未实现。
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
