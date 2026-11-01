-- CreateEnum
CREATE TYPE "ZoneKind" AS ENUM ('INBOUND', 'QC', 'STORAGE', 'PICKING', 'OUTBOUND', 'CHARGING');

-- CreateEnum
CREATE TYPE "LayoutStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "Quality" AS ENUM ('HOLD', 'RELEASED');

-- CreateEnum
CREATE TYPE "MovementKind" AS ENUM ('OPENING', 'TRANSFER');

-- AlterTable
ALTER TABLE "Warehouse" ADD COLUMN     "activeLayoutId" UUID;

-- CreateTable
CREATE TABLE "LayoutVersion" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "LayoutStatus" NOT NULL DEFAULT 'DRAFT',
    "width" INTEGER NOT NULL,
    "depth" INTEGER NOT NULL,
    "cellSize" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "originX" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "originZ" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LayoutVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LayoutZone" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "layoutId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "ZoneKind" NOT NULL,
    "gridX" INTEGER NOT NULL,
    "gridZ" INTEGER NOT NULL,
    "sizeX" INTEGER NOT NULL,
    "sizeZ" INTEGER NOT NULL,

    CONSTRAINT "LayoutZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rack" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "layoutId" UUID NOT NULL,
    "zoneId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "gridX" INTEGER NOT NULL,
    "gridZ" INTEGER NOT NULL,
    "sizeX" INTEGER NOT NULL,
    "sizeZ" INTEGER NOT NULL,
    "levels" INTEGER NOT NULL,
    "levelHeight" DOUBLE PRECISION NOT NULL DEFAULT 1.5,

    CONSTRAINT "Rack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "ZoneKind" NOT NULL,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LayoutLocation" (
    "spaceId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "layoutId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "zoneId" UUID NOT NULL,
    "rackId" UUID,
    "gridX" INTEGER NOT NULL,
    "gridZ" INTEGER NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "serviceX" INTEGER NOT NULL,
    "serviceZ" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,

    CONSTRAINT "LayoutLocation_pkey" PRIMARY KEY ("layoutId","locationId")
);

