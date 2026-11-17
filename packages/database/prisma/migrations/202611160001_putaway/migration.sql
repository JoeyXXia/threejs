-- Full-receipt putaway, serialized with the existing warehouse write boundary.
CREATE TABLE "PutawayTask" (
  id UUID PRIMARY KEY, "spaceId" UUID NOT NULL, "warehouseId" UUID NOT NULL,
  "inboundOrderId" UUID NOT NULL UNIQUE, "transitLocationId" UUID NOT NULL UNIQUE,
  "targetLocationId" UUID NOT NULL, phase "TransportPhase" NOT NULL DEFAULT 'READY',
  FOREIGN KEY ("spaceId","warehouseId","inboundOrderId") REFERENCES "InboundOrder"("spaceId","warehouseId",id) ON DELETE RESTRICT,
  FOREIGN KEY ("spaceId","warehouseId","transitLocationId") REFERENCES "Location"("spaceId","warehouseId",id) ON DELETE RESTRICT,
  FOREIGN KEY ("spaceId","warehouseId","targetLocationId") REFERENCES "Location"("spaceId","warehouseId",id) ON DELETE RESTRICT,
  CHECK ("transitLocationId"<>"targetLocationId")
);
CREATE INDEX "PutawayTask_targetLocationId_phase_idx" ON "PutawayTask"("targetLocationId",phase);
-- Legacy name intentionally retained: capacity/layout guards already call it.
CREATE OR REPLACE FUNCTION staging_reserved(target UUID) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT sum(a.quantity) FROM "TransportTask" t JOIN "Allocation" a ON a.id=t."allocationId"
 WHERE t."stagingLocationId"=target AND t.phase IN ('READY','IN_TRANSIT')),0)
 + coalesce((SELECT sum(r.quantity) FROM "PutawayTask" t JOIN "InboundOrder" r ON r.id=t."inboundOrderId"
 WHERE t."targetLocationId"=target AND t.phase IN ('READY','IN_TRANSIT')),0)
$$;
CREATE FUNCTION guard_putaway_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt "InboundOrder"%ROWTYPE; maximum integer; occupied bigint;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Putaway tasks are immutable' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM "Warehouse" WHERE id=NEW."warehouseId" FOR UPDATE;
 IF TG_OP='UPDATE' THEN
  IF (OLD.id,OLD."spaceId",OLD."warehouseId",OLD."inboundOrderId",OLD."transitLocationId",OLD."targetLocationId")
    IS DISTINCT FROM (NEW.id,NEW."spaceId",NEW."warehouseId",NEW."inboundOrderId",NEW."transitLocationId",NEW."targetLocationId")
    OR NOT ((OLD.phase='READY' AND NEW.phase='IN_TRANSIT') OR (OLD.phase='IN_TRANSIT' AND NEW.phase='STAGED')) THEN
   RAISE EXCEPTION 'Invalid putaway transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO receipt FROM "InboundOrder" WHERE id=NEW."inboundOrderId" AND status='PASSED';
 SELECT p.capacity INTO maximum FROM "Warehouse" w JOIN "LayoutLocation" p ON p."layoutId"=w."activeLayoutId"
 JOIN "Location" l ON l.id=p."locationId" AND l.kind='STORAGE'
 WHERE w.id=NEW."warehouseId" AND l.id=NEW."targetLocationId";
 IF NEW.phase<>'READY' OR receipt.id IS NULL OR maximum IS NULL OR count_location_frozen(NEW."targetLocationId")
   OR NOT EXISTS (SELECT 1 FROM "Location" WHERE id=NEW."transitLocationId" AND kind='TRANSIT') THEN
  RAISE EXCEPTION 'Invalid putaway receipt or endpoints' USING ERRCODE='23514'; END IF;
 SELECT coalesce(sum("onHand"),0) INTO occupied FROM "InventoryBalance" WHERE "locationId"=NEW."targetLocationId";
 IF occupied+staging_reserved(NEW."targetLocationId")+receipt.quantity>maximum THEN
  RAISE EXCEPTION 'Putaway capacity exceeded' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM "InventoryBalance" WHERE "locationId"=NEW."targetLocationId" AND "onHand">0
   AND ("skuId"<>receipt."skuId" OR "batchId"<>receipt."batchId")) OR EXISTS (
  SELECT 1 FROM "PutawayTask" t JOIN "InboundOrder" r ON r.id=t."inboundOrderId"
  WHERE t."targetLocationId"=NEW."targetLocationId" AND t.phase IN ('READY','IN_TRANSIT')
  AND (r."skuId"<>receipt."skuId" OR r."batchId"<>receipt."batchId")) THEN
  RAISE EXCEPTION 'Putaway cannot mix SKU or batch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER putaway_task_guard BEFORE INSERT OR UPDATE OR DELETE ON "PutawayTask"
 FOR EACH ROW EXECUTE FUNCTION guard_putaway_task();

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
    ) AND NOT EXISTS (
      SELECT 1 FROM "PutawayTask" t JOIN "InboundOrder" r ON r.id=t."inboundOrderId"
      WHERE t."transitLocationId"=NEW."locationId" AND r."skuId"=NEW."skuId" AND r."batchId"=NEW."batchId"
        AND NEW.quality='RELEASED' AND NEW.reserved=NEW."onHand"
        AND (NEW."onHand"=0 OR (t.phase='IN_TRANSIT' AND NEW."onHand"=r.quantity))
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
  IF location_kind='STORAGE' AND NEW."onHand">0 AND EXISTS (
    SELECT 1 FROM "PutawayTask" t JOIN "InboundOrder" r ON r.id=t."inboundOrderId"
    WHERE t."targetLocationId"=NEW."locationId" AND t.phase IN ('READY','IN_TRANSIT')
      AND (r."skuId"<>NEW."skuId" OR r."batchId"<>NEW."batchId")
  ) THEN RAISE EXCEPTION 'Storage has incompatible incoming reservation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;


CREATE UNIQUE INDEX "PutawayTask_spaceId_warehouseId_inboundOrderId_key" ON "PutawayTask"("spaceId","warehouseId","inboundOrderId");
