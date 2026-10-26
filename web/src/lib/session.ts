/**
 * 登录态：账号密码 → 服务端会话 Cookie。
 *
 * 与旧版的区别：以前是「把 api_key 存进 localStorage、每个请求带 Bearer」。
 * 现在改为登录换取 HttpOnly Cookie——密码不落在浏览器里，JS 也读不到会话令牌
 * （XSS 偷不走），刷新不掉线，登出即失效。
 */
import { useCallback, useEffect, useState } from 'react'

export type Session = {
  logged_in: boolean
  auth_required: boolean
  user?: string
  expires_at?: string
  reason?: string
}

type LoginResult = { ok: boolean; error?: string }

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch('/panel/api/' + path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** 读取当前登录态。任何异常都当作「未登录」，让用户看到登录页而不是白屏。 */
export async function fetchSession(): Promise<Session> {
  try {
    const r = await fetch('/panel/api/session', { credentials: 'same-origin' })
    if (!r.ok) return { logged_in: false, auth_required: true }
    return (await r.json()) as Session
  } catch {
    return { logged_in: false, auth_required: true }
  }
}

export async function doLogin(username: string, password: string): Promise<LoginResult> {
  const r = await post('login', { username, password })
  if (r.ok) return { ok: true }
  const d = await r.json().catch(() => ({}))
  // 后端只给机器码，文案在前端集中维护（改文案不用动服务端）。
  const map: Record<string, string> = {
    bad_credentials: '账号或密码不正确',
    too_many_attempts: '尝试过于频繁，请稍后再试',
    panel_auth_not_configured: '面板未配置登录账号，请先在 config.json 里设置 panel_auth',
    invalid_json: '请求格式有误',
  }
  return { ok: false, error: map[d?.error] || d?.error || `登录失败（HTTP ${r.status}）` }
}

export async function doLogout(): Promise<void> {
  await post('logout').catch(() => {})
}

/** useSession：一次会话查询 + 登录 / 登出动作。 */
export function useSession() {
  const [session, setSession] = useState<Session | null>(null) // null = 还没查出来

  const refresh = useCallback(async () => {
    setSession(await fetchSession())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const login = useCallback(async (u: string, p: string) => {
    const res = await doLogin(u, p)
    if (res.ok) await refresh()
    return res
  }, [refresh])

  const logout = useCallback(async () => {
    await doLogout()
    setSession({ logged_in: false, auth_required: true })
  }, [])

  return { session, refresh, login, logout }
}
