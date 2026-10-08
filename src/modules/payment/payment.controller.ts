import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  Param,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { PaymentService } from './payment.service';
import { CreatePaymentDto, RefundDto, WithdrawDto } from './dto/payment.dto';

@ApiTags('支付')
@Controller('payment')
export class PaymentController {
  constructor(private paymentService: PaymentService) {}

  @Post('create')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建支付订单' })
  @ApiResponse({ status: 200, description: '创建成功' })
  async createPayment(@Request() req, @Body() dto: CreatePaymentDto) {
    this.requireRole(req, 'child');
    return this.paymentService.createPayment(req.user.id, dto);
  }

  @Get('status/:orderId')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '查询付款及订单完成状态' })
  async getStatus(@Request() req, @Param('orderId') orderId: string) {
    this.requireRole(req, 'child');
    return this.paymentService.getStatus(req.user.id, orderId);
  }

  @Post('notify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '微信支付回调' })
  @ApiResponse({ status: 200, description: '处理成功' })
  async wechatNotify(
    @Body() body: any,
  ) {
    return this.paymentService.handleWechatCallback(body);
  }

  @Post('refund')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '申请退款' })
  @ApiResponse({ status: 200, description: '申请成功' })
  async refund(@Request() req, @Body() dto: RefundDto) {
    this.requireRole(req, 'child');
    return this.paymentService.refund(req.user.id, dto);
  }

  @Post('withdraw')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '天使提现' })
  @ApiResponse({ status: 200, description: '申请成功' })
  async withdraw(@Request() req, @Body() dto: WithdrawDto) {
    this.requireRole(req, 'angel');
    return this.paymentService.withdraw(req.user.id, dto);
  }

  @Get('income')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取收入明细' })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getIncome(
    @Request() req,
    @Query('page') page = 1,
    @Query('pageSize') pageSize = 20,
  ) {
    this.requireRole(req, 'angel');
    return this.paymentService.getIncomeRecords(req.user.id, +page, +pageSize);
  }

  private requireRole(req: any, role: 'child' | 'angel'): void {
    if (req.user?.userType !== role) throw new ForbiddenException('无权执行此操作');
  }
}
