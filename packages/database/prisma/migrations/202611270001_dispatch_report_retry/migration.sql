ALTER TABLE "DispatchReportJob"
    ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastFailedGeneration" INTEGER,
    ADD COLUMN "lastFailureAt" TIMESTAMPTZ(3),
    ADD COLUMN "lastFailureAttempts" INTEGER,
    ADD CONSTRAINT "DispatchReportJob_generation_valid" CHECK ("generation" >= 0),
    ADD CONSTRAINT "DispatchReportJob_failure_valid" CHECK (
        ("lastFailedGeneration" IS NULL AND "lastFailureAt" IS NULL AND "lastFailureAttempts" IS NULL)
        OR ("lastFailedGeneration" IS NOT NULL AND "lastFailureAt" IS NOT NULL AND "lastFailureAttempts" IS NOT NULL
            AND "lastFailedGeneration" BETWEEN 0 AND "generation" AND "lastFailureAttempts" >= 0
            AND ("completedAt" IS NULL OR "lastFailedGeneration" < "generation"))
    );
