import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { errText, fmtCredit, ago } from '../lib/format'
import { type AccountStatus, type Overview } from '../lib/types'
import { Card, Seg, Stat, Stats, View, ViewHead } from '../components/Layout'
import AddAccountDialog from '../components/AddAccountDialog'
import RemarksDialog from '../components/RemarksDialog'
import { useRemarks } from '../lib/remarks'
import type { ViewProps } from './types'

/** 单号动作需要二次确认（会改变账号状态或不可撤销的那些）。 */
const CONFIRM: Record<string, string> = {
  remove: '移除后该账号会从池中删除，需要重新登录才能加回来。确定移除？',
  disable: '禁用后该账号不再参与选号，需手动「解冻」才能恢复。确定禁用？',
}

/** 状态标签：与旧面板同口径，把「不可选」的几种原因分开显示。 */
function stateTag(a: AccountStatus) {
  if (a.disabled) return <span className="tag bad">已禁用</span>
  if (a.paused) return <span className="tag warn">已暂停选号</span>
  if (a.breaker_until) return <span className="tag bad">熔断中</span>
  if (a.cooling) return <span className="tag warn">冷却中</span>
  if (a.degrade_until) return <span className="tag warn">连败降权</span>
  if (a.reserve_blocked) return <span className="tag warn">保留积分</span>
  if ((a.session_dead_fails || 0) > 0) return <span className="tag warn">疑似登录失效</span>
  return <span className="tag ok">可用</span>
}

/** 冷却剩余描述（冷却/熔断/降权取最大者，与后端选号判定同源）。 */
function coolText(a: AccountStatus): string {
  const sec = Math.max(
    a.cool_remaining_sec || 0,
    a.breaker_until ? (Date.parse(a.breaker_until) - Date.now()) / 1000 : 0,
    a.degrade_until ? (Date.parse(a.degrade_until) - Date.now()) / 1000 : 0,
    0,
  )
  if (sec <= 0) return ''
  if (sec < 60) return `${Math.ceil(sec)}s`
  if (sec < 3600) return `${Math.ceil(sec / 60)}m`
  return `${(sec / 3600).toFixed(1)}h`
}

/** 配额条：有总额度按剩余/总额，无总额则按池内最高值作分母。 */
function CreditCell({ a, maxCred }: { a: AccountStatus; maxCred: number }) {
  const unlimited = a.credits_total === -1
  const pct = unlimited
    ? 100
    : a.credits_total && a.credits_total > 0
      ? Math.min(100, Math.round(((a.credits || 0) / a.credits_total) * 100))
      : Math.round(((a.credits || 0) / Math.max(1, maxCred)) * 100)
  return (
    <div className="cred-cell">
      <div className="cred-n">
        {unlimited ? (
          <span>不限</span>
        ) : (
          <>
            {fmtCredit(a.credits)}
            {a.credits_total && a.credits_total > 0 ? (
              <span className="of">/{fmtCredit(a.credits_total)}</span>
            ) : null}
          </>
        )}
      </div>
      <div className="cred-bar" title={pct + '%'}>
        <i style={{ width: pct + '%' }} />
      </div>
    </div>
  )
}

