import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useStore } from 'zustand';
import { ApiError } from '../api';
import { loadSnapshot, warehouseKey } from './data';
import { createSceneStore } from './scene-store';
import { zoneAppearance } from './zone-palette';
import { SceneBoundary } from './SceneBoundary';
import { findLocations, inventoryAppearance, locationViews, warningLocation } from './inventory-view';
import type { InventoryWarning, ZoneFilter } from './inventory-view';
import { InventoryDetails } from './InventoryDetails';
import { InventoryTable } from './InventoryTable';
import { NavigationDebug } from './NavigationDebug';

const WarehouseScene = lazy(() => import('./WarehouseScene').then((module) => ({ default: module.WarehouseScene })));

type Props = { userId: string; spaceId: string; warehouseId: string; name: string; onUnauthorized: () => void;
  initialBatchId?: string; warning?: InventoryWarning | null };

export function WarehouseView({ userId, spaceId, warehouseId, name, onUnauthorized, initialBatchId = '', warning = null }: Props) {
  // A route-keyed instance: switching warehouse/logout discards these UI choices.
  const [store] = useState(createSceneStore);
  const ui = useStore(store);
  const [sceneGeneration, setSceneGeneration] = useState(0);
  const [showNavigation, setShowNavigation] = useState(false);
  const [search, setSearch] = useState('');
  const [searchMessage, setSearchMessage] = useState('');
  const [searchIds, setSearchIds] = useState<string[]>([]);
  const [batchId, setBatchId] = useState(initialBatchId);
  const focusedWarning = useRef(false);
  const query = useQuery({
    queryKey: warehouseKey(userId, spaceId, warehouseId),
    queryFn: ({ signal }) => loadSnapshot(spaceId, warehouseId, signal),
    staleTime: 10000, gcTime: 0, retry: false, refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) onUnauthorized();
  }, [query.error, onUnauthorized]);
  const allViews = query.data ? locationViews(query.data, 'ALL', batchId) : [];
  const views = allViews.filter((view) => ui.zoneFilter === 'ALL' || view.location.kind === ui.zoneFilter);
  const selected = views.find((view) => view.location.id === ui.selectedLocationId);
  const cameraRequest = ui.cameraRequest.locationId && !views.some((view) => view.location.id === ui.cameraRequest.locationId)
    ? { ...ui.cameraRequest, locationId: null }
    : ui.cameraRequest;
  const batches = new Map(query.data?.inventory.balances.map((row) => [row.batch.id, `${row.sku.code} / ${row.batch.code}`]));
  const locatingWarning = Boolean(warning && initialBatchId && batchId === initialBatchId);
  const target = query.isSuccess && warning && locatingWarning ? warningLocation(query.data, batchId, warning) : undefined;
  const targetId = target?.id;
  useEffect(() => {
    if (targetId && !focusedWarning.current) {
      focusedWarning.current = true;
      store.getState().focusLocation(targetId);
    }
  }, [store, targetId]);
  return <section className="workspace" aria-label="仓库场景">
    <div className="view-heading"><div><p className="eyebrow">数据驱动 / 软件模拟设备</p><h1>{name}</h1></div>
      <button disabled={query.isFetching} onClick={() => { void query.refetch(); }}>刷新数据</button></div>
    {query.isPending ? <p role="status" className="empty-state">正在读取布局和库存…</p>
      : query.isError ? <div role="alert" className="error-state"><h2>仓库数据不可用</h2><p>{query.error.message}</p><p>场景与旧汇总已隐藏；不会使用默认库存。</p><button onClick={() => { void query.refetch(); }}>重试读取</button></div>
        : <>
          <div className="snapshot-meta"><span>布局 v{query.data.layout.layoutVersion.version} · {query.data.layout.locations.length} 个货位</span>
            <span>{query.isFetching ? '同步中，显示上次成功快照' : `数据时间 ${new Date(query.data.inventory.asOf).toLocaleTimeString()}`}</span></div>
          <div className="metrics" aria-label="库存汇总">
            {([['全仓现存', query.data.inventory.summary.onHand], ['可用', query.data.inventory.summary.available], ['预占', query.data.inventory.summary.reserved], ['待检', query.data.inventory.summary.hold]] as const)
              .map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}<small> 件</small></strong></div>)}
          </div>
          <div className="view-switch" aria-label="数据视图">
            <button aria-pressed={ui.viewMode === 'scene'} onClick={() => ui.setViewMode('scene')}>3D 场景</button>
            <button aria-pressed={ui.viewMode === 'list'} onClick={() => ui.setViewMode('list')}>2D 库存列表</button>
            <button aria-pressed={showNavigation} onClick={() => setShowNavigation((value) => !value)}>导航调试</button>
          </div>
          {showNavigation && <NavigationDebug layout={query.data.layout} />}
          <form className="location-search" onSubmit={(event) => {
            event.preventDefault();
            const visible = new Set(allViews.map((view) => view.location.id));
            const results = findLocations(query.data, search).filter((entry) => visible.has(entry.id));
            setSearchIds(results.map((entry) => entry.id));
            if (results.length === 1) { ui.focusLocation(results[0]!.id); setSearchMessage(`已定位 ${results[0]!.code}`); }
            else setSearchMessage(results.length ? `找到 ${results.length} 个货位，请选择。` : '未找到匹配货位，请检查编号、ID 或批次筛选。');
          }}><label>货位搜索<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="例如 R01-1-L1" maxLength={100} /></label><button>搜索并定位</button></form>
          {searchMessage && <p role="status">{searchMessage}</p>}
          {searchIds.length > 1 && <div className="search-results">{searchIds.slice(0, 20).map((id) => <button key={id} onClick={() => {
            ui.focusLocation(id); setSearchMessage(`已定位 ${query.data.layout.locations.find((entry) => entry.id === id)?.code}`); setSearchIds([]);
          }}>{query.data.layout.locations.find((entry) => entry.id === id)?.code}</button>)}</div>}
          <div className="scene-toolbar">
            <label><input type="checkbox" checked={ui.showZones} onChange={ui.toggleZones} />区域图层</label>
            <label><input type="checkbox" checked={ui.showServiceCells} onChange={ui.toggleServiceCells} />地面服务点</label>
            <label>参照货位 <select value={selected?.location.id ?? ''} onChange={(event) => ui.selectLocation(event.target.value || null)}>
              <option value="">不选中</option>{views.map(({ location }) => <option key={location.id} value={location.id}>{location.code}</option>)}
            </select></label>
            <label>区域筛选<select value={ui.zoneFilter} onChange={(event) => ui.setZoneFilter(event.target.value as ZoneFilter)}>
              <option value="ALL">全部区域</option>{Object.entries(zoneAppearance).map(([kind, entry]) => <option key={kind} value={kind}>{entry.name}</option>)}
            </select></label>
            <label>批次筛选<select value={batchId} onChange={(event) => {
              setBatchId(event.target.value);
              ui.selectLocation(null);
              ui.resetCamera();
              setSearchIds([]);
              setSearchMessage('');
            }}>
              <option value="">全部批次</option>
              {batchId && !batches.has(batchId) && <option value={batchId}>当前快照无此批次</option>}
              {[...batches].map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select></label>
            <label>相机视角<select value={ui.cameraMode} onChange={(event) => ui.setCameraMode(event.target.value === 'top' ? 'top' : 'perspective')}>
              <option value="perspective">自由透视</option><option value="top">俯视正交</option></select></label>
            <button onClick={ui.resetCamera}>重置相机</button>
            <button onClick={() => setSceneGeneration((value) => value + 1)}>重新载入场景</button>
          </div>
          <p className="view-note">显示 {views.length} / {query.data.layout.locations.length} 个货位。筛选只控制展示，货架障碍仍保留；顶部数字为全仓汇总。</p>
          {locatingWarning && <p role="status">{target ? `预警货位：${target.code}` : '当前快照没有可定位的预警货位。库存可能已经变化或位于虚拟在途库位。'}</p>}
          {ui.viewMode === 'scene' && views.length === 0 && <p role="status" className="empty-state">当前筛选没有货位。</p>}
          {ui.viewMode === 'scene' ? <div className="scene-canvas" aria-label="三维仓库"><SceneBoundary key={`${query.data.layout.layoutVersion.id}:${sceneGeneration}`}>
            <Suspense fallback={<p role="status" className="scene-fallback">正在载入 3D 场景…</p>}><WarehouseScene
              snapshot={query.data} views={views} showZones={ui.showZones} showServiceCells={ui.showServiceCells} selectedLocationId={selected?.location.id ?? null}
              zoneFilter={ui.zoneFilter} cameraMode={ui.cameraMode} cameraRequest={cameraRequest} onSelect={ui.selectLocation} /></Suspense>
          </SceneBoundary></div> : <InventoryTable views={views} selectedId={ui.selectedLocationId} onSelect={ui.selectLocation} onFocus={ui.focusLocation} />}
          <ul className="zone-legend" aria-label="库存状态图例">{Object.entries(inventoryAppearance).map(([key, entry]) => <li key={key}><i style={{ background: entry.color }} />{entry.name}</li>)}</ul>
          <p className="view-note">同位多状态按待检、预占、可用优先显示；不可分配包含到期库存。颜色同时配文字和数量。</p>
          <InventoryDetails view={selected} onClose={() => ui.selectLocation(null)} />
          <ul className="zone-legend" aria-label="区域图例">{Object.entries(zoneAppearance).map(([kind, value]) => <li key={kind}><i style={{ background: value.color }} />{value.name}</li>)}</ul>
          <p className="view-note">点选货位查看详情，拖动旋转，滚轮缩放。线框为空位；货位在货架内，地面圆环是服务点。无 WebGL 时可直接使用 2D 库存列表。</p>
          <p className="view-note">画面由 API 数据生成，设备为软件模拟；尚无机器人运动、任务或实时推送。</p>
        </>}
  </section>;
}
