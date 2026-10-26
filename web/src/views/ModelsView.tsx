import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { errText, fmtCredit, fmtK } from '../lib/format'
import { type AccountStatus, type Overview } from '../lib/types'
import { Card, Stat, Stats, View } from '../components/Layout'
import type { ViewProps } from './types'

/** /panel/api/models 里一条模型目录项（字段由上游透传，与旧版 app.js 的 panelModelEntry 同口径）。 */
type ModelItem = {
  id: string
  name?: string
  default_effort?: string
  supported_efforts?: string[]
  can_disable_thinking?: boolean
  supports_reasoning?: boolean
  supports_images?: boolean
  credits?: string | number
  description?: string
  tags?: string[]
  vendor?: string
  tier?: string
  is_default?: boolean
  supports_tool_call?: boolean
  only_reasoning?: boolean
  reasoning_effort?: string
  promo_factor?: number | null
  promo_credits?: string | number
  promo_label?: string
  promo_note?: string
  max_allowed_size?: number
  context_length?: number
  max_output_tokens?: number
  busy?: string
  image_generation?: boolean
  measured_credit?: number | string
  charge_last?: { credit?: number; size?: string; quality?: string; output_image_tokens?: number; output_image_coefficient?: number }
  [k: string]: unknown
}

type ModelsResp = {
  models: ModelItem[]
  global_source?: string
}

/** POST /panel/api/models/test 的返回。 */
type ModelTestResult = {
  ok: boolean
  elapsed_ms?: number
  content?: string
  model?: string
  error?: string
  kind?: string
  status?: number
  usage?: unknown
}

/** /panel/api/status 里的模型级限流全清单。 */
type ModelLockRow = {
  model: string
  realm: string
  total?: number
  servable?: number
  locked?: number
  state: string
  reason?: string
}

/** /panel/api/model_probes 的探测条目（输出上限实测）。 */
type Probe = {
  claimed?: number
  measured?: number
  note?: string
  tested_at?: string
  verdict?: string
}

/** /panel/api/request_metrics 的最近请求条目。 */
type RecentEvent = {
  model?: string
  status?: number
  time?: string
  outcome?: string
}

/** 模型 id 形如 "cn:glm-5.2" / "global:claude-x"，拆出域与原名。 */
function splitID(id: string): { realm: string; name: string } {
  const i = id.indexOf(':')
  if (i < 0) return { realm: 'cn', name: id }
  return { realm: id.slice(0, i), name: id.slice(i + 1) }
}

/** 繁忙度文案：只标需要避让的三档。 */
const BUSY_WORDS: Record<string, string> = { busy: '繁忙', congested: '拥堵', unavailable: '不可用' }

/** 倍率数值：优先促销价（限时免费 = 0），无倍率记为 Infinity（排最后）。 */
function mdRateValue(m: ModelItem): number {
  const raw = m.promo_credits != null && m.promo_credits !== '' ? m.promo_credits : m.credits
  const n = parseFloat(String(raw == null ? '' : raw).replace(/[^\d.]/g, ''))
  return Number.isFinite(n) ? n : Infinity
}