-- CreateTable
CREATE TABLE "Sku" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'piece',

    CONSTRAINT "Sku_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "skuId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryBalance" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "skuId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "quality" "Quality" NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" UUID NOT NULL,
    "spaceId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "skuId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "kind" "MovementKind" NOT NULL,
    "sourceLocationId" UUID,
    "sourceQuality" "Quality",
    "destinationLocationId" UUID NOT NULL,
    "destinationQuality" "Quality" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "businessKey" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LayoutVersion_spaceId_warehouseId_id_key" ON "LayoutVersion"("spaceId", "warehouseId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LayoutVersion_spaceId_warehouseId_version_key" ON "LayoutVersion"("spaceId", "warehouseId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "LayoutZone_spaceId_warehouseId_layoutId_id_key" ON "LayoutZone"("spaceId", "warehouseId", "layoutId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LayoutZone_layoutId_code_key" ON "LayoutZone"("layoutId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Rack_spaceId_warehouseId_layoutId_id_key" ON "Rack"("spaceId", "warehouseId", "layoutId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Rack_layoutId_code_key" ON "Rack"("layoutId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Location_spaceId_warehouseId_id_key" ON "Location"("spaceId", "warehouseId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Location_spaceId_warehouseId_code_key" ON "Location"("spaceId", "warehouseId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "LayoutLocation_layoutId_gridX_gridZ_level_key" ON "LayoutLocation"("layoutId", "gridX", "gridZ", "level");

-- CreateIndex
CREATE UNIQUE INDEX "Sku_spaceId_warehouseId_id_key" ON "Sku"("spaceId", "warehouseId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Sku_spaceId_warehouseId_code_key" ON "Sku"("spaceId", "warehouseId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_spaceId_warehouseId_skuId_id_key" ON "Batch"("spaceId", "warehouseId", "skuId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_spaceId_warehouseId_skuId_code_key" ON "Batch"("spaceId", "warehouseId", "skuId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryBalance_spaceId_warehouseId_locationId_skuId_batch_key" ON "InventoryBalance"("spaceId", "warehouseId", "locationId", "skuId", "batchId", "quality");

-- CreateIndex
CREATE INDEX "InventoryMovement_spaceId_warehouseId_createdAt_idx" ON "InventoryMovement"("spaceId", "warehouseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_spaceId_warehouseId_businessKey_key" ON "InventoryMovement"("spaceId", "warehouseId", "businessKey");

-- AddForeignKey
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_spaceId_id_activeLayoutId_fkey" FOREIGN KEY ("spaceId", "id", "activeLayoutId") REFERENCES "LayoutVersion"("spaceId", "warehouseId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "LayoutVersion" ADD CONSTRAINT "LayoutVersion_spaceId_warehouseId_fkey" FOREIGN KEY ("spaceId", "warehouseId") REFERENCES "Warehouse"("spaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayoutZone" ADD CONSTRAINT "LayoutZone_spaceId_warehouseId_layoutId_fkey" FOREIGN KEY ("spaceId", "warehouseId", "layoutId") REFERENCES "LayoutVersion"("spaceId", "warehouseId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rack" ADD CONSTRAINT "Rack_spaceId_warehouseId_layoutId_fkey" FOREIGN KEY ("spaceId", "warehouseId", "layoutId") REFERENCES "LayoutVersion"("spaceId", "warehouseId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rack" ADD CONSTRAINT "Rack_spaceId_warehouseId_layoutId_zoneId_fkey" FOREIGN KEY ("spaceId", "warehouseId", "layoutId", "zoneId") REFERENCES "LayoutZone"("spaceId", "warehouseId", "layoutId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_spaceId_warehouseId_fkey" FOREIGN KEY ("spaceId", "warehouseId") REFERENCES "Warehouse"("spaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayoutLocation" ADD CONSTRAINT "LayoutLocation_spaceId_warehouseId_layoutId_fkey" FOREIGN KEY ("spaceId", "warehouseId", "layoutId") REFERENCES "LayoutVersion"("spaceId", "warehouseId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayoutLocation" ADD CONSTRAINT "LayoutLocation_spaceId_warehouseId_locationId_fkey" FOREIGN KEY ("spaceId", "warehouseId", "locationId") REFERENCES "Location"("spaceId", "warehouseId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayoutLocation" ADD CONSTRAINT "LayoutLocation_spaceId_warehouseId_layoutId_zoneId_fkey" FOREIGN KEY ("spaceId", "warehouseId", "layoutId", "zoneId") REFERENCES "LayoutZone"("spaceId", "warehouseId", "layoutId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayoutLocation" ADD CONSTRAINT "LayoutLocation_spaceId_warehouseId_layoutId_rackId_fkey" FOREIGN KEY ("spaceId", "warehouseId", "layoutId", "rackId") REFERENCES "Rack"("spaceId", "warehouseId", "layoutId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sku" ADD CONSTRAINT "Sku_spaceId_warehouseId_fkey" FOREIGN KEY ("spaceId", "warehouseId") REFERENCES "Warehouse"("spaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_spaceId_warehouseId_skuId_fkey" FOREIGN KEY ("spaceId", "warehouseId", "skuId") REFERENCES "Sku"("spaceId", "warehouseId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_spaceId_warehouseId_locationId_fkey" FOREIGN KEY ("spaceId", "warehouseId", "locationId") REFERENCES "Location"("spaceId", "warehouseId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_spaceId_warehouseId_skuId_batchId_fkey" FOREIGN KEY ("spaceId", "warehouseId", "skuId", "batchId") REFERENCES "Batch"("spaceId", "warehouseId", "skuId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_spaceId_warehouseId_skuId_batchId_fkey" FOREIGN KEY ("spaceId", "warehouseId", "skuId", "batchId") REFERENCES "Batch"("spaceId", "warehouseId", "skuId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_spaceId_warehouseId_sourceLocationId_fkey" FOREIGN KEY ("spaceId", "warehouseId", "sourceLocationId") REFERENCES "Location"("spaceId", "warehouseId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_spaceId_warehouseId_destinationLocationI_fkey" FOREIGN KEY ("spaceId", "warehouseId", "destinationLocationId") REFERENCES "Location"("spaceId", "warehouseId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
