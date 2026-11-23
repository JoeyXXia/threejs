-- Historical events did not record the commit-time version or lease epoch.
ALTER TABLE "WarehouseEvent" ADD COLUMN "version" INTEGER, ADD COLUMN "epoch" INTEGER;
