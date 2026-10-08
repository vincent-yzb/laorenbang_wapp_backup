import { Injectable, BadRequestException, UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { randomInt } from 'crypto';
import { CacheService } from '../../cache/cache.service';
import { ConfigService } from '../../config/config.service';
import { BindPhoneDto, SendCodeDto, UserType, WechatPhoneDto } from './dto/auth.dto';
import { validateInput } from './validate-input';

@Injectable()
export class IdentityService {
  constructor(private cache: CacheService, private config: ConfigService) {}

  async sendCode(input: SendCodeDto) {
    const dto = validateInput(SendCodeDto, input);
    if (dto.type === UserType.ELDERLY) {
      throw new BadRequestException('老人用户请使用邀请码登录');
    }
    // No SMS vendor is integrated yet. Never report a real SMS as sent.
    if (process.env.NODE_ENV !== 'development' || process.env.ALLOW_MOCK_SMS !== 'true') {
      throw new ServiceUnavailableException('短信服务尚未接入，请使用微信授权手机号');
    }
    if (!(await this.cache.checkSendLimit(dto.phone))) {
      throw new BadRequestException('发送太频繁，请1分钟后再试');
    }
    const devCode = randomInt(100000, 1000000).toString();
    await this.cache.setVerificationCode(dto.phone, devCode, 300);
    return { success: true, message: '开发模式验证码已生成，未发送短信', devCode };
  }

  async consumePhoneCode(phone: string, code: string) {
    validateInput(BindPhoneDto, { phone, code });
    if (!(await this.cache.consumeVerificationCode(phone, code))) {
      throw new BadRequestException('验证码错误或已过期');
    }
  }

  private wechatCredentials() {
    const appId = this.config.wechatAppId;
    const appSecret = this.config.wechatAppSecret;
    if (!appId || !appSecret) {
      throw new ServiceUnavailableException('微信服务尚未配置');
    }
    return { appId, appSecret };
  }

  private async requestWechat(url: string, options?: RequestInit): Promise<any> {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('upstream unavailable');
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid response');
      return data;
    } catch {
      // Never include URLs, codes, session keys or upstream response bodies in logs/errors.
      throw new ServiceUnavailableException('微信服务暂时不可用，请重试');
    }
  }

  async getWechatOpenId(code: string): Promise<string> {
    validateInput(WechatPhoneDto, { code });
    const { appId, appSecret } = this.wechatCredentials();
    const params = new URLSearchParams({ appid: appId, secret: appSecret, js_code: code, grant_type: 'authorization_code' });
    const data = await this.requestWechat(`https://api.weixin.qq.com/sns/jscode2session?${params}`);
    if ((data.errcode !== undefined && data.errcode !== 0) || typeof data.openid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.openid)) {
      throw new UnauthorizedException('微信授权无效或已过期，请重新授权');
    }
    return data.openid;
  }

  async getWechatPhone(code: string): Promise<string> {
    validateInput(WechatPhoneDto, { code });
    const { appId, appSecret } = this.wechatCredentials();
    const params = new URLSearchParams({ grant_type: 'client_credential', appid: appId, secret: appSecret });
    const token = await this.requestWechat(`https://api.weixin.qq.com/cgi-bin/token?${params}`);
    if (typeof token.access_token !== 'string' || !token.access_token || (token.errcode !== undefined && token.errcode !== 0)) {
      throw new ServiceUnavailableException('微信手机号服务暂时不可用');
    }
    const phoneParams = new URLSearchParams({ access_token: token.access_token });
    const data = await this.requestWechat(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?${phoneParams}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    });
    const phone = data.phone_info?.purePhoneNumber || data.phone_info?.phoneNumber;
    if (data.errcode !== 0 || typeof phone !== 'string' || !/^1[3-9]\d{9}$/.test(phone)) {
      throw new UnauthorizedException('微信手机号授权无效，请重新授权');
    }
    return phone;
  }
}
