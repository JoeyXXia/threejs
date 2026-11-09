CREATE TYPE "CountStatus" AS ENUM ('OPEN', 'SUBMITTED', 'APPROVED', 'REJECTED');
CREATE TABLE "CountOrder" (
  id UUID PRIMARY KEY,
  "spaceId" UUID NOT NULL,
  "warehouseId" UUID NOT NULL,
  "locationId" UUID NOT NULL,
  "layoutId" UUID NOT NULL,
  status "CountStatus" NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submissionNote" TEXT,
  FOREIGN KEY ("spaceId", "warehouseId", "locationId") REFERENCES "Location"("spaceId", "warehouseId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("spaceId", "warehouseId", "layoutId") REFERENCES "LayoutVersion"("spaceId", "warehouseId", id) ON DELETE RESTRICT,
  CONSTRAINT count_submission_required CHECK (status NOT IN ('SUBMITTED', 'APPROVED') OR "submissionNote" IS NOT NULL)
);
CREATE INDEX "CountOrder_spaceId_warehouseId_createdAt_idx" ON "CountOrder"("spaceId", "warehouseId", "createdAt");
CREATE UNIQUE INDEX count_one_active_per_location ON "CountOrder"("locationId") WHERE status IN ('OPEN', 'SUBMITTED');
CREATE TABLE "CountLine" (
  "countId" UUID NOT NULL REFERENCES "CountOrder"(id) ON DELETE RESTRICT,
  "balanceId" UUID NOT NULL,
  "skuId" UUID NOT NULL,
  "batchId" UUID NOT NULL,
  "skuCode" TEXT NOT NULL,
  "batchCode" TEXT NOT NULL,
  quality "Quality" NOT NULL,
  expected INTEGER NOT NULL CHECK (expected >= 0),
  "balanceVersion" INTEGER NOT NULL CHECK ("balanceVersion" >= 0),
  actual INTEGER CHECK (actual >= 0),
  PRIMARY KEY ("countId", "balanceId")
);

ALTER TABLE "InventoryMovement" DROP CONSTRAINT movement_endpoints;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT movement_endpoints CHECK (
  (kind IN ('OPENING', 'RECEIPT') AND "sourceLocationId" IS NULL AND "sourceQuality" IS NULL
    AND "destinationLocationId" IS NOT NULL AND "destinationQuality" IS NOT NULL)
  OR (kind = 'TRANSFER' AND "sourceLocationId" IS NOT NULL AND "sourceQuality" IS NOT NULL
    AND "destinationLocationId" IS NOT NULL AND "destinationQuality" IS NOT NULL
    AND ("sourceLocationId" <> "destinationLocationId" OR "sourceQuality" <> "destinationQuality"))
  OR (kind = 'DISPATCH' AND "sourceLocationId" IS NOT NULL AND "sourceQuality" IS NOT DISTINCT FROM 'RELEASED'::"Quality"
    AND "destinationLocationId" IS NULL AND "destinationQuality" IS NULL)
  OR (kind = 'COUNT_ADJUSTMENT' AND (
    ("sourceLocationId" IS NULL AND "sourceQuality" IS NULL AND "destinationLocationId" IS NOT NULL AND "destinationQuality" IS NOT NULL)
    OR ("sourceLocationId" IS NOT NULL AND "sourceQuality" IS NOT NULL AND "destinationLocationId" IS NULL AND "destinationQuality" IS NULL)
  ))
);

CREATE FUNCTION count_location_frozen(target UUID) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "CountOrder" WHERE "locationId" = target AND status IN ('OPEN', 'SUBMITTED'))
$$;

CREATE FUNCTION guard_frozen_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_location UUID; next_location UUID; prior_warehouse UUID; next_warehouse UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    prior_location := OLD."locationId";
    prior_warehouse := OLD."warehouseId";
  END IF;
  IF TG_OP <> 'DELETE' THEN
    next_location := NEW."locationId";
    next_warehouse := NEW."warehouseId";
  END IF;
  PERFORM 1 FROM "Warehouse" WHERE id IN (prior_warehouse, next_warehouse) ORDER BY id FOR UPDATE;
  IF count_location_frozen(prior_location) OR count_location_frozen(next_location) THEN
    RAISE EXCEPTION 'Inventory location is frozen for counting' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER balance_freeze_guard BEFORE INSERT OR UPDATE OR DELETE ON "InventoryBalance"
  FOR EACH ROW EXECUTE FUNCTION guard_frozen_balance();

CREATE FUNCTION guard_frozen_transport_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "Warehouse" WHERE id = NEW."warehouseId" FOR UPDATE;
  IF count_location_frozen(NEW."stagingLocationId") THEN
    RAISE EXCEPTION 'Transport target is frozen for counting' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transport_task_freeze_guard BEFORE INSERT ON "TransportTask"
  FOR EACH ROW EXECUTE FUNCTION guard_frozen_transport_target();
