import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { errText, fmtCredit, fmtK } from '../lib/format'
import { Card, Seg, View } from '../components/Layout'
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

/** 运行日志一条（internal/panel/ring.LogEntry）。 */
type LogEntry = { ts: string; ch: string; text: string }

/** 积分历史一条（/panel/api/credit_history：{time,uid,account,delta,before,after}）。 */
type CreditRow = {
  time?: string
  uid?: string
  account?: string
  delta?: number
  before?: number
  after?: number
}

/** 日志错误汇总一行（/panel/api/error_summary）。 */
type ErrStat = {
  account: string
  kind: string
  code?: string
  model?: string
  count: number
  last?: string
  sev: string
  until?: string
  sample?: string
  sample_full?: string
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

/** 日志频道（与旧版 logChips 同款）。 */
const LOG_CHIPS: { value: string; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'task', label: '任务' },
  { value: 'chat', label: '对话' },
  { value: 'sys', label: '系统' },
]
const CH_LABEL: Record<string, string> = { task: '任务', chat: '对话', sys: '系统' }

/** 日志行的颜色级别：先抹掉「空赋值」字段再判（旧版 logLevel 同款）。 */
function logLevel(text: string): string {
  const t = String(text == null ? '' : text).replace(/\b[a-z_]+=(?:""|'')/g, '')
  if (/error|失败|错误/.test(t)) return ' ln-e'
  if (/warn|冷却|熔断/.test(t)) return ' ln-w'
  return ''
}

function fmtTime(s?: string): string {
  if (!s) return '—'
  const d = new Date(s)
  return Number.isFinite(d.getTime())
    ? d.toLocaleTimeString('zh-CN', { hour12: false })
    : '—'
}

