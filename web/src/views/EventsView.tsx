import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { errText } from '../lib/format'
import { Card, View } from '../components/Layout'
import type { ViewProps } from './types'

/** 请求事件一条（internal/reqlog.Event 的前端投影，Keeper 大屏口径）。 */
type Event = {
  time: string
  request_id: string
  path: string
  account?: string
  model?: string
  status: number
  ok: boolean
  outcome: string
  duration_ms: number
  ttfb_ms?: number
  attempts?: number
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  reasoning_tokens?: number
  reasoning_effort?: string
  executor_type?: string
  cache_hit_tokens?: number
  cache_miss_tokens?: number
  client_ip?: string
  user_agent?: string
  client_key?: string
  mode?: string
}

/** formatEventNum（旧版同款）：1.23K / 4.56M。 */
function formatEventNum(n: number): string {
  if (!n || n < 0) return '0'
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(2) + 'K'
  return String(n)
}

/** deriveEventExecutor（旧版同款）：从 UA 推断调用方执行器。 */
function deriveEventExecutor(ua?: string): string {
  if (!ua) return 'WorkBuddyExecutor'
  const l = ua.toLowerCase()
  if (l.includes('antigravity')) return 'AntigravityExecutor'
  if (l.includes('codex')) return 'CodexExecutor'
  if (l.includes('claude')) return 'ClaudeCodeExecutor'
  if (l.includes('cursor')) return 'CursorExecutor'
  if (l.includes('continue')) return 'ContinueExecutor'
  if (l.includes('openai') || l.includes('python')) return 'OpenAIClient'
  return 'WorkBuddyExecutor'
}

