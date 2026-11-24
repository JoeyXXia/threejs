const labels = {
  connected: '实时同步正常',
  syncing: '同步中 · 正在核对已提交事件和快照',
  offline: '离线 · 如有缓存，仅显示最后确认状态',
  stale: '数据陈旧 · 同步失败，请重试',
  denied: '已失去仓库访问权限',
};
export function RealtimeStatus({ status, after }: { status: keyof typeof labels; after: number | undefined }) {
  return <p className="view-note" data-testid="warehouse-realtime" data-status={status} data-after={after}>
    {labels[status]}{after !== undefined ? ` · seq ${after}` : ''}
  </p>;
}
