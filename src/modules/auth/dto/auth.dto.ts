import { IsString, IsNotEmpty, IsMobilePhone, IsEnum, IsOptional, Length } from 'class-validator';

/**
 * 用户类型枚举
 */
export enum UserType {
  CHILD = 'child',     // 子女
  ELDERLY = 'elderly', // 老人
  ANGEL = 'angel',     // 天使
}

/**
 * 发送验证码 DTO
 */
export class SendCodeDto {
  @IsNotEmpty({ message: '手机号不能为空' })
  @IsMobilePhone('zh-CN', {}, { message: '请输入有效的手机号' })
  phone: string;

  @IsEnum(UserType, { message: '用户类型无效' })
  type: UserType;
}

/**
 * 手机号登录 DTO
 */
export class PhoneLoginDto {
  @IsNotEmpty({ message: '手机号不能为空' })
  @IsMobilePhone('zh-CN', {}, { message: '请输入有效的手机号' })
  phone: string;

  @IsNotEmpty({ message: '验证码不能为空' })
  @Length(6, 6, { message: '验证码为6位数字' })
  code: string;

  @IsEnum(UserType, { message: '用户类型无效' })
  userType: UserType;
}

/**
 * 微信登录 DTO
 */
export class WechatLoginDto {
  @IsNotEmpty({ message: 'code 不能为空' })
  @IsString()
  code: string;

  @IsEnum(UserType, { message: '用户类型无效' })
  userType: UserType;
}

/**
 * 微信手机号登录 DTO (快速验证)
 */
export class WechatPhoneLoginDto {
  @IsNotEmpty({ message: 'code 不能为空' })
  @IsString()
  code: string;

  @IsEnum(UserType, { message: '用户类型无效' })
  userType: UserType;
}

/**
 * 老人登录 DTO (邀请码)
 */
export class ElderlyLoginDto {
  @IsNotEmpty({ message: '邀请码不能为空' })
  @IsString()
  inviteCode: string;
}

/**
 * 刷新 Token DTO
 */
export class RefreshTokenDto {
  @IsNotEmpty({ message: 'refresh_token 不能为空' })
  @IsString()
  refreshToken: string;
}

/**
 * JWT Payload
 */
export interface JwtPayload {
  sub: string;        // 用户ID
  phone?: string;     // 手机号
  userType: UserType; // 用户类型
  iat?: number;       // 签发时间
  exp?: number;       // 过期时间
}

/**
 * 登录响应
 */
export interface LoginResponse {
  success: boolean;
  data?: {
    token: string;
    refreshToken: string;
    expiresIn: number;
    user: {
      id: string;
      phone?: string;
      name?: string;
      avatar?: string;
      isVerified: boolean;
      userType: UserType;
      // 老人端专用：子女信息
      childName?: string;
      childPhone?: string;
    };
  };
  message?: string;
}
