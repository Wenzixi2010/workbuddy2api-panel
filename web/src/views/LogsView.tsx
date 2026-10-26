import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { errText, fmtCredit, fmtK } from '../lib/format'
import { Card, Seg, Stat, Stats, View, ViewHead } from '../components/Layout'
import type { ViewProps } from './types'

/** 一条请求事件（internal/reqlog.Event 的前端投影）。 */
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
  credit?: number
  credit_known?: boolean
  client_ip?: string
  user_agent?: string
  client_key?: string
}

/** 窗口选项：与 usage 一致，便于两个页面对照看。 */
const WINDOWS: { value: number; label: string }[] = [
  { value: 1, label: '1 小时' },
  { value: 6, label: '6 小时' },
  { value: 24, label: '24 小时' },
  { value: 168, label: '7 天' },
]

const OUTCOME_TAG: Record<string, string> = {
  ok: 'ok',
  success: 'ok',
  error: 'bad',
  fail: 'bad',
  timeout: 'bad',
  rate_limited: 'warn',
  fallback: 'warn',
}

export default function LogsView(_p: ViewProps) {
  const [entries, setEntries] = useState<Event[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [hours, setHours] = useState(24)
  const [outcome, setOutcome] = useState('')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(200)

  // 实时日志
  const [text, setText] = useState('')
  const [pin, setPin] = useState(true)
  const boxRef = useRef<HTMLPreElement | null>(null)

  const loadEvents = useCallback(async () => {
    setBusy(true)
    try {
      const from = new Date(Date.now() - hours * 3600 * 1000).toISOString()
      const params = new URLSearchParams({ limit: String(limit), from })
      if (outcome) params.set('outcome', outcome)
      if (q.trim()) params.set('model', q.trim())
      const r = await api<{ entries: Event[] }>(`request_logs?${params}`)
      setEntries(r.entries || [])
      setErr('')
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }, [hours, limit, outcome, q])

  useEffect(() => {
    void loadEvents()
  }, [loadEvents])

  // 实时日志轮询：3s 一次，与旧面板同节奏。
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const d = await api<{ lines?: string[]; log?: string }>('logs')
        if (!alive) return
        setText(d.log ?? (d.lines || []).join('\n'))
      } catch {
        /* 日志流断开不影响事件表 */
      }
    }
    void tick()
    const t = setInterval(tick, 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  // 贴底时才自动滚到底：用户往上翻的时候不该被拽回去。
  useEffect(() => {
    const el = boxRef.current
    if (!el || !pin) return
    el.scrollTop = el.scrollHeight
  }, [text, pin])

  const okCount = entries.filter((e) => e.ok).length
  const errCount = entries.length - okCount
  const totalTok = entries.reduce((s, e) => s + (e.total_tokens || 0), 0)
  const totalCredit = entries.reduce((s, e) => s + (e.credit || 0), 0)
  const avgMs = entries.length
    ? Math.round(entries.reduce((s, e) => s + (e.duration_ms || 0), 0) / entries.length)
    : 0

  return (
    <View>
      <ViewHead
        title="运行日志"
        desc="网关请求事件与实时服务日志。事件来自 JSONL 归档，可按时间窗口与结果筛选。"
        actions={
          <>
            <Seg value={hours} onChange={setHours} ariaLabel="时间窗口" options={WINDOWS} />
            <button className="btn sm" disabled={busy} onClick={() => void loadEvents()}>
              {busy ? '刷新中…' : '刷新'}
            </button>
          </>
        }
      />

      <Stats>
        <Stat label="请求数" value={entries.length} sub={`上限 ${limit}`} />
        <Stat label="成功" value={okCount} tone="good" />
        <Stat label="失败" value={errCount} tone={errCount ? 'bad' : undefined} />
        <Stat label="平均耗时" value={avgMs ? `${avgMs}ms` : '—'} />
        <Stat label="总 token" value={fmtK(totalTok)} />
        <Stat label="扣费积分" value={fmtCredit(totalCredit)} tone={totalCredit ? 'accent' : undefined} />
      </Stats>

      {err ? <div className="note err">{err}</div> : null}

      <Card
        title="请求事件"
        hint={`${entries.length} 条`}
        actions={
          <>
            <input
              className="inp sm"
              placeholder="按模型过滤"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ width: 150 }}
            />
            <select className="inp sm" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="">全部结果</option>
              <option value="ok">成功</option>
              <option value="error">失败</option>
            </select>
            <select className="inp sm" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              <option value={100}>100 条</option>
              <option value={200}>200 条</option>
              <option value={500}>500 条</option>
            </select>
          </>
        }
        flush
      >
        {entries.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">该条件下没有请求记录。网关还没有被调用，或归档未开启。</div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl log-tbl">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>结果</th>
                  <th>模型</th>
                  <th>账号</th>
                  <th className="num">状态</th>
                  <th className="num">耗时</th>
                  <th className="num">token</th>
                  <th className="num">积分</th>
                  <th>来源</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.request_id || e.time + e.path}>
                    <td className="nowrap dim">{new Date(e.time).toLocaleString()}</td>
                    <td>
                      <span className={'tag ' + (OUTCOME_TAG[e.outcome] || (e.ok ? 'ok' : 'bad'))}>
                        {e.outcome || (e.ok ? 'ok' : 'error')}
                      </span>
                      {e.attempts && e.attempts > 1 ? (
                        <span className="dim" title={`${e.attempts} 次尝试`}>
                          {' '}
                          ×{e.attempts}
                        </span>
                      ) : null}
                    </td>
                    <td className="mono">{e.model || '—'}</td>
                    <td className="dim">{e.account ? String(e.account).slice(0, 10) : '—'}</td>
                    <td className="num mono">{e.status}</td>
                    <td className="num mono">{e.duration_ms}ms</td>
                    <td className="num mono">{e.total_tokens ? fmtK(e.total_tokens) : '—'}</td>
                    <td className="num mono">
                      {e.credit_known ? fmtCredit(e.credit || 0) : <span className="dim">未知</span>}
                    </td>
                    <td className="dim">
                      {e.client_key ? <span className="tag mute">{e.client_key}</span> : null}
                      {e.client_ip ? <span className="mono"> {e.client_ip}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="服务日志"
        hint="最近输出"
        actions={
          <label className="sel-note">
            <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} />
            自动滚到底
          </label>
        }
      >
        <pre className="log-box" ref={boxRef}>
          {text || '（暂无日志）'}
        </pre>
      </Card>
    </View>
  )
}