/** 账号池：统计 + 账号表 + 加号/导入入口 + 行内操作。 */
export default function AccountsView({ onToast }: ViewProps) {
  const [d, setD] = useState<Overview | null>(null)
  const [err, setErr] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [remarkOpen, setRemarkOpen] = useState(false)
  const { of: remarkOf } = useRemarks()
  const [busy, setBusy] = useState<Record<string, string>>({})
  /** 全量动作与单号动作分开记：全量是整表级别的，不能复用行内按钮的 loading。 */
  const [batchBusy, setBatchBusy] = useState('')

  const load = useCallback(async () => {
    try {
      setD(await api<Overview>('overview'))
      setErr('')
    } catch (e) {
      setErr(errText(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 单号动作。成功后刷新 overview；失败把上游原因原样吐出来。 */
  const act = async (uid: string, action: string) => {
    const warn = CONFIRM[action]
    if (warn && !confirm(warn)) return
    setBusy((b) => ({ ...b, [uid]: action }))
    try {
      await api(`accounts/${encodeURIComponent(uid)}/${action}`, { body: {} })
      onToast('操作成功', 'ok')
      await load()
    } catch (e) {
      onToast(errText(e), 'err')
    } finally {
      setBusy((b) => {
        const next = { ...b }
        delete next[uid]
        return next
      })
    }
  }

  /** 全量动作（签到/旅行/活跃/保活/余额）。后端有防重入闸门，并发点不会重复跑。 */
  const batch = async (path: string, label: string) => {
    setBatchBusy(path)
    try {
      await api(path, { body: {} })
      onToast(`${label}已触发`, 'ok')
      await load()
    } catch (e) {
      onToast(errText(e), 'err')
    } finally {
      setBatchBusy('')
    }
  }

  const rows = d?.accounts || []
  const maxCred = useMemo(
    () => Math.max(1, ...rows.map((a) => a.credits || 0)),
    [rows],
  )

  const [filter, setFilter] = useState<'all' | 'usable' | 'problem'>('all')
  const shown = rows.filter((a) => {
    if (filter === 'usable') return !a.disabled && !a.paused && !a.cooling && !a.breaker_until
    if (filter === 'problem') return Boolean(a.disabled || a.paused || a.cooling || a.breaker_until)
    return true
  })

  if (err && !d) return <View><div className="empty err">读取失败：{err}</div></View>
  if (!d) return <View><div className="empty">加载中…</div></View>

  return (
    <View>
      <ViewHead
        title="账号池"
        desc="上游账号的健康状态、额度与手动运维入口。加号可添加账号（浏览器登录 / API Key / JSON 导入）。"
        actions={
          <>
            <button className="btn" onClick={() => setRemarkOpen(true)}>
              备注
            </button>
            <button className="btn primary" onClick={() => setAddOpen(true)}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
              </svg>
              添加账号
            </button>
          </>
        }
      />

      <Stats>
        <Stat label="账号总数" value={d.total ?? rows.length} />
        <Stat label="健康" value={d.healthy ?? '—'} tone="good" />
        <Stat label="冷却中" value={d.cooling ?? '—'} tone="warn" />
        <Stat label="已暂停选号" value={d.paused ?? '—'} tone="warn" />
        <Stat label="已禁用" value={d.disabled ?? '—'} tone="bad" />
        <Stat
          label="运行时长"
          value={typeof d.uptime_sec === 'number' ? `${Math.floor(d.uptime_sec / 3600)}h` : '—'}
          sub={d.sticky_sessions !== undefined ? `粘性 ${d.sticky_sessions}` : undefined}
        />
      </Stats>

      <Card
        title="账号池"
        hint={`${shown.length}/${rows.length}`}
        actions={
          <>
            <Seg
              value={filter}
              ariaLabel="筛选账号"
              onChange={setFilter}
              options={[
                { value: 'all', label: '全部' },
                { value: 'usable', label: '可用' },
                { value: 'problem', label: '异常' },
              ]}
            />
            <button
              className="btn sm"
              disabled={!!batchBusy}
              onClick={() => batch('checkin_all', '全量签到')}
            >
              签到
            </button>
            <button
              className="btn sm"
              disabled={!!batchBusy}
              onClick={() => batch('travel_all', '全量旅行')}
            >
              旅行
            </button>
            <button
              className="btn sm"
              disabled={!!batchBusy}
              onClick={() => batch('activity_all', '活跃上报')}
            >
              活跃
            </button>
            <button
              className="btn sm"
              disabled={!!batchBusy}
              onClick={() => batch('keepalive_all', '全量保活')}
            >
              保活
            </button>
            <button
              className="btn sm"
              disabled={!!batchBusy}
              onClick={() => batch('balance_all', '全量余额')}
            >
              余额
            </button>
          </>
        }
        flush
      >
        {shown.length === 0 ? (
          <div className="empty">
            {rows.length === 0 ? (
              <>
                <div className="empty-title">账号池是空的</div>
                <div className="empty-desc">
                  点右上角「添加账号」，用浏览器登录一个 WorkBuddy 账号，或用 API Key / JSON 导入。
                </div>
                <button className="btn primary" onClick={() => setAddOpen(true)}>
                  添加第一个账号
                </button>
              </>
            ) : (
              <div className="empty-desc">当前筛选条件下没有账号。</div>
            )}
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl acc-tbl">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>状态</th>
                  <th className="num">额度</th>
                  <th className="num">成功 / 失败</th>
                  <th className="num">在途</th>
                  <th>最近成功</th>
                  <th className="acts-col" />
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => {
                  const personal = !(a.enterprise || a.api_key)
                  const frozen = a.disabled || a.cooling || !!a.breaker_until || !!a.degrade_until
                  const busyAct = busy[a.uid]
                  const cool = coolText(a)
                  return (
                    <tr key={a.uid}>
                      <td className="who">
                        <div className="who-name">
                          {/* 备注优先显示，原名退成浅色虚体——备注是给人看的标签，
                              昵称仍要保留以免认不出到底是哪个号。 */}
                          {remarkOf(a.uid) ? (
                            <>
                              {remarkOf(a.uid)}
                              <span className="rm-ghost">{a.nickname || '未命名'}</span>
                            </>
                          ) : (
                            a.nickname || <span className="dim">未命名</span>
                          )}
                          {a.realm === 'global' ? <span className="tag">国际</span> : null}
                          {a.enterprise ? <span className="tag">企业</span> : null}
                          {a.api_key ? <span className="tag">API Key</span> : null}
                        </div>
                        <div className="who-id mono" title={a.uid}>
                          {String(a.uid).slice(0, 14)}
                        </div>
                      </td>
                      <td>
                        {stateTag(a)}
                        {cool ? <span className="dim cool-note"> {cool}</span> : null}
                        {a.reason ? (
                          <div className="row-reason" title={a.reason}>
                            {a.reason}
                          </div>
                        ) : null}
                      </td>
                      <td className="num">
                        <CreditCell a={a} maxCred={maxCred} />
                      </td>
                      <td className="num mono">
                        <span>{a.success_count || 0}</span>
                        <span className="dim"> / </span>
                        <span className="bad-text">{a.err_total || 0}</span>
                      </td>
                      <td className="num mono">{a.in_flight || 0}</td>
                      <td className="dim nowrap">{ago(a.last_success)}</td>
                      <td className="acts-col">
                        <div className="row-acts">
                          {personal ? (
                            <button
                              className="btn xs"
                              disabled={!!busyAct}
                              title={a.checkin_done ? '今日已签到；点击可重新签到' : '签到'}
                              onClick={() => act(a.uid, 'checkin')}
                            >
                              {a.checkin_done ? '已签' : '签到'}
                            </button>
                          ) : null}
                          <button
                            className="btn xs"
                            disabled={!!busyAct}
                            onClick={() => act(a.uid, 'balance')}
                          >
                            {a.enterprise ? '额度' : '余额'}
                          </button>
                          {frozen ? (
                            <>
                              <button
                                className="btn xs"
                                disabled={!!busyAct}
                                title="只读探测上游是否已解封，不改任何状态"
                                onClick={() => act(a.uid, 'probe_ban')}
                              >
                                探活
                              </button>
                              <button
                                className="btn xs primary"
                                disabled={!!busyAct}
                                onClick={() => act(a.uid, 'revive')}
                              >
                                解冻
                              </button>
                            </>
                          ) : a.paused ? (
                            <button
                              className="btn xs primary"
                              disabled={!!busyAct}
                              onClick={() => act(a.uid, 'resume')}
                            >
                              恢复选号
                            </button>
                          ) : (
                            <button
                              className="btn xs"
                              disabled={!!busyAct}
                              title="退出选号，但照常签到 / 保活 / 刷新余额"
                              onClick={() => act(a.uid, 'pause')}
                            >
                              暂停
                            </button>
                          )}
                          {a.disabled ? null : (
                            <button
                              className="btn xs"
                              disabled={!!busyAct}
                              onClick={() => act(a.uid, 'disable')}
                            >
                              禁用
                            </button>
                          )}
                          <button
                            className="btn xs danger"
                            disabled={!!busyAct}
                            onClick={() => act(a.uid, 'remove')}
                          >
                            移除
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {remarkOpen ? (
        <RemarksDialog
          accounts={rows.map((a) => ({ uid: a.uid, nickname: a.nickname }))}
          onClose={() => setRemarkOpen(false)}
          onToast={onToast}
        />
      ) : null}

      {addOpen ? (
        <AddAccountDialog
          onClose={() => setAddOpen(false)}
          onDone={async (msg) => {
            onToast(msg, 'ok')
            await load()
          }}
          onToast={onToast}
        />
      ) : null}
    </View>
  )
}