export default function EventsView({ onToast }: ViewProps) {
  const [rows, setRows] = useState<Event[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [limit, setLimit] = useState(100)
  const [fModel, setFModel] = useState('')
  const [fAccount, setFAccount] = useState('')
  const [fStatus, setFStatus] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const r = await api<{ entries: Event[] }>(`request_logs?limit=${limit}`)
      setRows(r.entries || [])
      setErr('')
    } catch (e) {
      // 不能把失败渲染成「共 0 条事件」——归档没开和查询出错是两回事。
      setRows([])
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }, [limit])

  useEffect(() => {
    void load()
  }, [load])

  const models = useMemo(() => [...new Set(rows.map((r) => r.model).filter(Boolean))] as string[], [rows])
  const accounts = useMemo(() => [...new Set(rows.map((r) => r.account).filter(Boolean))] as string[], [rows])

  const filtered = useMemo(
    () =>
      rows.filter((e) => {
        if (fModel && e.model !== fModel) return false
        if (fAccount && e.account !== fAccount) return false
        if (fStatus === 'success' && !(e.ok || (e.status >= 200 && e.status < 300))) return false
        if (fStatus === '429' && e.status !== 429) return false
        if (fStatus === 'error' && (e.ok || (e.status >= 200 && e.status < 300))) return false
        return true
      }),
    [rows, fModel, fAccount, fStatus],
  )

  const clearFilters = () => {
    setFModel('')
    setFAccount('')
    setFStatus('')
  }

  const exportJSON = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `requests-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`
    a.click()
    URL.revokeObjectURL(url)
    onToast(`已导出 ${filtered.length} 条`, 'ok')
  }

  return (
    <View>
      <Card
        title={
          <>
            请求事件日志{' '}
            <span className="events-badge">共 {filtered.length} 条事件</span>
          </>
        }
        hint="筛选、查看并分析实时调用事件与性能指标。"
        actions={
          <>
            <button className="btn sm" disabled={!filtered.length} onClick={exportJSON}>
              导出 JSON
            </button>
            <select className="inp sm" value={fModel} onChange={(e) => setFModel(e.target.value)}>
              <option value="">全部模型 ({models.length})</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select className="inp sm" value={fAccount} onChange={(e) => setFAccount(e.target.value)}>
              <option value="">全部账号 ({accounts.length})</option>
              {accounts.map((a) => (
                <option key={a} value={a}>
                  {String(a).slice(0, 12)}
                </option>
              ))}
            </select>
            <select className="inp sm" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
              <option value="">全部状态</option>
              <option value="success">成功</option>
              <option value="429">429 限流</option>
              <option value="error">错误</option>
            </select>
            {fModel || fAccount || fStatus ? (
              <button className="btn xs" onClick={clearFilters}>
                清除筛选
              </button>
            ) : null}
            <select className="inp sm" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              <option value={100}>100</option>
              <option value={200}>200</option>
              <option value={500}>500</option>
              <option value={1000}>1000</option>
            </select>
            <button className="btn sm primary" disabled={busy} onClick={() => void load()}>
              {busy ? '刷新中…' : '刷新'}
            </button>
          </>
        }
        flush
      >
        {err ? (
          <div className="note err">{err}</div>
        ) : filtered.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">
              {rows.length === 0 ? '没有请求事件。网关还没被调用过，或归档未开启。' : '没有符合筛选条件的请求事件。'}
            </div>
          </div>
        ) : (
          <div className="event-tbl-wrap">
            <table className="event-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>来源</th>
                  <th>模型</th>
                  <th>推理强度</th>
                  <th>结果</th>
                  <th>请求</th>
                  <th>延时</th>
                  <th>生成速度</th>
                  <th>Token</th>
                  <th>缓存</th>
                  <th>执行器</th>
                  <th>客户端 IP</th>
                  <th>用户代理</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => {
                  const d = new Date(e.time)
                  const tStr = isNaN(d.getTime())
                    ? '-'
                    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
                  const dStr = isNaN(d.getTime()) ? '' : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`

                  const acctRaw = e.account || '-'
                  const acctClean = acctRaw.replace(/\([^)]*\)/, '')
                  const effort = e.reasoning_effort || '-'

                  let resTag = <span className="tag-badge tag-success">成功</span>
                  if (e.status === 429) {
                    resTag = <span className="tag-badge tag-warn">429 限流</span>
                  } else if (e.status && (e.status < 200 || e.status >= 300)) {
                    resTag = <span className="tag-badge tag-error">{e.status} 错误</span>
                  }

                  const reqProto = e.mode === 'stream' || (e.path || '').includes('responses') ? 'SSE' : 'POST'
                  const reqPath = (e.path || '/chat').replace(/^\/v1/, '')

                  const durSec = ((e.duration_ms || 0) / 1000).toFixed(1) + 's'
                  const ttfbSec = e.ttfb_ms ? '首字延迟 ' + (e.ttfb_ms / 1000).toFixed(1) + 's' : '-'

                  let tpsStr = '-'
                  if ((e.completion_tokens || 0) > 0) {
                    const genMs = Math.max(100, (e.duration_ms || 0) - (e.ttfb_ms || 0))
                    tpsStr = (((e.completion_tokens || 0) / genMs) * 1000).toFixed(1) + ' t/s'
                  }

                  const thinkTok =
                    (e.reasoning_tokens || 0) > 0 ? (
                      <span className="tok-think" title="思考 Token">
                        🧠 {formatEventNum(e.reasoning_tokens || 0)}
                      </span>
                    ) : null

                  const cHit = e.cache_hit_tokens || 0
                  const cMiss = e.cache_miss_tokens || 0
                  const cTot = cHit + cMiss
                  const cRate = cTot > 0 ? ((cHit / cTot) * 100).toFixed(2) + '%' : '-'

                  const exec = e.executor_type || deriveEventExecutor(e.user_agent)
                  const ua = e.user_agent || '-'

                  return (
                    <tr key={e.request_id || e.time + e.path}>
                      <td className="time-cell">
                        <div className="t-time">{tStr}</div>
                        <div className="t-date">{dStr}</div>
                      </td>
                      <td>
                        <div className="acct-cell">
                          <span className="acct-icon" />
                          <span title={acctRaw}>{acctClean}</span>
                        </div>
                      </td>
                      <td className="model-cell">
                        <div className="m-name">{e.model || '-'}</div>
                      </td>
                      <td>
                        <span className="pill-effort">{effort}</span>
                      </td>
                      <td>{resTag}</td>
                      <td>
                        <span className="req-tag">{reqProto}</span>
                        <div className="req-path-sub">{reqPath}</div>
                      </td>
                      <td>
                        <div className="metric-main">{durSec}</div>
                        <div className="metric-sub">{ttfbSec}</div>
                      </td>
                      <td>
                        <div className="metric-main">{tpsStr}</div>
                      </td>
                      <td className="token-cell">
                        <div className="tok-total">{formatEventNum(e.total_tokens || 0)}</div>
                        <div className="token-breakdown">
                          <div className="token-breakdown-row">
                            <span className="tok-in">↑ {formatEventNum(e.prompt_tokens || 0)}</span>
                          </div>
                          <div className="token-breakdown-row">
                            <span className="tok-out">↓ {formatEventNum(e.completion_tokens || 0)}</span> {thinkTok}
                          </div>
                        </div>
                      </td>
                      <td className="cache-cell">
                        <div className="cache-rate">{cRate}</div>
                        <div className="cache-breakdown">
                          <div>
                            <span className="cache-hit">命中 {formatEventNum(cHit)}</span>
                          </div>
                          <div>
                            <span className="cache-miss">未命中 {formatEventNum(cMiss)}</span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className="executor-name">{exec}</span>
                      </td>
                      <td>
                        <code className="ip-mono">{e.client_ip || '-'}</code>
                      </td>
                      <td>
                        <div className="ua-cell" title={ua}>
                          {ua}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </View>
  )
}
