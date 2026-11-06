CREATE TYPE "OutboundStatus" AS ENUM ('CREATED', 'ALLOCATED');
CREATE UNIQUE INDEX "balance_allocation_scope_key" ON "InventoryBalance"("spaceId","warehouseId","locationId","skuId","batchId",quality,id);
CREATE TABLE "OutboundOrder" (
  id UUID PRIMARY KEY, "spaceId" UUID NOT NULL, "warehouseId" UUID NOT NULL,
  "skuId" UUID NOT NULL, "batchId" UUID NOT NULL, quantity INTEGER NOT NULL,
  status "OutboundStatus" NOT NULL DEFAULT 'CREATED', version INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL, "allocationReason" TEXT, "createdById" UUID NOT NULL, "allocatedById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "allocatedAt" TIMESTAMP(3),
  CONSTRAINT outbound_quantities CHECK (quantity > 0 AND version >= 0),
  CONSTRAINT outbound_phase_fields CHECK (
    (status='CREATED' AND "allocatedById" IS NULL AND "allocatedAt" IS NULL AND "allocationReason" IS NULL)
    OR (status='ALLOCATED' AND "allocatedById" IS NOT NULL AND "allocatedAt" IS NOT NULL AND "allocationReason" IS NOT NULL)
  ),
  FOREIGN KEY ("spaceId","warehouseId") REFERENCES "Warehouse"("spaceId",id) ON DELETE RESTRICT,
  FOREIGN KEY ("spaceId","warehouseId","skuId","batchId") REFERENCES "Batch"("spaceId","warehouseId","skuId",id) ON DELETE RESTRICT,
  FOREIGN KEY ("createdById") REFERENCES "User"(id) ON DELETE RESTRICT,
  FOREIGN KEY ("allocatedById") REFERENCES "User"(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX outbound_allocation_scope_key ON "OutboundOrder"("spaceId","warehouseId","skuId","batchId",id);
CREATE INDEX "OutboundOrder_spaceId_warehouseId_createdAt_idx" ON "OutboundOrder"("spaceId","warehouseId","createdAt");
CREATE TABLE "Allocation" (
  id UUID PRIMARY KEY, "spaceId" UUID NOT NULL, "warehouseId" UUID NOT NULL, "orderId" UUID NOT NULL,
  "balanceId" UUID NOT NULL, "locationId" UUID NOT NULL, "skuId" UUID NOT NULL, "batchId" UUID NOT NULL,
  quality "Quality" NOT NULL DEFAULT 'RELEASED', quantity INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT allocation_quantity_quality CHECK (quantity > 0 AND quality='RELEASED'),
  FOREIGN KEY ("spaceId","warehouseId","skuId","batchId","orderId") REFERENCES "OutboundOrder"("spaceId","warehouseId","skuId","batchId",id) ON DELETE RESTRICT,
  FOREIGN KEY ("spaceId","warehouseId","locationId","skuId","batchId",quality,"balanceId")
    REFERENCES "InventoryBalance"("spaceId","warehouseId","locationId","skuId","batchId",quality,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "Allocation_orderId_balanceId_key" ON "Allocation"("orderId","balanceId");
CREATE INDEX "Allocation_balanceId_idx" ON "Allocation"("balanceId");
