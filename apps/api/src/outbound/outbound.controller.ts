import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthRequest } from '../auth/auth.guard';
import { OutboundService } from './outbound.service';

@Controller('spaces/:spaceId/warehouses/:warehouseId/outbound-orders')
@UseGuards(AuthGuard)
export class OutboundController {
  constructor(@Inject(OutboundService) private readonly service: OutboundService) {}
  @Get()
  list(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string) {
    return this.service.list(this.service.scope(req.identity.userId, spaceId, warehouseId));
  }
  @Post()
  create(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string, @Body() body: unknown) {
    return this.service.create(this.service.scope(req.identity.userId, spaceId, warehouseId), body);
  }
  @Post(':orderId/allocate')
  allocate(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string, @Param('orderId') orderId: string, @Body() body: unknown) {
    return this.service.allocate(this.service.scope(req.identity.userId, spaceId, warehouseId), orderId, body);
  }
}
