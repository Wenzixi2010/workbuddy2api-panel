import type { ReactNode } from 'react'

/**
 * 视图骨架组件。
 *
 * 存在的理由：间距节奏最容易出错的地方，是每个视图各写一套「卡片 + 标题 + 按钮」
 * 的结构——一旦漏了外边距，元素就贴到一起、圆角啃圆角。把结构收进这几个组件后，
 * 间距只由 .view 的 gap 决定，视图作者不需要（也没法）各自调。
 */

type ViewProps = {
  children: ReactNode
  className?: string
}

/** 视图容器：纵向节奏的唯一负责人（CSS 里 .view 用 flex + gap）。 */
export function View({ children, className }: ViewProps) {
  return <div className={'view' + (className ? ' ' + className : '')}>{children}</div>
}

/** 页头：标题 + 说明 + 右侧操作区。 */
export function ViewHead({
  title,
  desc,
  actions,
}: {
  title: ReactNode
  desc?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="view-head">
      <div className="vh-main">
        <h3>{title}</h3>
        {desc ? <div className="vh-desc">{desc}</div> : null}
      </div>
      {actions ? <div className="vh-acts">{actions}</div> : null}
    </div>
  )
}

/** 卡片：可选标题栏（带 hint 与右侧操作）与页脚。 */
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
  /** 标题旁的小灰字说明，放「这个区块怎么算的」这类补充信息。 */
  hint?: ReactNode
  /** 标题栏右侧的操作按钮。 */
  actions?: ReactNode
  children: ReactNode
  /** 页脚（合计、说明、分页）。 */
  footer?: ReactNode
  /** 内容自带贴边需求（表格）时为 true，去掉内边距。 */
  flush?: boolean
  className?: string
}) {
  const hasHead = title !== undefined || actions !== undefined
  return (
    <section className={'card' + (className ? ' ' + className : '')}>
      {hasHead ? (
        <header className="card-hd">
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
      <div className={'card-bd' + (flush ? ' flush' : '')}>{children}</div>
      {footer ? <footer className="card-ft">{footer}</footer> : null}
    </section>
  )
}

/** 统计卡一枚。tone 决定左侧色条语义色。 */
export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  tone?: 'good' | 'warn' | 'bad' | 'accent'
}) {
  return (
    <div className={'stat' + (tone ? ' ' + tone : '')}>
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  )
}

/** 统计卡容器。 */
export function Stats({ children }: { children: ReactNode }) {
  return <div className="stats">{children}</div>
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
