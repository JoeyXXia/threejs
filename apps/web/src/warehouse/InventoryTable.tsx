import { inventoryAppearance } from './inventory-view';
import type { LocationView } from './inventory-view';

export function InventoryTable({ views, selectedId, onSelect, onFocus }: {
  views: LocationView[]; selectedId: string | null; onSelect: (id: string) => void; onFocus: (id: string) => void;
}) {
  return <div className="inventory-table-wrap"><table aria-label="2D库存列表"><thead><tr>
    <th scope="col">货位</th><th scope="col">状态</th><th scope="col">现存</th><th scope="col">预占</th><th scope="col">可用</th><th scope="col">操作</th>
  </tr></thead><tbody>{views.map((view) => <tr key={view.location.id} aria-selected={selectedId === view.location.id}>
    <th scope="row"><button onClick={() => onSelect(view.location.id)} aria-label={`选择 ${view.location.code}`}>{view.location.code}</button></th>
    <td>{inventoryAppearance[view.status].name}</td><td>{view.total.onHand}</td><td>{view.total.reserved}</td><td>{view.total.available}</td>
    <td><button onClick={() => onFocus(view.location.id)} aria-label={`定位 ${view.location.code}`}>3D 定位</button></td>
  </tr>)}</tbody></table>{views.length === 0 && <p>当前筛选没有货位。</p>}</div>;
}
