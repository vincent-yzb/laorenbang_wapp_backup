import { AuthModule } from '../auth/auth.module';
import { Module } from '@nestjs/common';
import { ElderlyController } from './elderly.controller';
import { ElderlyService } from './elderly.service';

@Module({
  imports: [AuthModule],
  controllers: [ElderlyController],
  providers: [ElderlyService],
  exports: [ElderlyService],
})
export class ElderlyModule {}
