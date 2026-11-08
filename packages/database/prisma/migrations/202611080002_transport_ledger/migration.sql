CREATE TYPE "TransportPhase" AS ENUM ('READY', 'IN_TRANSIT', 'STAGED');
CREATE UNIQUE INDEX allocation_task_scope_key ON "Allocation"("spaceId", "warehouseId", id);
CREATE TABLE "TransportTask" (
  id UUID PRIMARY KEY,
  "spaceId" UUID NOT NULL,
  "warehouseId" UUID NOT NULL,
  "allocationId" UUID NOT NULL UNIQUE,
  "transitLocationId" UUID NOT NULL UNIQUE,
  "stagingLocationId" UUID NOT NULL,
  phase "TransportPhase" NOT NULL DEFAULT 'READY',
  FOREIGN KEY ("spaceId", "warehouseId", "allocationId") REFERENCES "Allocation"("spaceId", "warehouseId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("spaceId", "warehouseId", "transitLocationId") REFERENCES "Location"("spaceId", "warehouseId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("spaceId", "warehouseId", "stagingLocationId") REFERENCES "Location"("spaceId", "warehouseId", id) ON DELETE RESTRICT,
  CONSTRAINT task_distinct_locations CHECK ("transitLocationId" <> "stagingLocationId")
);
CREATE UNIQUE INDEX task_allocation_scope_key ON "TransportTask"("spaceId", "warehouseId", "allocationId");
CREATE INDEX "TransportTask_stagingLocationId_phase_idx" ON "TransportTask"("stagingLocationId", phase);
ALTER TABLE "LayoutZone" ADD CONSTRAINT layout_zone_physical CHECK (kind <> 'TRANSIT');

ALTER TABLE "OutboundOrder" DROP CONSTRAINT outbound_phase_fields;
ALTER TABLE "OutboundOrder" ADD CONSTRAINT outbound_phase_fields CHECK (
  (status = 'CREATED' AND "allocatedById" IS NULL AND "allocatedAt" IS NULL AND "allocationReason" IS NULL)
  OR (status IN ('ALLOCATED', 'DISPATCHED') AND "allocatedById" IS NOT NULL AND "allocatedAt" IS NOT NULL AND "allocationReason" IS NOT NULL)
);
ALTER TABLE "InventoryMovement" ALTER COLUMN "destinationLocationId" DROP NOT NULL;
ALTER TABLE "InventoryMovement" ALTER COLUMN "destinationQuality" DROP NOT NULL;
ALTER TABLE "InventoryMovement" DROP CONSTRAINT movement_endpoints;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT movement_endpoints CHECK (
  (kind IN ('OPENING', 'RECEIPT') AND "sourceLocationId" IS NULL AND "sourceQuality" IS NULL
    AND "destinationLocationId" IS NOT NULL AND "destinationQuality" IS NOT NULL)
  OR (kind = 'TRANSFER' AND "sourceLocationId" IS NOT NULL AND "sourceQuality" IS NOT NULL
    AND "destinationLocationId" IS NOT NULL AND "destinationQuality" IS NOT NULL
    AND ("sourceLocationId" <> "destinationLocationId" OR "sourceQuality" <> "destinationQuality"))
  OR (kind = 'DISPATCH' AND "sourceLocationId" IS NOT NULL AND "sourceQuality" IS NOT DISTINCT FROM 'RELEASED'::"Quality"
    AND "destinationLocationId" IS NULL AND "destinationQuality" IS NULL)
);

CREATE FUNCTION staging_reserved(target UUID) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(a.quantity), 0)
  FROM "TransportTask" t JOIN "Allocation" a ON a.id = t."allocationId"
  WHERE t."stagingLocationId" = target AND t.phase IN ('READY', 'IN_TRANSIT')
$$;

CREATE FUNCTION guard_transport_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maximum integer; occupied bigint; load integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Transport tasks cannot be deleted' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM "Warehouse" WHERE id = NEW."warehouseId" FOR UPDATE;
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.id, OLD."spaceId", OLD."warehouseId", OLD."allocationId", OLD."transitLocationId", OLD."stagingLocationId")
       IS DISTINCT FROM (NEW.id, NEW."spaceId", NEW."warehouseId", NEW."allocationId", NEW."transitLocationId", NEW."stagingLocationId")
       OR NOT ((OLD.phase = 'READY' AND NEW.phase = 'IN_TRANSIT') OR (OLD.phase = 'IN_TRANSIT' AND NEW.phase = 'STAGED')) THEN
      RAISE EXCEPTION 'Invalid transport transition' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM "Location" WHERE id = NEW."stagingLocationId" FOR UPDATE;
  SELECT p.capacity INTO maximum FROM "Warehouse" w
    JOIN "LayoutLocation" p ON p."layoutId" = w."activeLayoutId"
    JOIN "Location" l ON l.id = p."locationId" AND l.kind = 'OUTBOUND'
    WHERE w.id = NEW."warehouseId" AND l.id = NEW."stagingLocationId";
  SELECT a.quantity INTO load FROM "Allocation" a JOIN "OutboundOrder" o ON o.id = a."orderId"
    WHERE a.id = NEW."allocationId" AND o.status = 'ALLOCATED';
  IF NEW.phase <> 'READY' OR maximum IS NULL OR load IS NULL OR NOT EXISTS (
    SELECT 1 FROM "Location" WHERE id = NEW."transitLocationId" AND kind = 'TRANSIT'
  ) THEN RAISE EXCEPTION 'Invalid transport endpoints or allocation' USING ERRCODE = '23514'; END IF;
  SELECT coalesce(sum("onHand"), 0) INTO occupied FROM "InventoryBalance" WHERE "locationId" = NEW."stagingLocationId";
  IF occupied + staging_reserved(NEW."stagingLocationId") + load > maximum THEN
    RAISE EXCEPTION 'Staging capacity exceeded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transport_task_guard BEFORE INSERT OR UPDATE OR DELETE ON "TransportTask"
  FOR EACH ROW EXECUTE FUNCTION guard_transport_task();

