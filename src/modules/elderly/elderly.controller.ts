import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { ElderlyService } from './elderly.service';

@ApiTags('老人管理')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('elderly')
export class ElderlyController {
  constructor(private elderlyService: ElderlyService) {}

  @Post()
  @ApiOperation({ summary: '添加老人' })
  @ApiResponse({ status: 201, description: '添加成功' })
  async create(
    @Request() req,
    @Body() body: {
      name: string;
      phone: string;
      relation: string;
      address: string;
      lat?: number;
      lng?: number;
      avatar?: string;
      healthNote?: string;
      angelNote?: string;
    },
  ) {
    return this.elderlyService.create(req.user.id, body);
  }

  @Get()
  @ApiOperation({ summary: '获取老人列表' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async list(@Request() req) {
    return this.elderlyService.list(req.user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: '获取老人详情' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getDetail(@Request() req, @Param('id') id: string) {
    return this.elderlyService.getDetail(id, req.user.id);
  }

  @Put(':id')
  @ApiOperation({ summary: '更新老人信息' })
  @ApiResponse({ status: 200, description: '更新成功' })
  async update(
    @Request() req,
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      phone?: string;
      relation?: string;
      address?: string;
      lat?: number;
      lng?: number;
      avatar?: string;
      healthNote?: string;
      angelNote?: string;
    },
  ) {
    return this.elderlyService.update(id, req.user.id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除老人' })
  @ApiResponse({ status: 200, description: '删除成功' })
  async delete(@Request() req, @Param('id') id: string) {
    return this.elderlyService.delete(id, req.user.id);
  }

  @Post(':id/refresh-invite-code')
  @ApiOperation({ summary: '刷新邀请码' })
  @ApiResponse({ status: 200, description: '刷新成功' })
  async refreshInviteCode(@Request() req, @Param('id') id: string) {
    return this.elderlyService.refreshInviteCode(id, req.user.id);
  }
}
