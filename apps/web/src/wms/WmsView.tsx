import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { wmsReconciliationSchema, wmsSchema } from '@warehouse-twin/contracts';
import { ApiError, api } from '../api';

type Props = { userId: string; spaceId: string; warehouseId: string; name: string; onUnauthorized: () => void };
const movementLabels = {
  OPENING: '期初入账', RECEIPT: '收货', TRANSFER: '库内转移', DISPATCH: '发运', COUNT_ADJUSTMENT: '盘点调整',
};
const warningLabels = { EXPIRED: '已过期', EXPIRING: '7 天内到期', HOLD: '质检隔离' };

function scopeCheck<T extends { spaceId: string; warehouseId: string }>(value: T, spaceId: string, warehouseId: string) {
  if (value.spaceId !== spaceId || value.warehouseId !== warehouseId) throw new Error('台账响应归属不一致');
  return value;
}

export function WmsView({ userId, spaceId, warehouseId, name, onUnauthorized }: Props) {
  const [kind, setKind] = useState('');
  const [batchId, setBatchId] = useState('');
  const [movementBefore, setMovementBefore] = useState('');
  const [auditBefore, setAuditBefore] = useState('');
  const base = `/spaces/${spaceId}/warehouses/${warehouseId}`;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries({ kind, batchId, movementBefore, auditBefore })) if (value) search.set(key, value);
  const query = useQuery({
    queryKey: ['wms', userId, spaceId, warehouseId, search.toString()], gcTime: 0, retry: false,
    queryFn: async ({ signal }) => {
      const value = wmsSchema.parse(await api(`${base}/wms?${search}`, 'GET', undefined, signal));
      if ((value.batch?.id ?? '') !== batchId) throw new Error('批次详情响应不一致');
      return scopeCheck(value, spaceId, warehouseId);
    },
  });
  const reconciliation = useQuery({
    queryKey: ['wms-reconciliation', userId, spaceId, warehouseId], enabled: false, gcTime: 0, retry: false,
    queryFn: async ({ signal }) => scopeCheck(wmsReconciliationSchema.parse(
      await api(`${base}/wms/reconcile`, 'GET', undefined, signal),
    ), spaceId, warehouseId),
  });
  useEffect(() => {
    if ([query.error, reconciliation.error].some((error) => error instanceof ApiError && error.status === 401)) onUnauthorized();
  }, [query.error, reconciliation.error, onUnauthorized]);

  const result = reconciliation.data;
  const data = query.data;
  const warehouse = `/warehouses/${spaceId}/${warehouseId}`;
  return <section className="workspace inbound-workspace wms-workspace" aria-label="仓库台账">
    <div className="view-heading"><div><p className="eyebrow">流水 / 批次 / 审计</p><h1>{name} · 仓库台账</h1></div>
      <Link to={warehouse}>查看场景与库存</Link></div>
    <p><Link to={`${warehouse}/inbound`}>入库与质检</Link> · <Link to={`${warehouse}/outbound`}>出库与预占</Link></p>
    <button disabled={query.isFetching} onClick={() => { void query.refetch(); }}>刷新台账</button>
    {query.isPending ? <p role="status">正在读取台账…</p> : query.isError ? <p role="alert">{query.error.message}</p> : data && <>
      <p className="view-note">读取时间 {data.asOf}。每次翻页读取新的仓库快照。</p>
      <article className="inbound-order">
        <h2>库存预警</h2>
        <p className="view-note">仅统计有库存的批次。同一批次可同时出现隔离和到期预警。</p>
        {data.warnings.length === 0 ? <p>暂无预警。</p> : <ul>{data.warnings.map((warning) => (
          <li key={`${warning.batch.id}:${warning.type}`}>
            {warning.batch.skuCode} / {warning.batch.code} · {warningLabels[warning.type]} · {warning.quantity} 件
          </li>
        ))}</ul>}
      </article>
      <article className="inbound-order">
        <h2>批次详情与库存流水</h2>
        <fieldset>
          <label>批次<select value={batchId} onChange={(event) => { setBatchId(event.target.value); setMovementBefore(''); }}>
            <option value="">全部批次</option>
            {data.batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.skuCode} / {batch.code}</option>)}
          </select></label>
          <label>流水类型<select value={kind} onChange={(event) => { setKind(event.target.value); setMovementBefore(''); }}>
            <option value="">全部类型</option>
            {Object.entries(movementLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
        </fieldset>
        {data.batch && <section aria-label="批次详情">
          <h3>{data.batch.skuCode} / {data.batch.code}</h3>
          <p>生产 {data.batch.producedAt ?? '未记录'} · 到期 {data.batch.expiresAt ?? '未记录'}</p>
          {data.batch.balances.length === 0 ? <p>暂无余额。</p> :
            <table aria-label="批次余额"><thead><tr><th>货位</th><th>质量</th><th>现存</th><th>预占</th></tr></thead>
              <tbody>{data.batch.balances.map((row) => <tr key={row.id}>
                <td>{row.locationCode}</td><td>{row.quality}</td><td>{row.onHand}</td><td>{row.reserved}</td>
              </tr>)}</tbody></table>}
        </section>}
        {data.movements.length === 0 ? <p>没有符合筛选的流水。</p> :
          <table aria-label="库存流水"><thead><tr><th>时间 / 类型</th><th>批次</th><th>来源 → 目标</th><th>件数</th><th>原因 / 关联</th></tr></thead>
            <tbody>{data.movements.map((row) => <tr key={row.id}>
              <td>{row.createdAt}<br />{movementLabels[row.kind]}</td><td>{row.batch.skuCode} / {row.batch.code}</td>
              <td>{row.source ? `${row.source.code} (${row.source.quality})` : '外部'} → {row.destination ? `${row.destination.code} (${row.destination.quality})` : '外部'}</td>
              <td>{row.quantity}</td><td>{row.reason}<br /><small>{row.reference}</small></td>
            </tr>)}</tbody></table>}
        <button disabled={!movementBefore || query.isFetching} onClick={() => setMovementBefore('')}>最新流水</button>{' '}
        <button disabled={!data.movementBefore || query.isFetching} onClick={() => setMovementBefore(data.movementBefore ?? '')}>更早流水</button>
      </article>
      <article className="inbound-order">
        <h2>业务审计</h2>
        {data.audits.length === 0 ? <p>暂无审计记录。</p> :
          <table aria-label="业务审计"><thead><tr><th>时间</th><th>动作</th><th>操作者</th><th>原因 / 关联</th></tr></thead>
            <tbody>{data.audits.map((row) => <tr key={row.id}>
              <td>{row.createdAt}</td><td>{row.action}</td><td>{row.actor}</td><td>{row.reason}<br /><small>{row.correlationId ?? '—'}</small></td>
            </tr>)}</tbody></table>}
        <button disabled={!auditBefore || query.isFetching} onClick={() => setAuditBefore('')}>最新审计</button>{' '}
        <button disabled={!data.auditBefore || query.isFetching} onClick={() => setAuditBefore(data.auditBefore ?? '')}>更早审计</button>
      </article>
      <article className="inbound-order">
        <h2>库存对账</h2>
        <button disabled={reconciliation.isFetching} onClick={() => { void reconciliation.refetch(); }}>运行只读对账</button>
        {reconciliation.isFetching ? <p role="status">正在对账…</p> : reconciliation.isError ? <p role="alert">{reconciliation.error.message}</p> : result && <>
          <p role="status">{result.consistent ? '对账通过' : '发现库存差异'} · 现存 {result.mismatches.length} · 预占与运输 {result.reservationMismatches.length}</p>
          <p className="view-note">对账时间 {result.asOf}。差异仅供排查。</p>
          {(result.mismatches.length > 0 || result.reservationMismatches.length > 0) && <ul>
            {result.mismatches.map((row) => <li key={`${row.locationId}:${row.batchId}:${row.quality}`}>
              现存 {row.locationId} / {row.batchId} / {row.quality} · 实际 {row.actual}，应为 {row.expected}
            </li>)}
            {result.reservationMismatches.map((row) => <li key={`${row.kind}:${row.id}`}>
              {row.kind} {row.id} · 实际 {row.actual}，应为 {row.expected}
            </li>)}
          </ul>}
        </>}
      </article>
    </>}
  </section>;
}
