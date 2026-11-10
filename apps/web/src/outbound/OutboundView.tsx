import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createOutboundSchema } from '@warehouse-twin/contracts';
import { ApiError } from '../api';
import { refreshWarehouseViews } from '../warehouse/sync';
import { commandAttempts, loadOutbound, outboundKey, outboundPath, sendOutbound } from './data';

type Props = { userId: string; spaceId: string; warehouseId: string; name: string; onUnauthorized: () => void };
export function OutboundView({ userId, spaceId, warehouseId, name, onUnauthorized }: Props) {
  const client = useQueryClient(), key = outboundKey(userId, spaceId, warehouseId);
  const [message, setMessage] = useState(''), [selectedSkuId, setSelectedSkuId] = useState('');
  const attempts = useRef(commandAttempts());
  const lifecycle = useRef({ active: true, controller: new AbortController() });
  useEffect(() => {
    const current = { active: true, controller: new AbortController() }; lifecycle.current = current;
    return () => { current.active = false; current.controller.abort(); };
  }, []);
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => loadOutbound(spaceId, warehouseId, signal), retry: false, gcTime: 0, refetchOnWindowFocus: false });
  useEffect(() => { if (query.error instanceof ApiError && query.error.status === 401) onUnauthorized(); }, [query.error, onUnauthorized]);
  const mutation = useMutation({
    mutationFn: async ({ path, payload }: { path: string; payload: object }) => {
      const current = lifecycle.current;
      const requestKey = attempts.current.forRequest(path, payload);
      const result = await sendOutbound(path, { ...payload, key: requestKey }, spaceId, warehouseId, current.controller.signal);
      if (current.active) {
        attempts.current.completed();
        await refreshWarehouseViews(client, userId, spaceId, warehouseId, key);
      }
      return { result, active: current.active };
    },
    onSuccess: ({ result, active }) => { if (active) setMessage(result.status === 'ALLOCATED' ? '整单预占已提交；现存数量不变，库存已重新读取。' : '出库单已创建，尚未预占。'); },
    onError: (error) => { if (!lifecycle.current.active) return; if (error instanceof ApiError && error.status === 401) onUnauthorized(); else setMessage(`${error.message}。结果不确定时请保持原参数重试，或刷新核对单据。`); },
  });
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const parsed = createOutboundSchema.safeParse({ key: 'validate-only', skuId: form.get('skuId'), batchId: form.get('batchId'), quantity: Number(form.get('quantity')), reason: form.get('reason') });
    if (!parsed.success) { setMessage('请选择 SKU 与单一批次，填写正整数数量和创建原因。'); return; }
    const { skuId, batchId, quantity, reason } = parsed.data;
    mutation.mutate({ path: outboundPath(spaceId, warehouseId), payload: { skuId, batchId, quantity, reason } });
  }
  const skuId = selectedSkuId || query.data?.skus[0]?.id || '';
  const recommendations = query.data?.recommendations.filter((row) => row.skuId === skuId) ?? [];
  return <section className="workspace inbound-workspace" aria-label="出库与预占">
    <div className="view-heading"><div><p className="eyebrow">出库 / 批次 / 分配</p><h1>{name} · 出库与预占</h1></div><Link to={`/warehouses/${spaceId}/${warehouseId}`}>查看场景与库存</Link></div>
    <p className="view-note">一单一个 SKU / 批次。创建不占库存，确认后全量预占；不搬运、不发运、不减少现存。当前不支持取消或自动释放。</p>
    {message && <p role="status">{message}</p>}
    <button disabled={query.isFetching || mutation.isPending} onClick={() => { void query.refetch(); }}>刷新出库与推荐</button>
    {query.isPending ? <p role="status">正在读取出库单…</p> : query.isError ? <p role="alert">出库数据不可用：{query.error.message}</p> : <>
      {query.data.role === 'VIEWER' && <p>当前为只读账户，可查看出库与分配记录。</p>}
      <form className="inbound-form" aria-label="创建出库单" onSubmit={create}>
        <h2>创建出库单</h2><fieldset disabled={query.data.role === 'VIEWER' || mutation.isPending}>
          <label>商品 SKU<select name="skuId" value={skuId} onChange={(event) => setSelectedSkuId(event.target.value)} required>{query.data.skus.map((sku) => <option key={sku.id} value={sku.id}>{sku.code}</option>)}</select></label>
          <label>批次（FEFO 推荐顺序）<select key={skuId} name="batchId" required>{recommendations.map((row) => <option key={row.batchId} value={row.batchId}>{row.batchCode} · 储存区可分配 {row.available} 件 · 到期 {row.expiresAt ?? '无到期日'}</option>)}</select></label>
          <label>数量（件）<input name="quantity" type="number" min={1} max={1000000} step={1} required defaultValue={1} /></label>
          <label>创建原因<input name="reason" maxLength={200} required /></label>
          <button disabled={!recommendations.length}>创建出库单</button>
        </fieldset>
        <p className="view-note">推荐仅含当前布局 STORAGE 的已放行未过期库存；QC 已放行量也不计入。按到期时间升序、无到期日排后，同日期按批次 ID 固定排序。推荐时间：{query.data.asOf}。提交时重新检查，不足提示拆单，不自动跨批。</p>
        {!recommendations.length && <p>当前 SKU 暂无储存区可分配批次；全仓可用量与这里的来源范围不同。</p>}
      </form>
      <h2>出库记录</h2>{query.data.hasMore && <p>仅显示最近 100 单，更早记录暂不在此页面展示。</p>}
      {!query.data.orders.length && <p>暂无出库单。</p>}
      {query.data.orders.map((order) => <article className="inbound-order" key={order.id} aria-label={`出库单 ${order.id}`}>
        <h3>{order.batchCode} · {{ CREATED: '待预占', ALLOCATED: '已预占', DISPATCHED: '已发运' }[order.status]}</h3>
        <p>{order.skuCode} · {order.quantity} 件 · 到期 {order.expiresAt ?? '无到期日'}</p><small>单据 ID：{order.id}</small>
        <p>创建人：{order.createdById} · {order.createdAt} · {order.reason}</p>
        {order.allocatedAt && <p>预占人：{order.allocatedById} · {order.allocatedAt} · {order.allocationReason}</p>}
        {order.status === 'CREATED' && <form aria-label={`预占 ${order.id}`} onSubmit={(event) => {
          event.preventDefault(); const form = new FormData(event.currentTarget);
          mutation.mutate({ path: `${outboundPath(spaceId, warehouseId)}/${order.id}/allocate`, payload: { reason: form.get('reason') } });
        }}><fieldset disabled={query.data.role === 'VIEWER' || mutation.isPending}>
          <label>预占原因<input name="reason" required maxLength={200} /></label><button>确认全量预占</button>
        </fieldset></form>}
        {order.allocations.length > 0 && <table aria-label={`分配明细 ${order.id}`}><thead><tr><th>来源货位</th><th>预占（件）</th><th>余额 ID</th></tr></thead>
          <tbody>{order.allocations.map((row) => <tr key={row.id}><td>{row.locationCode}</td><td>{row.quantity}</td><td>{row.balanceId}</td></tr>)}</tbody></table>}
      </article>)}
    </>}
  </section>;
}
