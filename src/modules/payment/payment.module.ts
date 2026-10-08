import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { FundsService } from './funds.service';
import { WechatPayGateway } from './wechat-pay.gateway';
import { PaymentOperatorGuard } from './payment-operator.guard';

@Module({
  controllers: [PaymentController],
  providers: [PaymentService, FundsService, WechatPayGateway, PaymentOperatorGuard],
  exports: [PaymentService],
})
export class PaymentModule {}
