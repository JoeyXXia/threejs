export class ApiError extends Error {
  constructor(public status: number, detail?: string) {
    super(detail ?? (status === 401 ? '会话已失效，请重新登录。'
      : status === 403 ? '当前操作没有权限，或请求来源无效。'
        : status === 404 ? '仓库不可访问或尚未配置布局。'
          : status === 409 ? '资料已变化，请刷新后重试。'
            : status === 429 ? '尝试次数过多，请稍后重试。' : '请求失败，请检查服务状态。'));
  }
}

export async function api(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'WarehouseTwin' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    let detail: string | undefined;
    if ([400, 409].includes(response.status)) {
      const error: unknown = await response.json().catch(() => null);
      if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message.length <= 200) detail = error.message;
    }
    throw new ApiError(response.status, detail);
  }
  return response.json();
}
