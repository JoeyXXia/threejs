import { useEffect, useMemo, useRef } from 'react';
import type { LayoutResponse } from '@warehouse-twin/contracts';
import { buildNavigationGrid, navigationCell } from './navigation';

const legend = [
  ['通道', '#e0e9e3'], ['货架', '#3e4d60'], ['墙或额外阻塞', '#95494d'],
  ['储位服务点', '#0d746b'], ['工作站', '#c77728'],
] as const;

export function NavigationDebug({ layout }: { layout: LayoutResponse }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const model = useMemo(() => {
    try { return { grid: buildNavigationGrid(layout), error: null }; }
    catch (error) { return { grid: null, error: error instanceof Error ? error.message : '导航网格不可用' }; }
  }, [layout]);
  const { grid } = model;
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!grid || !context) return;
    for (let z = 0; z < grid.depth; z++) {
      for (let x = 0; x < grid.width; x++) {
        context.fillStyle = legend[grid.cellAt({ x, z }) ?? navigationCell.WALL][1];
        context.fillRect(x, z, 1, 1);
      }
    }
  }, [grid]);

  return <section className="navigation-debug" aria-label="导航调试网格">
    <h2>导航调试网格</h2>
    {!grid ? <p role="alert">{model.error}</p> : <>
      <p>布局 v{grid.version} · {grid.width} × {grid.depth} · 可走 {grid.walkableCount} 格 · 连通分区 {grid.componentCount} · 合法服务货位 {grid.servicePoints.size}/{layout.locations.length}</p>
      {grid.componentCount !== 1 && <p role="status">{grid.componentCount ? '地图不连通，各分区之间无法四邻接通行。' : '地图没有可走格。'}</p>}
      {grid.invalidServices.length > 0 && <p role="alert">无合法服务点的货位：{grid.invalidServices.join('、')}</p>}
      <canvas ref={canvas} width={grid.width} height={grid.depth} role="img" aria-label="导航单元格分布图" />
      <p className="view-note">左上角为 (0, 0)，X 向右，Z 向下。地图外不可走。</p>
      <ul className="zone-legend" aria-label="导航图例">
        {legend.map(([label, color]) => <li key={label}><i style={{ background: color }} />{label}</li>)}
      </ul>
    </>}
  </section>;
}
