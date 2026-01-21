import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import {
  SendCodeDto,
  PhoneLoginDto,
  WechatLoginDto,
  ElderlyLoginDto,
  RefreshTokenDto,
} from './dto/auth.dto';

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('send-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '发送短信验证码' })
  @ApiResponse({ status: 200, description: '验证码发送成功' })
  async sendCode(@Body() dto: SendCodeDto) {
    return this.authService.sendCode(dto);
  }

  @Post('phone-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '手机号验证码登录' })
  @ApiResponse({ status: 200, description: '登录成功' })
  async phoneLogin(@Body() dto: PhoneLoginDto) {
    return this.authService.phoneLogin(dto);
  }

  @Post('wechat-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '微信登录' })
  @ApiResponse({ status: 200, description: '登录成功' })
  async wechatLogin(@Body() dto: WechatLoginDto) {
    return this.authService.wechatLogin(dto);
  }

  @Post('elderly-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '老人邀请码登录' })
  @ApiResponse({ status: 200, description: '登录成功' })
  async elderlyLogin(@Body() dto: ElderlyLoginDto) {
    return this.authService.elderlyLogin(dto);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '刷新 Token' })
  @ApiResponse({ status: 200, description: '刷新成功' })
  async refreshToken(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto.refreshToken);
  }
}
