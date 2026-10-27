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

/** 旧版 PK_ACCOUNT_COLORS 同款：按账号稳定取色（排序后分配，刷新不换色）。 */
const PK_ACCOUNT_COLORS = ['#4f8cff', '#25b08b', '#e8a33d', '#c96bd6', '#e2607a', '#20a4a4', '#8fbf3f', '#d4785c', '#5aa9e6', '#b58b5a']
const PK_DAY_MS = 86400000

/** 到期分布的一个分段：某账号某包的（FEFO 抵扣后）剩余积分。 */
type ExpirySeg = {
  uid: string
  accountName: string
  source: string
  amount: number
  expiresAt: number | null
  days: number | null
}

/**
 * pkAccountSegments（旧版同口径）：把账号余额按「先到期先扣（FEFO）」分摊到各包，
 * 得到每个包实际还在的积分段。到期时间为空（长期包）排最后。
 */
function pkAccountSegments(a: PkgRow, now: number): ExpirySeg[] {
  let balance = Math.max(0, Number(a.remain || 0))
  const out: ExpirySeg[] = []
  for (const p of a.packages || []) {
    const remain = Number(p.remain || 0)
    if (!Number.isFinite(remain) || remain <= 0 || balance <= 0) continue
    const amount = Math.min(balance, remain)
    const expiresAt = p.expires_at && p.expires_at > 0 ? p.expires_at : null
    out.push({
      uid: String(a.uid || ''),
      accountName: a.nickname || String(a.uid || '').slice(0, 8) || '未命名账号',
      source: p.name || '积分',
      amount,
      expiresAt,
      days: expiresAt == null ? null : Math.max(0, Math.ceil((expiresAt - now) / PK_DAY_MS)),
    })
    balance -= amount
  }
  return out.sort((x, y) => {
    if (x.expiresAt == null && y.expiresAt != null) return 1
    if (x.expiresAt != null && y.expiresAt == null) return -1
    return (x.expiresAt || 0) - (y.expiresAt || 0)
  })
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

  // 积分到期分布：只在套餐明细已查询后可算（需要逐包数据）。按账号稳定取色。
  const expiryDist = useMemo(() => {
    if (!pk) return null
    const now = Date.now()
    const usable = pk.filter((a) => !a.error && Number.isFinite(Number(a.remain)))
    const uids = usable.map((a) => String(a.uid)).sort()
    const colorMap = new Map<string, string>()
    uids.forEach((uid, i) => colorMap.set(uid, PK_ACCOUNT_COLORS[i % PK_ACCOUNT_COLORS.length]))
    const buckets = new Map<number, { days: number; credits: number; segments: ExpirySeg[] }>()
    let unavailable = 0
    for (const a of pk) {
      if (a.error || !Number.isFinite(Number(a.remain))) {
        unavailable++
        continue
      }
      for (const seg of pkAccountSegments(a, now)) {
        if (seg.days == null) continue
        let row = buckets.get(seg.days)
        if (!row) {
          row = { days: seg.days, credits: 0, segments: [] }
          buckets.set(seg.days, row)
        }
        row.credits += seg.amount
        row.segments.push(seg)
      }
    }
    const rows = [...buckets.values()].sort((a, b) => a.days - b.days)
    for (const row of rows) {
      row.segments.sort(
        (a, b) =>
          (a.expiresAt || Infinity) - (b.expiresAt || Infinity) ||
          a.accountName.localeCompare(b.accountName) ||
          a.source.localeCompare(b.source),
      )
    }
    const legend = usable
      .filter((a) => pkAccountSegments(a, now).some((s) => s.days != null))
      .map((a) => ({ name: a.nickname || String(a.uid).slice(0, 8), color: colorMap.get(String(a.uid)) || 'var(--accent)' }))
    return { rows, accountCount: usable.length, unavailable, colorMap, legend }
  }, [pk])

  // 账号对比卡片（旧版 pkSummary）：每账号一张卡，剩余/总额 + 按包来源的色条。
  const pkCards = useMemo(() => {
    if (!pk) return null
    const maxRemain = Math.max(1, ...pk.map((a) => Number(a.remain || 0)))
    // 包名 → 稳定色号（跨账号一致，肉眼对齐）。
    const names: string[] = []
    for (const a of pk) for (const p of a.packages || []) if (!names.includes(p.name)) names.push(p.name)
    const colorOf = (n: string) => PK_ACCOUNT_COLORS[names.indexOf(n) % PK_ACCOUNT_COLORS.length]
    return { list: pk, maxRemain, colorOf }
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

      {/* 积分到期分布：与旧版同构 —— 每个到期日一行，条内按账号分段着色。 */}
      <Card
        title="积分到期分布"
        hint="按批次到期日聚合，颜色区分账号"
        actions={
          <button className="btn sm" disabled={busy} onClick={() => void loadPackages()}>
            {busy ? '查询中…' : pk ? '刷新' : '查询'}
          </button>
        }
        flush
      >
        {!pk ? (
          <div className="empty">
            <div className="empty-desc">
              到期分布需要逐账号查上游套餐（慢且压上游），点「查询」拉取后展示。
            </div>
          </div>
        ) : !expiryDist || expiryDist.rows.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">{expiryDist && expiryDist.unavailable ? '部分账号查询失败，且没有可展示的到期批次。' : '没有按日到期的积分批次（长期包或已清空）。'}</div>
          </div>
        ) : (
          <div className="pad">
            <div className="pk-expiry-hdr">
              <span>剩余天数</span>
              <span style={{ textAlign: 'center' }}>各账号该批剩余</span>
              <b>剩余积分</b>
            </div>
            <div className="pk-expiry-chart">
            {expiryDist.rows.map((row) => {
              const total = row.credits || 1
              return (
                <div className="pk-expiry-row" key={row.days}>
                  <span>{row.days === 0 ? '已到期' : row.days + ' 天'}</span>
                  <div className="pk-expiry-track">
                    {row.segments.map((seg, i) => {
                      const color = expiryDist.colorMap.get(seg.uid) || 'var(--accent)'
                      const title =
                        seg.source +
                        '\n' + fmtCredit(seg.amount) + ' 积分\n' +
                        (seg.expiresAt ? '到期时间 ' + fmtLocalDateTime(seg.expiresAt) : '长期包') +
                        '\n' + seg.accountName
                      return (
                        <span
                          key={i}
                          className="pk-expiry-seg"
                          title={title}
                          style={{
                            background: color,
                            opacity: seg.days == null ? 1 : Math.max(0.25, 1 - seg.days / 90),
                            flex: Math.max(0.008, seg.amount / total) + ' 1 0',
                          }}
                        />
                      )
                    })}
                  </div>
                  <b>{fmtCredit(row.credits)}</b>
                </div>
              )
            })}
            </div>
            <div className="pk-legend">
              {expiryDist.legend.map((l, i) => (
                <span key={i}>
                  <i style={{ background: l.color }} />
                  {l.name}
                </span>
              ))}
              {expiryDist.unavailable ? <span>· {expiryDist.unavailable} 个未获取余额</span> : null}
            </div>
          </div>
        )}
      </Card>

      {/* 账号对比：与旧版同构 —— 每账号一张卡（剩余/总额 + 按包来源色条）。 */}
      <Card title="账号对比" hint={pk ? `${(pk || []).length} 个账号` : '查询套餐明细后展示'} flush>
        {!pkCards || pkCards.list.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">{pk ? '没有账号' : '点「积分到期分布」的「查询」后展示每账号对比。'}</div>
          </div>
        ) : (
          <div className="pad">
            <div className="pk-grid">
              {pkCards.list.map((a) => {
                if (a.error) {
                  return (
                    <div className="pk-card" key={a.uid}>
                      <div className="who">
                        <span className="nm">{a.nickname || String(a.uid).slice(0, 8)}</span>
                        <span className="realm">{a.realm || ''}</span>
                      </div>
                      <div className="row-reason">查询失败：{a.error}</div>
                    </div>
                  )
                }
                // 按包来源聚合（同名包合并），色条宽度按 size 占比。
                const bySrc = new Map<string, { name: string; size: number; n: number }>()
                for (const p of a.packages || []) {
                  const cur = bySrc.get(p.name) || { name: p.name, size: 0, n: 0 }
                  cur.size += Number(p.size || 0)
                  cur.n += 1
                  bySrc.set(p.name, cur)
                }
                const srcs = [...bySrc.values()].sort((x, y) => y.size - x.size)
                const total = Math.max(1, Number(a.size || 0))
                return (
                  <div className="pk-card" key={a.uid}>
                    <div className="who">
                      <span className="nm">{a.nickname || String(a.uid).slice(0, 8)}</span>
                      <span className="realm">{a.realm || ''}</span>
                    </div>
                    <div className="big">{fmtCredit(a.remain)}</div>
                    <div className="sub">
                      共 {fmtCredit(a.size)} · {(a.packages || []).length} 个包 · 占最高{' '}
                      {((Number(a.remain || 0) / pkCards.maxRemain) * 100).toFixed(0)}%
                    </div>
                    <div className="mixbar">
                      {srcs.map((s) => (
                        <i
                          key={s.name}
                          style={{
                            width: ((s.size / total) * 100).toFixed(2) + '%',
                            background: pkCards.colorOf(s.name),
                          }}
                          title={s.name + ' ' + fmtCredit(s.size)}
                        />
                      ))}
                    </div>
                    <div className="pk-legend">
                      {srcs.map((s) => (
                        <span key={s.name}>
                          <i style={{ background: pkCards.colorOf(s.name) }} />
                          {s.name.replace(/^CodeBuddy/, '')} ×{s.n} · {fmtCredit(s.size)}
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </Card>

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
