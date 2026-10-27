/**
 * 无依赖分组柱状图（纯 SVG）——余额趋势「每日变化」。
 *
 * 与旧面板 renderDailyBars 同口径的几个关键点：
 *   - x = 日期，每账号一根柱；绿 = 当日净增（--ok），红 = 当日净减（--bad）。
 *   - 零轴居中，上下独立缩放 + 各留 12% 余量（不强制对称）。
 *   - **离群点 P95 裁剪**：一次 +4414 的到账（新手礼包）会把轴拉到 ±4414，
 *     其余 ±500 的日常波动被压成 2px 短线——韦伯-费希纳定律，人读的是比例。
 *     轴范围用 P95；极值 > P95×3 才启用裁剪，超出者画成贴顶三角 + title 标真实值。
 *   - 不完整日（今天 / 服务中途启用那天）：柱子低透明度——「今天只涨了一点」
 *     会被误读成「今天赚得少」，其实是当天还没采完。
 */
import { SERIES_COLORS } from './LineChart'

export type DailyVal = { change: number; full: boolean }
export type DailySeries = { uid: string; name: string; daily: Record<string, DailyVal> }

type Props = {
  series: DailySeries[]
  height?: number
  emptyText?: string
}

/** 三角标记（离群点贴顶/贴底）。 */
function Outlier({ x, y, up, color, title }: { x: number; y: number; up: boolean; color: string; title: string }) {
  const d = up
    ? `M${x},${y + 6} L${x - 4},${y + 12} L${x + 4},${y + 12} Z`
    : `M${x},${y - 6} L${x - 4},${y - 12} L${x + 4},${y - 12} Z`
  return (
    <path d={d} style={{ fill: color }}>
      <title>{title}</title>
    </path>
  )
}

