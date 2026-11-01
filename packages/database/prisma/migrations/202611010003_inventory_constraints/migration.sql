-- Prisma cannot express these cross-row, geometric and CHECK invariants.
ALTER TABLE "LayoutVersion" ADD CONSTRAINT "layout_dimensions" CHECK
  ("version" > 0 AND "width" > 0 AND "depth" > 0 AND "cellSize" > 0 AND "cellSize" < 'Infinity'::float8
   AND "originX" BETWEEN -1000000 AND 1000000 AND "originZ" BETWEEN -1000000 AND 1000000);
ALTER TABLE "LayoutZone" ADD CONSTRAINT "zone_dimensions" CHECK ("gridX" >= 0 AND "gridZ" >= 0 AND "sizeX" > 0 AND "sizeZ" > 0);
ALTER TABLE "Rack" ADD CONSTRAINT "rack_dimensions" CHECK ("gridX" >= 0 AND "gridZ" >= 0 AND "sizeX" > 0 AND "sizeZ" > 0 AND "levels" > 0 AND "levelHeight" > 0 AND "levelHeight" < 'Infinity'::float8);
ALTER TABLE "LayoutLocation" ADD CONSTRAINT "placement_quantities" CHECK
  ("capacity" > 0 AND "level" >= 0 AND "gridX" >= 0 AND "gridZ" >= 0 AND "serviceX" >= 0 AND "serviceZ" >= 0);
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "balance_quantities" CHECK
  ("onHand" >= 0 AND "reserved" >= 0 AND "reserved" <= "onHand" AND "version" >= 0);
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "movement_quantities" CHECK ("quantity" > 0);
ALTER TABLE "Sku" ADD CONSTRAINT "sku_quantity_unit" CHECK (unit = 'piece');
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "movement_endpoints" CHECK (
  ("kind" = 'OPENING' AND "sourceLocationId" IS NULL AND "sourceQuality" IS NULL)
  OR ("kind" = 'TRANSFER' AND "sourceLocationId" IS NOT NULL AND "sourceQuality" IS NOT NULL
      AND ("sourceLocationId" <> "destinationLocationId" OR "sourceQuality" <> "destinationQuality"))
);

CREATE FUNCTION validate_layout_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'PUBLISHED' THEN RAISE EXCEPTION 'Published layout is immutable' USING ERRCODE = '23514'; END IF;
  IF NEW.status <> 'PUBLISHED' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM "LayoutZone" z WHERE z."layoutId" = NEW.id AND
    (z."gridX" + z."sizeX" > NEW.width OR z."gridZ" + z."sizeZ" > NEW.depth)) THEN
    RAISE EXCEPTION 'Zone outside layout' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "Rack" r JOIN "LayoutZone" z ON z.id = r."zoneId" WHERE r."layoutId" = NEW.id AND
    (z.kind <> 'STORAGE' OR r."gridX" < z."gridX" OR r."gridZ" < z."gridZ"
     OR r."gridX" + r."sizeX" > z."gridX" + z."sizeX" OR r."gridZ" + r."sizeZ" > z."gridZ" + z."sizeZ")) THEN
    RAISE EXCEPTION 'Rack outside storage zone' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "Rack" a JOIN "Rack" b ON a."layoutId" = b."layoutId" AND a.id < b.id
    WHERE a."layoutId" = NEW.id AND a."gridX" < b."gridX" + b."sizeX" AND b."gridX" < a."gridX" + a."sizeX"
      AND a."gridZ" < b."gridZ" + b."sizeZ" AND b."gridZ" < a."gridZ" + a."sizeZ") THEN
    RAISE EXCEPTION 'Overlapping racks' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "LayoutLocation" p JOIN "Location" l ON l.id = p."locationId"
    JOIN "LayoutZone" z ON z.id = p."zoneId" LEFT JOIN "Rack" r ON r.id = p."rackId"
    WHERE p."layoutId" = NEW.id AND (
      p."gridX" < z."gridX" OR p."gridZ" < z."gridZ" OR p."gridX" >= z."gridX" + z."sizeX" OR p."gridZ" >= z."gridZ" + z."sizeZ"
      OR p."serviceX" >= NEW.width OR p."serviceZ" >= NEW.depth OR l.kind <> z.kind
      OR (l.kind = 'STORAGE' AND (r.id IS NULL OR r."zoneId" <> p."zoneId" OR p.level >= r.levels
        OR p."gridX" < r."gridX" OR p."gridX" >= r."gridX" + r."sizeX"
        OR p."gridZ" < r."gridZ" OR p."gridZ" >= r."gridZ" + r."sizeZ"
        OR NOT (((p."serviceX" = r."gridX" - 1 OR p."serviceX" = r."gridX" + r."sizeX")
                 AND p."serviceZ" >= r."gridZ" AND p."serviceZ" < r."gridZ" + r."sizeZ")
                OR ((p."serviceZ" = r."gridZ" - 1 OR p."serviceZ" = r."gridZ" + r."sizeZ")
                 AND p."serviceX" >= r."gridX" AND p."serviceX" < r."gridX" + r."sizeX"))))
      OR (l.kind <> 'STORAGE' AND (r.id IS NOT NULL OR p.level <> 0 OR p."serviceX" <> p."gridX" OR p."serviceZ" <> p."gridZ"))
      OR EXISTS (SELECT 1 FROM "Rack" obstacle WHERE obstacle."layoutId" = NEW.id
        AND p."serviceX" >= obstacle."gridX" AND p."serviceX" < obstacle."gridX" + obstacle."sizeX"
        AND p."serviceZ" >= obstacle."gridZ" AND p."serviceZ" < obstacle."gridZ" + obstacle."sizeZ")
    )) THEN RAISE EXCEPTION 'Invalid location or service cell' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER layout_publication BEFORE UPDATE ON "LayoutVersion" FOR EACH ROW EXECUTE FUNCTION validate_layout_publication();

