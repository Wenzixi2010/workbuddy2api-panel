import { VIEWS, type ViewId } from '../lib/views'
import { displayVersion } from '../lib/version'
import type { OverviewStatus } from '../App'
import CodebuddyMark from './CodebuddyMark'

type Props = {
  view: ViewId
  onNavigate: (id: ViewId) => void
  open: boolean
  status: OverviewStatus | null
  onClose: () => void
}

/** 左侧导航：品牌、视图列表、连接状态。 */
export default function Nav({ view, onNavigate, open, status, onClose }: Props) {
  const version = typeof status?.version === 'string' ? status.version : ''
  const redis = typeof status?.redis === 'string' ? status.redis : ''
  const healthy = typeof status?.healthy === 'number' ? status.healthy : null
  const total = typeof status?.accounts === 'number' ? status.accounts : null
  const connected = status !== null

  return (
    <>
      <nav className={'nav' + (open ? ' open' : '')}>
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            <CodebuddyMark size={20} />
          </div>
          <div className="brand-text">
            <div className="name">WorkBuddy2API</div>
            <div className="sub">{displayVersion(version)}</div>
          </div>
        </div>

        <ul>
          {VIEWS.map((v) => (
            <li key={v.id}>
              <a
                href={'#' + v.id}
                className={v.id === view ? 'on' : ''}
                aria-current={v.id === view ? 'page' : undefined}
                onClick={(e) => {
                  // 拦下默认跳转：让 App 统一处理 hash 与状态，
                  // 否则浏览器已经改了 hash，React 会在 hashchange 里再改一次。
                  e.preventDefault()
                  onNavigate(v.id)
                }}
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.4}
                  dangerouslySetInnerHTML={{ __html: v.icon }}
                />
                <span>{v.title}</span>
              </a>
            </li>
          ))}
        </ul>

        <div className="sig">
          <div className="sig-row">
            <span className={'pulse' + (connected ? ' on' : '')} />
            <span className="sig-label">{connected ? '已连接' : '连接中'}</span>
            <span className="sig-health">
              {healthy !== null && total !== null ? `${healthy}/${total}` : '—'}
            </span>
          </div>
          <div className="sig-row sig-dim">
            <span>存储</span>
            <span>{redis || '内存'}</span>
          </div>
        </div>
      </nav>
      <div className={'nav-scrim' + (open ? ' on' : '')} onClick={onClose} />
    </>
  )
}
