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
import { PutawayService } from './transport/putaway.service';
import { TransportService } from './transport/transport.service';
import { CountController } from './count/count.controller';
import { CountService } from './count/count.service';
import { WmsController } from './wms.controller';
import { FleetService } from './simulation/fleet.service';
import { FleetController } from './simulation/fleet.controller';
import { SimulationService } from './simulation/simulation.service';
import { SimulationController } from './simulation/simulation.controller';
import { WarehouseGateway } from './realtime/warehouse.gateway';

@Module({
  controllers: [HealthController, AuthController, WarehouseController, InventoryController, InboundController, OutboundController, CountController, WmsController, SimulationController, FleetController],
  providers: [DatabaseService, AuthService, AuthGuard, InboundService, OutboundService, TransportService, PutawayService, CountService, SimulationService, FleetService, WarehouseGateway],
})
export class AppModule {}
