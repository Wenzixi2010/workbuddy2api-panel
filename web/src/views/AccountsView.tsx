import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { errText, fmtCredit, fmtK, ago } from '../lib/format'
import { type AccountStatus, type Overview } from '../lib/types'
import { Card, Seg, Stat, Stats, View } from '../components/Layout'
import AddAccountDialog from '../components/AddAccountDialog'
import RemarksDialog from '../components/RemarksDialog'
import { useRemarks } from '../lib/remarks'
import type { ViewProps } from './types'

/** 单号动作需要二次确认（会改变账号状态或不可撤销的那些）。 */
const CONFIRM: Record<string, string> = {
  remove: '移除后该账号会从池中删除，需要重新登录才能加回来。确定移除？',
  disable: '禁用后该账号不再参与选号，需手动「解冻」才能恢复。确定禁用？',
}

/** 模型锁池一行（internal/pool.ModelLockRow）。 */
type ModelLockRow = {
  model: string
  realm: string
  total?: number
  servable?: number
  locked?: number
  state: string
  unlock_at?: string
  fully_unlock_at?: string
  reason?: string
}

/** 锁池状态 → 标签（与旧版 ML_STATE 同款）。 */
const ML_STATE: Record<string, { cls: string; label: string }> = {
  locked: { cls: 'bad', label: '全池锁定' },
  starved: { cls: 'warn', label: '此刻无号' },
  partial: { cls: 'ok', label: '部分限流' },
}

/** 延迟文案（与旧版 formatLatency 同款）。 */
function latencyText(ms?: number): string {
  if (!ms || ms <= 0) return '—'
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms'
}

