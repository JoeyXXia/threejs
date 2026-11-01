const { PrismaClient } = require('@prisma/client');

async function reconcile(tx) {
  return tx.$queryRaw`
    WITH postings AS (
      SELECT "spaceId", "warehouseId", "destinationLocationId" AS "locationId", "skuId", "batchId",
        "destinationQuality" AS quality, quantity::bigint AS delta FROM "InventoryMovement"
      UNION ALL
      SELECT "spaceId", "warehouseId", "sourceLocationId", "skuId", "batchId", "sourceQuality", -quantity::bigint
        FROM "InventoryMovement" WHERE "sourceLocationId" IS NOT NULL
    ), ledger AS (
      SELECT "spaceId", "warehouseId", "locationId", "skuId", "batchId", quality, sum(delta) AS expected
      FROM postings GROUP BY "spaceId", "warehouseId", "locationId", "skuId", "batchId", quality
    )
    SELECT coalesce(b."spaceId", l."spaceId") AS "spaceId", coalesce(b."warehouseId", l."warehouseId") AS "warehouseId",
      coalesce(b."locationId", l."locationId") AS "locationId", coalesce(b."skuId", l."skuId") AS "skuId",
      coalesce(b."batchId", l."batchId") AS "batchId", coalesce(b.quality, l.quality) AS quality,
      coalesce(b."onHand", 0)::text AS actual, coalesce(l.expected, 0)::text AS expected
    FROM "InventoryBalance" b FULL OUTER JOIN ledger l
      ON b."spaceId" = l."spaceId" AND b."warehouseId" = l."warehouseId" AND b."locationId" = l."locationId"
      AND b."skuId" = l."skuId" AND b."batchId" = l."batchId" AND b.quality = l.quality
    WHERE coalesce(b."onHand", 0) <> coalesce(l.expected, 0)
    ORDER BY "warehouseId", "locationId", "skuId", "batchId", quality
  `;
}

module.exports = { reconcile };
if (require.main === module) {
  const db = new PrismaClient();
  db.$transaction(reconcile, { isolationLevel: 'RepeatableRead' })
    .then((mismatches) => {
      console.log(JSON.stringify({ consistent: mismatches.length === 0, mismatches }, null, 2));
      if (mismatches.length) process.exitCode = 1;
    })
    .catch(() => { console.error('Reconciliation failed; check database configuration'); process.exitCode = 1; })
    .finally(() => db.$disconnect());
}
