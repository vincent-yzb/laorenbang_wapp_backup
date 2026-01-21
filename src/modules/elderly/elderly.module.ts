import { Module } from '@nestjs/common';
import { ElderlyController } from './elderly.controller';
import { ElderlyService } from './elderly.service';

@Module({
  controllers: [ElderlyController],
  providers: [ElderlyService],
  exports: [ElderlyService],
})
export class ElderlyModule {}
