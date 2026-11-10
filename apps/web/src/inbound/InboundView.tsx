import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createInboundSchema } from '@warehouse-twin/contracts';
import type { InboundOrderResponse } from '@warehouse-twin/contracts';
import { ApiError } from '../api';
import { refreshWarehouseViews } from '../warehouse/sync';
import { commandAttempts, inboundKey, inboundPath, loadInbound, sendInbound } from './data';

type Props = { userId: string; spaceId: string; warehouseId: string; name: string; onUnauthorized: () => void };
const statusNames = { CREATED: '待收货', RECEIVED: '待质检 / HOLD', PASSED: '质检通过', REJECTED: '质检拒绝 / HOLD' };
export function InboundView({ userId, spaceId, warehouseId, name, onUnauthorized }: Props) {
  const client = useQueryClient(), key = inboundKey(userId, spaceId, warehouseId);
  const [message, setMessage] = useState('');
  const attempts = useRef(commandAttempts());
  const lifecycle = useRef({ active: true, controller: new AbortController() });
  useEffect(() => {
    const current = { active: true, controller: new AbortController() }; lifecycle.current = current;
    return () => { current.active = false; current.controller.abort(); };
  }, []);
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => loadInbound(spaceId, warehouseId, signal), retry: false, gcTime: 0, refetchOnWindowFocus: false });
  useEffect(() => { if (query.error instanceof ApiError && query.error.status === 401) onUnauthorized(); }, [query.error, onUnauthorized]);
  const mutation = useMutation({
    mutationFn: async ({ path, payload }: { path: string; payload: object }) => {
      const current = lifecycle.current;
      const requestKey = attempts.current.forRequest(path, payload);
      const result = await sendInbound(path, { ...payload, key: requestKey }, spaceId, warehouseId, current.controller.signal);
      if (current.active) {
        attempts.current.completed();
        // Never write inventory optimistically; read committed server state again.
        await refreshWarehouseViews(client, userId, spaceId, warehouseId, key);
      }
      return { result, active: current.active };
    },
    onSuccess: ({ result, active }) => { if (active) setMessage(`操作已提交：${statusNames[result.status]}。库存以重新读取结果为准。`); },
    onError: (error) => { if (!lifecycle.current.active) return; if (error instanceof ApiError && error.status === 401) onUnauthorized(); else setMessage(`${error.message}。如请求结果不确定，请保持参数不变重试，或刷新查看单据。`); },
  });
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const produced = String(form.get('produced') ?? ''), expires = String(form.get('expires') ?? '');
    const parsed = createInboundSchema.safeParse({ key: 'validate-only', skuId: form.get('skuId'), qcLocationId: form.get('qcLocationId'),
      batchCode: form.get('batchCode'), quantity: Number(form.get('quantity')), reason: form.get('reason'),
      producedAt: produced ? `${produced}T00:00:00.000Z` : null, expiresAt: expires ? `${expires}T00:00:00.000Z` : null });
    if (!parsed.success) { setMessage('请填写合法 SKU、QC 货位、正整数数量和原因；生产日期须早于到期日。'); return; }
    const data = parsed.data;
    mutation.mutate({ path: inboundPath(spaceId, warehouseId), payload: { skuId: data.skuId, qcLocationId: data.qcLocationId,
      batchCode: data.batchCode, quantity: data.quantity, reason: data.reason, producedAt: data.producedAt, expiresAt: data.expiresAt } });
  }
  function phase(event: FormEvent<HTMLFormElement>, order: InboundOrderResponse) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const payload = order.status === 'CREATED' ? { reason: form.get('reason') } : { reason: form.get('reason'), decision: form.get('decision') };
    mutation.mutate({ path: `${inboundPath(spaceId, warehouseId)}/${order.id}/${order.status === 'CREATED' ? 'receive' : 'inspect'}`, payload });
  }
  const writable = query.data?.role !== 'VIEWER';
  return <section className="workspace inbound-workspace" aria-label="入库与质检">
    <div className="view-heading"><div><p className="eyebrow">入库 / 批次 / 质量</p><h1>{name} · 入库与质检</h1></div><Link to={`/warehouses/${spaceId}/${warehouseId}`}>查看场景与库存</Link></div>
    <p className="view-note">一单一个 SKU / 批次，一次全量收货与质检。收货进入 QC 的 HOLD；拒绝仍隔离，通过只改变质量，不移动货位。</p>
    {message && <p role="status">{message}</p>}
    <button disabled={query.isFetching || mutation.isPending} onClick={() => { void query.refetch(); }}>刷新入库单</button>
    {query.isPending ? <p role="status">正在读取入库单…</p> : query.isError ? <p role="alert">入库数据不可用：{query.error.message}</p> : <>
      {query.data.role === 'VIEWER' && <p>当前为只读账户，可查看入库与质检记录。</p>}
      <form className="inbound-form" aria-label="创建入库单" onSubmit={create}>
        <h2>创建入库单</h2><fieldset disabled={!writable || mutation.isPending}>
          <label>商品 SKU<select name="skuId" required>{query.data.skus.map((sku) => <option key={sku.id} value={sku.id}>{sku.code}</option>)}</select></label>
          <label>批次编号<input name="batchCode" required maxLength={80} /></label>
          <label>收货 QC 货位<select name="qcLocationId" required>{query.data.qcLocations.map((location) => <option key={location.id} value={location.id}>{location.code}</option>)}</select></label>
          <label>数量（件）<input name="quantity" type="number" required min={1} max={1000000} step={1} defaultValue={1} /></label>
          <label>生产日期（可选，UTC）<input name="produced" type="date" /></label>
          <label>到期日（可选，UTC 零点起到期）<input name="expires" type="date" /></label>
          <label>创建原因<input name="reason" required maxLength={200} /></label>
          <button disabled={!query.data.skus.length || !query.data.qcLocations.length}>创建入库单</button>
        </fieldset><p className="view-note">同一批次已有日期不得覆盖；已过期可隔离收货，但不能质检放行。日期按 UTC 零点提交。</p>
      </form>
      <h2>入库记录</h2>{query.data.hasMore && <p>仅显示最近 100 单，更早记录暂不在此页面展示。</p>}
      {query.data.orders.length === 0 && <p>暂无入库单。</p>}
      {query.data.orders.map((order) => <article className="inbound-order" key={order.id} aria-label={`入库单 ${order.batchCode} ${order.id}`}>
        <h3>{order.batchCode} · {statusNames[order.status]}</h3>
        <p>{order.skuCode} · {order.quantity} 件 · {order.qcCode} · 版本 {order.version}</p><small>单据 ID：{order.id}</small>
        <p>生产：{order.producedAt ?? '未填写'} / 到期：{order.expiresAt ?? '无到期日'}</p>
        <p>创建人：{order.createdById} · {order.createdAt} · {order.reason}</p>
        {order.receivedAt && <p>收货人：{order.receivedById} · {order.receivedAt} · {order.receiptReason}</p>}
        {order.inspectedAt && <p>质检人：{order.inspectedById} · {order.inspectedAt} · {order.inspectionReason}</p>}
        {(order.status === 'CREATED' || order.status === 'RECEIVED') && <form onSubmit={(event) => phase(event, order)} aria-label={`${order.status === 'CREATED' ? '收货' : '质检'} ${order.id}`}>
          <fieldset disabled={!writable || mutation.isPending}>
            {order.status === 'RECEIVED' && <label>质检决定<select name="decision"><option value="PASS">通过</option><option value="REJECT">拒绝，保持 HOLD</option></select></label>}
            <label>操作原因<input name="reason" required maxLength={200} /></label>
            <button>{order.status === 'CREATED' ? '确认全量收货' : '提交全量质检'}</button>
          </fieldset>
        </form>}
      </article>)}
    </>}
  </section>;
}
