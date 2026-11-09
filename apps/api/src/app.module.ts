import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DatabaseService } from './database.service';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './auth/auth.guard';
import { AuthController } from './auth/auth.controller';
import { WarehouseController } from './warehouse.controller';
import { InventoryController } from './inventory.controller';
import { InboundController } from './inbound/inbound.controller';
import { InboundService } from './inbound/inbound.service';
import { OutboundController } from './outbound/outbound.controller';
import { OutboundService } from './outbound/outbound.service';
import { TransportService } from './transport/transport.service';
import { CountController } from './count/count.controller';
import { CountService } from './count/count.service';

@Module({
  controllers: [HealthController, AuthController, WarehouseController, InventoryController, InboundController, OutboundController, CountController],
  providers: [DatabaseService, AuthService, AuthGuard, InboundService, OutboundService, TransportService, CountService],
})
export class AppModule {}
