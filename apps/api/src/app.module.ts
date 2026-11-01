import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DatabaseService } from './database.service';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './auth/auth.guard';
import { AuthController } from './auth/auth.controller';
import { WarehouseController } from './warehouse.controller';

@Module({
  controllers: [HealthController, AuthController, WarehouseController],
  providers: [DatabaseService, AuthService, AuthGuard],
})
export class AppModule {}
