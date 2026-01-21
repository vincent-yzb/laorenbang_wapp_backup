/**
 * 微信支付配置
 * 
 * ⚠️ 重要：以下配置需要从微信支付商户平台获取
 * 
 * 申请流程：
 * 1. 注册微信支付商户号：https://pay.weixin.qq.com/
 * 2. 完成商户认证
 * 3. 获取 API 密钥和证书
 * 4. 在小程序后台关联商户号
 */

export interface WechatPayConfig {
  // 小程序 AppID
  appId: string;
  
  // 商户号
  mchId: string;
  
  // APIv3 密钥（32位）
  apiV3Key: string;
  
  // 商户证书序列号
  serialNo: string;
  
  // 商户私钥（apiclient_key.pem 内容）
  privateKey: string;
  
  // 支付结果通知回调地址
  notifyUrl: string;
}

// 从环境变量读取配置
export const wechatPayConfig: WechatPayConfig = {
  appId: process.env.WECHAT_APP_ID || '',
  mchId: process.env.WECHAT_MCH_ID || '',
  apiV3Key: process.env.WECHAT_API_V3_KEY || '',
  serialNo: process.env.WECHAT_SERIAL_NO || '',
  privateKey: process.env.WECHAT_PRIVATE_KEY || '',
  notifyUrl: process.env.WECHAT_PAY_NOTIFY_URL || 'https://laorenbang-backend.onrender.com/api/payment/notify',
};

// 验证配置是否完整
export const validateWechatPayConfig = (): boolean => {
  const required = ['appId', 'mchId', 'apiV3Key', 'serialNo', 'privateKey'];
  const missing = required.filter(key => !wechatPayConfig[key as keyof WechatPayConfig]);
  
  if (missing.length > 0) {
    console.warn(`⚠️ 微信支付配置缺失: ${missing.join(', ')}`);
    console.warn('支付功能将不可用，请在 Render 环境变量中配置');
    return false;
  }
  
  return true;
};

export default wechatPayConfig;

