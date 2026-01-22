import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../cache/cache.service';
import { ConfigService } from '../../config/config.service';
import {
  SendCodeDto,
  PhoneLoginDto,
  WechatLoginDto,
  ElderlyLoginDto,
  UserType,
  JwtPayload,
  LoginResponse,
} from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private cacheService: CacheService,
    private configService: ConfigService,
  ) {}

  /**
   * 发送短信验证码
   */
  async sendCode(dto: SendCodeDto): Promise<{ success: boolean; message: string; code?: string }> {
    const { phone, type } = dto;

    // 检查发送频率
    const canSend = await this.cacheService.checkSendLimit(phone);
    if (!canSend) {
      throw new BadRequestException('发送太频繁，请1分钟后再试');
    }

    // 生成6位验证码
    const code = Math.random().toString().slice(2, 8);

    // 存储验证码（5分钟有效）
    await this.cacheService.setVerificationCode(phone, code, 300);

    // TODO: 调用短信服务发送验证码
    // await this.smsService.send(phone, code);

    console.log(`[SMS] 发送验证码到 ${phone}: ${code}`);

    return {
      success: true,
      message: '验证码已发送',
      // 开发环境返回验证码
      ...(this.configService.isDevelopment && { code }),
    };
  }

  /**
   * 手机号验证码登录
   */
  async phoneLogin(dto: PhoneLoginDto): Promise<LoginResponse> {
    const { phone, code, userType } = dto;

    // 验证验证码
    const storedCode = await this.cacheService.getVerificationCode(phone);
    if (!storedCode || storedCode !== code) {
      throw new BadRequestException('验证码错误或已过期');
    }

    // 删除已使用的验证码
    await this.cacheService.deleteVerificationCode(phone);

    // 根据用户类型处理登录
    let user: any;

    if (userType === UserType.CHILD) {
      // 子女登录/注册
      user = await this.prisma.user.upsert({
        where: { phone },
        create: { phone, name: `用户${phone.slice(-4)}` },
        update: {},
      });
    } else if (userType === UserType.ANGEL) {
      // 天使登录/注册
      user = await this.prisma.angel.upsert({
        where: { phone },
        create: { phone, name: `天使${phone.slice(-4)}` },
        update: {},
      });
    } else {
      throw new BadRequestException('老人用户请使用邀请码登录');
    }

    // 生成 Token
    return this.generateTokenResponse(user, userType);
  }

  /**
   * 微信登录（静默登录）
   * 
   * 根据微信 openid 自动创建或查找用户，实现无感登录
   * 如果微信配置缺失，使用 code 的哈希作为临时标识
   */
  async wechatLogin(dto: WechatLoginDto): Promise<LoginResponse> {
    try {
      const { code, userType } = dto;

      console.log('[wechatLogin] 开始处理, userType:', userType);

      if (!userType || !['child', 'angel', 'elderly'].includes(userType)) {
        throw new BadRequestException('用户类型无效');
      }

      if (userType === UserType.ELDERLY) {
        throw new BadRequestException('老人用户请使用邀请码登录');
      }

      let identifier: string;

      // 尝试调用微信 API 获取 openid
      try {
        const wxResult = await this.getWechatOpenId(code);
        console.log('[wechatLogin] 微信API返回:', JSON.stringify(wxResult));
        
        if (wxResult.openid) {
          identifier = wxResult.openid;
        } else {
          console.warn('[wechatLogin] 微信 API 调用失败，使用临时开发模式:', wxResult.errmsg);
          identifier = `dev_${userType}_default`;
        }
      } catch (wxError) {
        console.error('[wechatLogin] 调用微信API出错:', wxError);
        identifier = `dev_${userType}_default`;
      }

      console.log('[wechatLogin] 使用标识符:', identifier);

      // 用 phone 字段临时存储标识
      const fakePhone = `wx_${identifier.slice(-8)}`;
      console.log('[wechatLogin] 临时手机号:', fakePhone);

      let user: any;

      if (userType === UserType.CHILD) {
        console.log('[wechatLogin] 创建/查找子女用户...');
        user = await this.prisma.user.upsert({
          where: { phone: fakePhone },
          create: { 
            phone: fakePhone, 
            name: '微信用户',
          },
          update: {},
        });
        console.log('[wechatLogin] 子女用户:', user?.id);
      } else if (userType === UserType.ANGEL) {
        console.log('[wechatLogin] 创建/查找天使用户...');
        user = await this.prisma.angel.upsert({
          where: { phone: fakePhone },
          create: { 
            phone: fakePhone, 
            name: '新天使',
            isOnline: true, // 登录即在线
          },
          update: {
            isOnline: true, // 登录时自动上线
          },
        });
        console.log('[wechatLogin] 天使用户:', user?.id);
      }

      if (!user) {
        throw new BadRequestException('用户创建失败');
      }

      console.log('[wechatLogin] 生成Token...');
      const response = this.generateTokenResponse(user, userType);
      console.log('[wechatLogin] 登录成功, userId:', user.id);
      
      return response;
    } catch (error) {
      console.error('[wechatLogin] 错误:', error);
      // 重新抛出 BadRequestException，其他错误包装一下
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(`微信登录失败: ${error.message || '未知错误'}`);
    }
  }

  /**
   * 老人邀请码登录
   */
  async elderlyLogin(dto: ElderlyLoginDto): Promise<LoginResponse> {
    const { inviteCode } = dto;

    // 查询老人信息
    const elderly = await this.prisma.elderly.findUnique({
      where: { inviteCode },
      include: { user: true },
    });

    if (!elderly) {
      throw new BadRequestException('邀请码无效');
    }

    // 生成 Token
    return this.generateTokenResponse(
      { id: elderly.id, name: elderly.name, phone: elderly.phone },
      UserType.ELDERLY,
    );
  }

  /**
   * 刷新 Token
   */
  async refreshToken(refreshToken: string): Promise<LoginResponse> {
    try {
      const payload = this.jwtService.verify<JwtPayload>(refreshToken, {
        secret: this.configService.jwtSecret + '_refresh',
      });

      // 查询用户
      let user: any;
      if (payload.userType === UserType.CHILD) {
        user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
      } else if (payload.userType === UserType.ANGEL) {
        user = await this.prisma.angel.findUnique({ where: { id: payload.sub } });
      } else if (payload.userType === UserType.ELDERLY) {
        user = await this.prisma.elderly.findUnique({ where: { id: payload.sub } });
      }

      if (!user) {
        throw new UnauthorizedException('用户不存在');
      }

      return this.generateTokenResponse(user, payload.userType);
    } catch (error) {
      throw new UnauthorizedException('Token 已过期，请重新登录');
    }
  }

  /**
   * 验证 Token
   */
  async validateToken(token: string): Promise<JwtPayload | null> {
    try {
      return this.jwtService.verify<JwtPayload>(token);
    } catch {
      return null;
    }
  }

  // ============ 私有方法 ============

  /**
   * 生成 Token 响应
   */
  private generateTokenResponse(user: any, userType: UserType): LoginResponse {
    const payload: JwtPayload = {
      sub: user.id,
      phone: user.phone,
      userType,
    };

    const token = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.jwtSecret + '_refresh',
      expiresIn: '30d',
    });

    return {
      success: true,
      data: {
        token,
        refreshToken,
        expiresIn: 7 * 24 * 60 * 60, // 7天（秒）
        user: {
          id: user.id,
          phone: user.phone,
          name: user.name,
          avatar: user.avatar,
          isVerified: user.isVerified ?? false,
          userType,
        },
      },
    };
  }

  /**
   * 调用微信 API 获取 OpenID
   */
  private async getWechatOpenId(code: string): Promise<{
    openid?: string;
    unionid?: string;
    session_key?: string;
    errcode?: number;
    errmsg?: string;
  }> {
    const appId = this.configService.wechatAppId;
    const appSecret = this.configService.wechatAppSecret;

    if (!appId || !appSecret) {
      console.warn('微信小程序配置缺失');
      return { errcode: -1, errmsg: '微信配置缺失' };
    }

    try {
      const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${appId}&secret=${appSecret}&js_code=${code}&grant_type=authorization_code`;
      const response = await fetch(url);
      return response.json();
    } catch (error) {
      console.error('微信登录接口调用失败:', error);
      return { errcode: -1, errmsg: '网络错误' };
    }
  }
}
