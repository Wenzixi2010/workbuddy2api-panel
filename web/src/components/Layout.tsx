import { createContext, useContext, type ReactNode } from 'react'

/**
 * 内容区骨架组件。
 *
 * 本版回到旧面板的视觉语言：内容区是一块流式文档，一个功能区一张 `.box`
 * （header 放标题/hint/操作，正文用 .pad 或贴边表格），统计是连续的统计条，
 * 表格用旧版 `.acc` 密度。间距由 legacy.css 的 `.box { margin-bottom }` 与
 * 这里的 `.view > .stats` 补丁负责，视图作者不再各自处理「页头 + 卡片」三层结构。
 */

type ViewProps = {
  children: ReactNode
  className?: string
}

/** 视图容器：纵向节奏的唯一负责人（CSS 里 .view 用流式布局）。 */
export function View({ children, className }: ViewProps) {
  return <div className={'view' + (className ? ' ' + className : '')}>{children}</div>
}

/**
 * 内容区块：沿用旧面板的 `.box > header + 内容` 结构。
 *
 * 这不是单纯换类名。旧版的视觉边界是「一整个功能区一张卡」：标题、hint、
 * 右侧操作都在 header，表格直接贴边，普通内容才加 .pad。React 第一版把它拆成
 * 页头、统计小卡、内容卡三层，信息密度和旧版完全不同，所以这里回到旧结构。
 */
export function Card({
  title,
  hint,
  actions,
  children,
  footer,
  flush,
  className,
}: {
  title?: ReactNode
  hint?: ReactNode
  actions?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** 表格等贴边内容不加 .pad；其余内容与旧版一样使用 17px 内边距。 */
  flush?: boolean
  className?: string
}) {
  const hasHead = title !== undefined || actions !== undefined
  return (
    <section className={'box' + (className ? ' ' + className : '')}>
      {hasHead ? (
        <header>
          {title !== undefined ? (
            <h3>
              {title}
              {hint ? <span className="hint">{hint}</span> : null}
            </h3>
          ) : null}
          <span className="grow" />
          {actions ? <div className="hd-acts">{actions}</div> : null}
        </header>
      ) : null}
      {flush ? children : <div className="pad">{children}</div>}
      {footer ? <footer className="box-ft">{footer}</footer> : null}
    </section>
  )
}

/** 统计条形态：stats = 旧版 .stats 连续统计带；kpi = 旧版 .kpis 独立小卡。 */
const StatsCtx = createContext<'stats' | 'kpi'>('stats')

/** 统计项：按外层 Stats 的形态输出 .stat（带内网格）或 .kpi（独立卡）。 */
export function Stat({
  label,
  value,
  sub,
  tone,
  bar,
}: {
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  tone?: 'good' | 'warn' | 'bad' | 'accent'
  /** kpi 形态的构成条（如总 token 卡的 prompt/completion 占比），渲染为 .kbar。 */
  bar?: ReactNode
}) {
  const kind = useContext(StatsCtx)
  // .stat 用 tone 类着色（good/warn/bad/accent）；.kpi 用 c-* 类（c-ok/c-warn/c-bad/c-accent）。
  const toneCls =
    kind === 'kpi'
      ? tone
        ? ` c-${tone === 'good' ? 'ok' : tone}`
        : ''
      : tone
        ? ` ${tone}`
        : ''
  const cls = kind === 'kpi' ? 'kpi' : 'stat'
  // 副标题：旧版 kpi 用 .s、.stat 用 .sub（两种形态的类名不同，见 legacy.css）。
  const subCls = kind === 'kpi' ? 's' : 'sub'
  return (
    <div className={cls + toneCls}>
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {bar ? <div className="kbar">{bar}</div> : null}
      {sub ? <div className={subCls}>{sub}</div> : null}
    </div>
  )
}

/**
 * 统计条：账号池等使用旧版 .stats；用量使用旧版 .kpis。
 * 两种都是区块内连续的统计带，不是彼此悬浮的小卡片。
 */
export function Stats({ children, variant = 'stats' }: { children: ReactNode; variant?: 'stats' | 'kpi' }) {
  return (
    <StatsCtx.Provider value={variant}>
      <div className={variant === 'kpi' ? 'kpis' : 'stats auto'}>{children}</div>
    </StatsCtx.Provider>
  )
}

/** 分段控件（互斥多选一）。 */
export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: { value: T; label: ReactNode; title?: string }[]
  onChange: (v: T) => void
  ariaLabel?: string
}) {
  return (
    <span className="seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={o.value === value ? 'on' : ''}
          aria-pressed={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  )
}
