import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { UserService } from './user.service';

@ApiTags('用户')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('user')
export class UserController {
  constructor(private userService: UserService) {}

  @Get('profile')
  @ApiOperation({ summary: '获取用户信息' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getProfile(@Request() req) {
    return this.userService.getProfile(req.user.id);
  }

  @Put('profile')
  @ApiOperation({ summary: '更新用户信息' })
  @ApiResponse({ status: 200, description: '更新成功' })
  async updateProfile(
    @Request() req,
    @Body() body: { name?: string; avatar?: string },
  ) {
    return this.userService.updateProfile(req.user.id, body);
  }

  @Post('verify')
  @ApiOperation({ summary: '实名认证' })
  @ApiResponse({ status: 200, description: '认证成功' })
  async verifyIdentity(
    @Request() req,
    @Body() body: {
      name: string;
      idCard: string;
      idCardFront?: string;
      idCardBack?: string;
    },
  ) {
    return this.userService.verifyIdentity(req.user.id, body);
  }

  @Get('order-stats')
  @ApiOperation({ summary: '获取订单统计' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getOrderStats(@Request() req) {
    return this.userService.getOrderStats(req.user.id);
  }
}
