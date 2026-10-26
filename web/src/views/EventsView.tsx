import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { errText, fmtCredit, fmtK } from '../lib/format'
import { Card, Seg, Stat, Stats, View, ViewHead } from '../components/Layout'
import type { ViewProps } from './types'

/** internal/reqlog.Event 的前端投影。 */
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
  cache_hit_tokens?: number
  cache_miss_tokens?: number
  client_ip?: string
  user_agent?: string
  client_key?: string
  mode?: string
}

/** 日志错误汇总（/panel/api/error_summary）：账号 × 类型的聚合行。 */
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

const RANGES: { value: number; label: string }[] = [
  { value: 1, label: '1 小时' },
  { value: 6, label: '6 小时' },
  { value: 24, label: '今天' },
  { value: 168, label: '7 天' },
]

/** 结果标签颜色：成功绿、限流黄、其余红。 */
function outcomeTone(outcome: string, ok: boolean): string {
  if (ok) return 'ok'
  if (/rate|limit|throttl/i.test(outcome)) return 'warn'
  return 'bad'
}

function hitRate(e: Event): number | null {
  const h = e.cache_hit_tokens || 0
  const m = e.cache_miss_tokens || 0
  if (h + m <= 0) return null
  return h / (h + m)
}

export default function EventsView({ onToast }: ViewProps) {
  const [rows, setRows] = useState<Event[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [hours, setHours] = useState(24)
  const [limit, setLimit] = useState(200)
  const [fModel, setFModel] = useState('')
  const [fAccount, setFAccount] = useState('')
  const [fOutcome, setFOutcome] = useState('')
  const [errStats, setErrStats] = useState<ErrStat[] | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const from = new Date(Date.now() - hours * 3600 * 1000).toISOString()
      const params = new URLSearchParams({ limit: String(limit), from })
      if (fModel) params.set('model', fModel)
      if (fAccount) params.set('account', fAccount)
      if (fOutcome) params.set('outcome', fOutcome)
      const r = await api<{ entries?: Event[] }>(`request_logs?${params}`)
      setRows(r.entries || [])
      setErr('')
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }, [hours, limit, fModel, fAccount, fOutcome])

  useEffect(() => {
    void load()
  }, [load])

  // 错误汇总是进程内日志环的聚合，与归档表各管一段：
  // 归档回答"某次请求怎么样"，汇总回答"哪个号在反复报什么错"。
  useEffect(() => {
    let alive = true
    api<{ rows: ErrStat[] }>('error_summary')
      .then((d) => alive && setErrStats(d.rows || []))
      .catch(() => alive && setErrStats([]))
    return () => {
      alive = false
    }
  }, [])

  /** 下拉选项从当前结果里提取：比再开一个接口拿全量模型/账号列表简单，也不会不同步。 */
  const models = useMemo(
    () => [...new Set(rows.map((r) => r.model).filter(Boolean))].sort() as string[],
    [rows],
  )
  const accounts = useMemo(
    () => [...new Set(rows.map((r) => r.account).filter(Boolean))].sort() as string[],
    [rows],
  )

  const okCount = rows.filter((r) => r.ok).length
  const errCount = rows.length - okCount
  const avgLatency = rows.length
    ? Math.round(rows.reduce((s, r) => s + (r.duration_ms || 0), 0) / rows.length)
    : 0
  const totalTok = rows.reduce((s, r) => s + (r.total_tokens || 0), 0)
  const totalCredit = rows.reduce((s, r) => s + (r.credit || 0), 0)

  /** 导出当前筛选结果为 CSV（前端生成，不额外开后端接口）。 */
  const exportCSV = () => {
    const head = [
      'time',
      'request_id',
      'outcome',
      'status',
      'model',
      'account',
      'client_key',
      'duration_ms',
      'ttfb_ms',
      'prompt_tokens',
      'completion_tokens',
      'total_tokens',
      'credit',
      'client_ip',
    ]
    const esc = (v: unknown) => {
      const s = v === undefined || v === null ? '' : String(v)
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }
    const lines = [head.join(',')]
    for (const r of rows) {
      lines.push(
        [
          r.time,
          r.request_id,
          r.outcome,
          r.status,
          r.model,
          r.account,
          r.client_key,
          r.duration_ms,
          r.ttfb_ms,
          r.prompt_tokens,
          r.completion_tokens,
          r.total_tokens,
          r.credit,
          r.client_ip,
        ]
          .map(esc)
          .join(','),
      )
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `requests-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`
    a.click()
    URL.revokeObjectURL(url)
    onToast(`已导出 ${rows.length} 条`, 'ok')
  }

  const clearFilters = () => {
    setFModel('')
    setFAccount('')
    setFOutcome('')
  }

  return (
    <View>
      <ViewHead
        title="请求事件日志"
        desc="网关每条请求的归档记录，含模型、账号、耗时与 token 用量，可按结果筛选并导出 CSV。"
        actions={
          <>
            <Seg value={hours} onChange={setHours} ariaLabel="时间范围" options={RANGES} />
            <button className="btn sm" disabled={busy} onClick={() => void load()}>
              {busy ? '刷新中…' : '刷新'}
            </button>
            <button className="btn sm" disabled={!rows.length} onClick={exportCSV}>
              导出 CSV
            </button>
          </>
        }
      />

      <Stats>
        <Stat label="请求数" value={rows.length} sub={`上限 ${limit}`} />
        <Stat label="成功" value={okCount} tone="good" />
        <Stat label="失败" value={errCount} tone={errCount ? 'bad' : undefined} />
        <Stat label="平均耗时" value={avgLatency ? `${avgLatency}ms` : '—'} />
        <Stat label="总 token" value={fmtK(totalTok)} />
        <Stat label="扣费积分" value={fmtCredit(totalCredit)} tone={totalCredit ? 'accent' : undefined} />
      </Stats>

      {err ? <div className="note err">{err}</div> : null}

      <Card
        title="错误汇总"
        hint={errStats ? `${errStats.length} 类` : '读取中'}
        flush
      >
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
            <table className="tbl">
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
                  <tr key={`${r.account}-${r.kind}-${r.code || ''}-${i}`}>
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

      <Card
        title="事件明细"
        hint={`${rows.length} 条`}
        actions={
          <>
            <select className="inp sm" value={fModel} onChange={(e) => setFModel(e.target.value)}>
              <option value="">全部模型</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select className="inp sm" value={fAccount} onChange={(e) => setFAccount(e.target.value)}>
              <option value="">全部账号</option>
              {accounts.map((a) => (
                <option key={a} value={a}>
                  {String(a).slice(0, 12)}
                </option>
              ))}
            </select>
            <select className="inp sm" value={fOutcome} onChange={(e) => setFOutcome(e.target.value)}>
              <option value="">全部结果</option>
              <option value="ok">成功</option>
              <option value="error">失败</option>
            </select>
            <select className="inp sm" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              <option value={100}>100</option>
              <option value={200}>200</option>
              <option value={500}>500</option>
              <option value={1000}>1000</option>
            </select>
            {fModel || fAccount || fOutcome ? (
              <button className="btn xs" onClick={clearFilters}>
                清除筛选
              </button>
            ) : null}
          </>
        }
        flush
      >
        {rows.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">
              没有符合条件的请求事件。网关还没被调用过，或者归档未开启。
            </div>
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
                  <th>调用方</th>
                  <th className="num">状态</th>
                  <th className="num">耗时</th>
                  <th className="num">TTFB</th>
                  <th className="num">Token</th>
                  <th className="num">积分</th>
                  <th className="num">命中率</th>
                  <th>来源</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const hr = hitRate(e)
                  return (
                    <tr key={e.request_id || e.time + e.path}>
                      <td className="nowrap dim">{new Date(e.time).toLocaleString()}</td>
                      <td>
                        <span className={'tag ' + outcomeTone(e.outcome, e.ok)}>
                          {e.outcome || (e.ok ? 'ok' : 'error')}
                        </span>
                        {e.attempts && e.attempts > 1 ? (
                          <span className="dim" title={`重试 ${e.attempts} 次`}>
                            {' '}
                            ×{e.attempts}
                          </span>
                        ) : null}
                      </td>
                      <td className="mono">{e.model || '—'}</td>
                      <td className="dim mono">{e.account ? String(e.account).slice(0, 10) : '—'}</td>
                      <td>
                        {e.client_key ? (
                          <span className="tag mute">{e.client_key}</span>
                        ) : (
                          <span className="dim">主密钥</span>
                        )}
                      </td>
                      <td className="num mono">{e.status}</td>
                      <td className="num mono">{e.duration_ms}ms</td>
                      <td className="num mono">{e.ttfb_ms ? `${e.ttfb_ms}ms` : '—'}</td>
                      <td className="num mono">{e.total_tokens ? fmtK(e.total_tokens) : '—'}</td>
                      <td className="num mono">
                        {e.credit_known ? fmtCredit(e.credit || 0) : <span className="dim">未知</span>}
                      </td>
                      <td className="num mono">{hr === null ? '—' : (hr * 100).toFixed(0) + '%'}</td>
                      <td className="dim mono" title={e.user_agent}>
                        {e.client_ip || '—'}
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
