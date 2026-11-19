import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, type AuthRequest } from '../auth/auth.guard';
import { FleetService } from './fleet.service';

@Controller('spaces/:spaceId/warehouses/:warehouseId/fleet')
@UseGuards(AuthGuard)
export class FleetController {
  constructor(@Inject(FleetService) private readonly fleet: FleetService) {}
  @Get()
  read(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string) {
    return this.fleet.read({ actorId: req.identity.userId, spaceId, warehouseId });
  }
  @Post('initialize')
  initialize(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string, @Body() body: unknown) {
    return this.fleet.initialize({ actorId: req.identity.userId, spaceId, warehouseId }, body);
  }
  @Post('assign')
  assign(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string, @Body() body: unknown) {
    return this.fleet.assign({ actorId: req.identity.userId, spaceId, warehouseId }, body);
  }
  @Post('resources')
  configure(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string, @Body() body: unknown) {
    return this.fleet.configure({ actorId: req.identity.userId, spaceId, warehouseId }, body);
  }
  @Post('navigation')
  changeMap(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string, @Body() body: unknown) {
    return this.fleet.changeMap({ actorId: req.identity.userId, spaceId, warehouseId }, body);
  }
  @Post('control')
  control(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string, @Body() body: unknown) {
    return this.fleet.control({ actorId: req.identity.userId, spaceId, warehouseId }, body);
  }
}
