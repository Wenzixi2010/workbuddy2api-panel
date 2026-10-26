import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { errText, fmtCredit, fmtK } from '../lib/format'
import { Card, Seg, Stat, Stats, View } from '../components/Layout'
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
  credits_per_1m_tokens?: number
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

/** 时间窗口选项：后端按 hours 解析滚动窗口。 */
const WINDOWS: { value: number; label: string }[] = [
  { value: 6, label: '6 小时' },
  { value: 24, label: '24 小时' },
  { value: 72, label: '3 天' },
  { value: 168, label: '7 天' },
  { value: 720, label: '30 天' },
]

/**
 * 解析后端的时间点。
 *
 * 后端小时桶的 t 是 `2006-01-02T15`（小时刻度，没有分钟段），天桶是
 * `2006-01-02`。`Date.parse("2026-10-25T20")` 在 V8 下返回 NaN——不是"解析出
 * 20 点"，而是整条无效。旧实现直接把 NaN 点过滤掉，结果图表永远空着，
 * 所以这里显式补齐分钟/秒再交给 Date。
 */
function parsePointTime(s: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})$/.exec(s)
  const ms = Date.parse(m ? `${m[1]}T${m[2]}:00:00` : s)
  return Number.isFinite(ms) ? ms : NaN
}

/** 时间点标签：小时桶显示 HH:00，天桶显示 M/D。 */
function pointLabel(s: string, scope: string): string {
  const ms = parsePointTime(s)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  if (scope === 'day') return `${d.getMonth() + 1}/${d.getDate()}`
  return `${String(d.getHours()).padStart(2, '0')}:00`
}

function pct(n?: number): string {
  if (!n || n <= 0) return '—'
  return (n * 100).toFixed(1) + '%'
}

