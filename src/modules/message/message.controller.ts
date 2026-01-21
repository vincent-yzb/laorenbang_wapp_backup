import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { MessageService } from './message.service';

@ApiTags('消息')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('messages')
export class MessageController {
  constructor(private messageService: MessageService) {}

  @Get()
  @ApiOperation({ summary: '获取消息列表' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getMessages(
    @Request() req,
    @Query('page') page = 1,
    @Query('pageSize') pageSize = 20,
  ) {
    return this.messageService.getMessages(req.user.id, req.user.userType, +page, +pageSize);
  }

  @Get('unread-count')
  @ApiOperation({ summary: '获取未读消息数' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getUnreadCount(@Request() req) {
    return this.messageService.getUnreadCount(req.user.id, req.user.userType);
  }

  @Post(':id/read')
  @ApiOperation({ summary: '标记消息已读' })
  @ApiResponse({ status: 200, description: '操作成功' })
  async markAsRead(@Request() req, @Param('id') id: string) {
    return this.messageService.markAsRead(id, req.user.id);
  }

  @Get('order/:orderId')
  @ApiOperation({ summary: '获取订单消息' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getOrderMessages(
    @Request() req,
    @Param('orderId') orderId: string,
    @Query('lastId') lastId?: string,
  ) {
    return this.messageService.getOrderMessages(orderId, req.user.id, lastId);
  }

  @Post('order/:orderId')
  @ApiOperation({ summary: '发送订单消息' })
  @ApiResponse({ status: 200, description: '发送成功' })
  async sendOrderMessage(
    @Request() req,
    @Param('orderId') orderId: string,
    @Body() body: { content: string; messageType?: 'text' | 'image' },
  ) {
    return this.messageService.sendOrderMessage({
      orderId,
      senderId: req.user.id,
      senderType: req.user.userType,
      content: body.content,
      messageType: body.messageType,
    });
  }
}

