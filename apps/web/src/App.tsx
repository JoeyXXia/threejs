import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './api';
import { WarehouseView } from './warehouse/WarehouseView';
import { InboundView } from './inbound/InboundView';
import { OutboundView } from './outbound/OutboundView';
import { CountView } from './count/CountView';
import { WmsView } from './wms/WmsView';

type Warehouse = { id: string; spaceId: string; name: string; version: number; role: 'ADMIN' | 'OPERATOR' | 'VIEWER' };
type Session = { user: { id: string; email: string }; expiresAt: string; warehouses: Warehouse[] };

function parseSession(value: unknown): Session {
  if (!value || typeof value !== 'object') throw new Error('身份响应格式错误');
  const data = value as Partial<Session>;
  if (!data.user || typeof data.user.id !== 'string' || typeof data.user.email !== 'string'
    || typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt))
    || !Array.isArray(data.warehouses) || !data.warehouses.every((w) => w && typeof w.id === 'string'
      && typeof w.spaceId === 'string' && typeof w.name === 'string' && Number.isInteger(w.version)
      && ['ADMIN', 'OPERATOR', 'VIEWER'].includes(w.role))) throw new Error('身份响应格式错误');
  return data as Session;
}

const warehousePath = (warehouse: Warehouse) => `/warehouses/${warehouse.spaceId}/${warehouse.id}`;

function WarehouseRoute({ session, onUnauthorized, page = 'scene' }: {
  session: Session; onUnauthorized: () => void; page?: 'scene' | 'inbound' | 'outbound' | 'count' | 'wms';
}) {
  const { spaceId, warehouseId } = useParams();
  const { search } = useLocation();
  const warehouse = session.warehouses.find((entry) => entry.id === warehouseId && entry.spaceId === spaceId);
  if (!warehouse) return <section role="alert" className="error-state"><h1>仓库不可访问</h1><p>当前身份没有该仓库的访问权限。</p><Link to="/account">查看授权仓库</Link></section>;
  if (page === 'wms' && warehouse.role === 'VIEWER') return <section role="alert" className="error-state"><h1>仓库台账限管理员与操作员</h1>
    <Link to={warehousePath(warehouse)}>返回仓库场景</Link></section>;
  const props = { userId: session.user.id, spaceId: warehouse.spaceId, warehouseId: warehouse.id, name: warehouse.name, onUnauthorized };
  const key = `${session.user.id}:${warehouse.spaceId}:${warehouse.id}`;
  if (page === 'scene') {
    const params = new URLSearchParams(search);
    const warning = params.get('warning');
    return <WarehouseView key={key + search} {...props} initialBatchId={params.get('batch') ?? ''}
      warning={warning === 'HOLD' || warning === 'EXPIRED' || warning === 'EXPIRING' ? warning : null} />;
  }
  const View = { inbound: InboundView, outbound: OutboundView, count: CountView, wms: WmsView }[page];
  return <View key={key} {...props} />;
}