/** 生成速度文案（与旧版 formatRate 同款）。 */
function rateText(tps?: number): string {
  if (!tps || tps <= 0) return '—'
  return tps >= 100 ? Math.round(tps) + ' t/s' : tps.toFixed(1) + ' t/s'
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

  // 模型锁池（/overview 的 model_locks，与 /status 同源）：哪些模型不能用、还要锁多久。
  const [locks, setLocks] = useState<ModelLockRow[]>([])
  useEffect(() => {
    api<{ model_locks?: ModelLockRow[] }>('overview')
      .then((r) => setLocks(r.model_locks || []))
      .catch(() => setLocks([]))
  }, [d]) // d 变化（每次轮询刷新）后同步一次锁池

  const rows = d?.accounts || []
  const maxCred = useMemo(
    () => Math.max(1, ...rows.map((a) => a.credits || 0)),
    [rows],
  )

  // 积分到期提醒行：每账号取最早到期批次（与旧版同口径；无未来批次不入表）。
  const expiryRows = useMemo(() => {
    const now = Date.now()
    const out: { uid: string; name: string; date: string; days: number; remain: number; daily: string }[] = []
    for (const a of rows) {
      const bs = (a.credits_expiry_buckets || []).filter((b) => {
        if (!b.date) return false
        const t = Date.parse(b.date + 'T23:59:59+08:00')
        return Number.isFinite(t) && t >= now
      })
      if (!bs.length) continue
      const b = bs[0]
      const days = Math.max(0, Math.ceil((Date.parse(b.date + 'T23:59:59+08:00') - now) / 86400000))
      out.push({
        uid: a.uid,
        name: a.nickname || String(a.uid).slice(0, 12),
        date: b.date,
        days,
        remain: b.remain || 0,
        daily: days === 0 ? '—' : fmtCredit((b.remain || 0) / days),
      })
    }
    return out
  }, [rows])

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
      <Stats>
        <Stat label="账号总数" value={d.total ?? rows.length} />
        <Stat label="可用" value={d.healthy ?? '—'} tone="good" />
        <Stat label="冷却中" value={d.cooling ?? '—'} tone="warn" />
        <Stat label="已暂停选号" value={d.paused ?? '—'} tone="warn" />
        <Stat label="已禁用" value={d.disabled ?? '—'} tone="bad" />
        <Stat
          label="积分剩余 / 总额"
          value={fmtCredit(rows.reduce((s, a) => s + (a.credits || 0), 0))}
          sub={(() => {
            const t = rows.reduce((s, a) => s + (a.credits_total && a.credits_total > 0 ? a.credits_total : 0), 0)
            return t > 0 ? `总额 ${fmtCredit(t)}` : undefined
          })()}
        />
        <Stat label="粘性会话" value={d.sticky_sessions ?? 0} />
      </Stats>

      {/* 积分到期提醒：与旧版同构 —— 按账号列出最早到期批次与日均需耗（FEFO 口径）。 */}
      {expiryRows.length > 0 ? (
        <Card title="积分到期提醒" hint="按自然日聚合 · 日均需耗 = 该日到期积分 ÷ 距到期天数 · 上游按失效时刻先后自动优先扣减（FEFO）" flush>
          <div className="tbl-wrap">
            <table className="acc">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>最近到期</th>
                  <th className="num">距到期</th>
                  <th className="num">该日到期</th>
                  <th className="num">日均需耗</th>
                </tr>
              </thead>
              <tbody>
                {expiryRows.map((r) => (
                  <tr key={r.uid}>
                    <td>{r.name}</td>
                    <td className="dim nowrap">{r.date}</td>
                    <td className={'num mono' + (r.days <= 3 ? ' bad-text' : r.days <= 7 ? ' warn-text' : '')}>
                      {r.days === 0 ? '今天' : `${r.days} 天`}
                    </td>
                    <td className="num mono">{fmtCredit(r.remain)}</td>
                    <td className="num mono">{r.daily}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <Card
        title="账号池"
        hint={`${shown.length}/${rows.length}`}
        actions={
          <>
            <button
              className="btn sm"
              disabled={!!batchBusy}
              onClick={() => batch('checkin_all', '全量签到')}
            >
              全部签到
            </button>
            <button
              className="btn sm"
              disabled={!!batchBusy}
              onClick={() => batch('travel_all', '全量旅行')}
            >
              旅行巡检
            </button>
            <button
              className="btn sm"
              disabled={!!batchBusy}
              onClick={() => batch('activity_all', '活跃上报')}
            >
              活跃上报
            </button>
            <button
              className="btn sm"
              disabled={!!batchBusy}
              onClick={() => batch('keepalive_all', '全量保活')}
            >
              全部保活
            </button>
            <button
              className="btn sm"
              disabled={!!batchBusy}
              onClick={() => batch('balance_all', '全量余额')}
            >
              刷新余额
            </button>
            <button className="btn sm" onClick={() => setRemarkOpen(true)}>
              备注
            </button>
            <button className="btn sm primary" onClick={() => setAddOpen(true)}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
              </svg>
              添加账号
            </button>
          </>
        }
        flush
      >
        <div className="fbar">
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
          <span className="grow" />
          <span className="note">{shown.length} 个账号</span>
        </div>
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
            <table className="acc">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>状态</th>
                  <th className="num">积分</th>
                  <th className="num">成功 / 失败</th>
                  <th className="num">在途</th>
                  <th className="num" title="最近一次：请求次数 / 总 token / 延迟 / 生成速度">
                    用量
                  </th>
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
                      <td className="num usage-cell" title={`最近一次：${a.token_usage?.request_count || 0} 次 / ${a.token_usage?.total_tokens ? fmtK(a.token_usage.total_tokens) : '—'}`}>
                        <span className="usage-item usage-count">
                          <b>{a.token_usage?.request_count || 0}</b>
                          <em>次</em>
                        </span>
                        <span className="usage-item usage-total">
                          <b>{a.token_usage?.total_tokens ? fmtK(a.token_usage.total_tokens) : '—'}</b>
                          {a.token_usage?.total_tokens ? <em>tok</em> : null}
                        </span>
                        <span className="usage-item usage-latency">
                          <b>{latencyText(a.token_usage?.last_latency_ms)}</b>
                        </span>
                        <span className="usage-item usage-rate">
                          <b>{rateText(a.token_usage?.last_tokens_per_second)}</b>
                        </span>
                      </td>
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

      {/* 模型锁池：与旧版同构 —— 哪些模型不能用、锁了几个号、还要锁多久。 */}
      <Card
        title="模型锁池"
        hint={locks.length ? `${locks.length} 个模型受限` : '当前没有模型级限流 —— 所有模型均可选'}
        flush
      >
        {locks.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">当前没有模型级限流 —— 所有模型均可选。</div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="acc">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>域</th>
                  <th>状态</th>
                  <th className="num">可选 / 总数</th>
                  <th className="num">锁定账号</th>
                  <th className="num">最早解锁</th>
                  <th className="num">全池解锁</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {locks.map((r, i) => {
                  const ml = ML_STATE[r.state] || { cls: '', label: r.state || '—' }
                  const fmtT = (s?: string) => {
                    if (!s || s.startsWith('0001-')) return '—'
                    const d = new Date(s)
                    return Number.isFinite(d.getTime())
                      ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
                      : '—'
                  }
                  return (
                    <tr key={`${r.model}-${r.realm}-${i}`}>
                      <td>
                        <b>{r.model}</b>
                      </td>
                      <td>{r.realm === 'global' ? '国际版' : '国内版'}</td>
                      <td>
                        <span className={'tag ' + ml.cls}>{ml.label}</span>
                      </td>
                      <td className="num mono">
                        {r.servable || 0} / {r.total || 0}
                      </td>
                      <td className="num mono">{r.locked || 0}</td>
                      <td className="num mono dim">{fmtT(r.unlock_at)}</td>
                      <td className="num mono dim">{fmtT(r.fully_unlock_at)}</td>
                      <td className="row-reason" title={r.reason || ''}>
                        {r.reason || '—'}
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
