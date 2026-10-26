/**
 * API 客户端：面板所有后端调用的唯一入口。
 *
 * 与旧 app.js 的 api() 保持同一契约（错误上挂 status、401 触发密钥弹窗），
 * 因为后端 /panel/api/* 的错误形状已经定型，重写前端不该顺带改协议。
 */

/** 主题偏好键。theme.js（首屏预热）读的是同一个键，两边必须一致。 */
export const LS_THEME = 'wb2api.theme'

/** api() 抛出的错误；status 供调用方区分「可重试抖动」与「终态」。 */
export class ApiError extends Error {
  status: number
  body: unknown
  constructor(message: string, status: number, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export type ApiOpts = {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

/** 401 时的回调：由 App 注入（重新查询登录态，切回登录页）。 */
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn
}

/**
 * 发一次面板 API 请求。
 *
 * path 不含 /panel/api/ 前缀（与旧实现一致）：调用方写 'overview'、'client_keys/x/rotate'。
 */
export async function api<T = any>(path: string, opts: ApiOpts = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers || {}) }
  if (opts.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }

  // credentials: 'same-origin' —— 面板会话是 HttpOnly Cookie，必须显式带上。
  // （fetch 默认就是 same-origin，这里写出来是为了不让后人误以为是 cross-origin 调用。）
  const res = await fetch('/panel/api/' + path, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    credentials: 'same-origin',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  })

  if (res.status === 401) {
    // 会话过期或未登录：交给 App 重新查询登录态并切回登录页。
    onUnauthorized?.()
    throw new ApiError('登录已失效，请重新登录', 401)
  }

  const text = await res.text()
  let data: any = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      // 非 JSON（网关错误页 / 反代 502 HTML）：把原文截断后带进错误信息，
      // 否则调用方只能看到「HTTP 502」而不知道是反代还是应用。
      data = { error: text.slice(0, 300) }
    }
  }

  if (!res.ok) {
    throw new ApiError(data?.error || `HTTP ${res.status}`, res.status, data)
  }
  return data as T
}

/**
 * 上传 multipart 表单（目前只有「JSON 导入账号」用到）。
 *
 * 单独一个函数而不是给 api() 加分支：FormData 必须让浏览器自己设
 * Content-Type（要带 boundary），一旦手写 header 就拿不到 boundary，
 * 服务端解析会直接失败。把这条约束关在一个函数里，比散在调用点上安全。
 */
export async function postForm<T = any>(path: string, form: FormData): Promise<T> {
  const res = await fetch('/panel/api/' + path, {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  })
  if (res.status === 401) {
    onUnauthorized?.()
    throw new ApiError('登录已失效，请重新登录', 401)
  }
  const text = await res.text()
  let data: any = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { error: text.slice(0, 300) }
    }
  }
  if (!res.ok) {
    throw new ApiError(data?.error || `HTTP ${res.status}`, res.status, data)
  }
  return data as T
}
