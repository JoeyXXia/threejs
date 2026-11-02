import { inventoryAppearance } from './inventory-view';
import type { LocationView } from './inventory-view';

export function InventoryDetails({ view, onClose }: { view: LocationView | undefined; onClose: () => void }) {
  return <section className="inventory-details" aria-label="货位详情">
    {!view ? <p>点击场景货位或在列表选择，查看同一 API 快照中的批次库存。</p> : <>
      <div className="detail-heading"><h2>{view.location.code}</h2><button onClick={onClose}>关闭详情</button></div>
      <p><span className="status-badge" style={{ borderColor: inventoryAppearance[view.status].color }}>{inventoryAppearance[view.status].name}</span> · 现存 {view.total.onHand} / 容量 {view.total.capacity} 件 · 预占 {view.total.reserved} · 可用 {view.total.available}</p>
      <small>货位 ID：{view.location.id}</small>
      {view.total.onHand === 0 && <p>空货位，当前无现存库存。</p>}
      {view.balances.map((balance) => <dl key={balance.id} className="batch-detail">
        <div><dt>SKU</dt><dd>{balance.sku.code} · {balance.sku.name}</dd></div>
        <div><dt>批次</dt><dd>{balance.batch.code}</dd></div>
        <div><dt>现存 / 预占 / 可用</dt><dd>{balance.onHand} / {balance.reserved} / {balance.available} 件</dd></div>
        <div><dt>质量</dt><dd>{balance.quality === 'HOLD' ? '待检 HOLD' : '已放行 RELEASED'}</dd></div>
        <div><dt>到期</dt><dd>{balance.batch.expiresAt ? new Date(balance.batch.expiresAt).toLocaleDateString() : '无到期日'}</dd></div>
      </dl>)}
    </>}
  </section>;
}
