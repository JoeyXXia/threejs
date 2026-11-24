import { Controller, Get, Inject, NotFoundException, Param, Req, UseGuards } from '@nestjs/common';
import { Prisma } from '@warehouse-twin/database';
import { AuthGuard, AuthRequest } from './auth/auth.guard';
import { uuidInput } from './auth/input';
import { DatabaseService } from './database.service';
import { FleetService } from './simulation/fleet.service';
import { SimulationService } from './simulation/simulation.service';
import { AuthService } from './auth/auth.service';
import type { LayoutResponse, InventoryResponse, RealtimeSnapshot } from '@warehouse-twin/contracts';

function physicalKind(kind: LayoutResponse['locations'][number]['kind'] | 'TRANSIT') {
  if (kind === 'TRANSIT') throw new Error('Transit cannot be placed on the physical layout');
  return kind;
}

@Controller('spaces/:spaceId/warehouses/:warehouseId')
@UseGuards(AuthGuard)
export class InventoryController {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(FleetService) private readonly fleet: FleetService,
    @Inject(SimulationService) private readonly simulation: SimulationService,
    @Inject(AuthService) private readonly auth: AuthService) {}

  private async snapshot<T>(req: AuthRequest, spaceId: string, warehouseId: string,
    read: (tx: Prisma.TransactionClient, layoutId: string, actorId: string) => Promise<T>, recheckSession = false) {
    uuidInput(spaceId); uuidInput(warehouseId);
    return this.db.$transaction(async (tx) => {
      const identity = recheckSession ? await this.auth.identity(req.headers.cookie, tx) : req.identity;
      const access = await tx.warehouseAccess.findUnique({
        where: { userId_spaceId_warehouseId: { userId: identity.userId, spaceId, warehouseId } },
        include: { warehouse: true },
      });
      if (!access) throw new NotFoundException('Warehouse not found');
      if (!access.warehouse.activeLayoutId) throw new NotFoundException('Layout not configured');
      return read(tx, access.warehouse.activeLayoutId, identity.userId);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  @Get('layout')
  layout(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string) {
    return this.snapshot(req, spaceId, warehouseId, (tx, layoutId) => this.readLayout(tx, spaceId, warehouseId, layoutId));
  }

  private async readLayout(tx: Prisma.TransactionClient, spaceId: string, warehouseId: string, layoutId: string): Promise<LayoutResponse> {
    const layout = await tx.layoutVersion.findUniqueOrThrow({ where: { id: layoutId } });
    const zones = await tx.layoutZone.findMany({ where: { layoutId }, orderBy: { code: 'asc' } });
    const racks = await tx.rack.findMany({ where: { layoutId }, orderBy: { code: 'asc' } });
    const placements = await tx.layoutLocation.findMany({ where: { layoutId }, include: { location: true }, orderBy: { location: { code: 'asc' } } });
    const blockedCells = racks.flatMap((rack) => Array.from({ length: rack.sizeX * rack.sizeZ }, (_, i) => ({
      x: rack.gridX + i % rack.sizeX, z: rack.gridZ + Math.floor(i / rack.sizeX),
    })));
    return {
      spaceId, warehouseId,
      layoutVersion: { id: layout.id, version: layout.version, width: layout.width, depth: layout.depth,
        cellSize: layout.cellSize, origin: { x: layout.originX, z: layout.originZ } },
      zones: zones.map((zone) => ({ id: zone.id, code: zone.code, kind: physicalKind(zone.kind),
        gridX: zone.gridX, gridZ: zone.gridZ, sizeX: zone.sizeX, sizeZ: zone.sizeZ })),
      racks: racks.map((rack) => ({ id: rack.id, code: rack.code, zoneId: rack.zoneId, gridX: rack.gridX,
        gridZ: rack.gridZ, sizeX: rack.sizeX, sizeZ: rack.sizeZ, levels: rack.levels, levelHeight: rack.levelHeight })),
      locations: placements.map((placement) => ({ id: placement.locationId, code: placement.location.code,
        kind: physicalKind(placement.location.kind), zoneId: placement.zoneId, rackId: placement.rackId,
        grid: { x: placement.gridX, z: placement.gridZ, level: placement.level }, capacity: placement.capacity,
        serviceCell: { x: placement.serviceX, z: placement.serviceZ } })),
      blockedCells,
    } satisfies LayoutResponse;
  }

  @Get('inventory')
  inventory(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string) {
    return this.snapshot(req, spaceId, warehouseId, (tx, layoutId) => this.readInventory(tx, spaceId, warehouseId, layoutId));
  }

  private async readInventory(tx: Prisma.TransactionClient, spaceId: string, warehouseId: string, layoutId: string): Promise<InventoryResponse> {
    const asOf = new Date();
    const layout = await tx.layoutVersion.findUniqueOrThrow({ where: { id: layoutId } });
    const rows = await tx.inventoryBalance.findMany({
      where: { spaceId, warehouseId }, include: { batch: { include: { sku: true } }, location: true }, orderBy: { id: 'asc' },
    });
    const placements = await tx.layoutLocation.findMany({ where: { layoutId }, include: { location: true }, orderBy: { location: { code: 'asc' } } });
    const placed = new Set(placements.map((placement) => placement.locationId));
    const balances = rows.filter((row) => row.onHand > 0 || placed.has(row.locationId)).map<InventoryResponse['balances'][number]>((balance) => {
      const unit = balance.batch.sku.unit;
      if (unit !== 'piece') throw new Error('Unsupported inventory unit');
      return {
      id: balance.id, locationId: balance.locationId, quality: balance.quality, onHand: balance.onHand,
        ...(balance.location.kind === 'TRANSIT' ? { transit: true as const } : {}),
      reserved: balance.reserved, version: balance.version,
      available: balance.quality === 'RELEASED' && (!balance.batch.expiresAt || balance.batch.expiresAt > asOf)
        ? balance.onHand - balance.reserved : 0,
      sku: { id: balance.skuId, code: balance.batch.sku.code, name: balance.batch.sku.name, unit },
      batch: { id: balance.batchId, code: balance.batch.code, expiresAt: balance.batch.expiresAt?.toISOString() ?? null },
    }; });
    const locationTotals = placements.map((placement) => {
      const stock = balances.filter((balance) => balance.locationId === placement.locationId);
      return { locationId: placement.locationId, code: placement.location.code, capacity: placement.capacity,
        onHand: stock.reduce((sum, balance) => sum + balance.onHand, 0),
        reserved: stock.reduce((sum, balance) => sum + balance.reserved, 0),
        available: stock.reduce((sum, balance) => sum + balance.available, 0) };
    });
    const watermark = (await tx.warehouseRuntime.findUnique({ where: { warehouseId }, select: { seq: true } }))?.seq ?? 0;
    return { spaceId, warehouseId, watermark, layoutId, layoutVersion: layout.version, asOf: asOf.toISOString(), balances, locationTotals,
      summary: { onHand: balances.reduce((sum, row) => sum + row.onHand, 0), reserved: balances.reduce((sum, row) => sum + row.reserved, 0),
        available: balances.reduce((sum, row) => sum + row.available, 0), hold: balances.filter((row) => row.quality === 'HOLD').reduce((sum, row) => sum + row.onHand, 0) } } satisfies InventoryResponse;
  }

  @Get('snapshot')
  consistent(@Req() req: AuthRequest, @Param('spaceId') spaceId: string, @Param('warehouseId') warehouseId: string): Promise<RealtimeSnapshot> {
    return this.snapshot(req, spaceId, warehouseId, async (tx, layoutId, actorId) => {
      const scope = { actorId, spaceId, warehouseId };
      const layout = await this.readLayout(tx, spaceId, warehouseId, layoutId);
      const inventory = await this.readInventory(tx, spaceId, warehouseId, layoutId);
      const fleet = await this.fleet.readInTransaction(tx, scope);
      const simulation = await this.simulation.readInTransaction(tx, scope);
      return { layout, inventory, fleet, simulation, watermark: inventory.watermark };
    }, true);
  }
}
