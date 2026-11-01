import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

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

class ApiError extends Error {
  constructor(public status: number) {
    super(status === 401 ? '会话失效或凭据错误，请重新登录。'
      : status === 403 ? '当前操作没有权限，或请求来源无效。'
        : status === 409 ? '仓库资料已变化，请刷新后重试。'
          : status === 429 ? '尝试次数过多，请稍后重试。' : '请求失败，请检查输入或服务状态。');
  }
}

async function api(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'WarehouseTwin' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new ApiError(response.status);
  return response.json();
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('admin@demo.local');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('正在检查会话…');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    api('/auth/me').then((value) => {
      if (current === generation.current) { setSession(parseSession(value)); setMessage('会话已恢复'); }
    }).catch((error: unknown) => {
      if (current === generation.current) setMessage(error instanceof ApiError && error.status === 401 ? '请登录演示账户。' : 'API 未连接，请检查后端与数据库。');
    });
    return () => { generation.current++; };
  }, []);

  useEffect(() => {
    if (!session) return;
    const timer = window.setTimeout(() => {
      generation.current++; setSession(null); setMessage('会话已到期，请重新登录。');
    }, Math.max(0, Date.parse(session.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [session]);

  async function action(work: () => Promise<void>) {
    setBusy(true); setMessage('处理中…');
    try { await work(); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) { generation.current++; setSession(null); }
      setMessage(error instanceof Error ? error.message : '请求失败');
    } finally { setBusy(false); }
  }

  function login(event: FormEvent) {
    event.preventDefault();
    void action(async () => {
      const current = ++generation.current;
      try {
        await api('/auth/login', 'POST', { email, password });
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

  return <main>
    <header><span className="brand">WT / WarehouseTwin</span><span>DAY 02 · 仓库访问</span></header>
    <p className="eyebrow">仓储业务 × 空间可视化</p>
    <h1>从身份开始，<br />明确每个仓库的边界。</h1>
    <p className="intro">演示账户仅能访问获授权的空间与仓库。数据库保存用户、会话和审计；设备为软件模拟。</p>
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
          await api('/auth/logout', 'POST'); setSession(null); setMessage('已退出，服务端会话已撤销。');
        }); }}>退出登录</button>
        <button disabled={busy} onClick={() => { void action(async () => {
          const current = generation.current;
          const next = parseSession(await api('/auth/me'));
          if (current === generation.current) { setSession(next); setMessage('已刷新仓库访问权限。'); }
        }); }}>刷新权限</button>
      </section>
      <section className="warehouse-list" aria-label="获授权仓库">
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
      </section>
    </>}
    <footer>当前页面提供身份与仓库资料；Day 3 已接入布局和库存只读 API，尚无 3D 场景或机器人运行数据。</footer>
  </main>;
}
