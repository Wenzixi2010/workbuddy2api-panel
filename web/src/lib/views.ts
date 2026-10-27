/** 视图定义：导航项、标题与 hash 路由的唯一真相。 */
import type { ComponentType } from 'react'
import type { ViewProps } from '../views/types'
import AccountsView from '../views/AccountsView'
import UsageView from '../views/UsageView'
import PackagesView from '../views/PackagesView'
import BalanceHistoryView from '../views/BalanceHistoryView'
import TasksCenterView from '../views/TasksCenterView'
import ModelsView from '../views/ModelsView'
import ClientKeysView from '../views/ClientKeysView'
import GroupsView from '../views/GroupsView'
import ConfigView from '../views/ConfigView'
import EventsView from '../views/EventsView'
import LogsView from '../views/LogsView'

export type ViewId =
  | 'accounts'
  | 'usage'
  | 'packages'
  | 'balhist'
  | 'taskscenter'
  | 'models'
  | 'keys'
  | 'groups'
  | 'config'
  | 'events'
  | 'logs'

export type ViewDef = {
  id: ViewId
  title: string
  icon: string
  Component: ComponentType<ViewProps>
}

/**
 * 导航顺序即此数组顺序。
 *
 * icon 是内联 SVG 的 path 段（viewBox 0 0 16 16，stroke 描边），沿用旧面板的图形语言——
 * 换图标库会引入一个依赖，而这些图标一共才十来个。
 */
export const VIEWS: ViewDef[] = [
  {
    id: 'accounts',
    title: '账号池',
    icon: '<circle cx="8" cy="5.5" r="2.6"/><path d="M2.8 13.5c.6-2.6 2.7-4 5.2-4s4.6 1.4 5.2 4"/>',
    Component: AccountsView,
  },
  {
    id: 'usage',
    title: '用量',
    icon: '<path d="M2 13.5h12"/><path d="M4.5 13.5V8.2M8 13.5V3.5M11.5 13.5v-3"/>',
    Component: UsageView,
  },
  {
    id: 'packages',
    title: '积分构成',
    icon:
      '<path d="M2.2 5.4 8 2.5l5.8 2.9v5.2L8 13.5l-5.8-2.9z"/><path d="M2.2 5.4 8 8.3l5.8-2.9M8 8.3v5.2"/>',
    Component: PackagesView,
  },
  {
    id: 'balhist',
    title: '余额趋势',
    icon:
      '<path d="M2.2 5.4 8 2.5l5.8 2.9v5.2L8 13.5l-5.8-2.9z"/><path d="M2.2 5.4 8 8.3l5.8-2.9M8 8.3v5.2"/>',
    Component: BalanceHistoryView,
  },
  {
    id: 'taskscenter',
    title: '任务中心',
    icon: '<path d="M3 2.5h10v9H8l-3 3v-3H3z"/><path d="M6 6.5h4M6 9h2.5"/>',
    Component: TasksCenterView,
  },
  {
    id: 'models',
    title: '模型与档位',
    icon: '<path d="M8 1.8 14 5v6L8 14.2 2 11V5z"/><path d="M2 5l6 3.2L14 5M8 8.2v6"/>',
    Component: ModelsView,
  },
  {
    id: 'keys',
    title: 'API Keys',
    icon: '<circle cx="5.2" cy="10.8" r="2.6"/><path d="M7.1 8.9l5.4-5.4M10.2 5.8l1.6 1.6M11.8 4.2l1.6 1.6"/>',
    Component: ClientKeysView,
  },
  {
    id: 'groups',
    title: '分组',
    icon: '<rect x="2" y="3" width="5.2" height="5.2" rx="1"/><rect x="8.8" y="3" width="5.2" height="5.2" rx="1"/><rect x="2" y="10.2" width="5.2" height="2.8" rx="1"/><rect x="8.8" y="10.2" width="5.2" height="2.8" rx="1"/>',
    Component: GroupsView,
  },
  {
    id: 'config',
    title: '配置',
    icon:
      '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v1.9M8 12.5v1.9M1.6 8h1.9M12.5 8h1.9M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3"/>',
    Component: ConfigView,
  },
  {
    id: 'events',
    title: '请求事件日志',
    icon:
      '<rect x="2" y="2" width="12" height="12" rx="2.5"/><path d="M5 5.5h6M5 8h6M5 10.5h3.5"/>',
    Component: EventsView,
  },
  {
    id: 'logs',
    title: '运行日志',
    icon: '<path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h7"/>',
    Component: LogsView,
  },
]

export const VIEW_IDS = new Set<string>(VIEWS.map((v) => v.id))

export function viewById(id: string): ViewDef {
  return VIEWS.find((v) => v.id === id) || VIEWS[0]
}

/** 从 location.hash 取视图（未知/空 → 账号池）。 */
export function parseHash(hash: string): ViewId {
  const id = hash.replace(/^#/, '').split('?')[0]
  return (VIEW_IDS.has(id) ? id : 'accounts') as ViewId
}
