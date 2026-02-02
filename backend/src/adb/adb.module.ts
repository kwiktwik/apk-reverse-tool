import { Module } from '@nestjs/common';
import { AdbService } from './adb.service';
import { AdbController } from './adb.controller';
import { LogsModule } from '../logs/logs.module';

@Module({
  imports: [LogsModule],
  providers: [AdbService],
  controllers: [AdbController]
})
export class AdbModule {}
