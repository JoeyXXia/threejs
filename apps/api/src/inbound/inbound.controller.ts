import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthRequest } from '../auth/auth.guard';
import { InboundService } from './inbound.service';

@Controller('spaces/:spaceId/warehouses/:warehouseId/inbound-orders')
@UseGuards(AuthGuard)
export class InboundController {
  constructor(@Inject(InboundService) private readonly service: InboundService) {}
  @Get()
  list(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string) {
    return this.service.list(this.service.scope(req.identity.userId, spaceId, warehouseId));
  }
  @Post()
  create(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string, @Body() body: unknown) {
    return this.service.create(this.service.scope(req.identity.userId, spaceId, warehouseId), body);
  }
  @Post(':orderId/receive')
  receive(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string, @Param('orderId') orderId: string, @Body() body: unknown) {
    return this.service.phase(this.service.scope(req.identity.userId, spaceId, warehouseId), orderId, 'receive', body);
  }
  @Post(':orderId/inspect')
  inspect(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string, @Param('orderId') orderId: string, @Body() body: unknown) {
    return this.service.phase(this.service.scope(req.identity.userId, spaceId, warehouseId), orderId, 'inspect', body);
  }
}
