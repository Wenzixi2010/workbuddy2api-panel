import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { errText, fmtCredit } from '../lib/format'
import { type AccountStatus, type Overview } from '../lib/types'
import { Card, Seg, Stat, Stats, View, ViewHead } from '../components/Layout'
import type { ViewProps } from './types'

/** /panel/api/models 里一条模型目录项（字段由上游透传，只取用到的）。 */
type ModelItem = {
  id: string
  name?: string
  rate?: string | number
  default_tier?: string
  effort?: string[] | string
  busy?: string
  context?: number
  thinking?: unknown
  [k: string]: unknown
}

type ModelsResp = {
  models: ModelItem[]
  global_source?: string
}

const BUSY_LABEL: Record<string, { cls: string; label: string }> = {
  idle: { cls: 'ok', label: '空闲' },
  normal: { cls: 'ok', label: '正常' },
  busy: { cls: 'warn', label: '繁忙' },
  crowded: { cls: 'bad', label: '拥挤' },
}

/** 模型 id 形如 "cn:glm-5.2" / "global:claude-x"，拆出域与原名。 */
function splitID(id: string): { realm: string; name: string } {
  const i = id.indexOf(':')
  if (i < 0) return { realm: 'cn', name: id }
  return { realm: id.slice(0, i), name: id.slice(i + 1) }
}

function effortText(v: ModelItem['effort']): string {
  if (!v) return '—'
  if (Array.isArray(v)) return v.length ? v.join(' / ') : '—'
  return String(v) || '—'
}

export default function ModelsView(_props: ViewProps) {
  const [resp, setResp] = useState<ModelsResp | null>(null)
  const [ov, setOv] = useState<Overview | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const [realm, setRealm] = useState<'all' | 'cn' | 'global'>('all')
  const [sort, setSort] = useState<'name' | 'rate'>('name')

  const loadModels = useCallback(async () => {
    setBusy(true)
    try {
      setResp(await api<ModelsResp>('models'))
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

  const rows = useMemo(() => {
    let list = resp?.models || []
    if (realm !== 'all') list = list.filter((m) => splitID(m.id).realm === realm)
    if (q.trim()) {
      const kw = q.trim().toLowerCase()
      list = list.filter((m) => m.id.toLowerCase().includes(kw))
    }
    const sorted = [...list]
    if (sort === 'rate') {
      sorted.sort((a, b) => Number(a.rate || 0) - Number(b.rate || 0))
    } else {
      sorted.sort((a, b) => a.id.localeCompare(b.id))
    }
    return sorted
  }, [resp, realm, q, sort])

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

  if (err && !resp) {
    return (
      <View>
        <ViewHead title="模型与档位" />
        <div className="empty err">读取失败：{err}</div>
        <button className="btn" onClick={() => void loadModels()}>
          重试
        </button>
      </View>
    )
  }

  return (
    <View>
      <ViewHead
        title="模型与档位"
        desc="上游可用模型目录、计费倍率与繁忙度。目录来自实时代理查询，会缓存在内存里。"
        actions={
          <button className="btn sm" disabled={busy} onClick={() => void loadModels()}>
            {busy ? '查询中…' : '刷新目录'}
          </button>
        }
      />

      <Stats>
        <Stat label="模型总数" value={resp?.models.length ?? '—'} />
        <Stat label="筛选后" value={rows.length} />
        <Stat label="国内版" value={(resp?.models || []).filter((m) => splitID(m.id).realm === 'cn').length} />
        <Stat label="国际版" value={(resp?.models || []).filter((m) => splitID(m.id).realm === 'global').length} />
        <Stat label="实测免费" value={freeCount} tone={freeCount ? 'good' : undefined} sub={`${costs.length} 条台账`} />
      </Stats>

      {err ? <div className="note err">{err}</div> : null}
      {resp?.global_source ? (
        <div className="note">
          国际版目录来源：<code>{resp.global_source}</code>
          {resp.global_source !== 'v3-desktop' ? '（非默认来源，可能缺少部分模型）' : ''}
        </div>
      ) : null}

      <Card
        title="模型目录"
        hint={`${rows.length} / ${resp?.models.length ?? 0}`}
        actions={
          <>
            <input
              className="inp sm"
              placeholder="搜索模型"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ width: 160 }}
            />
            <Seg
              value={realm}
              ariaLabel="域筛选"
              onChange={setRealm}
              options={[
                { value: 'all', label: '全部' },
                { value: 'cn', label: '国内' },
                { value: 'global', label: '国际' },
              ]}
            />
            <Seg
              value={sort}
              ariaLabel="排序"
              onChange={setSort}
              options={[
                { value: 'name', label: '按名称' },
                { value: 'rate', label: '按倍率' },
              ]}
            />
          </>
        }
        flush
      >
        {rows.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">
              {resp ? '没有符合条件的模型。' : '正在从上游拉取模型目录…'}
            </div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>域</th>
                  <th className="num">倍率</th>
                  <th>默认档</th>
                  <th>思维档位</th>
                  <th>繁忙度</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const { realm: r, name } = splitID(m.id)
                  const busy = m.busy ? BUSY_LABEL[m.busy] || { cls: 'mute', label: m.busy } : null
                  return (
                    <tr key={m.id}>
                      <td>
                        <div className="mono">{name}</div>
                        {m.name && m.name !== name ? <div className="who-id">{m.name}</div> : null}
                      </td>
                      <td>
                        <span className={'tag ' + (r === 'global' ? 'warn' : 'mute')}>
                          {r === 'global' ? '国际' : '国内'}
                        </span>
                      </td>
                      <td className="num mono">{m.rate !== undefined && m.rate !== null ? String(m.rate) : '—'}</td>
                      <td className="dim">{m.default_tier || '—'}</td>
                      <td className="dim">{effortText(m.effort)}</td>
                      <td>
                        {busy ? (
                          <span className={'tag ' + busy.cls}>{busy.label}</span>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
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
            <table className="tbl">
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
    </View>
  )
}