-- Published snapshots must start as drafts, and cannot be deleted or edited later.
CREATE FUNCTION guard_layout_header() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'DRAFT' THEN RAISE EXCEPTION 'Create draft first' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'DELETE' AND OLD.status = 'PUBLISHED' THEN RAISE EXCEPTION 'Published layout is immutable' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER layout_header_guard BEFORE INSERT OR DELETE ON "LayoutVersion" FOR EACH ROW EXECUTE FUNCTION guard_layout_header();

CREATE FUNCTION guard_layout_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE layout_key uuid; layout_state "LayoutStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN layout_key := NEW."layoutId"; ELSE layout_key := OLD."layoutId"; END IF;
  SELECT status INTO layout_state FROM "LayoutVersion" WHERE id = layout_key FOR UPDATE;
  IF layout_state = 'PUBLISHED' THEN RAISE EXCEPTION 'Published layout is immutable' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND NEW."layoutId" <> OLD."layoutId" THEN
    SELECT status INTO layout_state FROM "LayoutVersion" WHERE id = NEW."layoutId" FOR UPDATE;
    IF layout_state = 'PUBLISHED' THEN RAISE EXCEPTION 'Published layout is immutable' USING ERRCODE = '23514'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zone_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON "LayoutZone" FOR EACH ROW EXECUTE FUNCTION guard_layout_child();
CREATE TRIGGER rack_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON "Rack" FOR EACH ROW EXECUTE FUNCTION guard_layout_child();
CREATE TRIGGER placement_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON "LayoutLocation" FOR EACH ROW EXECUTE FUNCTION guard_layout_child();

CREATE FUNCTION guard_location_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "LayoutLocation" p JOIN "LayoutVersion" v ON v.id = p."layoutId"
    WHERE p."locationId" = OLD.id AND v.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'Published location identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER location_identity_guard BEFORE UPDATE OR DELETE ON "Location" FOR EACH ROW EXECUTE FUNCTION guard_location_identity();

CREATE FUNCTION validate_active_layout() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."activeLayoutId" IS NOT DISTINCT FROM OLD."activeLayoutId" THEN RETURN NEW; END IF;
  IF NEW."activeLayoutId" IS NULL OR NOT EXISTS (SELECT 1 FROM "LayoutVersion" v WHERE v.id = NEW."activeLayoutId"
    AND v."spaceId" = NEW."spaceId" AND v."warehouseId" = NEW.id AND v.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'Active layout must be a published warehouse snapshot' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT b."locationId" FROM "InventoryBalance" b LEFT JOIN "LayoutLocation" p
      ON p."layoutId" = NEW."activeLayoutId" AND p."locationId" = b."locationId"
    WHERE b."warehouseId" = NEW.id GROUP BY b."locationId", p.capacity
    HAVING sum(b."onHand") > 0 AND (p.capacity IS NULL OR sum(b."onHand") > p.capacity)) THEN
    RAISE EXCEPTION 'Active layout cannot orphan or overfill stock' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER active_layout_guard BEFORE UPDATE ON "Warehouse" FOR EACH ROW EXECUTE FUNCTION validate_active_layout();

CREATE FUNCTION validate_balance_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maximum integer; occupied bigint; location_kind "ZoneKind";
BEGIN
  PERFORM 1 FROM "Warehouse" WHERE id = NEW."warehouseId" AND "spaceId" = NEW."spaceId" FOR UPDATE;
  -- Row lock serializes different SKU/batch/quality balances competing for one location.
  PERFORM 1 FROM "Location" WHERE id = NEW."locationId" AND "spaceId" = NEW."spaceId" AND "warehouseId" = NEW."warehouseId" FOR UPDATE;
  SELECT p.capacity, l.kind INTO maximum, location_kind FROM "Warehouse" w
    JOIN "LayoutLocation" p ON p."layoutId" = w."activeLayoutId" AND p."locationId" = NEW."locationId"
    JOIN "Location" l ON l.id = p."locationId"
    WHERE w.id = NEW."warehouseId" AND w."spaceId" = NEW."spaceId";
  IF maximum IS NULL THEN RAISE EXCEPTION 'Stock requires an active location placement' USING ERRCODE = '23514'; END IF;
  SELECT coalesce(sum("onHand"), 0) INTO occupied FROM "InventoryBalance"
    WHERE "locationId" = NEW."locationId" AND id <> NEW.id
      AND NOT ("skuId" = NEW."skuId" AND "batchId" = NEW."batchId" AND quality = NEW.quality);
  IF occupied + NEW."onHand" > maximum THEN RAISE EXCEPTION 'Location capacity exceeded' USING ERRCODE = '23514'; END IF;
  IF location_kind = 'STORAGE' AND NEW."onHand" > 0 AND EXISTS (SELECT 1 FROM "InventoryBalance"
    WHERE "locationId" = NEW."locationId" AND id <> NEW.id AND "onHand" > 0
      AND ("skuId" <> NEW."skuId" OR "batchId" <> NEW."batchId")) THEN
    RAISE EXCEPTION 'Storage location cannot mix SKU or batch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER balance_capacity_guard BEFORE INSERT OR UPDATE ON "InventoryBalance" FOR EACH ROW EXECUTE FUNCTION validate_balance_capacity();

CREATE FUNCTION reject_movement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Inventory movements are append only' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER movement_append_only BEFORE UPDATE OR DELETE ON "InventoryMovement" FOR EACH ROW EXECUTE FUNCTION reject_movement_mutation();
