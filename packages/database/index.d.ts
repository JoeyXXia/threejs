export * from '@prisma/client';
import type { Prisma } from '@prisma/client';
export function reconcileWarehouse(tx: Prisma.TransactionClient, scope?: { spaceId: string; warehouseId: string }): Promise<{
  consistent: boolean;
  mismatches: { spaceId: string; warehouseId: string; locationId: string; skuId: string; batchId: string; quality: string; actual: string; expected: string }[];
  reservationMismatches: { kind: string; id: string; actual: string; expected: string }[];
}>;
