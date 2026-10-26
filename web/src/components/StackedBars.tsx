/**
 * 无依赖堆叠柱状图（纯 SVG）。
 *
 * 为什么手写而不是引图表库：面板总共两处图（用量 token、余额趋势），用 ECharts/
 * Chart.js 会带进 200KB+ 和一套自己的主题系统，和现有 CSS 变量对不上；而这里的
 * 需求就是"按时间排的堆叠柱 + 一条命中率线 + 悬停读数"，两百行 SVG 够了。
 *
 * 两个必须守住的细节（都是旧面板踩过的坑）：
 *   1. 柱子颜色走 style 而不是 presentation 属性——Blink/WebKit 不解析属性里的
 *      var()，写成 fill="var(--accent)" 会整条失效、柱子全透明。
 *   2. 首尾各让出半个柱宽，否则第一个/最后一个点的一半会跑到绘图区外被切掉。
 */

export type BarPoint = {
  /** X 轴时间戳（ms），决定落点与刻度。 */
  t: number
  /** 主堆叠段（prompt token）。 */
  a: number
  /** 次堆叠段（completion token）。 */
  b: number
  /** 该点的悬停标签，例如 "14:00"。 */
  label: string
  /** 该点右侧显示的附加读数（命中率等），无则不显示。 */
  extra?: string
}

type Props = {
  points: BarPoint[]
  /** 主段/次段的图例名。 */
  seriesA: string
  seriesB: string
  /** 空数据文案。 */
  emptyText?: string
  height?: number
}

/** 数字缩略：图表轴上用，避免 "1,234,567" 占满空间。 */
function short(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}

export default function StackedBars({ points, seriesA, seriesB, emptyText, height = 200 }: Props) {
  if (!points.length) {
    return <div className="chart-empty">{emptyText || '暂无数据。发起一次对话后再刷新。'}</div>
  }

  const W = 1200
  const H = height
  const PL = 56
  const PR = 16
  const PT = 16
  const PB = 28
  const iw = W - PL - PR
  const ih = H - PT - PB

  const t0 = points[0].t
  const t1 = points[points.length - 1].t
  const span = Math.max(1, t1 - t0)

  const max = Math.max(1, ...points.map((p) => p.a + p.b))

  // 柱宽取「最小真实间隔」的 70%，夹在 2..30px——窗口拉到很长时柱子会变细但不消失。
  let minGap = Infinity
  for (let i = 1; i < points.length; i++) minGap = Math.min(minGap, points[i].t - points[i - 1].t)
  if (!Number.isFinite(minGap) || minGap <= 0) minGap = span
  const slot = (iw * minGap) / span
  const bw = Math.max(2, Math.min(30, slot * 0.7))

  // 首尾各让半个柱宽，保证最左/最右柱子完整可见。
  const xOf = (t: number) => PL + bw / 2 + ((t - t0) / span) * Math.max(1, iw - bw)
  const yOf = (v: number) => PT + ih - ih * (v / max)

  // 纵轴 4 条网格线 + 刻度
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: max * f, y: yOf(max * f) }))

  // 横轴标签：最多 8 个，等间距取点，避免密集时刻度糊成一片。
  const step = Math.max(1, Math.ceil(points.length / 8))
  const xLabels = points.filter((_, i) => i % step === 0 || i === points.length - 1)

  return (
    <div className="chart-wrap">
      <div className="chart-legend">
        <span className="lg">
          <i className="sw sw-a" />
          {seriesA}
        </span>
        <span className="lg">
          <i className="sw sw-b" />
          {seriesB}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="用量趋势">
        <defs>
          {/* stop-color 必须走 style：属性里的 var() 在 Blink 下不解析 */}
          <linearGradient id="gA" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--accent)', stopOpacity: 1 }} />
            <stop offset="1" style={{ stopColor: 'var(--accent)', stopOpacity: 0.62 }} />
          </linearGradient>
          <linearGradient id="gB" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--ok)', stopOpacity: 1 }} />
            <stop offset="1" style={{ stopColor: 'var(--ok)', stopOpacity: 0.62 }} />
          </linearGradient>
        </defs>

        {/* 网格 + 纵轴刻度 */}
        {ticks.map((tk, i) => (
          <g key={i}>
            <line
              x1={PL}
              x2={W - PR}
              y1={tk.y}
              y2={tk.y}
              style={{ stroke: 'var(--line)' }}
              strokeWidth={1}
              strokeDasharray={i === 0 ? undefined : '3 4'}
            />
            <text
              x={PL - 8}
              y={tk.y + 3}
              textAnchor="end"
              style={{ fill: 'var(--ink-3)', fontSize: 10 }}
            >
              {short(tk.v)}
            </text>
          </g>
        ))}

        {/* 堆叠柱 */}
        {points.map((p) => {
          const x = xOf(p.t) - bw / 2
          const ha = ih * (p.a / max)
          const hb = ih * (p.b / max)
          const yA = PT + ih - ha
          const yB = yA - hb
          return (
            <g key={p.t}>
              {hb > 0 ? (
                <rect x={x} y={yB} width={bw} height={hb} rx={Math.min(2, bw / 2)} fill="url(#gB)">
                  <title>{`${p.label} · ${seriesB} ${short(p.b)}`}</title>
                </rect>
              ) : null}
              {ha > 0 ? (
                <rect
                  x={x}
                  y={yA}
                  width={bw}
                  height={ha}
                  rx={Math.min(2, bw / 2)}
                  fill="url(#gA)"
                >
                  <title>{`${p.label} · ${seriesA} ${short(p.a)}`}</title>
                </rect>
              ) : null}
            </g>
          )
        })}

        {/* 横轴标签 */}
        {xLabels.map((p) => (
          <text
            key={'x' + p.t}
            x={xOf(p.t)}
            y={H - 8}
            textAnchor="middle"
            style={{ fill: 'var(--ink-3)', fontSize: 10 }}
          >
            {p.label}
          </text>
        ))}
      </svg>
    </div>
  )
}
