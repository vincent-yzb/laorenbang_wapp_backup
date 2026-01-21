import { Injectable } from '@nestjs/common';

/**
 * 配置服务 - 管理应用配置
 */
@Injectable()
export class ConfigService {
  // 应用配置
  get port(): number {
    return parseInt(process.env.PORT || '3000', 10);
  }

  get nodeEnv(): string {
    return process.env.NODE_ENV || 'development';
  }

  get isDevelopment(): boolean {
    return this.nodeEnv === 'development';
  }

  // JWT 配置
  get jwtSecret(): string {
    return process.env.JWT_SECRET || 'laorenbang-jwt-secret-dev';
  }

  get jwtExpiresIn(): string {
    return process.env.JWT_EXPIRES_IN || '7d';
  }

  // 微信小程序配置
  get wechatAppId(): string {
    return process.env.WECHAT_APPID || '';
  }

  get wechatAppSecret(): string {
    return process.env.WECHAT_APP_SECRET || '';
  }

  // 微信支付配置
  get wechatMchId(): string {
    return process.env.WECHAT_MCH_ID || '';
  }

  get wechatPayKey(): string {
    return process.env.WECHAT_PAY_KEY || '';
  }

  get wechatPayCertPath(): string {
    return process.env.WECHAT_PAY_CERT_PATH || '';
  }

  // Redis 配置
  get redisHost(): string {
    return process.env.REDIS_HOST || 'localhost';
  }

  get redisPort(): number {
    return parseInt(process.env.REDIS_PORT || '6379', 10);
  }

  get redisPassword(): string {
    return process.env.REDIS_PASSWORD || '';
  }

  // 短信配置 (腾讯云)
  get smsSecretId(): string {
    return process.env.SMS_SECRET_ID || '';
  }

  get smsSecretKey(): string {
    return process.env.SMS_SECRET_KEY || '';
  }

  get smsAppId(): string {
    return process.env.SMS_APP_ID || '';
  }

  get smsSignName(): string {
    return process.env.SMS_SIGN_NAME || '老人帮';
  }

  // 高德地图配置
  get amapKey(): string {
    return process.env.AMAP_KEY || '';
  }

  get amapSecret(): string {
    return process.env.AMAP_SECRET || '';
  }

  // 腾讯云 COS 配置
  get cosSecretId(): string {
    return process.env.COS_SECRET_ID || '';
  }

  get cosSecretKey(): string {
    return process.env.COS_SECRET_KEY || '';
  }

  get cosBucket(): string {
    return process.env.COS_BUCKET || '';
  }

  get cosRegion(): string {
    return process.env.COS_REGION || 'ap-beijing';
  }
}

