import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { errText, fmtCredit } from '../lib/format'
import { Card, Stat, Stats, View } from '../components/Layout'
import StackedBars, { type BarPoint } from '../components/StackedBars'
import type { ViewProps } from './types'

/** 来自 internal/usage 的 Snapshot 形状（只声明前端读到的字段）。 */
type Agg = {
  requests: number
  errors: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cache_hit_tokens: number
  cache_miss_tokens: number
  avg_latency_ms: number
  avg_tokens_per_second: number
  credits: number
  credit_samples?: number
  credit_tokens?: number
  credits_per_1m_tokens?: number
  cache_hit_rate?: number
}

type KeyedAgg = Agg & { key: string; realm?: string; extra?: string }
type CreditAgg = {
  key: string
  realm?: string
  nickname?: string
  rate?: string
  requests: number
  credits: number
  credit_samples?: number
  credit_tokens?: number
  credits_per_1m_tokens?: number
  cache_hit_tokens?: number
  cache_miss_tokens?: number
}
type Point = Agg & { t: string; scope: string }

type Snapshot = {
  totals: Agg
  by_realm?: KeyedAgg[]
  by_account?: KeyedAgg[]
  by_model?: KeyedAgg[]
  series?: Point[]
  credit_by_account?: CreditAgg[]
  credit_by_model?: CreditAgg[]
  buckets?: number
  file_bytes?: number
  since?: string
  window_from?: string
  window_to?: string
  generated?: string
}

/** 进程内实时请求指标（/panel/api/request_metrics）。 */
type Metrics = {
  started_at: string
  completed: number
  in_flight: number
  succeeded: number
  failed: number
  success_rate: number
  http_success_rate: number
  avg_duration_ms: number
  recent?: RecentReq[]
  archive?: { enabled: boolean; files: number; bytes: number; dropped_writes: number; last_error?: string }
}

type RecentReq = {
  time: string
  request_id: string
  model?: string
  account?: string
  status: number
  ok: boolean
  outcome: string
  duration_ms: number
  total_tokens?: number
  credit?: number
  credit_known?: boolean
  client_key?: string
}

/* ── 时间范围（对齐旧版 .trange）──────────────────────────────────────
   preset: 'today' | 小时数(24/72/168/720) | '0'(全部历史) | 'custom'。 */
const TRANGE_PRESETS: [string, string][] = [
  ['today', '今天'],
  ['24', '近 24 小时'],
  ['72', '近 3 天'],
  ['168', '近 7 天'],
  ['720', '近 30 天'],
  ['0', '全部历史'],
  ['custom', '自定义…'],
]
const TRANGE_DEFAULT = '72'

type RangeState = { preset: string; from: string; to: string }

function trangeQuery(st: RangeState): string {
  const q = new URLSearchParams()
  if (st.preset === 'custom') {
    if (st.from) q.set('from', st.from)
    if (st.to) q.set('to', st.to)
    return q.toString()
  }
  if (st.preset === 'today') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    q.set('from', String(Math.floor(d.getTime() / 1000)))
    return q.toString()
  }
  if (st.preset === '0') {
    q.set('hours', '0')
    return q.toString()
  }
  q.set('hours', st.preset)
  return q.toString()
}

function trangeLabel(st: RangeState): string {
  const found = TRANGE_PRESETS.find((p) => p[0] === st.preset)
  if (st.preset !== 'custom') return found ? found[1] : ''
  if (!st.from && !st.to) return '自定义'
  const f = (s: string) => (s ? s.slice(5, 16).replace('T', ' ') : '…')
  return f(st.from) + ' → ' + f(st.to)
}

/* ── 旧版 usage 格式化（语义与 internal/panel/app.js 完全一致）──────── */

