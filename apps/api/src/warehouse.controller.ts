import { Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Patch, Req, UseGuards, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from './database.service';
import { AuthGuard, AuthRequest } from './auth/auth.guard';
import { objectInput, textInput, uuidInput } from './auth/input';

@Controller('spaces/:spaceId/warehouses/:warehouseId')
@UseGuards(AuthGuard)
export class WarehouseController {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  private async access(req: AuthRequest, spaceId: string, warehouseId: string) {
    uuidInput(spaceId); uuidInput(warehouseId);
    const access = await this.db.warehouseAccess.findUnique({
      where: { userId_spaceId_warehouseId: { userId: req.identity.userId, spaceId, warehouseId } },
      include: { warehouse: true },
    });
    if (!access) throw new NotFoundException('Warehouse not found');
    return access;
  }

  @Get()
  async get(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string) {
    const { warehouse, role } = await this.access(req, spaceId, warehouseId);
    return { id: warehouse.id, spaceId, name: warehouse.name, version: warehouse.version, role };
  }

  @Patch()
  async rename(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string, @Body() body: unknown) {
    const access = await this.access(req, spaceId, warehouseId);
    if (access.role === 'VIEWER') throw new ForbiddenException('Read only');
    const input = objectInput(body, ['name', 'version', 'reason']);
    const name = textInput(input.name, 1, 80);
    const reason = textInput(input.reason, 1, 200);
    if (!Number.isInteger(input.version) || (input.version as number) < 0) {
      throw new ConflictException('Expected warehouse version');
    }
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "userId" FROM "WarehouseAccess" WHERE "userId" = ${req.identity.userId}::uuid AND "spaceId" = ${spaceId}::uuid AND "warehouseId" = ${warehouseId}::uuid FOR SHARE`;
      // Recheck access inside the same transaction, so roles are never cached in the session.
      const currentAccess = await tx.warehouseAccess.findUnique({ where: { userId_spaceId_warehouseId: { userId: req.identity.userId, spaceId, warehouseId } } });
      if (!currentAccess) throw new NotFoundException();
      if (currentAccess.role === 'VIEWER') throw new ForbiddenException('Read only');
      const before = await tx.warehouse.findUnique({ where: { id: warehouseId } });
      const updated = await tx.warehouse.updateMany({
        where: { id: warehouseId, spaceId, version: input.version as number },
        data: { name, version: { increment: 1 } },
      });
      if (updated.count !== 1) throw new ConflictException('Warehouse changed; reload first');
      await tx.auditLog.create({ data: {
        actorId: req.identity.userId, spaceId, warehouseId, action: 'WAREHOUSE_RENAMED', reason,
        requestId: randomUUID(), before: { name: before?.name ?? '', version: input.version as number },
        after: { name, version: (input.version as number) + 1 },
      } });
      return { id: warehouseId, spaceId, name, version: (input.version as number) + 1, role: currentAccess.role };
    });
  }
}
