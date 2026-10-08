import { AuthModule } from '../auth/auth.module';
import { Module } from '@nestjs/common';
import { AngelController } from './angel.controller';
import { AngelService } from './angel.service';

@Module({
  imports: [AuthModule],
  controllers: [AngelController],
  providers: [AngelService],
  exports: [AngelService],
})
export class AngelModule {}
