import { useEffect, useState } from 'react';

type Connection = 'checking' | 'online' | 'offline';
const labels: Record<Connection, string> = {
  checking: '正在连接 API…',
  online: 'API 已连接 · /health',
  offline: 'API 未连接，请检查后端服务',
};

function isHealthy(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && 'status' in value && value.status === 'ok'
    && 'service' in value && value.service === 'warehouse-twin-api'
    && 'devices' in value && value.devices === 'simulated';
}

export function App() {
  const [connection, setConnection] = useState<Connection>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    let active = true;
    setConnection('checking');
    async function checkHealth() {
      try {
        const response = await fetch('/api/health', { signal: controller.signal });
        if (!response.ok || !isHealthy(await response.json())) throw new Error('Invalid health response');
        if (active) setConnection('online');
      } catch {
        if (active) setConnection('offline');
      } finally {
        window.clearTimeout(timeout);
      }
    }
    void checkHealth();
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [attempt]);

  return (
    <main>
      <header><span className="brand">WT / WarehouseTwin</span><span>DAY 01 · 工程起点</span></header>
      <p className="eyebrow">仓储业务 × 空间可视化</p>
      <h1>让每一次搬运，<br />都有据可查。</h1>
      <p className="intro">WMS 业务驱动的智能仓库数字孪生演示系统。今天建立范围、坐标约定与前后端工程骨架。</p>
      <section className="connection" aria-label="服务连接">
        <p role="status" data-connection={connection}>{labels[connection]}</p>
        <button onClick={() => setAttempt((value) => value + 1)}>重新检查</button>
      </section>
      <section className="modules" aria-label="规划中的模块">
        {[
          ['01 / WMS', '库存与业务', '收货、质检、预占、搬运、发运；以后端持久化记录为权威。'],
          ['02 / SIMULATION', '设备与调度', '软件模拟机器人，四邻接网格步进；不接入真实设备。'],
          ['03 / SYNC', '实时与回放', '投递已提交事件，以历史快照与记录重建过程。'],
          ['04 / WEB', '业务与场景', 'React 管理界面，R3F 连接 Three.js；前端展示业务状态。'],
        ].map(([number, title, text]) => (
          <article key={number}><small>{number}</small><h2>{title}</h2><p>{text}</p></article>
        ))}
      </section>
      <footer>当前仅有服务存活检查，尚无库存、数据库、3D 场景或机器人运行数据。设备始终为软件模拟。</footer>
    </main>
  );
}