/** 每日净变化分组柱状图：x=日期，每账号一根。 */
export default function DailyBars({ series, height = 200, emptyText }: Props) {
  // 收集所有日期（并集，升序）。
  const daySet = new Set<string>()
  for (const s of series) for (const day of Object.keys(s.daily)) daySet.add(day)
  const days = [...daySet].sort()
  if (!days.length || !series.length) {
    return <div className="us-empty">{emptyText || '暂无按日数据（需跨过零点后才出现第一天）。'}</div>
  }

  const W = 920
  const H = height
  const PL = 56
  const PR = 14
  const PT = 18
  const PB = 26
  const iw = W - PL - PR
  const ih = H - PT - PB

  // 原始正负极值。
  let rawHi = 0
  let rawLo = 0
  const absVals: number[] = []
  for (const s of series) {
    for (const day of days) {
      const d = s.daily[day]
      if (!d || typeof d.change !== 'number') continue
      if (d.change > rawHi) rawHi = d.change
      if (d.change < rawLo) rawLo = d.change
      absVals.push(Math.abs(d.change))
    }
  }
  if (rawHi === 0 && rawLo === 0) {
    return <div className="us-empty">这段时间没有变化。</div>
  }

  // P95 离群点裁剪（见文件头注释）：极值 > P95×3 才收窄，避免把正常高位数据误裁。
  let hi = rawHi
  let lo = rawLo
  if (absVals.length >= 8) {
    absVals.sort((a, b) => a - b)
    const p95 = absVals[Math.floor(absVals.length * 0.95)]
    const curMax = Math.max(Math.abs(rawHi), Math.abs(rawLo))
    if (p95 > 0 && curMax > p95 * 3) {
      hi = Math.min(rawHi, p95 * 1.12)
      lo = Math.max(rawLo, -p95 * 1.12)
    }
  }
  // 上下独立缩放 + 各留 12% 余量。
  const spanUp = hi > 0 ? hi * 1.12 : 0
  const spanDown = lo < 0 ? -lo * 1.12 : 0
  const total = spanUp + spanDown || 1
  const yZero = PT + (ih * spanUp) / total // 零轴 y 坐标
  const yOf = (v: number) => (v >= 0 ? yZero - (v / (spanUp || 1)) * (ih * spanUp) / total : yZero - (v / (spanDown || 1)) * (ih * spanDown) / total)

  // 每天的槽宽与柱宽。
  const slot = iw / days.length
  const bw = Math.max(1.5, Math.min(14, (slot - 4) / series.length))
  const groupW = bw * series.length

  const yTicks: { v: number; y: number }[] = []
  if (spanUp > 0) yTicks.push({ v: hi, y: yOf(hi) })
  yTicks.push({ v: 0, y: yZero })
  if (spanDown > 0) yTicks.push({ v: lo, y: yOf(lo) })

  // x 轴日期标签：柱多时隔一取一，避免重叠。
  const labelEvery = Math.max(1, Math.ceil(days.length / 12))

  // 找出被裁剪的离群点，画三角标记。
  const outliers: { s: DailySeries; day: string; change: number; x: number; clipped: boolean }[] = []
  days.forEach((day, di) => {
    series.forEach((s, si) => {
      const d = s.daily[day]
      if (!d || typeof d.change !== 'number') return
      const clipped = (d.change > hi && rawHi > hi) || (d.change < lo && rawLo < lo)
      if (clipped) {
        outliers.push({ s, day, change: d.change, x: PL + di * slot + slot / 2 - groupW / 2 + si * bw + bw / 2, clipped })
      }
    })
  })

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="line-multi" role="img" aria-label="每日变化柱状图">
        {/* 网格 + y 轴标签 */}
        {yTicks.map(({ v, y }, i) => (
          <g key={i}>
            <line x1={PL} x2={W - PR} y1={y} y2={y} style={{ stroke: v === 0 ? 'var(--line)' : 'var(--line-soft)' }} strokeWidth={1} />
            <text x={PL - 6} y={y + 3.5} textAnchor="end" className="ax-lb">
              {Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v * 10) / 10)}
            </text>
          </g>
        ))}
        {/* 柱：每天一组，每账号一根 */}
        {days.map((day, di) => {
          const gx = PL + di * slot + slot / 2 - groupW / 2
          return series.map((s, si) => {
            const d = s.daily[day]
            if (!d || typeof d.change !== 'number' || d.change === 0) return null
            const x = gx + si * bw
            const y = yOf(d.change)
            const h = Math.max(1, Math.abs(y - yZero))
            const yy = d.change >= 0 ? yZero - h : yZero
            const clipped = (d.change > hi && rawHi > hi) || (d.change < lo && rawLo < lo)
            const tip = `${s.name} · ${day}\n净变化 ${d.change >= 0 ? '+' : ''}${d.change.toFixed(2)}${d.full ? '' : '\n（当日采样不完整）'}`
            return (
              <rect
                key={s.uid + day}
                x={x}
                y={yy}
                width={bw}
                height={h}
                rx={1}
                style={{
                  fill: d.change >= 0 ? 'var(--ok)' : 'var(--bad)',
                  opacity: d.full ? (clipped ? 0.45 : 0.92) : 0.4,
                }}
              >
                <title>{tip}</title>
              </rect>
            )
          })
        })}
        {/* 离群点三角标记 */}
        {outliers.map((o, i) => (
          <Outlier
            key={i}
            x={o.x}
            y={o.change > 0 ? PT : H - PB}
            up={o.change <= 0}
            color={o.change > 0 ? 'var(--ok)' : 'var(--bad)'}
            title={`${o.s.name} · ${o.day}\n净变化 ${o.change >= 0 ? '+' : ''}${o.change.toFixed(2)}（超出轴范围，已裁剪显示）`}
          />
        ))}
        {/* x 轴日期标签 */}
        {days.map((day, di) =>
          di % labelEvery === 0 ? (
            <text key={day} x={PL + di * slot + slot / 2} y={H - 8} textAnchor="middle" className="ax-lb">
              {day.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
      <div className="bh-legend">
        <span className="lg-item dim">绿=当日净增 红=当日净减 · 低透明度=采样不完整</span>
        {series.map((s, si) => (
          <span key={s.uid} className="lg-item">
            <i style={{ background: SERIES_COLORS[si % SERIES_COLORS.length] }} />
            <span className="lg-name" title={s.uid}>
              {s.name}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}