export default function UsageView(_props: ViewProps) {
  const [win, setWin] = useState(24)
  const [d, setD] = useState<Snapshot | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [dim, setDim] = useState<'account' | 'model' | 'realm'>('account')
  const [live, setLive] = useState<Metrics | null>(null)

  const load = useCallback(async (hours: number) => {
    setBusy(true)
    try {
      setD(await api<Snapshot>(`usage?hours=${hours}`))
      setErr('')
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load(win)
  }, [load, win])

  // 当前请求是**实时**信息：进程内指标每 5 秒刷一次。
  // 独立于用量桶（那是落盘的、按小时聚合的），两者时间尺度差一个量级。
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
    if (dim === 'model') return d.by_model || []
    if (dim === 'realm') return d.by_realm || []
    return d.by_account || []
  }, [d, dim])

  const creditRows: CreditAgg[] = useMemo(() => {
    if (!d) return []
    return dim === 'model' ? d.credit_by_model || [] : d.credit_by_account || []
  }, [d, dim])

  if (err && !d) return <View><div className="empty err">读取失败：{err}</div></View>
  if (!d) return <View><div className="empty">加载中…</div></View>

  const t = d.totals
  const hitRate =
    (t.cache_hit_tokens || 0) + (t.cache_miss_tokens || 0) > 0
      ? (t.cache_hit_tokens || 0) / ((t.cache_hit_tokens || 0) + (t.cache_miss_tokens || 0))
      : 0

  const dimLabel = dim === 'model' ? '模型' : dim === 'realm' ? '域' : '账号'

  return (
    <View>
      <Stats variant="kpi">
        <Stat label="请求数" value={fmtK(t.requests || 0)} sub={t.errors ? `${t.errors} 失败` : undefined} />
        <Stat label="输入 token" value={fmtK(t.prompt_tokens || 0)} />
        <Stat label="输出 token" value={fmtK(t.completion_tokens || 0)} />
        <Stat label="合计 token" value={fmtK(t.total_tokens || 0)} />
        <Stat
          label="扣费积分"
          value={fmtCredit(t.credits || 0)}
          tone={t.credits ? 'accent' : undefined}
          sub={t.credits_per_1m_tokens ? `${fmtCredit(t.credits_per_1m_tokens)} / 1M tok` : undefined}
        />
        <Stat label="缓存命中率" value={pct(hitRate)} tone={hitRate > 0.5 ? 'good' : undefined} />
        <Stat label="平均延迟" value={t.avg_latency_ms ? `${Math.round(t.avg_latency_ms)}ms` : '—'} />
        <Stat label="平均速度" value={t.avg_tokens_per_second ? `${t.avg_tokens_per_second.toFixed(1)} tok/s` : '—'} />
      </Stats>

      {/* 当前请求：进程内实时指标 + 最近几条。与下面的按小时聚合是两种尺度，
          放在一起看才完整——「刚才慢不慢」和「今天用了多少」是两个问题。 */}
      <Card
        title="当前请求"
        hint={live ? `进程启动于 ${new Date(live.started_at).toLocaleString()}` : '每 5 秒刷新'}
        actions={
          <>
            <Seg value={win} onChange={setWin} ariaLabel="时间窗口" options={WINDOWS} />
            <button className="btn sm" disabled={busy} onClick={() => void load(win)}>
              {busy ? '刷新中…' : '刷新'}
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
                <span className="v">{fmtK(live.completed)}</span>
              </div>
              <div className="live-cell">
                <span className="k">成功</span>
                <span className="v good">{fmtK(live.succeeded)}</span>
              </div>
              <div className="live-cell">
                <span className="k">失败</span>
                <span className={'v' + (live.failed ? ' bad' : '')}>{fmtK(live.failed)}</span>
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
                        <td className="num mono">{r.total_tokens ? fmtK(r.total_tokens) : '—'}</td>
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

      <Card
        title="Token 趋势"
        hint={`${bars.length} 个数据点 · ${d.buckets ?? 0} 个桶`}
      >
        <StackedBars points={bars} seriesA="输入 prompt" seriesB="输出 completion" />
      </Card>

      <Card
        title={`按${dimLabel}汇总`}
        hint={`${rows.length} 行`}
        actions={
          <Seg
            value={dim}
            ariaLabel="汇总维度"
            onChange={setDim}
            options={[
              { value: 'account', label: '账号' },
              { value: 'model', label: '模型' },
              { value: 'realm', label: '域' },
            ]}
          />
        }
        flush
      >
        {rows.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">该窗口内没有调用记录。</div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="acc">
              <thead>
                <tr>
                  <th>{dimLabel}</th>
                  <th className="num">请求</th>
                  <th className="num">失败</th>
                  <th className="num">输入</th>
                  <th className="num">输出</th>
                  <th className="num">合计</th>
                  <th className="num">命中率</th>
                  <th className="num">延迟</th>
                  <th className="num">积分</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const hr =
                    (r.cache_hit_tokens || 0) + (r.cache_miss_tokens || 0) > 0
                      ? (r.cache_hit_tokens || 0) / ((r.cache_hit_tokens || 0) + (r.cache_miss_tokens || 0))
                      : 0
                  return (
                    <tr key={r.key}>
                      <td>
                        <div>{r.extra || r.key}</div>
                        {r.extra ? <div className="who-id mono">{r.key}</div> : null}
                      </td>
                      <td className="num mono">{r.requests || 0}</td>
                      <td className="num mono">{r.errors ? <span className="bad-text">{r.errors}</span> : 0}</td>
                      <td className="num mono">{fmtK(r.prompt_tokens || 0)}</td>
                      <td className="num mono">{fmtK(r.completion_tokens || 0)}</td>
                      <td className="num mono">{fmtK(r.total_tokens || 0)}</td>
                      <td className="num mono">{pct(hr)}</td>
                      <td className="num mono">{r.avg_latency_ms ? `${Math.round(r.avg_latency_ms)}ms` : '—'}</td>
                      <td className="num mono">{r.credits ? fmtCredit(r.credits) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="积分扣费明细"
        hint="仅统计上游返回 usage.credit 的请求；未观测到的不计"
        flush
      >
        {creditRows.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">该窗口内没有观测到积分扣费。</div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="acc">
              <thead>
                <tr>
                  <th>{dim === 'model' ? '模型' : '账号'}</th>
                  {dim === 'model' ? <th>倍率</th> : null}
                  <th className="num">请求</th>
                  <th className="num">积分</th>
                  <th className="num">每 1M token</th>
                </tr>
              </thead>
              <tbody>
                {creditRows.map((r) => (
                  <tr key={r.key}>
                    <td>{r.nickname || r.key}</td>
                    {dim === 'model' ? <td className="dim">{r.rate || '1'}</td> : null}
                    <td className="num mono">{r.requests || 0}</td>
                    <td className="num mono">{fmtCredit(r.credits || 0)}</td>
                    <td className="num mono">
                      {r.credits_per_1m_tokens ? fmtCredit(r.credits_per_1m_tokens) : '—'}
                    </td>
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
