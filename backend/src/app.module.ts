import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdbModule } from './adb/adb.module';
import { LogsGateway } from './logs/logs.gateway';

@Module({
  imports: [AdbModule],
  controllers: [AppController],
  providers: [AppService, LogsGateway],
})
export class AppModule {}
