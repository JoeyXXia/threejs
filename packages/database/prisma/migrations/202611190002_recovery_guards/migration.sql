-- Preserve existing endpoint/capacity checks; permit terminal cancellation only before pickup.
CREATE OR REPLACE FUNCTION guard_transport_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maximum integer; occupied bigint; load integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Transport tasks cannot be deleted' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM "Warehouse" WHERE id = NEW."warehouseId" FOR UPDATE;
  IF TG_OP = 'UPDATE' THEN
    IF (OLD.id, OLD."spaceId", OLD."warehouseId", OLD."allocationId", OLD."transitLocationId", OLD."stagingLocationId")
       IS DISTINCT FROM (NEW.id, NEW."spaceId", NEW."warehouseId", NEW."allocationId", NEW."transitLocationId", NEW."stagingLocationId")
       OR NOT ((OLD.phase = 'READY' AND NEW.phase IN ('IN_TRANSIT','CANCELLED')) OR (OLD.phase = 'IN_TRANSIT' AND NEW.phase = 'STAGED')) THEN
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
CREATE OR REPLACE FUNCTION guard_putaway_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt "InboundOrder"%ROWTYPE; maximum integer; occupied bigint;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Putaway tasks are immutable' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM "Warehouse" WHERE id=NEW."warehouseId" FOR UPDATE;
 IF TG_OP='UPDATE' THEN
  IF (OLD.id,OLD."spaceId",OLD."warehouseId",OLD."inboundOrderId",OLD."transitLocationId",OLD."targetLocationId")
    IS DISTINCT FROM (NEW.id,NEW."spaceId",NEW."warehouseId",NEW."inboundOrderId",NEW."transitLocationId",NEW."targetLocationId")
    OR NOT ((OLD.phase='READY' AND NEW.phase IN ('IN_TRANSIT','CANCELLED')) OR (OLD.phase='IN_TRANSIT' AND NEW.phase='STAGED')) THEN
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
CREATE OR REPLACE FUNCTION guard_fleet_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ledger_phase "TransportPhase";
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Fleet claims are retained' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM "Warehouse" WHERE id=NEW."warehouseId" FOR UPDATE;
 IF TG_OP='UPDATE' AND ((OLD.id,OLD."spaceId",OLD."warehouseId",OLD.kind,OLD."taskId",OLD."robotId",OLD."actorId")
 IS DISTINCT FROM (NEW.id,NEW."spaceId",NEW."warehouseId",NEW.kind,NEW."taskId",NEW."robotId",NEW."actorId")
 OR (NOT OLD.active AND NEW IS DISTINCT FROM OLD)) THEN
 RAISE EXCEPTION 'Claim identity/ownership is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.kind='OUTBOUND' THEN
 SELECT phase INTO ledger_phase FROM "TransportTask" WHERE id=NEW."taskId" AND "spaceId"=NEW."spaceId" AND "warehouseId"=NEW."warehouseId";
 ELSE
 SELECT phase INTO ledger_phase FROM "PutawayTask" WHERE id=NEW."taskId" AND "spaceId"=NEW."spaceId" AND "warehouseId"=NEW."warehouseId";
 END IF;
 IF ledger_phase IS NULL OR (TG_OP='INSERT' AND (NOT NEW.active OR NEW.loaded OR ledger_phase<>'READY'))
 OR (NEW.active AND NEW.loaded AND ledger_phase<>'IN_TRANSIT')
 OR (NEW.active AND NOT NEW.loaded AND ledger_phase<>'READY')
 OR (NOT NEW.active AND ledger_phase NOT IN ('STAGED','CANCELLED')) THEN
 RAISE EXCEPTION 'Claim and scoped ledger phase disagree' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
