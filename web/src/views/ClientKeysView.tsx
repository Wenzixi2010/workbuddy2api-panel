import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { ago, errText, fmtCredit } from '../lib/format'
import type { BindableAccount, ClientKey, ClientKeysResp, Group } from '../lib/types'
import { Card, Stat, Stats, View } from '../components/Layout'
import type { ViewProps } from './types'
import KeyEditor from '../components/KeyEditor'

const PERIOD_LABEL: Record<string, string> = {
  day: '每日重置',
  total: '累计总额',
  '': '不限额',
}

function QuotaCell({ k }: { k: ClientKey }) {
  if (!k.limits.credits || !k.limits.period) return <span className="dim">不限额</span>
  const pct = Math.min(100, (k.used / k.limits.credits) * 100)
  const cls = k.exhausted ? 'bad' : pct >= 80 ? 'warn' : ''
  return (
    <div className={'ck-quota ' + cls}>
      <div className="ck-q-bar">
        <i style={{ width: pct.toFixed(1) + '%' }} />
      </div>
      <div className="ck-q-txt">
        <b>{fmtCredit(k.used)}</b> / {fmtCredit(k.limits.credits)} · {PERIOD_LABEL[k.limits.period] || k.limits.period}
      </div>
    </div>
  )
}

/** API Keys：客户 Key 的签发与管理。 */
export default function ClientKeysView({ onToast }: ViewProps) {
  const [data, setData] = useState<ClientKeysResp | null>(null)
  const [err, setErr] = useState('')
  const [bindable, setBindable] = useState<BindableAccount[]>([])
  const [editing, setEditing] = useState<ClientKey | null | 'new'>(null)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [groups, setGroups] = useState<Group[]>([])

  const load = useCallback(async () => {
    try {
      const d = await api<ClientKeysResp>('client_keys')
      setData(d)
      setErr('')
    } catch (e) {
      setErr(errText(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    api<{ groups?: Group[] }>('groups')
      .then((d) => setGroups(d.groups || []))
      .catch(() => setGroups([]))
  }, [])

  useEffect(() => {
    if (!data?.enabled) return
    api<{ accounts?: BindableAccount[] }>('client_keys/bindable')
      .then((d) => setBindable(d.accounts || []))
      .catch(() => setBindable([]))
  }, [data?.enabled])

  const groupName = (id?: string) => (id ? groups.find((g) => g.id === id)?.name || id : '')

  const act = async (id: string, path: string, okMsg: string) => {
    try {
      await api(`client_keys/${encodeURIComponent(id)}/${path}`, { method: 'POST' })
      onToast(okMsg, 'ok')
      void load()
    } catch (e) {
      onToast(`${okMsg}失败：${errText(e)}`, 'err')
    }
  }

  // 切换某把 Key 明文的显示/隐藏（明文存档在 key 字段，随时可看）。
  const toggleReveal = (id: string) => {
    setRevealed((r) => ({ ...r, [id]: !r[id] }))
  }

  if (err && !data) return <View><div className="empty err">读取失败：{err}</div></View>
  if (!data) return <View><div className="empty">加载中…</div></View>

  // 未启用 = 配置文件里显式写了 client_keys.enabled=false。这不是"没配置"，
  // 而是有人主动关掉了；把原因和恢复方法说清楚，别让人以为是程序坏了。
  if (!data.enabled) {
    return (
      <View>
        <Card title="客户 API Key 已停用">
          <div className="empty">
            <div className="empty-title">功能已关闭</div>
            <div className="empty-desc">
              配置里 <code>client_keys.enabled</code> 被设为 <code>false</code>，
              已签发的 Key 当前一律不可用。改回 <code>true</code> 并保存配置即可恢复。
            </div>
            {data.error ? <div className="note err">{data.error}</div> : null}
          </div>
        </Card>
      </View>
    )
  }

  const keys = data.keys || []
  const enabled = keys.filter((k) => !k.disabled && !k.exhausted).length
  const totalUsed = keys.reduce((s, k) => s + (k.used || 0), 0)
  // 网关与面板同 host：Base URL 直接用当前访问地址（去掉 /panel/ 路径）。
  const baseUrl = window.location.origin
  const sampleReq = `curl ${baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer <你的Key>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"<模型>","messages":[{"role":"user","content":"你好"}]}'`

  return (
    <View>
      <Stats>
        <Stat label="Key 总数" value={keys.length} />
        <Stat label="可用" value={enabled} tone="good" />
        <Stat label="已停用/超限" value={keys.length - enabled} tone={keys.length - enabled ? 'warn' : undefined} />
        <Stat label="累计消耗" value={fmtCredit(totalUsed)} />
      </Stats>

      <Card title="连接信息" hint="下游客户端接入时使用（密钥请在 Key 列表里查看明文后自行粘贴）">
        <div className="ck-conn">
          <div className="ck-conn-row">
            <span className="ck-conn-label">Base URL</span>
            <code className="ck-conn-val">{baseUrl}</code>
          </div>
          <div className="ck-conn-row">
            <span className="ck-conn-label">接口</span>
            <code className="ck-conn-val">POST {baseUrl}/v1/chat/completions</code>
          </div>
          <div className="ck-conn-row">
            <span className="ck-conn-label">示例请求</span>
          </div>
          <pre className="ck-conn-pre">{sampleReq}</pre>
        </div>
      </Card>

      {keys.length === 0 ? (
        <Card title="Key 列表">
          <div className="empty">
            <div className="empty-title">还没有客户 Key</div>
            <div className="empty-desc">
              签发一把 Key 发给下游即可。可以绑定专属账号（这些账号不再服务其他 Key）或设积分额度。
            </div>
            <button className="btn primary" onClick={() => setEditing('new')}>
              新建第一把 Key
            </button>
          </div>
        </Card>
      ) : (
        <Card
          title="Key 列表"
          hint={`${keys.length} 把 · ${data.path || ''}`}
          actions={
            <>
              <button className="btn sm" onClick={() => void load()}>
                刷新
              </button>
              <button className="btn sm primary" onClick={() => setEditing('new')}>
                新建 Key
              </button>
            </>
          }
          flush
        >
          <div className="tbl-wrap">
          <table className="acc ck-tbl">
            <thead>
              <tr>
                <th>名称</th>
                <th>分组</th>
                <th>Key</th>
                <th>绑定账号</th>
                <th>额度</th>
                <th className="num">请求 / 未知</th>
                <th>最近使用</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>
                    <div className="ck-name">{k.name}</div>
                    {k.remark ? <div className="ck-remark">{k.remark}</div> : null}
                  </td>
                  <td>
                    {k.group ? (
                      <span className="tag warn" title={`分组「${groupName(k.group)}」的模型白名单对本 Key 生效`}>
                        {groupName(k.group)}
                      </span>
                    ) : (
                      <span className="dim">未分组</span>
                    )}
                  </td>
                  <td className="mono">
                    {revealed[k.id] && k.key ? (
                      <span className="ck-key ck-key-plain">{k.key}</span>
                    ) : (
                      <span className="ck-key">••••{k.key_hint}</span>
                    )}
                    {k.key ? (
                      <button
                        className="btn xs ghost"
                        title={revealed[k.id] ? '隐藏明文' : '显示明文'}
                        onClick={() => toggleReveal(k.id)}
                      >
                        {revealed[k.id] ? '隐藏' : '显示'}
                      </button>
                    ) : (
                      <span className="dim" title="旧 Key 无明文存档，轮换一次后即可查看">
                        （无存档）
                      </span>
                    )}
                  </td>
                  <td>
                    {k.binds.length === 0 ? (
                      <span className="dim">不绑定（共享全池）</span>
                    ) : (
                      <span className="ck-bind" title={k.binds.join('\n')}>
                        <b>{k.binds.length}</b> 个
                      </span>
                    )}
                  </td>
                  <td>
                    <QuotaCell k={k} />
                  </td>
                  <td className="num mono">
                    {k.requests} / {k.unknown_credits}
                  </td>
                  <td className="dim">{ago(k.last_used_at)}</td>
                  <td>
                    {k.disabled ? (
                      <span className="tag bad">已停用</span>
                    ) : k.exhausted ? (
                      <span className="tag warn">额度用尽</span>
                    ) : (
                      <span className="tag ok">正常</span>
                    )}
                  </td>
                  <td className="ck-ops">
                    <button className="btn sm ghost" onClick={() => setEditing(k)}>
                      编辑
                    </button>
                    <button
                      className="btn sm ghost"
                      onClick={() => {
                        if (!confirm(`轮换「${k.name}」？旧 key 会立刻失效。`)) return
                        void act(k.id, 'rotate', '已轮换')
                      }}
                    >
                      轮换
                    </button>
                    <button className="btn sm ghost" onClick={() => void act(k.id, 'reset_usage', '额度已重置')}>
                      重置额度
                    </button>
                    <button
                      className="btn sm ghost"
                      onClick={async () => {
                        try {
                          await api(`client_keys/${encodeURIComponent(k.id)}`, {
                            method: 'POST',
                            body: { disabled: !k.disabled },
                          })
                          onToast(k.disabled ? '已启用' : '已停用', 'ok')
                          void load()
                        } catch (e) {
                          onToast(errText(e), 'err')
                        }
                      }}
                    >
                      {k.disabled ? '启用' : '停用'}
                    </button>
                    <button
                      className="btn sm ghost"
                      onClick={() => {
                        if (!confirm(`删除「${k.name}」？不可恢复。`)) return
                        void act(k.id, 'delete', '已删除')
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Card>
      )}

      {editing ? (
        <KeyEditor
          keyItem={editing === 'new' ? null : editing}
          accounts={bindable}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
          onToast={onToast}
        />
      ) : null}
    </View>
  )
}
