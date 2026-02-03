import { Module } from '@nestjs/common';
import { AdbService } from './adb.service';
import { AdbController } from './adb.controller';
import { LogsModule } from '../logs/logs.module';
import { ApkModule } from '../apk/apk.module';

@Module({
  imports: [LogsModule, ApkModule],
  providers: [AdbService],
  controllers: [AdbController]
})
export class AdbModule { }
