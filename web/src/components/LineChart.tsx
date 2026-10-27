/**
 * 无依赖多序列折线图（纯 SVG）——余额趋势「积分水位」。
 *
 * 与旧面板 renderBalanceChart 同口径的几个关键点：
 *   - x 轴按**真实时间比例**排布（30 分钟等间隔采样），而非数据序号等距——
 *     「什么时候到账/掉分」本身就是这张图要回答的问题。
 *   - y 轴下界不强制贴 0：下界取 max(0, 最低值−12% 留白)，仅当最低值离 0 很近
 *     （< 轴高 15%）时才贴 0，否则底部一大片空白全是浪费的数据墨水。
 *   - 每个序列固定取色（BH_COLORS 同款 7 色环），与图例、按账号表的圆点一一对应。
 */
export const SERIES_COLORS = [
  '#f0e070', '#a7fa70', '#70fa93', '#70e1fa', '#9a8cf5', '#ee70fa', '#fa7097',
]

export type LinePoint = { t: number; c: number }
export type LineSeries = { uid: string; name: string; points: LinePoint[] }

type Props = {
  series: LineSeries[]
  height?: number
  /** 空数据文案。 */
  emptyText?: string
}

function fmtAxis(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (a >= 1e4) return (n / 1e3).toFixed(1) + 'k'
  if (a >= 100) return String(Math.round(n))
  return String(Math.round(n * 10) / 10)
}

function fmtTime(t: number): string {
  const d = new Date(t)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 多账号积分水位折线。手写 SVG：x=时间，y=积分，一账号一条线。 */
export default function LineChart({ series, height = 220, emptyText }: Props) {
  const rows = series.filter((s) => s.points.length >= 1)
  if (!rows.length) {
    return <div className="us-empty">{emptyText || '暂无余额采样。'}</div>
  }
  const W = 920
  const H = height
  const PL = 56
  const PR = 14
  const PT = 14
  const PB = 26
  const iw = W - PL - PR
  const ih = H - PT - PB

  let t0 = Infinity
  let t1 = -Infinity
  let lo = Infinity
  let hi = -Infinity
  for (const s of rows) {
    for (const p of s.points) {
      if (p.t < t0) t0 = p.t
      if (p.t > t1) t1 = p.t
      if (p.c < lo) lo = p.c
      if (p.c > hi) hi = p.c
    }
  }
  if (t1 <= t0) t1 = t0 + 1
  // y 轴：下界不强制贴 0（见文件头注释），最低值贴近 0 时才贴。
  const pad = (hi - lo) * 0.12 || Math.max(1, hi * 0.12)
  const rawLo = Math.max(0, lo - pad)
  hi += pad
  const AXIS_ZERO_SNAP = 0.15
  lo = lo <= (hi - rawLo) * AXIS_ZERO_SNAP ? 0 : rawLo
  const range = Math.max(1e-9, hi - lo)

  const xOf = (t: number) => PL + ((t - t0) / (t1 - t0)) * iw
  const yOf = (v: number) => PT + ih - ((v - lo) / range) * ih

  // y 轴刻度：4 条网格线 + 数值。
  const yTicks = [0, 1, 2, 3].map((i) => lo + (range * i) / 3)
  // x 轴刻度：4 个等分时间点。
  const xTicks = [0, 1, 2, 3].map((i) => t0 + ((t1 - t0) * i) / 3)

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="line-multi" role="img" aria-label="积分水位折线图">
        {/* 网格 + y 轴标签 */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line
              x1={PL}
              x2={W - PR}
              y1={yOf(v)}
              y2={yOf(v)}
              style={{ stroke: 'var(--line-soft)' }}
              strokeWidth={1}
            />
            <text x={PL - 6} y={yOf(v) + 3.5} textAnchor="end" className="ax-lb">
              {fmtAxis(v)}
            </text>
          </g>
        ))}
        {/* x 轴标签 */}
        {xTicks.map((t, i) => (
          <text key={i} x={xOf(t)} y={H - 8} textAnchor={i === 0 ? 'start' : i === 3 ? 'end' : 'middle'} className="ax-lb">
            {fmtTime(t)}
          </text>
        ))}
        {/* 各账号折线 */}
        {rows.map((s, si) => {
          const color = SERIES_COLORS[si % SERIES_COLORS.length]
          const pts = s.points
          if (pts.length === 1) {
            // 单点：画一个圆点，避免"什么都没有"的困惑。
            return (
              <circle
                key={s.uid}
                cx={xOf(pts[0].t)}
                cy={yOf(pts[0].c)}
                r={3}
                style={{ fill: color }}
              />
            )
          }
          const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.t).toFixed(1)},${yOf(p.c).toFixed(1)}`).join(' ')
          return (
            <path
              key={s.uid}
              d={d}
              fill="none"
              style={{ stroke: color }}
              strokeWidth={1.6}
              strokeLinejoin="round"
              strokeLinecap="round"
            >
              <title>{s.name}</title>
            </path>
          )
        })}
      </svg>
      {/* 图例：颜色点 + 账号名（与按账号表的颜色点一致） */}
      <div className="bh-legend">
        {rows.map((s, si) => (
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
