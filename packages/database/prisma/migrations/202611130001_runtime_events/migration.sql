CREATE TABLE "WarehouseRuntime" (
  "warehouseId" uuid PRIMARY KEY, "spaceId" uuid NOT NULL,
  "ownerId" uuid, "epoch" integer NOT NULL DEFAULT 0,
  "leaseUntil" timestamptz(3), "tick" integer NOT NULL DEFAULT 0,
  "version" integer NOT NULL DEFAULT 0, "seq" integer NOT NULL DEFAULT 0,
  "checkpoint" jsonb,
  UNIQUE ("spaceId", "warehouseId"),
  FOREIGN KEY ("spaceId", "warehouseId") REFERENCES "Warehouse" ("spaceId", id) ON DELETE RESTRICT,
  CHECK (epoch >= 0 AND tick >= 0 AND version >= 0 AND seq >= 0),
  CHECK (("ownerId" IS NULL) = ("leaseUntil" IS NULL))
);
INSERT INTO "WarehouseRuntime" ("spaceId", "warehouseId") SELECT "spaceId", id FROM "Warehouse";
CREATE TABLE "WarehouseEvent" (
  "warehouseId" uuid NOT NULL, "spaceId" uuid NOT NULL,
  seq integer NOT NULL CHECK (seq > 0), tick integer NOT NULL CHECK (tick >= 0),
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 100), payload jsonb NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("warehouseId", seq),
  FOREIGN KEY ("spaceId", "warehouseId") REFERENCES "WarehouseRuntime" ("spaceId", "warehouseId") ON DELETE RESTRICT
);
CREATE FUNCTION immutable_warehouse_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'warehouse events are append-only'; END $$;
CREATE TRIGGER warehouse_event_immutable BEFORE UPDATE OR DELETE ON "WarehouseEvent"
  FOR EACH ROW EXECUTE FUNCTION immutable_warehouse_event();
