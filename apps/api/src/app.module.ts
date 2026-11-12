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
import { WmsController } from './wms.controller';
import { SimulationService } from './simulation/simulation.service';
import { SimulationController } from './simulation/simulation.controller';

@Module({
  controllers: [HealthController, AuthController, WarehouseController, InventoryController, InboundController, OutboundController, CountController, WmsController, SimulationController],
  providers: [DatabaseService, AuthService, AuthGuard, InboundService, OutboundService, TransportService, CountService, SimulationService],
})
export class AppModule {}
