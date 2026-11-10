import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { countListSchema, countOrderSchema } from '@warehouse-twin/contracts';
import type { CountOrderResponse } from '@warehouse-twin/contracts';
import { ApiError, api } from '../api';
import { commandAttempts } from '../inbound/data';
import { refreshWarehouseViews } from '../warehouse/sync';

type Props = { userId: string; spaceId: string; warehouseId: string; name: string; onUnauthorized: () => void };
const statusNames = { OPEN: '待录数', SUBMITTED: '待审批', APPROVED: '已批准', REJECTED: '已拒绝' };
const actions = { submit: '提交实数', approve: '批准并调整库存', reject: '拒绝并解冻' };

export function CountView({ userId, spaceId, warehouseId, name, onUnauthorized }: Props) {
  const client = useQueryClient();
  const key = ['count-orders', userId, spaceId, warehouseId];
  const path = `/spaces/${spaceId}/warehouses/${warehouseId}/count-orders`;
  const [message, setMessage] = useState('');
  const attempts = useRef(commandAttempts());
  const lifecycle = useRef({ active: true, controller: new AbortController() });
  useEffect(() => {
    const current = { active: true, controller: new AbortController() };
    lifecycle.current = current;
    return () => { current.active = false; current.controller.abort(); };
  }, []);
  const query = useQuery({
    queryKey: key, retry: false, gcTime: 0,
    queryFn: async ({ signal }) => {
      const value = countListSchema.parse(await api(path, 'GET', undefined, signal));
      if (value.spaceId !== spaceId || value.warehouseId !== warehouseId
        || value.orders.some((row) => row.spaceId !== spaceId || row.warehouseId !== warehouseId)) {
        throw new Error('盘点响应归属不一致');
      }
      return value;
    },
  });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) onUnauthorized();
  }, [query.error, onUnauthorized]);

  const mutation = useMutation({
    mutationFn: async ({ suffix, payload }: { suffix: string; payload: object }) => {
      const current = lifecycle.current;
      const target = `${path}${suffix}`;
      const requestKey = attempts.current.forRequest(target, payload);
      const result = countOrderSchema.parse(await api(target, 'POST', { ...payload, key: requestKey }, current.controller.signal));
      if (result.spaceId !== spaceId || result.warehouseId !== warehouseId) throw new Error('盘点操作响应归属不一致');
      if (current.active) {
        attempts.current.completed();
        await refreshWarehouseViews(client, userId, spaceId, warehouseId, key, true);
      }
      return { result, current };
    },
    onSuccess: ({ result, current }) => {
      if (current.active) setMessage(`盘点操作已提交，状态为${statusNames[result.status]}。`);
    },
    onError: (error) => {
      if (!lifecycle.current.active) return;
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else setMessage(`${error.message} 结果不确定时可用原参数重试，或刷新确认。`);
    },
  });

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    mutation.mutate({ suffix: '', payload: { locationId: form.get('locationId'), reason: form.get('reason') } });
  }

  function phase(event: FormEvent<HTMLFormElement>, order: CountOrderResponse, action: keyof typeof actions) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const reason = form.get('reason');
    const payload = action === 'submit' ? {
      reason, lines: order.lines.map(({ balanceId }) => ({ balanceId, actual: Number(form.get(balanceId)) })),
    } : { reason };
    mutation.mutate({ suffix: `/${order.id}/${action}`, payload });
  }

  const data = query.data;
  return <section className="workspace inbound-workspace" aria-label="盘点与审批">
    <div className="view-heading">
      <div><p className="eyebrow">盘点 / 差异 / 审批</p><h1>{name} · 盘点与审批</h1></div>
      <Link to={`/warehouses/${spaceId}/${warehouseId}`}>查看场景与库存</Link>
    </div>
    <p className="view-note">开盘后冻结单一储位或出库暂存位。逐项录入实数，管理员批准后过账。发现账外物品时，在录数说明中记录，待确认归属后处理。</p>
    {message && <p role="status">{message}</p>}
    <button disabled={query.isFetching || mutation.isPending} onClick={() => { void query.refetch(); }}>刷新盘点</button>
    {query.isPending ? <p role="status">正在读取盘点单…</p> : query.isError ? <p role="alert">盘点数据不可用：{query.error.message}</p> : data && <>
      {data.role === 'VIEWER' ? <p>当前为只读账户。</p> : <form className="inbound-form" aria-label="开始盘点" onSubmit={create}>
        <h2>开始盘点</h2>
        <fieldset disabled={mutation.isPending}>
          <label>货位<select name="locationId" required defaultValue="">
            <option value="" disabled>请选择货位</option>
            {data.locations.map((location) => <option key={location.id} value={location.id} disabled={location.frozen}>
              {location.code}{location.frozen ? ' · 盘点冻结' : ''}
            </option>)}
          </select></label>
          <label>开盘原因<input name="reason" required maxLength={200} /></label>
          <button disabled={!data.locations.some((location) => !location.frozen)}>开始并冻结货位</button>
        </fieldset>
      </form>}
      <h2>盘点记录</h2>
      <p className="view-note">显示活动盘点和最近 100 张已结单。</p>
      {!data.orders.length && <p>暂无盘点单。</p>}
      {data.orders.map((order) => <article className="inbound-order" key={order.id} aria-label={`盘点单 ${order.id}`}>
        <h3>{order.locationCode} · {statusNames[order.status]}</h3>
        <small>{order.createdAt}</small>
        {order.submissionNote && <p>录数说明：{order.submissionNote}</p>}
        {order.lines.length ? <table aria-label="盘点明细"><thead><tr><th>SKU / 批次 / 质量</th><th>账面</th><th>实数</th><th>差异</th></tr></thead>
          <tbody>{order.lines.map((row) => <tr key={row.balanceId}>
            <td>{row.skuCode} / {row.batchCode} / {row.quality}</td>
            <td>{row.expected}</td><td>{row.actual ?? '待录数'}</td><td>{row.actual === null ? '—' : row.actual - row.expected}</td>
          </tr>)}</tbody>
        </table> : <p>此货位开盘时没有账面余额行。</p>}
        {order.status === 'OPEN' && data.role !== 'VIEWER' && <form aria-label="录入实数" onSubmit={(event) => phase(event, order, 'submit')}>
          <fieldset disabled={mutation.isPending}>
            {order.lines.map((row) => <label key={row.balanceId}>{row.skuCode} / {row.batchCode} / {row.quality} 实数
              <input type="number" name={row.balanceId} min={0} max={2147483647} step={1} required />
            </label>)}
            <label>录数说明<input name="reason" required maxLength={200} /></label>
            <button>{actions.submit}</button>
          </fieldset>
        </form>}
        {data.role === 'ADMIN' && (order.status === 'OPEN' || order.status === 'SUBMITTED') && (
          (order.status === 'SUBMITTED' ? ['approve', 'reject'] as const : ['reject'] as const).map((action) => (
            <form key={action} aria-label={actions[action]} onSubmit={(event) => phase(event, order, action)}>
              <fieldset disabled={mutation.isPending}>
                <label>{action === 'approve' ? '批准原因' : '拒绝原因'}<input name="reason" required maxLength={200} /></label>
                <button>{actions[action]}</button>
              </fieldset>
            </form>
          ))
        )}
      </article>)}
    </>}
  </section>;
}
