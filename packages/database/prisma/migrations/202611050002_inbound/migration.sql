CREATE TYPE "InboundStatus" AS ENUM ('CREATED', 'RECEIVED', 'PASSED', 'REJECTED');
ALTER TABLE "Batch" ADD COLUMN "producedAt" TIMESTAMP(3);
ALTER TABLE "Batch" ADD CONSTRAINT "batch_dates" CHECK
  ("producedAt" IS NULL OR "expiresAt" IS NULL OR "producedAt" < "expiresAt");
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "movement_endpoints";
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "movement_endpoints" CHECK (
  (kind IN ('OPENING', 'RECEIPT') AND "sourceLocationId" IS NULL AND "sourceQuality" IS NULL)
  OR (kind = 'TRANSFER' AND "sourceLocationId" IS NOT NULL AND "sourceQuality" IS NOT NULL
    AND ("sourceLocationId" <> "destinationLocationId" OR "sourceQuality" <> "destinationQuality"))
);
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "receipt_hold" CHECK
  (kind <> 'RECEIPT' OR "destinationQuality" = 'HOLD');
CREATE TABLE "InboundOrder" (
  id UUID PRIMARY KEY, "spaceId" UUID NOT NULL, "warehouseId" UUID NOT NULL,
  "skuId" UUID NOT NULL, "batchId" UUID NOT NULL, "qcLocationId" UUID NOT NULL,
  quantity INTEGER NOT NULL, status "InboundStatus" NOT NULL DEFAULT 'CREATED',
  version INTEGER NOT NULL DEFAULT 0, "createdById" UUID NOT NULL,
  "receivedById" UUID, "inspectedById" UUID, reason TEXT NOT NULL,
  "receiptReason" TEXT, "inspectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "receivedAt" TIMESTAMP(3), "inspectedAt" TIMESTAMP(3),
  CONSTRAINT "inbound_quantities" CHECK (quantity > 0 AND version >= 0),
  CONSTRAINT "inbound_phase_fields" CHECK (
    (status = 'CREATED' AND "receivedAt" IS NULL AND "receivedById" IS NULL AND "receiptReason" IS NULL
      AND "inspectedAt" IS NULL AND "inspectedById" IS NULL AND "inspectionReason" IS NULL)
    OR (status = 'RECEIVED' AND "receivedAt" IS NOT NULL AND "receivedById" IS NOT NULL AND "receiptReason" IS NOT NULL
      AND "inspectedAt" IS NULL AND "inspectedById" IS NULL AND "inspectionReason" IS NULL)
    OR (status IN ('PASSED','REJECTED') AND "receivedAt" IS NOT NULL AND "receivedById" IS NOT NULL AND "receiptReason" IS NOT NULL
      AND "inspectedAt" IS NOT NULL AND "inspectedById" IS NOT NULL AND "inspectionReason" IS NOT NULL)
  ),
  FOREIGN KEY ("spaceId", "warehouseId") REFERENCES "Warehouse"("spaceId",id) ON DELETE RESTRICT,
  FOREIGN KEY ("spaceId", "warehouseId", "skuId", "batchId") REFERENCES "Batch"("spaceId", "warehouseId", "skuId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("spaceId", "warehouseId", "qcLocationId") REFERENCES "Location"("spaceId", "warehouseId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("createdById") REFERENCES "User"(id) ON DELETE RESTRICT,
  FOREIGN KEY ("receivedById") REFERENCES "User"(id) ON DELETE RESTRICT,
  FOREIGN KEY ("inspectedById") REFERENCES "User"(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "InboundOrder_spaceId_warehouseId_id_key" ON "InboundOrder"("spaceId","warehouseId",id);
CREATE INDEX "InboundOrder_spaceId_warehouseId_createdAt_idx" ON "InboundOrder"("spaceId","warehouseId","createdAt");
