type Props = {
  title: string
  user?: string
  /** 侧栏当前是否处于收起状态（桌面收起 / 移动端抽屉未展开）。 */
  navCollapsed?: boolean
  onToggleNav: () => void
  onToggleTheme: () => void
  onRefresh: () => void
  onLogout: () => void
}

/** 顶栏：面包屑、当前账号、主题、刷新、登出。 */
export default function Topbar({
  title,
  user,
  navCollapsed = false,
  onToggleNav,
  onToggleTheme,
  onRefresh,
  onLogout,
}: Props) {
  return (
    <div className="topbar">
      <button
        className="icon ghost"
        onClick={onToggleNav}
        title={navCollapsed ? '展开导航' : '收起导航'}
        aria-label="打开导航"
        aria-expanded={!navCollapsed}
        data-collapsed={navCollapsed ? 'true' : 'false'}
      >
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.4}>
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
        </svg>
      </button>
      <h2>{title}</h2>
      <span className="sep">/</span>
      <span className="meta">{user ? user : '—'}</span>
      <div className="grow" />
      <button className="icon ghost" onClick={onToggleTheme} title="切换明暗" aria-label="切换主题">
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.4}>
          <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z" />
        </svg>
      </button>
      <button className="icon ghost" onClick={onRefresh} title="刷新" aria-label="刷新">
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.4}>
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3" />
        </svg>
      </button>
      <button className="icon ghost" onClick={onLogout} title="退出登录" aria-label="退出登录">
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={1.4}>
          <path d="M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3M10 5l3 3-3 3M13 8H6" />
        </svg>
      </button>
    </div>
  )
}
