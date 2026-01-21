import { Module } from '@nestjs/common';
import { AngelController } from './angel.controller';
import { AngelService } from './angel.service';

@Module({
  controllers: [AngelController],
  providers: [AngelService],
  exports: [AngelService],
})
export class AngelModule {}
