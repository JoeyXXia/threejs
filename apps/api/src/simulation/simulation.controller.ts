import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, type AuthRequest } from '../auth/auth.guard';
import { SimulationService } from './simulation.service';

@Controller('spaces/:spaceId/warehouses/:warehouseId/simulation')
@UseGuards(AuthGuard)
export class SimulationController {
  constructor(@Inject(SimulationService) private readonly service: SimulationService) {}
  @Get()
  read(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string) {
    return this.service.read({ actorId: req.identity.userId, spaceId, warehouseId });
  }
  @Post('start')
  start(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string, @Body() body: unknown) {
    return this.service.start({ actorId: req.identity.userId, spaceId, warehouseId }, body);
  }
  @Get('events')
  events(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string, @Query('after') after = '0') {
    return this.service.events({ actorId: req.identity.userId, spaceId, warehouseId }, /^\d+$/.test(after) ? Number(after) : NaN);
  }
}
