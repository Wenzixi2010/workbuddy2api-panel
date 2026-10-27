import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { errText } from '../lib/format'
import type { Group, GroupsResp } from '../lib/types'
import { Card, Stat, Stats, View } from '../components/Layout'
import type { ViewProps } from './types'

/** 分组：客户 Key 的模型白名单。key 归属分组后只能调用分组允许的模型。 */
export default function GroupsView({ onToast }: ViewProps) {
  const [data, setData] = useState<GroupsResp | null>(null)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState<Group | null | 'new'>(null)
  const [name, setName] = useState('')
  const [modelsText, setModelsText] = useState('')
  const [busy, setBusy] = useState(false)

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
  }, [load])

  const openEditor = (g: Group | null) => {
    setEditing(g ?? 'new')
    setName(g?.name || '')
    setModelsText(g ? (g.models || []).join('\n') : '')
  }

  const submit = async () => {
    if (!name.trim()) {
      onToast('分组名称不能为空', 'err')
      return
    }
    const models = modelsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
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
                <span className="dim"> 每行一个模型名；留空 = 不限制（全放行）</span>
              </span>
              <textarea
                rows={8}
                value={modelsText}
                onChange={(e) => setModelsText(e.target.value)}
                placeholder={'cn:glm-5.2\ncn:deepseek-v4\nglobal:claude-x\n（裸名跨域匹配，也可写 realm:name）'}
                spellCheck={false}
                style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}
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