export default function LogsView(_p: ViewProps) {
  const [entries, setEntries] = useState<Event[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [hours, setHours] = useState(24)
  const [outcome, setOutcome] = useState('')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(200)

  // 运行日志
  const [logRows, setLogRows] = useState<LogEntry[]>([])
  const [logCh, setLogCh] = useState('all')
  const [pin, setPin] = useState(true)
  const boxRef = useRef<HTMLPreElement | null>(null)

  // 错误汇总 + 积分历史
  const [errStats, setErrStats] = useState<ErrStat[] | null>(null)
  const [credit, setCredit] = useState<CreditRow[] | null>(null)

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

  const loadAux = useCallback(async () => {
    // 运行日志 + 错误汇总 + 积分历史：一次并行拉（与旧版 loadLogs 同构）。
    const [lg, es, cr] = await Promise.all([
      api<{ entries: LogEntry[] }>('logs').catch(() => ({ entries: [] as LogEntry[] })),
      api<{ rows: ErrStat[] }>('error_summary').catch(() => ({ rows: [] as ErrStat[] })),
      api<{ rows?: CreditRow[] } | CreditRow[]>('credit_history?limit=100').catch(() => null),
    ])
    setLogRows((lg.entries || []).slice(-500))
    setErrStats(es.rows || [])
    const list = Array.isArray(cr) ? cr : cr?.rows
    setCredit(list || [])
  }, [])

  useEffect(() => {
    void loadEvents()
  }, [loadEvents])

  useEffect(() => {
    void loadAux()
    const t = setInterval(() => void loadAux(), 15000)
    return () => clearInterval(t)
  }, [loadAux])

  // 贴底时才自动滚到底：用户往上翻的时候不该被拽回去。
  useEffect(() => {
    const el = boxRef.current
    if (!el || !pin) return
    el.scrollTop = el.scrollHeight
  }, [logRows, logCh, pin])

  const shownLogs = logRows.filter((e) => logCh === 'all' || e.ch === logCh)
  const chCounts: Record<string, number> = {}
  for (const e of logRows) chCounts[e.ch] = (chCounts[e.ch] || 0) + 1
  const logNote =
    logCh === 'all'
      ? `任务 ${chCounts.task || 0} · 对话 ${chCounts.chat || 0} · 系统 ${chCounts.sys || 0}`
      : `${CH_LABEL[logCh] || logCh} ${shownLogs.length} 行`

  return (
    <View>
      {err ? <div className="note err">{err}</div> : null}

      {/* 请求记录：与旧版同构 —— fbar 筛选 + 10 列表（含来源 IP / User-Agent / 请求 ID）。 */}
      <Card
        title="请求记录"
        hint={`${entries.length} 条`}
        actions={
          <>
            <Seg value={hours} onChange={setHours} ariaLabel="时间窗口" options={WINDOWS} />
            <button className="btn sm" disabled={busy} onClick={() => void loadEvents()}>
              {busy ? '刷新中…' : '刷新'}
            </button>
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
            <table className="acc req">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>结果</th>
                  <th>模型</th>
                  <th>账号</th>
                  <th>来源 IP</th>
                  <th>User-Agent</th>
                  <th className="num">耗时</th>
                  <th className="num">Token</th>
                  <th className="num">积分</th>
                  <th>请求 ID</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.request_id}>
                    <td className="dim nowrap">{fmtTime(e.time)}</td>
                    <td>
                      <span className={'tag ' + (OUTCOME_TAG[e.outcome] || (e.ok ? 'ok' : 'bad'))}>
                        {e.status}
                      </span>
                    </td>
                    <td className="mono">{e.model || '—'}</td>
                    <td className="mono dim">{e.account ? String(e.account).slice(0, 12) : '—'}</td>
                    <td className="mono">{e.client_ip || '—'}</td>
                    <td className="dim ua-cell" title={e.user_agent || ''}>
                      {e.user_agent ? (e.user_agent.length > 28 ? e.user_agent.slice(0, 28) + '…' : e.user_agent) : '—'}
                    </td>
                    <td className="num mono">{e.duration_ms ? `${e.duration_ms}ms` : '—'}</td>
                    <td className="num mono">{e.total_tokens ? fmtK(e.total_tokens) : '—'}</td>
                    <td className="num mono">
                      {e.credit_known ? fmtCredit(e.credit || 0) : <span className="dim">未知</span>}
                    </td>
                    <td className="mono dim" title={e.request_id}>
                      {e.request_id ? e.request_id.slice(0, 8) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 错误汇总：旧版放在运行日志页（20261027 对齐移入）。 */}
      <Card title="错误汇总" hint={errStats ? `${errStats.length} 类` : '读取中'} flush>
        {!errStats ? (
          <div className="empty">
            <div className="empty-desc">读取中…</div>
          </div>
        ) : errStats.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">日志里没有 WARN / ERR 记录。</div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="acc">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>类型</th>
                  <th>模型</th>
                  <th className="num">次数</th>
                  <th>最近</th>
                  <th>样本</th>
                </tr>
              </thead>
              <tbody>
                {errStats.map((r, i) => (
                  <tr key={`${r.account}-${r.kind}-${r.code || ''}-${i}`} className={r.sev === 'bad' ? 'lv-e' : r.sev === 'warn' ? 'lv-w' : ''}>
                    <td className="mono">{r.account || <span className="dim">全局</span>}</td>
                    <td>
                      <span className={'tag ' + (r.sev === 'bad' ? 'bad' : r.sev === 'warn' ? 'warn' : 'mute')}>
                        {r.kind}
                      </span>
                      {r.code ? <span className="who-id mono">#{r.code}</span> : null}
                    </td>
                    <td className="mono dim">{r.model || '—'}</td>
                    <td className="num mono">{r.count}</td>
                    <td className="dim nowrap">
                      {r.last || '—'}
                      {r.until ? <div className="who-id">至 {r.until}</div> : null}
                    </td>
                    <td className="row-reason" title={r.sample_full || r.sample}>
                      {r.sample || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 运行日志：与旧版同构 —— chips（全部/任务/对话/系统）+ pre（带频道标签与级别着色）。 */}
      <Card
        title="运行日志"
        hint={logNote}
        actions={
          <>
            <div className="chips" role="tablist" aria-label="日志频道">
              {LOG_CHIPS.map((c) => (
                <button
                  key={c.value}
                  className={'chip' + (logCh === c.value ? ' on' : '')}
                  onClick={() => setLogCh(c.value)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <label className="sel-note">
              <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} />
              自动滚到底
            </label>
          </>
        }
      >
        <pre className="log-box" ref={boxRef}>
          {shownLogs.length
            ? shownLogs.map((e, i) => {
                const lvl = logLevel(e.text)
                const ch =
                  logCh === 'all' && e.ch ? (
                    <i key="ch" className={'lch c-' + e.ch}>
                      {CH_LABEL[e.ch] || e.ch}
                    </i>
                  ) : null
                return (
                  <span key={i} className={'ln' + lvl}>
                    {ch}
                    {fmtTime(e.ts)} {e.text}
                    {'\n'}
                  </span>
                )
              })
            : '（暂无日志）'}
        </pre>
      </Card>

      {/* 积分历史：与旧版同构 —— 最近扣费/到账流水表。 */}
      <Card title="积分历史" hint={credit ? `${credit.length} 条` : '读取中'} flush>
        {!credit ? (
          <div className="empty">
            <div className="empty-desc">读取中…</div>
          </div>
        ) : credit.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">还没有积分变动记录。</div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="acc">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>账号</th>
                  <th className="num">变动</th>
                  <th className="num">变动后余额</th>
                </tr>
              </thead>
              <tbody>
                {credit.map((r, i) => (
                  <tr key={i}>
                    <td className="dim nowrap">{fmtTime(r.time)}</td>
                    <td className="mono">{r.account || r.uid || '—'}</td>
                    <td className={'num mono ' + ((r.delta || 0) > 0 ? 'good-text' : (r.delta || 0) < 0 ? 'bad-text' : '')}>
                      {(r.delta || 0) > 0 ? '+' : ''}
                      {fmtCredit(r.delta || 0)}
                    </td>
                    <td className="num mono">{r.after != null ? fmtCredit(r.after) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </View>
  )
}
