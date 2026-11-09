import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthRequest } from '../auth/auth.guard';
import { CountService } from './count.service';

@Controller('spaces/:spaceId/warehouses/:warehouseId/count-orders')
@UseGuards(AuthGuard)
export class CountController {
  constructor(@Inject(CountService) private readonly service: CountService) {}

  @Get()
  list(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string) {
    return this.service.list(this.service.scope(req.identity.userId, spaceId, warehouseId));
  }

  @Post()
  create(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string, @Body() body: unknown) {
    return this.service.create(this.service.scope(req.identity.userId, spaceId, warehouseId), body);
  }

  @Post(':orderId/:action')
  phase(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string,
    @Param('orderId') orderId: string, @Param('action') action: string, @Body() body: unknown) {
    if (action !== 'submit' && action !== 'approve' && action !== 'reject') throw new NotFoundException('未知盘点操作');
    return this.service.phase(this.service.scope(req.identity.userId, spaceId, warehouseId), orderId, action, body);
  }
}
