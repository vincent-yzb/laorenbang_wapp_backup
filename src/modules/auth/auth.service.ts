import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { createHash } from 'crypto';
import { IdentityService } from './identity.service';
import { validateInput } from './validate-input';
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
    private identityService: IdentityService,
    private configService: ConfigService,
  ) {}

  /**
   * 发送短信验证码
   */
  async sendCode(dto: SendCodeDto) {
    return this.identityService.sendCode(dto);
  }

  /**
   * 手机号验证码登录
   */
  async phoneLogin(dto: PhoneLoginDto): Promise<LoginResponse> {
    const { phone, code, userType } = validateInput(PhoneLoginDto, dto);
    if (userType === UserType.ELDERLY) {
      throw new BadRequestException('老人用户请使用邀请码登录');
    }
    await this.identityService.consumePhoneCode(phone, code);

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

  /** 微信身份只通过完整 openid 匹配；上游失败时不创建账号。 */
  async wechatLogin(input: WechatLoginDto): Promise<LoginResponse> {
    const { code, userType } = validateInput(WechatLoginDto, input);
    if (userType === UserType.ELDERLY) {
      throw new BadRequestException('老人用户请使用邀请码登录');
    }
    const wechatOpenId = await this.identityService.getWechatOpenId(code);
    const phone = `wx_${createHash('sha256').update(wechatOpenId).digest('hex')}`;
    const user = userType === UserType.CHILD
      ? await this.prisma.user.upsert({
          where: { wechatOpenId },
          create: { wechatOpenId, phone, name: '微信用户' },
          update: {},
        })
      : await this.prisma.angel.upsert({
          where: { wechatOpenId },
          create: { wechatOpenId, phone, name: '新天使' },
          update: {},
        });
    return this.generateTokenResponse(user, userType);
  }

  /**
   * 老人邀请码登录
   */
  async elderlyLogin(dto: ElderlyLoginDto): Promise<LoginResponse> {
    const { inviteCode } = validateInput(ElderlyLoginDto, dto);

    // 查询老人信息，包含子女（创建者）信息
    let elderly = await this.prisma.elderly.findUnique({
      where: { inviteCode },
      include: { user: true },
    });

    // Preserve exact historical codes, including lowercase 8-character values.
    // New codes are uppercase; accept lowercase input only if no exact match exists.
    if (!elderly && inviteCode !== inviteCode.toUpperCase()) {
      elderly = await this.prisma.elderly.findUnique({
        where: { inviteCode: inviteCode.toUpperCase() },
        include: { user: true },
      });
    }

    if (!elderly) {
      throw new BadRequestException('邀请码无效');
    }

    // 生成 Token，包含子女信息
    return this.generateTokenResponse(
      { 
        id: elderly.id, 
        name: elderly.name, 
        phone: elderly.phone,
        // 子女信息
        childName: elderly.user?.name || '我的家人',
        childPhone: elderly.user?.phone,
      },
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
          // 老人端专用：子女信息
          childName: user.childName,
          childPhone: user.childPhone,
        },
      },
    };
  }

}
