import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { errText, fmtCredit, fmtLocalDateTime } from '../lib/format'
import { type Overview } from '../lib/types'
import { Card, Stat, Stats, View } from '../components/Layout'
import type { ViewProps } from './types'

/** 上游套餐一行。 */
type CreditPackage = {
  name: string
  remain: number
  used: number
  size: number
  end_time?: string
  expires_at?: number
  created_at?: string
  package_code?: string
}

type PkgRow = {
  uid: string
  nickname: string
  realm: string
  remain: number
  size: number
  packages: CreditPackage[]
  plan: string
  plan_evidence?: string
  error?: string
}

const PLAN_LABEL: Record<string, string> = {
  free: '免费',
  pro: 'Pro',
  max: 'Max',
  team: '团队',
  enterprise: '企业',
  unknown: '未知',
}

/** 剩余天数：只用 expires_at（毫秒），避免各时区解析歧义。 */
function remainDays(ms?: number): number | null {
  if (!ms || ms <= 0) return null
  const d = (ms - Date.now()) / 86400000
  return d > 0 ? d : 0
}

export default function PackagesView({ onToast }: ViewProps) {
  const [ov, setOv] = useState<Overview | null>(null)
  const [pk, setPk] = useState<PkgRow[] | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const loadOverview = useCallback(async () => {
    try {
      setOv(await api<Overview>('overview'))
      setErr('')
    } catch (e) {
      setErr(errText(e))
    }
  }, [])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  /**
   * 套餐明细要逐个账号查上游，很慢（N 个号就是 N 次往返）。
   * 所以**不自动拉**：进页面只看 overview 里现成的到期批次，点按钮才去查上游。
   * 旧面板也是这个策略——挂进轮询会把上游压垮。
   */
  const loadPackages = async () => {
    setBusy(true)
    try {
      const r = await api<{ accounts: PkgRow[] }>('packages')
      setPk(r.accounts || [])
      onToast('套餐明细已更新', 'ok')
    } catch (e) {
      onToast(errText(e), 'err')
    } finally {
      setBusy(false)
    }
  }

  const accts = ov?.accounts || []

  // 到期批次汇总：把各账号的 buckets 拉平，按日期聚合，看清"哪天有多少积分要过期"。
  const expiry = useMemo(() => {
    const byDate = new Map<string, number>()
    for (const a of accts) {
      for (const b of a.credits_expiry_buckets || []) {
        byDate.set(b.date, (byDate.get(b.date) || 0) + (b.remain || 0))
      }
    }
    return [...byDate.entries()].sort((x, y) => x[0].localeCompare(y[0]))
  }, [accts])

  const totalRemain = accts.reduce((s, a) => s + (a.credits || 0), 0)
  const totalExpiring = accts.reduce((s, a) => s + (a.credits_expiring || 0), 0)
  const planCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of pk || []) m.set(r.plan, (m.get(r.plan) || 0) + 1)
    return m
  }, [pk])

  if (err && !ov) return <View><div className="empty err">读取失败：{err}</div></View>
  if (!ov) return <View><div className="empty">加载中…</div></View>

  return (
    <View>
      <Stats>
        <Stat label="账号数" value={accts.length} />
        <Stat label="积分合计" value={fmtCredit(totalRemain)} tone="accent" />
        <Stat label="即将过期" value={fmtCredit(totalExpiring)} tone={totalExpiring ? 'warn' : undefined} />
        <Stat label="到期批次" value={expiry.length} />
        {pk
          ? [...planCount.entries()].map(([plan, n]) => (
              <Stat key={plan} label={PLAN_LABEL[plan] || plan} value={n} />
            ))
          : null}
      </Stats>

      <Card title="积分余额" hint={`${accts.length} 个账号`} flush>
        {accts.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">还没有账号。</div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="acc">
              <thead>
                <tr>
                  <th>账号</th>
                  <th className="num">当前</th>
                  <th className="num">总额度</th>
                  <th className="num">即将过期</th>
                  <th>最早到期</th>
                  <th className="num">批次</th>
                </tr>
              </thead>
              <tbody>
                {accts.map((a) => (
                  <tr key={a.uid}>
                    <td>
                      <div>{a.nickname || <span className="dim">未命名</span>}</div>
                      {a.realm === 'global' ? <span className="tag">国际</span> : null}
                    </td>
                    <td className="num mono">{fmtCredit(a.credits)}</td>
                    <td className="num mono">{a.credits_total ? fmtCredit(a.credits_total) : '—'}</td>
                    <td className="num mono">
                      {a.credits_expiring ? (
                        <span className="bad-text">{fmtCredit(a.credits_expiring)}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="dim nowrap">
                      {a.credits_earliest_expiry && !a.credits_earliest_expiry.startsWith('0001')
                        ? new Date(a.credits_earliest_expiry).toLocaleDateString()
                        : '—'}
                    </td>
                    <td className="num mono">{(a.credits_expiry_buckets || []).length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="到期批次" hint="先到期先扣（FEFO）" flush>
        {expiry.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">没有待过期的积分批次。</div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="acc">
              <thead>
                <tr>
                  <th>到期日期</th>
                  <th className="num">涉及积分</th>
                </tr>
              </thead>
              <tbody>
                {expiry.map(([date, amount]) => (
                  <tr key={date}>
                    <td className="mono">{date}</td>
                    <td className="num mono">{fmtCredit(amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="套餐明细"
        hint={pk ? `${pk.length} 个账号` : '未查询'}
        actions={
          <button className="btn sm" disabled={busy} onClick={() => void loadPackages()}>
            {busy ? '查询中…' : '刷新'}
          </button>
        }
        flush
      >
        {!pk ? (
          <div className="empty">
            <div className="empty-desc">
              套餐明细需要逐个账号查上游（慢且压上游），所以不自动加载。点「查套餐明细」拉取。
            </div>
          </div>
        ) : pk.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">没有账号。</div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="acc">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>套餐</th>
                  <th className="num">剩余 / 总量</th>
                  <th className="num">包数</th>
                  <th className="acts-col" />
                </tr>
              </thead>
              <tbody>
                {pk.map((r) => {
                  const open = !!expanded[r.uid]
                  return (
                    <Fragment key={r.uid}>
                      <tr>
                        <td>
                          <div>{r.nickname || String(r.uid).slice(0, 10)}</div>
                          {r.error ? (
                            <div className="row-reason" title={r.error}>
                              {r.error}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <span className={'tag ' + (r.plan === 'unknown' ? 'mute' : 'ok')}>
                            {PLAN_LABEL[r.plan] || r.plan}
                          </span>
                          {r.plan_evidence ? (
                            <div className="who-id" title={r.plan_evidence}>
                              {r.plan_evidence}
                            </div>
                          ) : null}
                        </td>
                        <td className="num mono">
                          {fmtCredit(r.remain)}
                          {r.size ? <span className="dim"> / {fmtCredit(r.size)}</span> : null}
                        </td>
                        <td className="num mono">{r.packages?.length || 0}</td>
                        <td className="acts-col">
                          {r.packages?.length ? (
                            <button
                              className="btn xs"
                              onClick={() => setExpanded((s) => ({ ...s, [r.uid]: !open }))}
                            >
                              {open ? '收起' : '展开'}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                      {open
                        ? r.packages.map((p, i) => {
                            const days = remainDays(p.expires_at)
                            const soon = days !== null && days <= 7
                            return (
                              <tr key={r.uid + i} className="sub-row">
                                <td className="dim" style={{ paddingLeft: 28 }}>
                                  {p.name}
                                </td>
                                <td className="dim mono">{p.package_code || ''}</td>
                                <td className="num mono">
                                  {fmtCredit(p.remain)}
                                  {p.size ? <span className="dim"> / {fmtCredit(p.size)}</span> : null}
                                </td>
                                <td className={'num nowrap ' + (soon ? 'bad-text' : 'dim')}>
                                  {days === null
                                    ? '—'
                                    : days === 0
                                      ? '已过期'
                                      : `${Math.ceil(days)} 天`}
                                </td>
                                <td className="acts-col dim nowrap">
                                  {p.expires_at ? fmtLocalDateTime(p.expires_at) : ''}
                                </td>
                              </tr>
                            )
                          })
                        : null}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </View>
  )
}
