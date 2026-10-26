import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { errText, fmtCredit } from '../lib/format'
import { Card, Seg, Stat, Stats, View, ViewHead } from '../components/Layout'
import type { ViewProps } from './types'

/** internal/balance 的 Point / Daily / Series 前端投影。 */
type Point = { t: number; u: string; c: number; d?: string }
type Daily = {
  day: string
  first: number
  last: number
  change: number
  min: number
  max: number
  n: number
  full: boolean
}
type Series = {
  uid: string
  name?: string
  points: Point[]
  current: number
  min: number
  max: number
  change: number
  daily?: Daily[]
  realm?: string
}

/** days 上限 30（后端 detailedKeep，更早的已折叠为日粒度）。 */
const RANGES: { value: number; label: string }[] = [
  { value: 7, label: '近 7 天' },
  { value: 14, label: '近 14 天' },
  { value: 30, label: '近 30 天' },
]

/** 单账号折线：把 points 铺满给定高度。手写 polyline，避免引图表库。 */
function Line({ s, height = 64 }: { s: Series; height?: number }) {
  const W = 320
  const H = height
  const pad = 3
  const pts = s.points
  if (pts.length < 2) {
    return <div className="line-flat">采样点不足</div>
  }
  const t0 = pts[0].t
  const t1 = pts[pts.length - 1].t
  const span = Math.max(1, t1 - t0)
  const lo = Math.min(...pts.map((p) => p.c))
  const hi = Math.max(...pts.map((p) => p.c))
  const range = Math.max(1, hi - lo)
  const xOf = (t: number) => pad + ((t - t0) / span) * (W - pad * 2)
  const yOf = (v: number) => H - pad - ((v - lo) / range) * (H - pad * 2)
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.t).toFixed(1)},${yOf(p.c).toFixed(1)}`).join(' ')
  // 面积填充：折线闭合到底边，视觉上更好判断趋势方向
  const area =
    `M${xOf(pts[0].t).toFixed(1)},${H - pad} ` +
    pts.map((p) => `L${xOf(p.t).toFixed(1)},${yOf(p.c).toFixed(1)}`).join(' ') +
    ` L${xOf(pts[pts.length - 1].t).toFixed(1)},${H - pad} Z`
  const up = s.change >= 0
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="line-chart" preserveAspectRatio="none">
      <path d={area} style={{ fill: up ? 'var(--ok-soft)' : 'var(--bad-soft)' }} />
      <path
        d={d}
        fill="none"
        style={{ stroke: up ? 'var(--ok)' : 'var(--bad)' }}
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default function BalanceHistoryView(_props: ViewProps) {
  const [series, setSeries] = useState<Series[] | null>(null)
  const [err, setErr] = useState('')
  const [days, setDays] = useState(30)
  const [busy, setBusy] = useState(false)
  const [realm, setRealm] = useState<'all' | 'cn' | 'global'>('all')

  const load = useCallback(async (d: number) => {
    setBusy(true)
    try {
      const r = await api<{ series: Series[] }>(`balance_history?days=${d}`)
      setSeries(r.series || [])
      setErr('')
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load(days)
  }, [load, days])

  const shown = useMemo(() => {
    const list = series || []
    if (realm === 'all') return list
    return list.filter((s) => (s.realm || 'other') === realm)
  }, [series, realm])

  const totalNow = shown.reduce((s, x) => s + (x.current || 0), 0)
  const totalChange = shown.reduce((s, x) => s + (x.change || 0), 0)
  const gainers = shown.filter((s) => s.change > 0).length
  const losers = shown.filter((s) => s.change < 0).length

  // 每日变化对照：跨账号按日聚合。
  const daily = useMemo(() => {
    const m = new Map<string, { change: number; accounts: number }>()
    for (const s of shown) {
      for (const d of s.daily || []) {
        const cur = m.get(d.day) || { change: 0, accounts: 0 }
        cur.change += d.change
        cur.accounts += 1
        m.set(d.day, cur)
      }
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [shown])

  return (
    <View>
      <ViewHead
        title="余额趋势"
        desc="各账号积分余额随时间的变化。每 5 分钟采样一次，超过 30 天的数据折叠为日粒度。"
        actions={
          <>
            <Seg value={days} onChange={setDays} ariaLabel="时间范围" options={RANGES} />
            <Seg
              value={realm}
              ariaLabel="域筛选"
              onChange={setRealm}
              options={[
                { value: 'all', label: '全部' },
                { value: 'cn', label: '国内' },
                { value: 'global', label: '国际' },
              ]}
            />
            <button className="btn sm" disabled={busy} onClick={() => void load(days)}>
              {busy ? '刷新中…' : '刷新'}
            </button>
          </>
        }
      />

      {err ? <div className="note err">{err}</div> : null}

      <Stats>
        <Stat label="账号数" value={shown.length} />
        <Stat label="当前合计" value={fmtCredit(totalNow)} tone="accent" />
        <Stat
          label={`${days} 天净变化`}
          value={(totalChange >= 0 ? '+' : '') + fmtCredit(totalChange)}
          tone={totalChange >= 0 ? 'good' : 'bad'}
        />
        <Stat label="增长账号" value={gainers} tone="good" />
        <Stat label="下降账号" value={losers} tone={losers ? 'bad' : undefined} />
      </Stats>

      {series === null ? (
        <div className="empty">加载中…</div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <div className="empty-desc">这段时间还没有余额记录。余额每 5 分钟采样，运行一段时间后就有数据。</div>
        </div>
      ) : (
        <Card title="各账号趋势" hint={`${shown.length} 个账号`}>
          <div className="spark-grid">
            {shown.map((s) => (
              <div className="spark" key={s.uid}>
                <div className="spark-hd">
                  <span className="spark-name" title={s.uid}>
                    {s.name || String(s.uid).slice(0, 12)}
                  </span>
                  <span className={'spark-change ' + (s.change >= 0 ? 'up' : 'down')}>
                    {s.change >= 0 ? '+' : ''}
                    {fmtCredit(s.change)}
                  </span>
                </div>
                <Line s={s} />
                <div className="spark-ft">
                  <span>{fmtCredit(s.current)}</span>
                  <span className="dim">
                    {fmtCredit(s.min)} ~ {fmtCredit(s.max)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="每日变化对照" hint="末值 − 首值" flush>
        {daily.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">没有日粒度数据。</div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>日期</th>
                  <th className="num">当日净变化</th>
                  <th className="num">采样账号</th>
                </tr>
              </thead>
              <tbody>
                {daily.map(([day, v]) => (
                  <tr key={day}>
                    <td className="mono">{day}</td>
                    <td className="num mono">
                      <span className={v.change >= 0 ? 'good-text' : 'bad-text'}>
                        {v.change >= 0 ? '+' : ''}
                        {fmtCredit(v.change)}
                      </span>
                    </td>
                    <td className="num mono">{v.accounts}</td>
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
