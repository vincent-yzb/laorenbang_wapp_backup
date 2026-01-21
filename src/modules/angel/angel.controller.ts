import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AngelService } from './angel.service';

@ApiTags('天使')
@Controller('angel')
export class AngelController {
  constructor(private angelService: AngelService) {}

  @Post('apply')
  @ApiOperation({ summary: '天使入驻申请' })
  @ApiResponse({ status: 200, description: '申请成功' })
  async apply(
    @Body() body: {
      phone: string;
      name: string;
      idCard: string;
      idCardFront: string;
      idCardBack: string;
      avatar?: string;
    },
  ) {
    return this.angelService.apply(body.phone, body);
  }

  @Get('apply/status')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取申请状态' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getApplyStatus(@Request() req) {
    return this.angelService.getApplyStatus(req.user.id);
  }

  @Get('profile')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取天使信息' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getProfile(@Request() req) {
    return this.angelService.getProfile(req.user.id);
  }

  @Put('profile')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '更新天使信息' })
  @ApiResponse({ status: 200, description: '更新成功' })
  async updateProfile(
    @Request() req,
    @Body() body: { name?: string; avatar?: string },
  ) {
    return this.angelService.updateProfile(req.user.id, body);
  }

  @Post('toggle-online')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '切换在线状态' })
  @ApiResponse({ status: 200, description: '操作成功' })
  async toggleOnline(@Request() req, @Body() body: { isOnline: boolean }) {
    return this.angelService.toggleOnline(req.user.id, body.isOnline);
  }

  @Get('order-stats')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取订单统计' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getOrderStats(@Request() req) {
    return this.angelService.getOrderStats(req.user.id);
  }

  @Get('reviews')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取评价列表' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getReviews(
    @Request() req,
    @Query('page') page = 1,
    @Query('pageSize') pageSize = 10,
  ) {
    return this.angelService.getReviews(req.user.id, +page, +pageSize);
  }
}
