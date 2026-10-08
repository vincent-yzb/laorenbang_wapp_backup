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
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { PaymentService } from './payment.service';
import { CreatePaymentDto, RefundDto, WithdrawDto, RejectFundsDto } from './dto/payment.dto';
import { FundsService } from './funds.service';
import { WechatPayGateway } from './wechat-pay.gateway';
import { PaymentOperatorGuard } from './payment-operator.guard';

@ApiTags('支付')
@Controller('payment')
export class PaymentController {
  constructor(private paymentService: PaymentService, @Optional() private funds?: FundsService, @Optional() private gateway?: WechatPayGateway) {}

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
    @Request() req: any,
  ) {
    return this.paymentService.handleWechatCallback(req.rawBody, req.headers);
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

  @Post('refund-notify')
  @HttpCode(HttpStatus.OK)
  async refundNotify(@Request() req: any) {
    const event = this.getGateway().verifyNotification(req.rawBody, req.headers);
    await this.getFunds().handleRefundNotification(event);
    return { code: 'SUCCESS', message: '成功' };
  }

  @Post('transfer-notify')
  @HttpCode(HttpStatus.OK)
  async transferNotify(@Request() req: any) {
    const event = this.getGateway().verifyNotification(req.rawBody, req.headers);
    await this.getFunds().handleTransferNotification(event);
    return { code: 'SUCCESS', message: '成功' };
  }

  @Get('refunds')
  @UseGuards(AuthGuard('jwt'))
  async refunds(@Request() req: any, @Query('orderId') orderId?: string) {
    this.requireRole(req, 'child');
    return this.getFunds().listRefunds(req.user.id, orderId);
  }

  @Get('refund/:id')
  @UseGuards(AuthGuard('jwt'))
  async refundStatus(@Request() req: any, @Param('id') id: string) {
    this.requireRole(req, 'child');
    return this.getFunds().getRefundStatus(req.user.id, id, { reconcile: true });
  }

  @Get('withdrawals')
  @UseGuards(AuthGuard('jwt'))
  async withdrawals(@Request() req: any) {
    this.requireRole(req, 'angel');
    return this.getFunds().listWithdrawals(req.user.id);
  }

  @Get('withdraw/:id')
  @UseGuards(AuthGuard('jwt'))
  async withdrawalStatus(@Request() req: any, @Param('id') id: string) {
    this.requireRole(req, 'angel');
    return this.getFunds().getWithdrawalStatus(req.user.id, id, { reconcile: true });
  }

  @Post('operator/refunds/:id/approve')
  @UseGuards(PaymentOperatorGuard)
  async approveRefund(@Request() req: any, @Param('id') id: string) {
    return this.getFunds().approveRefund(id, req.paymentOperator);
  }

  @Post('operator/refunds/:id/reject')
  @UseGuards(PaymentOperatorGuard)
  async rejectRefund(@Request() req: any, @Param('id') id: string, @Body() dto: RejectFundsDto) {
    return this.getFunds().rejectRefund(id, req.paymentOperator, dto.reason);
  }

  @Post('operator/withdrawals/:id/approve')
  @UseGuards(PaymentOperatorGuard)
  async approveWithdrawal(@Request() req: any, @Param('id') id: string) {
    return this.getFunds().approveWithdrawal(id, req.paymentOperator);
  }

  @Post('operator/withdrawals/:id/reject')
  @UseGuards(PaymentOperatorGuard)
  async rejectWithdrawal(@Request() req: any, @Param('id') id: string, @Body() dto: RejectFundsDto) {
    return this.getFunds().rejectWithdrawal(id, req.paymentOperator, dto.reason);
  }

  @Post('operator/reconcile')
  @UseGuards(PaymentOperatorGuard)
  async reconcile() {
    await this.paymentService.reconcilePending(100);
    return { success: true, message: '本轮待核实资金记录已查询' };
  }

  @Get('operator/configuration')
  @UseGuards(PaymentOperatorGuard)
  configuration() {
    return { success: true, data: { ...this.getGateway().configurationStatus(), transferEnabled: this.getGateway().transferIsConfigured() } };
  }

  private getFunds() { if (!this.funds) throw new ServiceUnavailableException('资金服务尚未配置'); return this.funds; }
  private getGateway() { if (!this.gateway) throw new ServiceUnavailableException('微信支付尚未配置'); return this.gateway; }

  private requireRole(req: any, role: 'child' | 'angel'): void {
    if (req.user?.userType !== role) throw new ForbiddenException('无权执行此操作');
  }
}
