import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, setUnauthorizedHandler } from './lib/api'
import { applyTheme, effectiveTheme, readThemePref, writeThemePref, type ThemePref } from './lib/theme'
import { parseHash, viewById, type ViewId } from './lib/views'
import { useSession } from './lib/session'
import Nav from './components/Nav'
import Topbar from './components/Topbar'
import Toasts, { type ToastItem, pushToast } from './components/Toasts'
import LoginPage from './components/LoginPage'

export type OverviewStatus = {
  version?: string
  redis?: string
  accounts?: number
  healthy?: number
  [k: string]: unknown
}

/** 窄屏断点：≤760px 时导航是浮层抽屉，>760px 时是常驻侧栏列。 */
const DRAWER_BREAKPOINT = 760

/** 当前是否处于抽屉模式（窄屏）。与 CSS 里 `@media (max-width: 760px)` 必须一致。 */
function isDrawerMode(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= DRAWER_BREAKPOINT
}

/** 应用外壳：登录闸门 + 导航 + 顶栏 + 当前视图。 */
export default function App() {
  const { session, refresh, login, logout } = useSession()
  const [view, setView] = useState<ViewId>(() => parseHash(location.hash))
  const [themePref, setThemePref] = useState<ThemePref>(() => readThemePref())
  // navOpen 的语义统一为「侧栏当前是否可见」：
  //  - 桌面端：默认可见，点按钮 = 收起/展开侧栏列
  //  - 移动端：默认隐藏，点按钮 = 弹出/关闭抽屉
  // 之前这个 state 只有移动端语义、初值 false，导致宽屏一进页面侧栏就是收起状态，
  // 点一下才"展开"——和用户预期（默认展开、点了收起）正好相反。
  const [navOpen, setNavOpen] = useState(() => !isDrawerMode())
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [status, setStatus] = useState<OverviewStatus | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const toastSeq = useRef(0)

  const eff = effectiveTheme(themePref)

  // 主题落到 <html data-theme>：CSS 用属性选择器切换整套色板。
  //
  // 过渡动画只在**主题真的变化**时启用：给 <html> 临时加 .theme-anim（CSS 里定义
  // 颜色过渡），过渡结束就摘掉。常驻 transition 会让打字、滚动、hover 都拖着
  // 颜色动画，明显发滞，所以必须按需开关。
  // 首次挂载不播放——否则一进页面就是一次从默认色板到目标色板的渐入，像卡了一下。
  const firstTheme = useRef(true)
  useEffect(() => {
    if (firstTheme.current) {
      firstTheme.current = false
      applyTheme(eff)
      return
    }
    const root = document.documentElement
    root.classList.add('theme-anim')
    applyTheme(eff)
    const t = window.setTimeout(() => root.classList.remove('theme-anim'), 260)
    return () => {
      window.clearTimeout(t)
      root.classList.remove('theme-anim')
    }
  }, [eff])

  // auto 模式跟随系统：系统换色时也走同一套过渡。
  useEffect(() => {
    if (themePref !== 'auto' || typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-color-scheme: light)')
    const onChange = () => applyTheme(effectiveTheme('auto'))
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [themePref])

  // hash 路由：面板只有一层视图切换，且要与旧面板的 #accounts / #usage 保持兼容。
  useEffect(() => {
    const onHash = () => setView(parseHash(location.hash))
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])

  const go = useCallback((id: ViewId) => {
    if (parseHash(location.hash) !== id) location.hash = id
    setView(id)
    // 只有抽屉模式（窄屏）才关边栏：那里导航是浮层，不关会挡住刚切到的内容。
    // 桌面端展开状态下切视图必须保持展开——否则每换一页都要重新点开。
    if (isDrawerMode()) setNavOpen(false)
  }, [])

  // 只在**真正跨过断点**时重置可见性，而不是每次 resize 都重置。
  //
  // 原先写成无条件的 setNavOpen(window.innerWidth > 760)，后果是任何一次 resize
  // ——拖动窗口边框、开关开发者工具、甚至浏览器因地址栏出现而重排——都会把用户
  // 手动收起 / 展开的选择覆盖掉，看起来就像"边栏自己乱跳"。
  // 记录上一次的模式，只有模式翻转时才动状态。
  useEffect(() => {
    let wasDrawer = isDrawerMode()
    const onResize = () => {
      const nowDrawer = isDrawerMode()
      if (nowDrawer === wasDrawer) return // 同一模式内的大小变化：保留用户选择
      wasDrawer = nowDrawer
      // 跨到桌面端 → 侧栏恢复常驻展开；跨到窄屏 → 抽屉默认收起。
      setNavOpen(!nowDrawer)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 会话过期（任何 API 返回 401）→ 重新问一次登录态，把界面切回登录页。
  useEffect(() => {
    setUnauthorizedHandler(() => {
      void refresh()
    })
    return () => setUnauthorizedHandler(null)
  }, [refresh])

  const toast = useCallback((msg: string, kind: 'ok' | 'err' | '' = '') => {
    const id = ++toastSeq.current
    setToasts((prev) => pushToast(prev, { id, msg, kind }))
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3600)
  }, [])

  const loggedIn = session?.logged_in === true

  // 侧栏状态：轮询 overview。未登录时不轮询（否则每次都是 401，日志里刷垃圾）。
  useEffect(() => {
    if (!loggedIn) return
    let alive = true
    const tick = async () => {
      try {
        const d = await api<OverviewStatus>('overview')
        if (alive) setStatus(d)
      } catch {
        if (alive) setStatus(null)
      }
    }
    void tick()
    const t = setInterval(tick, 15000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [refreshNonce, loggedIn])

  const def = useMemo(() => viewById(view), [view])
  const View = def.Component

  // 会话还没查出来：留一屏空白，避免「先闪登录页再跳主界面」。
  if (session === null) {
    return (
      <div className="boot">
        <div className="boot-dot" />
      </div>
    )
  }

  if (!loggedIn) {
    return (
      <>
        <LoginPage
          onSubmit={login}
          notConfigured={session.reason === 'panel_auth_not_configured'}
        />
        <Toasts items={toasts} />
      </>
    )
  }

  return (
    <div className={'shell' + (navOpen ? '' : ' nav-collapsed')}>
      <Nav
        view={view}
        onNavigate={go}
        open={navOpen}
        status={status}
        onClose={() => setNavOpen(false)}
      />
      <div className="main">
        <Topbar
          title={def.title}
          user={session.user}
          navCollapsed={!navOpen}
          onToggleNav={() => setNavOpen((v) => !v)}
          onToggleTheme={() => {
            const next: ThemePref = eff === 'light' ? 'dark' : 'light'
            writeThemePref(next)
            setThemePref(next)
          }}
          onRefresh={() => setRefreshNonce((n) => n + 1)}
          onLogout={() => {
            if (!confirm('退出登录？')) return
            void logout()
          }}
        />
        {/* key 带 refreshNonce：整视图重挂 = 重新拉数据，「刷新」按钮因此对所有视图都生效。 */}
        <View key={`${view}:${refreshNonce}`} onToast={toast} />
      </div>
      <Toasts items={toasts} />
    </div>
  )
}
