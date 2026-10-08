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
import { ApplyAngelDto, ToggleOnlineDto } from './dto/angel.dto';
import { UpdateProfileDto } from '../user/dto/user.dto';
import { BindPhoneDto, WechatPhoneDto, UserType } from '../auth/dto/auth.dto';
import { RequireUserType, UserTypeGuard } from '../auth/user-type.guard';

@ApiTags('天使')
@Controller('angel')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), UserTypeGuard)
@RequireUserType(UserType.ANGEL)
export class AngelController {
  constructor(private angelService: AngelService) {}

  @Post('apply')
  @ApiOperation({ summary: '天使入驻申请' })
  @ApiResponse({ status: 200, description: '申请成功' })
  async apply(@Request() req, @Body() body: ApplyAngelDto) {
    return this.angelService.apply(req.user.id, body);
  }

  @Get('apply/status')
  @ApiOperation({ summary: '获取申请状态' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getApplyStatus(@Request() req) {
    return this.angelService.getApplyStatus(req.user.id);
  }

  @Get('profile')
  @ApiOperation({ summary: '获取天使信息' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getProfile(@Request() req) {
    return this.angelService.getProfile(req.user.id);
  }

  @Put('profile')
  @ApiOperation({ summary: '更新天使信息' })
  @ApiResponse({ status: 200, description: '更新成功' })
  async updateProfile(
    @Request() req,
    @Body() body: UpdateProfileDto,
  ) {
    return this.angelService.updateProfile(req.user.id, body);
  }

  @Post('toggle-online')
  @ApiOperation({ summary: '切换在线状态' })
  @ApiResponse({ status: 200, description: '操作成功' })
  async toggleOnline(@Request() req, @Body() body: ToggleOnlineDto) {
    return this.angelService.toggleOnline(req.user.id, body.isOnline);
  }

  @Get('order-stats')
  @ApiOperation({ summary: '获取订单统计' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getOrderStats(@Request() req) {
    return this.angelService.getOrderStats(req.user.id);
  }

  @Get('reviews')
  @ApiOperation({ summary: '获取评价列表' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getReviews(
    @Request() req,
    @Query('page') page = 1,
    @Query('pageSize') pageSize = 10,
  ) {
    return this.angelService.getReviews(req.user.id, +page, +pageSize);
  }

  @Post('bind-phone')
  @ApiOperation({ summary: '绑定手机号（验证码方式）' })
  async bindPhone(@Request() req, @Body() body: BindPhoneDto) {
    return this.angelService.bindPhone(req.user.id, body.phone, body.code);
  }

  @Post('wechat-phone')
  @ApiOperation({ summary: '绑定手机号（微信方式）' })
  async bindWechatPhone(@Request() req, @Body() body: WechatPhoneDto) {
    return this.angelService.bindWechatPhone(req.user.id, body.code);
  }

}
