CREATE TABLE "WarehouseReplayFrame" (
  "warehouseId" UUID NOT NULL,
  "spaceId" UUID NOT NULL,
  "seq" INTEGER NOT NULL,
  "tick" INTEGER NOT NULL,
  "layoutId" UUID NOT NULL,
  "layoutVersion" INTEGER NOT NULL,
  "mode" TEXT NOT NULL,
  "anchor" BOOLEAN NOT NULL,
  "capturedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "state" JSONB NOT NULL,
  CONSTRAINT "WarehouseReplayFrame_pkey" PRIMARY KEY ("warehouseId", "seq"),
  CONSTRAINT "replay_frame_boundary" CHECK ("seq" > 0 AND "tick" > 0 AND "layoutVersion" > 0 AND "mode" IN ('SINGLE', 'FLEET')),
  CONSTRAINT "WarehouseReplayFrame_warehouseId_seq_fkey" FOREIGN KEY ("warehouseId", "seq") REFERENCES "WarehouseEvent"("warehouseId", "seq") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WarehouseReplayFrame_spaceId_warehouseId_layoutId_fkey" FOREIGN KEY ("spaceId", "warehouseId", "layoutId") REFERENCES "LayoutVersion"("spaceId", "warehouseId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WarehouseReplayFrame_warehouseId_tick_key" ON "WarehouseReplayFrame"("warehouseId", "tick");
CREATE INDEX "WarehouseReplayFrame_spaceId_warehouseId_capturedAt_seq_idx" ON "WarehouseReplayFrame"("spaceId", "warehouseId", "capturedAt", "seq");
CREATE INDEX "WarehouseReplayFrame_warehouseId_anchor_seq_idx" ON "WarehouseReplayFrame"("warehouseId", "anchor", "seq");
CREATE TRIGGER warehouse_replay_frame_immutable BEFORE UPDATE OR DELETE ON "WarehouseReplayFrame"
  FOR EACH ROW EXECUTE FUNCTION immutable_warehouse_event();
