ALTER TABLE "WarehouseRuntime" ADD COLUMN fleet JSONB;
CREATE TABLE "FleetClaim" (
 id UUID PRIMARY KEY, "spaceId" UUID NOT NULL, "warehouseId" UUID NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('OUTBOUND','PUTAWAY')), "taskId" UUID NOT NULL,
 "robotId" TEXT NOT NULL CHECK ("robotId" ~ '^robot-[1-5]$'), "actorId" UUID NOT NULL,
 loaded BOOLEAN NOT NULL DEFAULT false, active BOOLEAN NOT NULL DEFAULT true,
 FOREIGN KEY ("spaceId","warehouseId") REFERENCES "WarehouseRuntime"("spaceId","warehouseId") ON DELETE RESTRICT,
 UNIQUE ("warehouseId",kind,"taskId"), CHECK (active OR NOT loaded)
);
CREATE INDEX "FleetClaim_warehouseId_robotId_idx" ON "FleetClaim"("warehouseId","robotId");
CREATE UNIQUE INDEX fleet_one_active_task_per_robot ON "FleetClaim"("warehouseId","robotId") WHERE active;
CREATE FUNCTION guard_fleet_claim() RETURNS trigger LANGUAGE plpgsql AS $$
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
 OR (NOT NEW.active AND ledger_phase<>'STAGED') THEN
 RAISE EXCEPTION 'Claim and scoped ledger phase disagree' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fleet_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON "FleetClaim" FOR EACH ROW EXECUTE FUNCTION guard_fleet_claim();
