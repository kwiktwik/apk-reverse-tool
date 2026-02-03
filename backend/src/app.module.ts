import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdbModule } from './adb/adb.module';
import { ApkModule } from './apk/apk.module';
import { LogsGateway } from './logs/logs.gateway';

@Module({
  imports: [AdbModule, ApkModule],
  controllers: [AppController],
  providers: [AppService, LogsGateway],
})
export class AppModule { }
