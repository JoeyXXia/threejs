import { inventorySchema, layoutSchema, validateSnapshot } from '@warehouse-twin/contracts';
import type { WarehouseSnapshot } from '@warehouse-twin/contracts';
import { api } from '../api';

export const warehouseKey = (userId: string, spaceId: string, warehouseId: string) =>
  ['warehouse-snapshot', userId, spaceId, warehouseId] as const;

export async function loadSnapshot(spaceId: string, warehouseId: string, signal: AbortSignal): Promise<WarehouseSnapshot> {
  const path = `/spaces/${encodeURIComponent(spaceId)}/warehouses/${encodeURIComponent(warehouseId)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const [layoutRaw, inventoryRaw] = await Promise.all([api(`${path}/layout`, 'GET', undefined, signal), api(`${path}/inventory`, 'GET', undefined, signal)]);
    const layout = layoutSchema.safeParse(layoutRaw), inventory = inventorySchema.safeParse(inventoryRaw);
    if (!layout.success || !inventory.success) throw new Error('服务响应格式或数量关系错误，已停止显示场景。');
    if (layout.data.spaceId !== spaceId || inventory.data.spaceId !== spaceId
      || layout.data.warehouseId !== warehouseId || inventory.data.warehouseId !== warehouseId) {
      throw new Error('仓库响应归属不一致，已停止显示。');
    }
    if (layout.data.layoutVersion.id !== inventory.data.layoutId || layout.data.layoutVersion.version !== inventory.data.layoutVersion) {
      if (attempt === 0) continue;
      throw new Error('布局版本正在变化，无法取得一致快照，请重试。');
    }
    try { return validateSnapshot(layout.data, inventory.data, spaceId, warehouseId); }
    catch { throw new Error('库存货位与布局不匹配，已停止显示。'); }
  }
  throw new Error('无法读取仓库快照');
}
