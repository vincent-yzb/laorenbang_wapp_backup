import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { CacheModule } from './cache/cache.module';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { ElderlyModule } from './modules/elderly/elderly.module';
import { OrderModule } from './modules/order/order.module';
import { AngelModule } from './modules/angel/angel.module';
import { PaymentModule } from './modules/payment/payment.module';
import { MessageModule } from './modules/message/message.module';
import { LocationModule } from './modules/location/location.module';

@Module({
  imports: [
    // 全局模块
    ConfigModule,
    PrismaModule,
    CacheModule,
    
    // 业务模块
    AuthModule,
    UserModule,
    ElderlyModule,
    OrderModule,
    AngelModule,
    PaymentModule,
    MessageModule,
    LocationModule,
  ],
})
export class AppModule {}