/** token 紧凑显示：1e9→B(2位)、1e6→M(2位)、1e3→k(1位)。 */
function fmtTok(n: number): string {
  n = Number(n || 0)
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}
function fmtMs(ms: number): string {
  ms = Number(ms || 0)
  if (!ms) return '—'
  if (ms >= 1000) return (ms / 1000).toFixed(2) + 's'
  return Math.round(ms) + 'ms'
}
function fmtRate(r: number): string {
  return r ? Number(r).toFixed(1) + ' tok/s' : '—'
}
function trimFixed(s: string): string {
  if (!s.includes('.')) return s
  return s.replace(/0+$/, '').replace(/\.$/, '')
}
function fmtCreditRatio(v: number, samples: number, tokens: number): string {
  if (!samples || !tokens) return '—'
  const n = Number(v || 0)
  if (!Number.isFinite(n)) return '—'
  return trimFixed(n.toFixed(4)) + ' / 1M'
}
function fmtModelRate(rate?: string): string {
  const s = String(rate || '').trim()
  return s ? 'x' + s : '—'
}
function usPct(part: number, total: number): string {
  const t = Number(total || 0)
  if (!t) return '—'
  return (Number(part || 0) / t * 100).toFixed(1) + '%'
}
/** 缓存命中率单元格：≥90% 绿 / 80–90% 黄 / <80% 红；无样本灰。 */
function cacheRateCell(hit?: number, miss?: number): React.ReactNode {
  const h = Number(hit || 0)
  const m = Number(miss || 0)
  const total = h + m
  if (!total) return '—'
  const pct = (h / total) * 100
  const color = pct >= 90 ? 'var(--ok)' : pct >= 80 ? 'var(--warn)' : 'var(--bad)'
  return (
    <span style={{ color }} title={`命中 ${fmtTok(h)} / 未命中 ${fmtTok(m)} tok`}>
      {trimFixed(pct.toFixed(1))}%
    </span>
  )
}

/** 时间点解析：小时桶 t=YYYY-MM-DDTHH、日桶 t=YYYY-MM-DD。 */
function parsePointTime(s: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})$/.exec(s)
  const ms = Date.parse(m ? `${m[1]}T${m[2]}:00:00` : s)
  return Number.isFinite(ms) ? ms : NaN
}
function pointLabel(s: string, scope: string): string {
  const ms = parsePointTime(s)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return scope === 'day' ? `${d.getMonth() + 1}/${d.getDate()}` : `${String(d.getHours()).padStart(2, '0')}:00`
}
/** 按小时表的时段列：小时桶「MM-DD HH:00」、日桶「MM-DD」。 */
function usHourLabel(p: Point): string {
  const ms = parsePointTime(p.t)
  if (!Number.isFinite(ms)) return p.t
  const d = new Date(ms)
  const day = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
  return p.scope === 'day' ? day : `${day} ${String(d.getHours()).padStart(2, '0')}:00`
}

const US_DIMS = {
  account: { key: 'by_account', title: '账号', withRealm: true, withPerf: true, span: 11 },
  model: { key: 'by_model', title: '模型', withRealm: false, withPerf: false, span: 8 },
  realm: { key: 'by_realm', title: 'realm', withRealm: false, withPerf: false, span: 8 },
} as const
type DimKey = keyof typeof US_DIMS

