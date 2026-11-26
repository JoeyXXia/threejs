CREATE TABLE "DispatchReportJob" (
    "id" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "sourceSeq" INTEGER NOT NULL,
    "format" INTEGER NOT NULL,
    "nextRelayAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "result" JSONB,
    CONSTRAINT "DispatchReportJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DispatchReportJob_format_positive" CHECK ("format" > 0),
    CONSTRAINT "DispatchReportJob_result_complete" CHECK (("result" IS NULL) = ("completedAt" IS NULL))
);

CREATE UNIQUE INDEX "DispatchReportJob_warehouseId_sourceSeq_format_key" ON "DispatchReportJob"("warehouseId", "sourceSeq", "format");
CREATE INDEX "DispatchReportJob_completedAt_nextRelayAt_id_idx" ON "DispatchReportJob"("completedAt", "nextRelayAt", "id");
ALTER TABLE "DispatchReportJob" ADD CONSTRAINT "DispatchReportJob_warehouseId_sourceSeq_fkey"
    FOREIGN KEY ("warehouseId", "sourceSeq") REFERENCES "WarehouseEvent"("warehouseId", "seq") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reports scan dispatch events only; the index does not retain simulation ticks.
CREATE INDEX "WarehouseEvent_dispatchDay_idx" ON "WarehouseEvent" ("warehouseId", "createdAt", "seq")
    WHERE "kind" = 'OUTBOUND_DISPATCHED';