/** 参与关键字搜索的字段。 */
function mdSearchText(m: ModelItem): string {
  return [m.id, m.name, m.vendor, m.description, (m.tags || []).join(' ')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

type Filter = { q: string; realm: string; cap: string; effort: string; promo: string; sort: string }

function mdMatch(m: ModelItem, f: Filter): boolean {
  if (f.q) {
    const text = mdSearchText(m)
    for (const kw of f.q.toLowerCase().split(/\s+/).filter(Boolean)) {
      if (!text.includes(kw)) return false
    }
  }
  if (f.realm && !String(m.id || '').startsWith(f.realm + ':')) return false
  if (f.cap === 'tool' && !m.supports_tool_call) return false
  if (f.cap === 'vision' && !m.supports_images) return false
  if (f.cap === 'reasoning' && !m.supports_reasoning) return false
  if (f.cap === 'default' && !m.is_default) return false
  if (f.effort === 'off') {
    if (!m.can_disable_thinking) return false
  } else if (f.effort && !(m.supported_efforts || []).includes(f.effort)) {
    return false
  }
  const factor = m.promo_factor == null ? null : Number(m.promo_factor)
  if (f.promo === 'promo' && factor == null && !m.promo_label) return false
  if (f.promo === 'free' && factor !== 0) return false
  if (f.promo === 'discount' && !(factor != null && factor > 0)) return false
  return true
}

function mdSortList(list: ModelItem[], f: Filter): ModelItem[] {
  const out = list.slice()
  const num = (v: unknown) => {
    const n = Number(v || 0)
    return Number.isFinite(n) ? n : 0
  }
  if (f.sort === 'rate') out.sort((a, b) => mdRateValue(a) - mdRateValue(b))
  else if (f.sort === 'context') out.sort((a, b) => num(b.context_length) - num(a.context_length))
  else if (f.sort === 'output') out.sort((a, b) => num(b.max_output_tokens) - num(a.max_output_tokens))
  else if (f.sort === 'name') out.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')))
  return out
}

/** 可用性标签：模型锁优先于最近请求结果（仅 global 域有真实证据）。 */
function mdAvailabilityOf(
  m: ModelItem,
  locks: ModelLockRow[],
  recent: RecentEvent[],
): { key: string; label: string; cls: string; tip: string } | null {
  const id = String(m.id || '')
  if (!id.startsWith('global:')) return null
  const bare = id.slice('global:'.length)
  const lock = locks.find((r) => r && r.realm === 'global' && r.model === bare)
  if (lock) {
    const reason = String(lock.reason || '').trim()
    const lower = reason.toLowerCase()
    if (lock.state === 'partial') {
      return {
        key: 'partial',
        label: '部分可用',
        cls: 'warn',
        tip: `仍有 ${Number(lock.servable || 0)} 个 global 账号可服务；已锁 ${Number(lock.locked || 0)} 个${reason ? '；' + reason : ''}`,
      }
    }
    if (lock.state === 'starved') {
      return {
        key: 'starved',
        label: '账号暂不可用',
        cls: 'mute',
        tip: '没有账号能服务该模型，但并非该模型自身被锁；请检查账号冷却/在途占用',
      }
    }
    if (lower.startsWith('11158') || lower.includes('not allowed for user type')) {
      return { key: 'denied', label: '无权限', cls: 'bad', tip: '当前 global 账号类型不支持该模型' + (reason ? '；' + reason : '') }
    }
    if (lower.startsWith('11102') || lower.includes('service info not found')) {
      return { key: 'missing', label: '上游无此模型', cls: 'bad', tip: '上游目录残留，实际请求返回模型不存在' + (reason ? '；' + reason : '') }
    }
    return { key: 'limited', label: '限流/不可用', cls: 'warn', tip: '模型级冷却中' + (reason ? '；' + reason : '') }
  }
  const ev = recent.find((e) => e && e.model === id)
  if (ev) {
    const status = Number(ev.status || 0)
    const when = ev.time ? new Date(ev.time).toLocaleString('zh-CN', { hour12: false }) : ''
    if (ev.outcome === 'success' || (status >= 200 && status < 300)) {
      return { key: 'ok', label: '可用', cls: 'ok', tip: '最近一次真实请求成功' + (when ? ' · ' + when : '') }
    }
    if (status === 429) {
      return { key: 'rate', label: '限流', cls: 'warn', tip: '最近一次请求被限流' + (when ? ' · ' + when : '') }
    }
    if (status >= 500) {
      return { key: 'upstream', label: '上游错误', cls: 'bad', tip: '最近一次请求上游错误 HTTP ' + status + (when ? ' · ' + when : '') }
    }
    return { key: 'failed', label: '最近失败', cls: 'bad', tip: '最近一次请求失败 HTTP ' + (status || '—') + (when ? ' · ' + when : '') }
  }
  return { key: 'unknown', label: '待验证', cls: 'mute', tip: '尚无模型锁或近期真实请求记录；目录存在不代表当前账号有权限' }
}

/** 倍率列：牌价 vs 生效价（与旧版 rateCell 同口径）。 */
function rateCell(m: ModelItem): React.ReactNode {
  if (m.promo_factor != null && m.promo_credits) {
    return (
      <span title={m.promo_note} style={{ cursor: 'help' }}>
        <b>{String(m.promo_credits)}</b>
        {m.promo_label ? <span className="tag ok"> {m.promo_label}</span> : null}
        {m.credits ? (
          <s style={{ color: 'var(--ink-3)', fontSize: 11.5 }}> {String(m.credits)}</s>
        ) : null}
      </span>
    )
  }
  if (m.promo_label) {
    return (
      <span title={m.promo_note} style={{ cursor: 'help' }}>
        {m.credits ? String(m.credits) : '—'} <span className="tag warn">{m.promo_label}</span>
      </span>
    )
  }
  if (!m.credits && m.measured_credit) {
    return (
      <span title="上游未报倍率；此值来自本网关的实际扣费记录（credits/张）" style={{ cursor: 'help', color: 'var(--ink-2)' }}>
        实测 {String(m.measured_credit)}/张
      </span>
    )
  }
  return m.credits ? String(m.credits) : '—'
}

/** 最大输出列：探测标注（与旧版 outCell 同口径）。 */
function outCell(m: ModelItem, pr: Probe | undefined): React.ReactNode {
  if (!pr) {
    return <span>{m.max_output_tokens ? fmtK(m.max_output_tokens) : '—'}</span>
  }
  const tip =
    `声称 ${pr.claimed ? fmtK(pr.claimed) : '?'} · 实测 ${pr.measured ? fmtK(pr.measured) : '?'}` +
    (pr.note ? ' · ' + pr.note : '') +
    (pr.tested_at ? ' · 探测于 ' + pr.tested_at : '')
  const days = pr.tested_at ? Math.floor((Date.now() - new Date(pr.tested_at).getTime()) / 86400000) : null
  const stale = days != null && days > 30 ? ' · ' + days + ' 天前' : ''
  if (pr.verdict === 'clamped' && pr.measured) {
    if (pr.claimed && pr.measured < pr.claimed) {
      const x = pr.claimed / pr.measured
      const xs = (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10) + '×'
      return (
        <span title={tip}>
          <span style={{ color: 'var(--warn)', fontWeight: 600 }}>{fmtK(pr.measured)} ⚠</span>
          <div className="note">钳制 {xs}{stale}</div>
        </span>
      )
    }
    return (
      <span title={tip}>
        <span style={{ color: 'var(--ok)' }}>
          {fmtK(pr.measured)}
          {pr.claimed && pr.measured > pr.claimed ? ' ↑' : ' ✓'}
        </span>
      </span>
    )
  }
  if (pr.verdict === 'at_least' && pr.measured) {
    return (
      <span title={tip} style={{ color: 'var(--ink-3)' }}>
        ≥{fmtK(pr.measured)}
      </span>
    )
  }
  return (
    <span title={tip}>
      <span style={{ color: 'var(--ink-3)' }}>?</span>
      <div className="note">未测出{stale}</div>
    </span>
  )
}

export default function ModelsView(_props: ViewProps) {
  const [resp, setResp] = useState<ModelsResp | null>(null)
  const [ov, setOv] = useState<Overview | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Filter>({ q: '', realm: '', cap: '', effort: '', promo: '', sort: 'default' })
  const [locks, setLocks] = useState<ModelLockRow[]>([])
  const [recent, setRecent] = useState<RecentEvent[]>([])
  const [probes, setProbes] = useState<Record<string, Probe>>({})
  const [testing, setTesting] = useState<ModelItem | null>(null)
  const [testUid, setTestUid] = useState('')
  const [testBusy, setTestBusy] = useState(false)
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null)

  const runModelTest = async (m: ModelItem, uid: string) => {
    setTestBusy(true)
    setTestResult(null)
    try {
      const { name } = splitID(m.id)
      const r = await api<ModelTestResult>('models/test', {
        method: 'POST',
        body: { uid, model: name },
      })
      setTestResult(r)
    } catch (e) {
      setTestResult({ ok: false, error: errText(e) })
    } finally {
      setTestBusy(false)
    }
  }

  const loadModels = useCallback(async (force = false) => {
    setBusy(true)
    try {
      const [d, pr, st, rm] = await Promise.all([
        api<ModelsResp>('models' + (force ? '?refresh=1' : '')),
        api<{ probes?: Record<string, Probe> }>('model_probes').catch(() => ({ probes: {} }) as { probes?: Record<string, Probe> }),
        api<{ model_locks?: ModelLockRow[] }>('status').catch(() => ({ model_locks: [] }) as { model_locks?: ModelLockRow[] }),
        api<{ recent?: RecentEvent[] }>('request_metrics').catch(() => ({ recent: [] }) as { recent?: RecentEvent[] }),
      ])
      setResp(d)
      setProbes(pr.probes || {})
      setLocks(Array.isArray(st.model_locks) ? st.model_locks : [])
      setRecent(Array.isArray(rm.recent) ? rm.recent : [])
      setErr('')
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void loadModels()
    api<Overview>('overview')
      .then(setOv)
      .catch(() => {
        /* 成本台账取不到不影响目录展示 */
      })
  }, [loadModels])

  const probeOf = useCallback(
    (id: string) => {
      const keys = Object.keys(probes)
      return probes[id] || probes[keys.find((k) => k.endsWith(':' + id)) || '']
    },
    [probes],
  )

  const rows = useMemo(() => {
    const all = resp?.models || []
    return mdSortList(all.filter((m) => mdMatch(m, filter)), filter)
  }, [resp, filter])

  // 实测成本台账：摊平成 (账号, 模型) 粒度。
  const costs = useMemo(() => {
    const accts: AccountStatus[] = ov?.accounts || []
    return accts.flatMap((a) =>
      (a.model_costs || []).map((m) => ({
        uid: a.uid,
        nick: a.nickname || String(a.uid).slice(0, 10),
        model: m.model,
        cost: m.cost_per_1k,
        samples: m.samples,
        last: m.last_seen,
      })),
    )
  }, [ov])

  const freeCount = costs.filter((c) => c.cost <= 0).length
  const total = resp?.models.length ?? 0
  const filtered = rows.length !== total

  const srcNote = { 'v3-desktop': '', 'v3-union': ' · ⚠ 国际版目录来自回落（IDE+CLI 并集）', enterprise: ' · ⚠ 国际版目录已降级到企业端点（窄目录/旧倍率）' }[
    resp?.global_source || ''
  ] || ''

  if (err && !resp) {
    return (
      <View>
        <div className="empty err">读取失败：{err}</div>
        <button className="btn" onClick={() => void loadModels()}>
          重试
        </button>
      </View>
    )
  }

  return (
    <View>
      <Stats>
        <Stat label="模型总数" value={total || '—'} />
        <Stat label="筛选后" value={rows.length} />
        <Stat label="国内版" value={(resp?.models || []).filter((m) => splitID(m.id).realm === 'cn').length} />
        <Stat label="国际版" value={(resp?.models || []).filter((m) => splitID(m.id).realm === 'global').length} />
        <Stat label="实测免费" value={freeCount} tone={freeCount ? 'good' : undefined} sub={`${costs.length} 条台账`} />
      </Stats>

      {err ? <div className="note err">{err}</div> : null}

      <Card
        title="模型与档位"
        actions={
          <>
            <span className="note">
              {total ? `${total} 个模型 · 已刷新降级缓存` : '实时查询上游'}
              {srcNote}
            </span>
            <button className="btn sm" disabled={busy} onClick={() => void loadModels(true)}>
              {busy ? '查询中…' : '重新获取'}
            </button>
          </>
        }
        flush
      >
        <div className="fbar">
          <input
            type="search"
            placeholder="搜索模型 ID / 名称 / 描述 / 厂商"
            aria-label="搜索模型"
            value={filter.q}
            onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
          />
          <select
            aria-label="按域筛选"
            value={filter.realm}
            onChange={(e) => setFilter((f) => ({ ...f, realm: e.target.value }))}
          >
            <option value="">全部域</option>
            <option value="cn">国内版 CN</option>
            <option value="global">国际版 Global</option>
          </select>
          <select aria-label="按能力筛选" value={filter.cap} onChange={(e) => setFilter((f) => ({ ...f, cap: e.target.value }))}>
            <option value="">全部能力</option>
            <option value="tool">支持工具调用</option>
            <option value="vision">支持视觉</option>
            <option value="reasoning">支持思考</option>
            <option value="default">默认模型</option>
          </select>
          <select
            aria-label="按思考档位筛选"
            value={filter.effort}
            onChange={(e) => setFilter((f) => ({ ...f, effort: e.target.value }))}
          >
            <option value="">全部档位</option>
            <option value="off">可关闭思考</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
            <option value="max">max</option>
          </select>
          <select aria-label="按价格筛选" value={filter.promo} onChange={(e) => setFilter((f) => ({ ...f, promo: e.target.value }))}>
            <option value="">全部价格</option>
            <option value="promo">有折扣 / 限时免费</option>
            <option value="free">限时免费</option>
            <option value="discount">打折（非免费）</option>
          </select>
          <select aria-label="排序方式" value={filter.sort} onChange={(e) => setFilter((f) => ({ ...f, sort: e.target.value }))}>
            <option value="default">上游默认顺序</option>
            <option value="rate">积分倍率 低 → 高</option>
            <option value="context">上下文长度 大 → 小</option>
            <option value="output">最大输出 大 → 小</option>
            <option value="name">模型 ID A → Z</option>
          </select>
          <span className="grow" />
          <span className={'note' + (filtered ? ' src-off' : '')}>
            {total ? (filtered ? `命中 ${rows.length} / ${total} 个模型` : `${total} 个模型`) : ''}
          </span>
          <button
            className="btn xs ghost"
            title="清空全部筛选条件"
            onClick={() => setFilter({ q: '', realm: '', cap: '', effort: '', promo: '', sort: 'default' })}
          >
            重置
          </button>
        </div>

        <div className="tbl-wrap">
          <table className="acc md">
            <thead>
              <tr>
                <th className="mark" aria-hidden="true"></th>
                <th>模型</th>
                <th>积分倍率</th>
                <th>默认档</th>
                <th>支持的思考档位</th>
                <th>上下文长度</th>
                <th>最大输出</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <div className="empty">
                      {resp ? '没有符合当前筛选条件的模型' : '正在向上游查询…'}
                    </div>
                  </td>
                </tr>
              ) : (
                rows.map((m) => {
                  const eff = (m.supported_efforts || []).slice()
                  if (m.can_disable_thinking && eff.length && !eff.includes('off')) eff.push('off（可关）')
                  const effs = m.image_generation ? (
                    <span style={{ color: 'var(--ink-3)' }}>—</span>
                  ) : eff.length ? (
                    eff.map((e) => (
                      <span key={e} className="tag warn">
                        {e}
                      </span>
                    ))
                  ) : (
                    <span style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>
                      {m.supports_reasoning ? '固定档 · 默认 ' + (m.default_effort || '?') : '不支持思考'}
                    </span>
                  )
                  const caps: React.ReactNode[] = []
                  if (m.tier)
                    caps.push(
                      <span key="tier" className="tag warn" title={`上游付费层级（${m.tier}）：切换模型前留意，免费账号可能调不通或排队靠后`}>
                        {m.tier}
                      </span>,
                    )
                  if (m.image_generation) caps.push(<span key="img" className="tag ok">出图</span>)
                  if (m.is_default) caps.push(<span key="def" className="tag ok">默认</span>)
                  if (m.supports_tool_call) caps.push(<span key="tool" className="tag warn">工具</span>)
                  if (m.supports_images) caps.push(<span key="vis" className="tag warn">视觉</span>)
                  if (m.supports_reasoning && !m.can_disable_thinking)
                    caps.push(<span key="rsn" className="tag warn">思考常开</span>)
                  if (BUSY_WORDS[m.busy || '']) {
                    const bad = m.busy === 'congested' || m.busy === 'unavailable'
                    caps.push(
                      <span
                        key="busy"
                        className={'tag ' + (bad ? 'bad' : 'warn')}
                        title={`上游繁忙度 ${m.busy}（/v2/chat/busy 实时；服务端偶发无数据，同一批重查可能变）`}
                      >
                        {BUSY_WORDS[m.busy || '']}
                      </span>,
                    )
                  }
                  const avail = mdAvailabilityOf(m, locks, recent)
                  return (
                    <tr key={m.id}>
                      <td className="mark" aria-hidden="true">
                        <i></i>
                      </td>
                      <td className="who" title={m.description}>
                        <div className="nm">
                          <span className="mid">{m.id}</span>
                          {avail ? (
                            <span className={'tag ' + avail.cls + ' md-avail'} title={avail.tip}>
                              {avail.label}
                            </span>
                          ) : null}
                        </div>
                        <div className="id">{m.name || ''}</div>
                        {caps.length ? <div className="id" style={{ marginTop: 2 }}>{caps}</div> : null}
                        <div className="id" style={{ marginTop: 4 }}>
                          <button
                            className="btn xs ghost"
                            onClick={() => {
                              setTesting(m)
                              setTestResult(null)
                              setTestUid('')
                            }}
                          >
                            测试
                          </button>
                        </div>
                      </td>
                      <td className="num">{rateCell(m)}</td>
                      <td>
                        {m.default_effort && !m.image_generation ? (
                          <span className="tag ok">{m.default_effort}</span>
                        ) : (
                          <span style={{ color: 'var(--ink-3)' }}>—</span>
                        )}
                      </td>
                      <td className="efs" style={{ whiteSpace: 'normal' }}>
                        {effs}
                      </td>
                      <td className="num">{m.context_length ? Math.round(m.context_length / 1000) + 'K' : '—'}</td>
                      <td className="num">{outCell(m, probeOf(m.id))}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="实测成本台账" hint="每模型实测单价（发出请求后自动积累）" flush>
        {costs.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">
              还没有实测成本观测。网关每完成一次请求会记一笔单价，发几次请求后这里就有数据了。
            </div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="acc">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>模型</th>
                  <th className="num">每 1K token</th>
                  <th className="num">样本</th>
                  <th>最近观测</th>
                </tr>
              </thead>
              <tbody>
                {costs.map((c) => (
                  <tr key={c.uid + c.model}>
                    <td>{c.nick}</td>
                    <td className="mono">{c.model}</td>
                    <td className="num mono">
                      {c.cost > 0 ? fmtCredit(c.cost) : <span className="tag ok">免费</span>}
                    </td>
                    <td className="num mono">{c.samples ?? '—'}</td>
                    <td className="dim nowrap">{c.last ? new Date(c.last).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {testing ? (
        <div className="veil on" onClick={(e) => e.target === e.currentTarget && setTesting(null)}>
          <div className="modal" style={{ maxWidth: 560 }}>
            <h3>测试模型可用性</h3>
            <div className="fld">
              <span>模型</span>
              <input readOnly value={testing.id} />
            </div>
            <div className="fld" style={{ marginTop: 8 }}>
              <span>账号</span>
              <select value={testUid} onChange={(e) => setTestUid(e.target.value)}>
                <option value="">选择要测试的账号…</option>
                {(ov?.accounts || [])
                  .filter((a) => !a.disabled)
                  .map((a) => (
                    <option key={a.uid} value={a.uid}>
                      {a.nickname || String(a.uid).slice(0, 10)}（{a.uid.slice(0, 8)} · {a.realm || '?'}）
                    </option>
                  ))}
              </select>
            </div>

            {testResult ? (
              <div
                className="ck-secret-box"
                style={{ marginTop: 12, background: 'var(--surface-2)', padding: '10px 12px', borderRadius: 8 }}
              >
                {testResult.ok ? (
                  <>
                    <div className="note ok" style={{ marginBottom: 6 }}>
                      ✓ 可用 · {testResult.elapsed_ms ?? '—'}ms
                      {testResult.model ? ` · 实际 ${testResult.model}` : ''}
                    </div>
                    {testResult.content ? (
                      <div className="mono" style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>
                        {testResult.content.slice(0, 300)}
                      </div>
                    ) : (
                      <div className="dim">（空回复，但请求链路通）</div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="note err" style={{ marginBottom: 6 }}>
                      ✗ 不可用{testResult.elapsed_ms != null ? ` · ${testResult.elapsed_ms}ms` : ''}
                      {testResult.status ? ` · http ${testResult.status}` : ''}
                      {testResult.kind ? ` · ${testResult.kind}` : ''}
                    </div>
                    <div className="mono" style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>
                      {testResult.error || '未知错误'}
                    </div>
                  </>
                )}
              </div>
            ) : null}

            <div className="row-actions" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => setTesting(null)} disabled={testBusy}>
                关闭
              </button>
              <button
                className="btn primary"
                disabled={!testUid || testBusy}
                onClick={() => void runModelTest(testing, testUid)}
              >
                {testBusy ? '测试中…' : '测试'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </View>
  )
}