export function App() {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('admin@demo.local');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('正在检查会话…');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const forgetSession = useCallback(() => {
    generation.current++;
    void queryClient.cancelQueries();
    queryClient.clear();
    setSession(null);
    setMessage('会话已到期或失效，请重新登录。');
  }, [queryClient]);

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    api('/auth/me', 'GET', undefined, controller.signal).then((value) => {
      if (current === generation.current) { setSession(parseSession(value)); setMessage('会话已恢复'); }
    }).catch((error: unknown) => {
      if (current === generation.current) setMessage(error instanceof ApiError && error.status === 401 ? '请登录演示账户。' : 'API 未连接，请检查后端与数据库。');
    });
    return () => { generation.current++; controller.abort(); };
  }, []);

  useEffect(() => {
    if (!session) return;
    const timer = window.setTimeout(() => {
      forgetSession();
    }, Math.max(0, Date.parse(session.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [session, forgetSession]);

  async function action(work: () => Promise<void>) {
    setBusy(true); setMessage('处理中…');
    try { await work(); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) forgetSession();
      setMessage(error instanceof Error ? error.message : '请求失败');
    } finally { setBusy(false); }
  }

  function login(event: FormEvent) {
    event.preventDefault();
    void action(async () => {
      const current = ++generation.current;
      try {
        await api('/auth/login', 'POST', { email, password });
        queryClient.clear();
        const next = parseSession(await api('/auth/me'));
        if (current === generation.current) { setSession(next); setMessage('登录成功'); }
      } finally { setPassword(''); }
    });
  }

  function rename(event: FormEvent<HTMLFormElement>, warehouse: Warehouse) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void action(async () => {
      const current = generation.current;
      await api(`/spaces/${warehouse.spaceId}/warehouses/${warehouse.id}`, 'PATCH', {
        name: form.get('name'), reason: form.get('reason'), version: warehouse.version,
      });
      const next = parseSession(await api('/auth/me'));
      if (current === generation.current) { setSession(next); setMessage('仓库资料已保存并记录审计。'); }
    });
  }

  return <main className={session ? 'app-shell' : 'login-shell'}>
    <header><Link to="/" className="brand">WT / WarehouseTwin</Link><span>DAY 15 · 导航网格与服务点</span></header>
    {!session && <><p className="eyebrow">仓储业务 × 空间可视化</p>
      <h1>每一个位置，<br />都连接后端业务数据。</h1>
      <p className="intro">登录后读取仓库布局和批次库存，生成参数化 3D 场景。设备为软件模拟。</p></>}
    <p role="status">{message}</p>
    {!session ? <form onSubmit={login} className="auth-form">
      <label>邮箱<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required maxLength={254} /></label>
      <label>密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required maxLength={256} /></label>
      <button disabled={busy}>登录</button>
      <small>本地账户：admin / operator / viewer @demo.local；密码见本地 .env 的 DEMO_PASSWORD。</small>
    </form> : <>
      <section className="connection" aria-label="当前身份">
        <span>{session.user.email} · 到期时间 {new Date(session.expiresAt).toLocaleTimeString()}</span>
        <button disabled={busy} onClick={() => { void action(async () => {
          generation.current++;
          await api('/auth/logout', 'POST'); forgetSession(); setMessage('已退出，服务端会话已撤销。');
        }); }}>退出登录</button>
        <button disabled={busy} onClick={() => { void action(async () => {
          const current = generation.current;
          const next = parseSession(await api('/auth/me'));
          if (current === generation.current) { setSession(next); setMessage('已刷新仓库访问权限。'); }
        }); }}>刷新权限</button>
      </section>
      <div className="dashboard"><aside><p className="nav-label">获授权仓库</p><nav aria-label="主导航">
        {session.warehouses.map((warehouse) => <NavLink key={warehouse.id} to={warehousePath(warehouse)}>{warehouse.name}<small>{warehouse.role}</small></NavLink>)}
        {session.warehouses.map((warehouse) => <NavLink key={`inbound:${warehouse.id}`} to={`${warehousePath(warehouse)}/inbound`}>{warehouse.name} 入库与质检</NavLink>)}
        {session.warehouses.map((warehouse) => <NavLink key={`outbound:${warehouse.id}`} to={`${warehousePath(warehouse)}/outbound`}>{warehouse.name} 出库与预占</NavLink>)}
        {session.warehouses.map((warehouse) => <NavLink key={`count:${warehouse.id}`} to={`${warehousePath(warehouse)}/count`}>{warehouse.name} 盘点与审批</NavLink>)}
        {session.warehouses.filter((warehouse) => warehouse.role !== 'VIEWER').map((warehouse) => (
          <NavLink key={`wms:${warehouse.id}`} to={`${warehousePath(warehouse)}/wms`}>{warehouse.name} 仓库台账</NavLink>))}
        <NavLink to="/account">仓库资料</NavLink></nav><p className="view-note">库存来源：PostgreSQL<br />设备：软件模拟<br />更新方式：手动刷新</p></aside>
      <Routes>
        <Route path="/" element={<Navigate replace to={session.warehouses[0] ? warehousePath(session.warehouses[0]) : '/account'} />} />
        <Route path="/warehouses/:spaceId/:warehouseId" element={<WarehouseRoute session={session} onUnauthorized={forgetSession} />} />
        <Route path="/warehouses/:spaceId/:warehouseId/inbound" element={<WarehouseRoute session={session} onUnauthorized={forgetSession} page="inbound" />} />
        <Route path="/warehouses/:spaceId/:warehouseId/outbound" element={<WarehouseRoute session={session} onUnauthorized={forgetSession} page="outbound" />} />
        <Route path="/warehouses/:spaceId/:warehouseId/count" element={<WarehouseRoute session={session} onUnauthorized={forgetSession} page="count" />} />
        <Route path="/warehouses/:spaceId/:warehouseId/wms" element={<WarehouseRoute session={session} onUnauthorized={forgetSession} page="wms" />} />
        <Route path="/account" element={<section className="warehouse-list" aria-label="获授权仓库资料">
        <div><p className="eyebrow">账户 / 仓库资料</p><h1>访问与资料</h1></div>
        {session.warehouses.map((warehouse) => <article key={warehouse.id}>
          <small>{warehouse.role} · 版本 {warehouse.version}</small><h2>{warehouse.name}</h2>
          <p>空间 {warehouse.spaceId}<br />仓库 {warehouse.id}</p>
          <form onSubmit={(event) => rename(event, warehouse)} className="auth-form" key={`${warehouse.id}-${warehouse.version}`}>
            <label>仓库名称<input name="name" defaultValue={warehouse.name} maxLength={80} required disabled={warehouse.role === 'VIEWER' || busy} /></label>
            <label>修改原因<input name="reason" maxLength={200} required disabled={warehouse.role === 'VIEWER' || busy} /></label>
            <button disabled={warehouse.role === 'VIEWER' || busy}>保存资料</button>
            {warehouse.role === 'VIEWER' && <span>viewer 只有读取权限；服务端同样拒绝写入。</span>}
          </form>
        </article>)}
        {session.warehouses.length === 0 && <p>当前账户没有获授权仓库。</p>}
      </section>} />
        <Route path="*" element={<section className="error-state"><h1>页面不存在</h1><Link to="/">返回仓库</Link></section>} />
      </Routes></div>
    </>}
    <footer>WarehouseTwin · WMS 数据驱动的仓库演示。设备为软件模拟；未实现机器人运行、任务或实时推送。</footer>
  </main>;
}
