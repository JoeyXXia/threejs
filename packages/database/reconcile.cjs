const { PrismaClient } = require('@prisma/client');

async function reconcile(tx) {
  return tx.$queryRaw`
    WITH postings AS (
      SELECT "spaceId", "warehouseId", "destinationLocationId" AS "locationId", "skuId", "batchId",
        "destinationQuality" AS quality, quantity::bigint AS delta FROM "InventoryMovement" WHERE "destinationLocationId" IS NOT NULL
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

// Reservations are not physical movements: verify both balance and order totals separately.
async function reconcileReservations(tx) {
  return tx.$queryRaw`
    WITH allocated AS (
      SELECT a."spaceId", a."warehouseId", a."skuId", a."batchId", a.quality,
        CASE t.phase WHEN 'IN_TRANSIT' THEN t."transitLocationId" WHEN 'STAGED' THEN t."stagingLocationId"
          ELSE a."locationId" END AS "locationId", sum(a.quantity)::bigint AS expected
      FROM "Allocation" a JOIN "OutboundOrder" o ON o.id=a."orderId"
      LEFT JOIN "TransportTask" t ON t."allocationId"=a.id
      WHERE o.status='ALLOCATED' GROUP BY 1,2,3,4,5,6
    ), balance_differences AS (
      SELECT 'BALANCE'::text AS kind, coalesce(b.id,a."locationId") AS id,
        coalesce(b.reserved,0)::text AS actual, coalesce(a.expected,0)::text AS expected
      FROM "InventoryBalance" b FULL JOIN allocated a USING ("spaceId","warehouseId","skuId","batchId",quality,"locationId")
      WHERE coalesce(b.reserved,0) <> coalesce(a.expected,0)
    ), order_totals AS (
      SELECT o.id, o.status, o.quantity, coalesce(sum(a.quantity),0)::bigint AS actual,
        coalesce(sum(a.quantity) FILTER (WHERE t.phase='STAGED'),0)::bigint AS staged
      FROM "OutboundOrder" o LEFT JOIN "Allocation" a ON a."orderId"=o.id
      LEFT JOIN "TransportTask" t ON t."allocationId"=a.id GROUP BY o.id
    ), transit_totals AS (
      SELECT l.id, coalesce(sum(b."onHand"),0)::bigint AS actual,
        CASE WHEN t.phase='IN_TRANSIT' THEN a.quantity ELSE 0 END AS expected
      FROM "Location" l LEFT JOIN "TransportTask" t ON t."transitLocationId"=l.id
      LEFT JOIN "Allocation" a ON a.id=t."allocationId"
      LEFT JOIN "InventoryBalance" b ON b."locationId"=l.id
      WHERE l.kind='TRANSIT' GROUP BY l.id,t.phase,a.quantity
    ), staging_totals AS (
      SELECT l.id, coalesce(sum(b."onHand"),0)::bigint + staging_reserved(l.id) AS actual, coalesce(p.capacity,0) AS expected
      FROM "Location" l JOIN "Warehouse" w ON w.id=l."warehouseId"
      LEFT JOIN "LayoutLocation" p ON p."layoutId"=w."activeLayoutId" AND p."locationId"=l.id
      LEFT JOIN "InventoryBalance" b ON b."locationId"=l.id
      WHERE l.kind='OUTBOUND' GROUP BY l.id,p.capacity
    )
    SELECT * FROM balance_differences
    UNION ALL
    SELECT 'ORDER'::text, id, actual::text, (CASE WHEN status='CREATED' THEN 0 ELSE quantity END)::text
    FROM order_totals WHERE actual <> CASE WHEN status='CREATED' THEN 0 ELSE quantity END
    UNION ALL
    SELECT 'DISPATCH'::text, id, staged::text, quantity::text
    FROM order_totals WHERE status='DISPATCHED' AND staged <> quantity
    UNION ALL
    SELECT 'TRANSIT'::text, id, actual::text, expected::text
    FROM transit_totals WHERE actual <> expected
    UNION ALL
    SELECT 'CAPACITY'::text, id, actual::text, expected::text
    FROM staging_totals WHERE actual > expected
    ORDER BY kind,id
  `;
}
module.exports = { reconcile, reconcileReservations };
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
