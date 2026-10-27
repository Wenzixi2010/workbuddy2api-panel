import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { errText, fmtCredit } from '../lib/format'
import { Card, Seg, View } from '../components/Layout'
import LineChart, { SERIES_COLORS } from '../components/LineChart'
import DailyBars from '../components/DailyBars'
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

/** 与旧版窗口一致：近 24 小时 / 近 7 天 / 近 30 天。 */
const RANGES: { value: number; label: string }[] = [
  { value: 1, label: '近 24 小时' },
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
]

/** fmtChange 今日/昨日列：带 + 号；不完整日用浅色标。 */
function fmtChange(v: number | undefined, full: boolean | undefined): { text: string; dim: boolean } {
  if (v === undefined || Number.isNaN(v)) return { text: '—', dim: true }
  return { text: (v > 0 ? '+' : '') + fmtCredit(v), dim: full === false }
}

/**
 * flowOf 按 30 分钟采样差值聚合「消耗 / 到账」（旧版 fmtFlowCell 同口径）：
 * 相邻采样下降量之和 = 消耗下界估计；上升量之和 = 到账下界估计。
 * 采样间隔远粗于真实事件密度，同一窗口内的消耗与到账会被合并为净差。
 * 返回 {consumed, gained}；`full` = 窗口首尾采样完整（首点属于窗口起点当天）。
 */
function flowOf(points: Point[]): { consumed: number; gained: number } {
  let consumed = 0
  let gained = 0
  for (let i = 1; i < points.length; i++) {
    const d = points[i].c - points[i - 1].c
    if (d < 0) consumed += -d
    else gained += d
  }
  return { consumed, gained }
}

