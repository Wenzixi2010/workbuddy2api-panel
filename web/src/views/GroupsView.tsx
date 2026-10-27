import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { errText } from '../lib/format'
import type { Group, GroupsResp } from '../lib/types'
import { Card, Stat, Stats, View } from '../components/Layout'
import type { ViewProps } from './types'

/** 模型目录条目（/panel/api/models 的 models[] 里取 id/name 即可）。 */
type ModelOption = { id: string; name?: string }

/** 分组：客户 Key 的模型白名单。key 归属分组后只能调用分组允许的模型。 */
export default function GroupsView({ onToast }: ViewProps) {
  const [data, setData] = useState<GroupsResp | null>(null)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState<Group | null | 'new'>(null)
  const [name, setName] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  // 模型目录（下拉多选的数据源）。
  const [catalog, setCatalog] = useState<ModelOption[]>([])

  const load = useCallback(async () => {
    try {
      const d = await api<GroupsResp>('groups')
      setData(d)
      setErr('')
    } catch (e) {
      setErr(errText(e))
    }
  }, [])

  useEffect(() => {
    void load()
    // 模型目录：下拉多选的数据源；取不到不阻塞分组管理（下拉退化为空）。
    api<{ models?: ModelOption[] }>('models')
      .then((d) => setCatalog(d.models || []))
      .catch(() => setCatalog([]))
  }, [load])

  const openEditor = (g: Group | null) => {
    setEditing(g ?? 'new')
    setName(g?.name || '')
    setModels(g ? (g.models || []).slice() : [])
  }

  const submit = async () => {
    if (!name.trim()) {
      onToast('分组名称不能为空', 'err')
      return
    }
    setBusy(true)
    try {
      if (editing === 'new') {
        await api('groups', { method: 'POST', body: { name: name.trim(), models } })
        onToast('已创建分组', 'ok')
      } else if (editing) {
        await api(`groups/${encodeURIComponent(editing.id)}`, { method: 'POST', body: { name: name.trim(), models } })
        onToast('已保存分组', 'ok')
      }
      setEditing(null)
      void load()
    } catch (e) {
      onToast(`保存失败：${errText(e)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (g: Group) => {
    if (!confirm(`删除分组「${g.name}」？\n\n归属它的 Key 会失去模型白名单约束（视为未分组，全放行）。`)) return
    try {
      await api(`groups/${encodeURIComponent(g.id)}/delete`, { method: 'POST' })
      onToast('已删除分组', 'ok')
      void load()
    } catch (e) {
      onToast(`删除失败：${errText(e)}`, 'err')
    }
  }

  if (err && !data) return <View><div className="empty err">读取失败：{err}</div></View>
  if (!data) return <View><div className="empty">加载中…</div></View>
  if (!data.enabled) {
    return (
      <View>
        <Card title="分组不可用">
          <div className="empty">
            <div className="empty-title">分组功能未启用</div>
            <div className="empty-desc">{data.error || '检查启动日志里的 [gatewaykey] 行。'}</div>
          </div>
        </Card>
      </View>
    )
  }

  const groups = data.groups || []

  return (
    <View>
      <Stats>
        <Stat label="分组数" value={groups.length} />
        <Stat label="设了模型白名单" value={groups.filter((g) => g.models.length > 0).length} />
        <Stat label="未设白名单（全放行）" value={groups.filter((g) => g.models.length === 0).length} />
      </Stats>

      <Card
        title="分组"
        hint={`${groups.length} 个 · 存储：${data.path || ''}`}
        actions={
          <>
            <button className="btn sm" onClick={() => void load()}>
              刷新
            </button>
            <button className="btn sm primary" onClick={() => openEditor(null)}>
              新建分组
            </button>
          </>
        }
        flush
      >
        {groups.length === 0 ? (
          <div className="empty">
            <div className="empty-title">还没有分组</div>
            <div className="empty-desc">
              建一个分组并设模型白名单，然后把客户 Key 归属到它——该 Key 就只能调用这些模型了。
            </div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="acc">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>模型白名单</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <div className="ck-name">{g.name}</div>
                    </td>
                    <td>
                      {g.models.length === 0 ? (
                        <span className="dim">未设白名单（全放行）</span>
                      ) : (
                        <span className="ck-bind" title={g.models.join('\n')}>
                          <b>{g.models.length}</b> 个模型
                        </span>
                      )}
                      {g.models.length > 0 ? (
                        <div className="id" style={{ marginTop: 4, fontSize: 11.5, color: 'var(--ink-3)' }}>
                          {g.models.slice(0, 4).join('、')}
                          {g.models.length > 4 ? ` 等 ${g.models.length} 个` : ''}
                        </div>
                      ) : null}
                    </td>
                    <td className="dim nowrap">{new Date(g.created_at).toLocaleString()}</td>
                    <td className="ck-ops">
                      <button className="btn sm ghost" onClick={() => openEditor(g)}>
                        编辑
                      </button>
                      <button className="btn sm ghost danger" onClick={() => void remove(g)}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing ? (
        <div className="veil on" onClick={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="modal" style={{ maxWidth: 560 }}>
            <h3>{editing === 'new' ? '新建分组' : '编辑分组'}</h3>
            <div className="fld">
              <span>分组名称（必填）</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例：客服组" />
            </div>
            <div className="fld" style={{ marginTop: 10 }}>
              <span>
                模型白名单（可选）
                <span className="dim"> 下拉多选；留空 = 不限制（全放行）</span>
              </span>
              <ModelMultiSelect
                options={catalog}
                value={models}
                onChange={setModels}
                placeholder="搜索并选择模型…"
              />
            </div>
            <div className="note" style={{ marginTop: 8, fontSize: 12 }}>
              归属本分组的 Key 只能调用白名单内的模型；调用白名单外模型会被拒绝（403）。
            </div>
            <div className="row-actions" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => setEditing(null)} disabled={busy}>
                取消
              </button>
              <button className="btn primary" disabled={busy} onClick={() => void submit()}>
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </View>
  )
}

/** 可搜索多选下拉：点开面板 → 搜索 → 勾选模型（id 为 value）。 */
function ModelMultiSelect({
  options,
  value,
  onChange,
  placeholder,
}: {
  options: ModelOption[]
  value: string[]
  onChange: (v: string[]) => void
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // 下拉面板用 position:fixed 定位（弹出时按 box 的视口坐标算）：
  // modal 是 overflow:auto 的裁剪上下文，absolute 面板会被弹窗边缘裁掉、
  // 底部模型滚不到。fixed 面板挂在 body 层级语义上，完全脱离裁剪。
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null)

  // 打开时计算面板位置：默认朝下展开；下方视口空间不足（<180px）改朝上。
  const place = useCallback(() => {
    const box = boxRef.current
    if (!box) return
    const r = box.getBoundingClientRect()
    const up = window.innerHeight - r.bottom < 180 && r.top > 260
    setPos({ left: r.left, top: up ? r.top - 8 : r.bottom + 4, width: r.width, up })
  }, [])

  useEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    place()
    // 滚动/窗口变化时重算（fixed 定位不随文档流滚动）。
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, place])

  // 已选里的 id 若不在当前目录（如已下架模型），也保留展示，不丢。
  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const list = kw
      ? options.filter((o) => o.id.toLowerCase().includes(kw) || (o.name || '').toLowerCase().includes(kw))
      : options
    return list
  }, [options, q])

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  }

  const removeTag = (id: string) => onChange(value.filter((x) => x !== id))

  // 点击外部关闭。
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const byId = (id: string) => options.find((o) => o.id === id)

  return (
    <div className="msel" ref={boxRef}>
      <div
        className={'msel-box' + (open ? ' open' : '')}
        onClick={() => {
          setOpen(!open)
          setQ('')
        }}
      >
        {value.length === 0 ? (
          <span className="msel-ph">{placeholder}</span>
        ) : (
          <span className="msel-tags">
            {value.map((id) => (
              <span className="msel-tag" key={id}>
                {byId(id)?.id || id}
                <button
                  type="button"
                  className="msel-x"
                  title="移除"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeTag(id)
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </span>
        )}
        <span className="msel-arrow">▾</span>
      </div>

      {open && pos ? (
        <div
          className={'msel-panel' + (pos.up ? ' up' : '')}
          ref={panelRef}
          style={{ position: 'fixed', left: pos.left, width: pos.width, top: pos.up ? undefined : pos.top, bottom: pos.up ? window.innerHeight - pos.top : undefined }}
        >
          <input
            className="msel-q"
            value={q}
            autoFocus
            placeholder="搜索模型（id / 名称）…"
            onChange={(e) => setQ(e.target.value)}
            onClick={(e) => e.stopPropagation()}
          />
          <div className="msel-list">
            {filtered.length === 0 ? (
              <div className="msel-empty">没有匹配的模型</div>
            ) : (
              filtered.map((o) => {
                const checked = value.includes(o.id)
                return (
                  <label className="msel-item" key={o.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(o.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="msel-id mono">{o.id}</span>
                    {o.name ? <span className="msel-name">{o.name}</span> : null}
                  </label>
                )
              })
            )}
          </div>
          {value.length > 0 ? (
            <div className="msel-foot">
              <span className="dim">已选 {value.length} 个</span>
              <button className="btn xs ghost" onClick={() => onChange([])}>
                清空
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