export default function UsageView(_props: ViewProps) {
  const [range, setRange] = useState<RangeState>({ preset: TRANGE_DEFAULT, from: '', to: '' })
  const [d, setD] = useState<Snapshot | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [dim, setDim] = useState<DimKey>('account')
  const [creditDim, setCreditDim] = useState<'account' | 'model'>('account')
  const [usSort, setUsSort] = useState<'total' | 'requests' | 'errors' | 'latency'>('total')
  const [live, setLive] = useState<Metrics | null>(null)

  const load = useCallback(async (st: RangeState) => {
    setBusy(true)
    try {
      setD(await api<Snapshot>(`usage?${trangeQuery(st)}`))
      setErr('')
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load(range)
  }, [load, range])

  // 当前请求是**实时**信息：进程内指标每 5 秒刷一次。
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const m = await api<Metrics>('request_metrics')
        if (alive) setLive(m)
      } catch {
        /* 指标端点不可用不影响历史用量展示 */
      }
    }
    void tick()
    const t = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const bars: BarPoint[] = useMemo(
    () =>
      (d?.series || [])
        .map((p) => ({
          t: parsePointTime(p.t),
          a: p.prompt_tokens || 0,
          b: p.completion_tokens || 0,
          label: pointLabel(p.t, p.scope),
        }))
        .filter((p) => Number.isFinite(p.t)),
    [d?.series],
  )

  const rows: KeyedAgg[] = useMemo(() => {
    if (!d) return []
    const raw = dim === 'model' ? d.by_model || [] : dim === 'realm' ? d.by_realm || [] : d.by_account || []
    const out = raw.slice()
    const val = (a: KeyedAgg) =>
      usSort === 'requests' ? Number(a.requests || 0)
        : usSort === 'errors' ? Number(a.errors || 0)
        : usSort === 'latency' ? Number(a.avg_latency_ms || 0)
        : Number(a.total_tokens || 0)
    out.sort((a, b) => val(b) - val(a))
    return out
  }, [d, dim, usSort])

  const creditRows: CreditAgg[] = useMemo(() => {
    if (!d) return []
    return creditDim === 'model' ? d.credit_by_model || [] : d.credit_by_account || []
  }, [d, creditDim])

  if (err && !d) return <View><div className="empty err">读取失败：{err}</div></View>
  if (!d) return <View><div className="empty">加载中…</div></View>

  const t = d.totals
  const total = Number(t.total_tokens || 0)
  const pt = Number(t.prompt_tokens || 0)
  const ct = Number(t.completion_tokens || 0)
  const reqs = Number(t.requests || 0)
  const errs = Number(t.errors || 0)
  const okRate = reqs ? (reqs - errs) / reqs * 100 : null
  const pctW = (part: number) =>
    total ? Math.max(0, Math.min(100, (Number(part || 0) / total) * 100)).toFixed(2) + '%' : '0%'

  // 口径说明：回显区间 + 分桶数 + 数据起点。
  const rangeEcho = d.window_from
    ? String(d.window_from).replace('T', ' ').slice(0, 16) +
      (d.window_to ? ' → ' + String(d.window_to).replace('T', ' ').slice(0, 16) : ' → 现在')
    : ''
  const note =
    (rangeEcho || trangeLabel(range) ? (rangeEcho || trangeLabel(range)) + ' · ' : '') +
    (d.buckets || 0) + ' 个分桶' +
    (d.since ? ' · 数据自 ' + d.since.replace('T', ' ') : '') +
    (d.file_bytes ? ' · 文件 ' + (d.file_bytes / 1024).toFixed(1) + ' KB' : '')

  return (
    <View>
      {/* Box 1：用量总览（6 张 KPI + Token 时序图） */}
      <Card
        title="用量总览"
        actions={
          <>
            <span className="note">{note}</span>
            <span className="trange">
              <select
                aria-label="时间范围"
                value={range.preset}
                onChange={(e) => setRange({ preset: e.target.value, from: '', to: '' })}
              >
                {TRANGE_PRESETS.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
              {range.preset === 'custom' ? (
                <span className="tr-custom">
                  <input
                    type="datetime-local"
                    aria-label="起始时间"
                    value={range.from}
                    onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
                  />
                  <span className="tr-sep">→</span>
                  <input
                    type="datetime-local"
                    aria-label="结束时间"
                    value={range.to}
                    onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
                  />
                </span>
              ) : null}
            </span>
            <button className="btn sm" disabled={busy} onClick={() => void load(range)}>
              {busy ? '刷新中…' : '刷新'}
            </button>
          </>
        }
      >
        <Stats variant="kpi">
          <Stat label="请求数" value={fmtTok(reqs)} tone="accent" sub={errs ? `其中失败 ${errs} 次` : '全部成功'} />
          <Stat
            label="总 token"
            value={fmtTok(total)}
            tone="accent"
            sub={`prompt ${usPct(pt, total)} · completion ${usPct(ct, total)}`}
            bar={
              <>
                <i style={{ width: pctW(pt), background: 'var(--accent)' }} />
                <i style={{ width: pctW(ct), background: 'var(--ok)' }} />
              </>
            }
          />
          <Stat label="prompt" value={fmtTok(pt)} sub={`占比 ${usPct(pt, total)}`} />
          <Stat label="completion" value={fmtTok(ct)} tone="good" sub={`占比 ${usPct(ct, total)}`} />
          <Stat
            label="失败尝试"
            value={String(errs)}
            tone={errs ? 'warn' : undefined}
            sub={okRate == null ? '—' : errs ? `成功率 ${okRate.toFixed(1)}%` : '成功率 100%'}
          />
          <Stat
            label="平均延迟"
            value={fmtMs(t.avg_latency_ms)}
            sub={t.avg_tokens_per_second ? `吐字 ${fmtRate(t.avg_tokens_per_second)}` : '无速率样本'}
          />
        </Stats>
        <div className="pad">
          <div className="uschart">
            <div className="uschart-hd">
              <span className="lb">Token 时序</span>
              <span className="note">
                {bars.length} 个点
              </span>
              <span className="grow" />
              <span className="legend">
                <i className="sw sw-p" />
                prompt
                <i className="sw sw-c" />
                completion
              </span>
            </div>
            <div className="uschart-body">
              <StackedBars points={bars} seriesA="输入 prompt" seriesB="输出 completion" />
            </div>
          </div>
        </div>
      </Card>

      {/* Box 2：积分与 token 按小时 */}
      <Card
        title="积分与 token 按小时"
        hint="积分取上游 usage.credit（没观测到的请求不计）；兑换率 = token ÷ 积分"
        flush
      >
        {(d.series || []).length === 0 ? (
          <div className="empty">
            <div className="empty-desc">暂无数据。发起一次对话后再刷新。</div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="acc">
              <thead>
                <tr>
                  <th className="mark" aria-hidden="true"></th>
                  <th>时段</th>
                  <th className="num">请求</th>
                  <th className="num">Prompt</th>
                  <th className="num">Completion</th>
                  <th className="num">合计</th>
                  <th className="num">积分</th>
                  <th className="num">token/积分</th>
                </tr>
              </thead>
              <tbody>
                {[...(d.series || [])]
                  .filter((p) => Number.isFinite(parsePointTime(p.t)))
                  .sort((a, b) => parsePointTime(b.t) - parsePointTime(a.t))
                  .map((p) => {
                    const tt = Number(p.total_tokens || 0)
                    const cr = Number(p.credits || 0)
                    return (
                      <tr key={p.t}>
                        <td className="mark" aria-hidden="true"><i /></td>
                        <td>{usHourLabel(p)}</td>
                        <td className="num">{fmtTok(p.requests)}</td>
                        <td className="num">{fmtTok(p.prompt_tokens)}</td>
                        <td className="num">{fmtTok(p.completion_tokens)}</td>
                        <td className="num">{fmtTok(p.total_tokens)}</td>
                        <td className="num">{cr ? fmtCredit(p.credits) : '—'}</td>
                        <td className="num">{cr > 0 && tt > 0 ? fmtTok(tt / cr) : '—'}</td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Box 3：用量明细（按账号/模型/域 切换 + 排序） */}
      <Card
        title="用量明细"
        actions={
          <>
            <span className="vtabs">
              {(
                [
                  ['account', '按账号'],
                  ['model', '按模型'],
                  ['realm', '按域'],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  className={dim === v ? 'on' : ''}
                  aria-pressed={dim === v}
                  onClick={() => setDim(v)}
                >
                  {label}
                  <span className="cnt">
                    {v === 'account' ? (d.by_account || []).length : v === 'model' ? (d.by_model || []).length : (d.by_realm || []).length}
                  </span>
                </button>
              ))}
            </span>
            <span className="note">{rows.length} 行 · 请求数含失败尝试</span>
            <label className="sel-note">
              排序
              <select value={usSort} onChange={(e) => setUsSort(e.target.value as typeof usSort)}>
                <option value="total">合计 Token</option>
                <option value="requests">请求数</option>
                <option value="errors">失败数</option>
                <option value="latency">平均延迟</option>
              </select>
            </label>
          </>
        }
        flush
      >
        {rows.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">该窗口内没有调用记录。</div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="acc zebra">
              <thead>
                <tr>
                  <th className="mark" aria-hidden="true"></th>
                  <th>{US_DIMS[dim].title}</th>
                  {US_DIMS[dim].withRealm ? <th>域</th> : null}
                  <th className="num">请求</th>
                  <th className="num">失败</th>
                  <th className="num">Prompt</th>
                  <th className="num">缓存命中率</th>
                  <th className="num">Completion</th>
                  <th className="num">合计</th>
                  {US_DIMS[dim].withPerf ? (
                    <>
                      <th className="num">均延迟</th>
                      <th className="num">均速率</th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => {
                  const isAcct = dim === 'account'
                  const key = isAcct ? String(x.key || '').slice(0, 8) : x.key
                  return (
                    <tr key={x.key}>
                      <td className="mark" aria-hidden="true"><i /></td>
                      <td>
                        {isAcct ? key : x.key}
                        {isAcct && x.extra ? <div className="note">{x.extra}</div> : null}
                      </td>
                      {US_DIMS[dim].withRealm ? <td className="num">{x.realm || ''}</td> : null}
                      <td className="num">{fmtTok(x.requests)}</td>
                      <td className="num">{x.errors ? <span style={{ color: 'var(--warn)' }}>{fmtTok(x.errors)}</span> : '—'}</td>
                      <td className="num">{fmtTok(x.prompt_tokens)}</td>
                      <td className="num">{cacheRateCell(x.cache_hit_tokens, x.cache_miss_tokens)}</td>
                      <td className="num">{fmtTok(x.completion_tokens)}</td>
                      <td className="num">
                        {fmtTok(x.total_tokens)}
                        {total ? (
                          <span className="us-mix" title={`prompt ${usPct(x.prompt_tokens, x.total_tokens)} · completion ${usPct(x.completion_tokens, x.total_tokens)}`}>
                            <i className="p" style={{ width: pctW(x.prompt_tokens) }} />
                            <i className="c" style={{ width: pctW(x.completion_tokens) }} />
                          </span>
                        ) : null}
                      </td>
                      {US_DIMS[dim].withPerf ? (
                        <>
                          <td className="num">{fmtMs(x.avg_latency_ms)}</td>
                          <td className="num">{fmtRate(x.avg_tokens_per_second)}</td>
                        </>
                      ) : null}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Box 4：积分扣除历史（5 张 KPI + 按账号/模型切换） */}
      <Card
        title="积分扣除历史"
        actions={
          <>
            <span className="vtabs">
              {(
                [
                  ['account', '按账号'],
                  ['model', '按模型'],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  className={creditDim === v ? 'on' : ''}
                  aria-pressed={creditDim === v}
                  onClick={() => setCreditDim(v)}
                >
                  {label}
                  <span className="cnt">
                    {v === 'account' ? (d.credit_by_account || []).length : (d.credit_by_model || []).length}
                  </span>
                </button>
              ))}
            </span>
            <span className="note">
              {(d.credit_by_account || []).length} 个账号 · {(d.credit_by_model || []).length} 个模型倍率分组 · 仅统计与积分同时观测到的 Token
            </span>
          </>
        }
      >
        <Stats variant="kpi">
          <Stat label="扣除积分" value={fmtCredit(t.credits || 0)} tone="accent" sub="按上游 usage.credit 累计" />
          <Stat label="匹配 Token" value={fmtTok(t.credit_tokens || 0)} sub="与积分同时观测到的 Token" />
          <Stat
            label="平均积分 / 1M Token"
            value={fmtCreditRatio(t.credits_per_1m_tokens || 0, t.credit_samples || 0, t.credit_tokens || 0)}
            tone="good"
            sub="越低越划算"
          />
          <Stat label="有效积分样本" value={String(t.credit_samples || 0)} sub="缺字段的历史不参与折算" />
          <Stat label="缓存命中率" value={cacheRateCell(t.cache_hit_tokens, t.cache_miss_tokens)} sub="前缀缓存命中 / (命中+未命中)" />
        </Stats>
        {creditRows.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">暂无积分扣除记录；升级前仅含 Token 的历史不会伪造积分。</div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="acc zebra">
              <thead>
                <tr>
                  <th className="mark" aria-hidden="true"></th>
                  <th>{creditDim === 'model' ? '模型' : '账号'}</th>
                  {creditDim === 'model' ? <th>积分倍率</th> : null}
                  <th className="num">请求</th>
                  <th className="num">扣除积分</th>
                  <th className="num">有效样本 Token</th>
                  <th className="num">积分 / 1M Token</th>
                  <th className="num">缓存命中率</th>
                </tr>
              </thead>
              <tbody>
                {creditRows.map((row) => {
                  const uid = String(row.key || '')
                  const account = row.nickname || uid.slice(0, 8) || '—'
                  return (
                    <tr key={row.key + creditDim}>
                      <td className="mark" aria-hidden="true"><i /></td>
                      {creditDim === 'model' ? (
                        <>
                          <td>{row.key || '—'}</td>
                          <td>{fmtModelRate(row.rate)}</td>
                        </>
                      ) : (
                        <td>
                          {account}
                          <div className="note">{row.realm || ''} · {uid.slice(0, 8)}</div>
                        </td>
                      )}
                      <td className="num">{fmtTok(row.requests)}</td>
                      <td className="num">{fmtCredit(row.credits)}</td>
                      <td className="num">{fmtTok(row.credit_tokens || 0)}</td>
                      <td className="num">
                        {fmtCreditRatio(row.credits_per_1m_tokens || 0, row.credit_samples || 0, row.credit_tokens || 0)}
                      </td>
                      <td className="num">{cacheRateCell(row.cache_hit_tokens, row.cache_miss_tokens)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* 实时请求（React 增强，旧版无此卡；放在最后不干扰上面四个旧版区块） */}
      <Card
        title="当前请求"
        hint={live ? `进程启动于 ${new Date(live.started_at).toLocaleString()}` : '每 5 秒刷新'}
        actions={
          <>
            <button className="btn sm" onClick={() => setRange((r) => ({ ...r }))}>
              随上刷新
            </button>
            <span className={'live-dot' + (live && live.in_flight > 0 ? ' busy' : '')} />
          </>
        }
        flush
      >
        {!live ? (
          <div className="empty">
            <div className="empty-desc">读取实时指标中…</div>
          </div>
        ) : (
          <>
            <div className="live-strip">
              <div className="live-cell">
                <span className="k">进行中</span>
                <span className={'v' + (live.in_flight > 0 ? ' accent' : '')}>{live.in_flight}</span>
              </div>
              <div className="live-cell">
                <span className="k">已完成</span>
                <span className="v">{fmtTok(live.completed)}</span>
              </div>
              <div className="live-cell">
                <span className="k">成功</span>
                <span className="v good">{fmtTok(live.succeeded)}</span>
              </div>
              <div className="live-cell">
                <span className="k">失败</span>
                <span className={'v' + (live.failed ? ' bad' : '')}>{fmtTok(live.failed)}</span>
              </div>
              <div className="live-cell">
                <span className="k">成功率</span>
                <span className="v">{live.success_rate ? (live.success_rate * 100).toFixed(1) + '%' : '—'}</span>
              </div>
              <div className="live-cell">
                <span className="k">平均耗时</span>
                <span className="v">{live.avg_duration_ms ? Math.round(live.avg_duration_ms) + 'ms' : '—'}</span>
              </div>
            </div>
            {(live.recent || []).length === 0 ? (
              <div className="empty">
                <div className="empty-desc">本次进程内还没有请求。发出一次对话后这里会实时出现。</div>
              </div>
            ) : (
              <div className="tbl-wrap">
                <table className="acc req">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>结果</th>
                      <th>模型</th>
                      <th className="num">耗时</th>
                      <th className="num">token</th>
                      <th className="num">积分</th>
                      <th>调用方</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(live.recent || []).slice(0, 12).map((r) => (
                      <tr key={r.request_id || r.time}>
                        <td className="nowrap dim">{new Date(r.time).toLocaleTimeString()}</td>
                        <td>
                          <span className={'tag ' + (r.ok ? 'ok' : /rate|limit/i.test(r.outcome) ? 'warn' : 'bad')}>
                            {r.outcome || (r.ok ? 'ok' : 'error')}
                          </span>
                        </td>
                        <td className="mono">{r.model || '—'}</td>
                        <td className="num mono">{r.duration_ms}ms</td>
                        <td className="num mono">{r.total_tokens ? fmtTok(r.total_tokens) : '—'}</td>
                        <td className="num mono">
                          {r.credit_known ? fmtCredit(r.credit || 0) : <span className="dim">未知</span>}
                        </td>
                        <td>
                          {r.client_key ? (
                            <span className="tag mute">{r.client_key}</span>
                          ) : (
                            <span className="dim">主密钥</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>
    </View>
  )
}