/** 某天的 points（北京时间口径与后端采样一致：直接按本地日切）。 */

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
  const sampleCount = shown.reduce((s, x) => s + (x.points?.length || 0), 0)
  const usableCount = shown.filter((s) => (s.points?.length || 0) > 0).length

  // 每日变化图数据：uid -> {day: {change, full}}。
  const dailySeries = useMemo(
    () =>
      shown.map((s) => {
        const m: Record<string, { change: number; full: boolean }> = {}
        for (const d of s.daily || []) m[d.day] = { change: d.change, full: d.full }
        return { uid: s.uid, name: s.name || String(s.uid).slice(0, 12), daily: m }
      }),
    [shown],
  )

  // 按账号表：今日/昨日变化 + 消耗/到账（今日与整个窗口分别聚合）。
  const accRows = useMemo(
    () =>
      shown.map((s) => {
        const today = new Date()
        const yd = new Date(Date.now() - 86400000)
        const fmtDay = (d: Date) =>
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        const tDaily = (s.daily || []).find((x) => x.day === fmtDay(today))
        const yDaily = (s.daily || []).find((x) => x.day === fmtDay(yd))
        const win = flowOf(s.points || [])
        return { s, tDaily, yDaily, win }
      }),
    [shown],
  )

  return (
    <View>
      {err ? <div className="note err">{err}</div> : null}

      {series === null ? (
        <div className="empty">加载中…</div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <div className="empty-desc">这段时间还没有余额记录。余额每 30 分钟采样，运行一段时间后就有数据。</div>
        </div>
      ) : (
        <>
          {/* 余额趋势：与旧版同构 —— 卡内指标行 + 多账号水位折线 + 图例 */}
          <Card
            title="余额趋势"
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
          >
            <div className="card-stats">
              <div className="stat">
                <div className="v">{shown.length}</div>
                <div className="k">账号</div>
              </div>
              <div className="stat">
                <div className="v">
                  {usableCount}/{shown.length}
                </div>
                <div className="k">可用（有采样）</div>
              </div>
              <div className="stat">
                <div className="v">{fmtCredit(totalNow)}</div>
                <div className="k">当前合计</div>
              </div>
              <div className="stat">
                <div className={'v ' + (totalChange > 0 ? 'good-text' : totalChange < 0 ? 'bad-text' : '')}>
                  {(totalChange > 0 ? '+' : '') + fmtCredit(totalChange)}
                </div>
                <div className="k">窗口净变化</div>
              </div>
              <div className="stat">
                <div className="v">{sampleCount}</div>
                <div className="k">采样点数</div>
              </div>
            </div>
            <div className="pad">
              <div className="uschart">
                <div className="uschart-hd">
                  <span className="lb">积分水位（每 30 分钟一点）</span>
                  <span className="grow" />
                </div>
                <div className="uschart-body">
                  <LineChart
                    series={shown.map((s) => ({
                      uid: s.uid,
                      name: s.name || String(s.uid).slice(0, 12),
                      points: (s.points || []).map((p) => ({ t: p.t * 1000, c: p.c })),
                    }))}
                    emptyText="暂无余额采样。服务每 30 分钟自动记录一点，余额刷新后即出现（也可点上方「刷新」立即采样一次）。"
                  />
                </div>
              </div>
            </div>
          </Card>

          {/* 每日变化：分组柱状图（x=日期，每账号一根；绿=净增 红=净减） */}
          <Card
            title="每日变化"
            hint="每账号每天一根：绿=当日净增，红=当日净减；浅色 = 该日采样不完整"
            flush
          >
            <div className="pad">
              <DailyBars series={dailySeries} />
            </div>
          </Card>

          {/* 按账号：与旧版同列（当前/最低/最高/净变化/今日/昨日/消耗、到账/采样点） */}
          <Card title="按账号" hint="净变化 = 窗口末值 − 窗口首值" flush>
            <div className="tbl-wrap">
              <table className="acc">
                <thead>
                  <tr>
                    <th className="mark" aria-hidden="true" />
                    <th>账号</th>
                    <th className="num">当前</th>
                    <th className="num">最低</th>
                    <th className="num">最高</th>
                    <th className="num">净变化</th>
                    <th className="num">今日</th>
                    <th className="num">昨日</th>
                    <th
                      className="num"
                      title="按 30 分钟采样估算的消耗（相邻采样下降量之和）；采样间隔远粗于真实事件密度，同一窗口内的消耗与到账会被合并为净差，故为下界估计，实际可能更高。"
                    >
                      消耗*
                    </th>
                    <th
                      className="num"
                      title="按 30 分钟采样估算的到账（相邻采样上升量之和），口径与「消耗*」相同。"
                    >
                      到账*
                    </th>
                    <th className="num">采样点</th>
                  </tr>
                </thead>
                <tbody>
                  {accRows.length === 0 ? (
                    <tr>
                      <td colSpan={11}>
                        <div className="empty">
                          <div className="empty-desc">该域暂无采样。切到其他域，或等待下一次余额刷新。</div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    accRows.map(({ s, tDaily, yDaily, win }, i) => {
                      const t = fmtChange(tDaily?.change, tDaily?.full)
                      const y = fmtChange(yDaily?.change, yDaily?.full)
                      return (
                        <tr key={s.uid}>
                          <td className="mark" aria-hidden="true">
                            <i
                              className="dot"
                              style={{ background: SERIES_COLORS[i % SERIES_COLORS.length], width: 8, height: 8, borderRadius: '50%', display: 'inline-block' }}
                            />
                          </td>
                          <td>
                            {s.name || String(s.uid).slice(0, 12)}
                            {s.realm === 'global' ? <span className="tag">国际</span> : null}
                          </td>
                          <td className="num mono">{fmtCredit(s.current)}</td>
                          <td className="num mono dim">{fmtCredit(s.min)}</td>
                          <td className="num mono">{fmtCredit(s.max)}</td>
                          <td className={'num mono ' + (s.change > 0 ? 'good-text' : s.change < 0 ? 'bad-text' : '')}>
                            {s.change > 0 ? '+' : ''}
                            {fmtCredit(s.change)}
                          </td>
                          <td className={'num mono' + (t.dim ? ' dim' : '')}>{t.text}</td>
                          <td className={'num mono' + (y.dim ? ' dim' : '')}>{y.text}</td>
                          <td className="num mono dim">{fmtCredit(win.consumed)}</td>
                          <td className="num mono dim">{fmtCredit(win.gained)}</td>
                          <td className="num mono">{s.points?.length || 0}</td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
                {accRows.length > 0 ? (
                  <tfoot>
                    <tr>
                      <td className="mark" />
                      <td>合计</td>
                      <td className="num mono">{fmtCredit(totalNow)}</td>
                      <td className="num mono dim">—</td>
                      <td className="num mono">—</td>
                      <td className={'num mono ' + (totalChange > 0 ? 'good-text' : totalChange < 0 ? 'bad-text' : '')}>
                        {totalChange > 0 ? '+' : ''}
                        {fmtCredit(totalChange)}
                      </td>
                      <td className="num mono dim">—</td>
                      <td className="num mono dim">—</td>
                      <td className="num mono dim">
                        {fmtCredit(accRows.reduce((a, r) => a + r.win.consumed, 0))}
                      </td>
                      <td className="num mono dim">
                        {fmtCredit(accRows.reduce((a, r) => a + r.win.gained, 0))}
                      </td>
                      <td className="num mono">{sampleCount}</td>
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          </Card>
        </>
      )}
    </View>
  )
}