CREATE FUNCTION guard_transport_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "Warehouse" WHERE id = OLD."warehouseId" FOR UPDATE;
  IF NEW IS DISTINCT FROM OLD AND EXISTS (SELECT 1 FROM "TransportTask" WHERE "allocationId" = OLD.id) THEN
    RAISE EXCEPTION 'A transport allocation cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transport_allocation_guard BEFORE UPDATE ON "Allocation"
  FOR EACH ROW EXECUTE FUNCTION guard_transport_allocation();

CREATE OR REPLACE FUNCTION validate_balance_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maximum integer; occupied bigint; location_kind "ZoneKind";
BEGIN
  PERFORM 1 FROM "Warehouse" WHERE id = NEW."warehouseId" AND "spaceId" = NEW."spaceId" FOR UPDATE;
  SELECT kind INTO location_kind FROM "Location"
    WHERE id = NEW."locationId" AND "spaceId" = NEW."spaceId" AND "warehouseId" = NEW."warehouseId" FOR UPDATE;
  IF location_kind = 'TRANSIT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "TransportTask" t JOIN "Allocation" a ON a.id = t."allocationId"
      WHERE t."transitLocationId" = NEW."locationId" AND a."skuId" = NEW."skuId" AND a."batchId" = NEW."batchId"
        AND a.quality = NEW.quality AND NEW.reserved = NEW."onHand"
        AND (NEW."onHand" = 0 OR (t.phase = 'IN_TRANSIT' AND NEW."onHand" = a.quantity))
    ) THEN RAISE EXCEPTION 'Invalid transit stock' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  SELECT p.capacity INTO maximum FROM "Warehouse" w JOIN "LayoutLocation" p
    ON p."layoutId" = w."activeLayoutId" AND p."locationId" = NEW."locationId"
    WHERE w.id = NEW."warehouseId" AND w."spaceId" = NEW."spaceId";
  IF maximum IS NULL THEN RAISE EXCEPTION 'Stock requires an active location placement' USING ERRCODE = '23514'; END IF;
  SELECT coalesce(sum("onHand"), 0) INTO occupied FROM "InventoryBalance"
    WHERE "locationId" = NEW."locationId" AND id <> NEW.id
      AND NOT ("skuId" = NEW."skuId" AND "batchId" = NEW."batchId" AND quality = NEW.quality);
  IF occupied + NEW."onHand" + staging_reserved(NEW."locationId") > maximum THEN
    RAISE EXCEPTION 'Location capacity exceeded' USING ERRCODE = '23514';
  END IF;
  IF location_kind = 'STORAGE' AND NEW."onHand" > 0 AND EXISTS (SELECT 1 FROM "InventoryBalance"
    WHERE "locationId" = NEW."locationId" AND id <> NEW.id AND "onHand" > 0
      AND ("skuId" <> NEW."skuId" OR "batchId" <> NEW."batchId")) THEN
    RAISE EXCEPTION 'Storage location cannot mix SKU or batch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_active_layout() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."activeLayoutId" IS NOT DISTINCT FROM OLD."activeLayoutId" THEN RETURN NEW; END IF;
  IF NEW."activeLayoutId" IS NULL OR NOT EXISTS (SELECT 1 FROM "LayoutVersion" v WHERE v.id = NEW."activeLayoutId"
    AND v."spaceId" = NEW."spaceId" AND v."warehouseId" = NEW.id AND v.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'Active layout must be a published warehouse snapshot' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT l.id FROM "Location" l LEFT JOIN "InventoryBalance" b ON b."locationId" = l.id
    LEFT JOIN "LayoutLocation" p ON p."layoutId" = NEW."activeLayoutId" AND p."locationId" = l.id
    WHERE l."warehouseId" = NEW.id AND l.kind <> 'TRANSIT' GROUP BY l.id, p.capacity
    HAVING coalesce(sum(b."onHand"), 0) + staging_reserved(l.id) > coalesce(p.capacity, 0)
  ) THEN RAISE EXCEPTION 'Active layout cannot orphan or overfill stock or reservations' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
