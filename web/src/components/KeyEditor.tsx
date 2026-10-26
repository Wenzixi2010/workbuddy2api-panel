import { useMemo, useState } from 'react'
import { api } from '../lib/api'
import { errText } from '../lib/format'
import type { BindableAccount, ClientKey } from '../lib/types'

type Props = {
  keyItem: ClientKey | null // null = 新建
  accounts: BindableAccount[]
  onClose: () => void
  onSaved: () => void
  onToast: (msg: string, kind?: 'ok' | 'err' | '') => void
}

/** 客户 Key 的新建/编辑弹窗；新建时带明文一次性展示。 */
export default function KeyEditor({ keyItem, accounts, onClose, onSaved, onToast }: Props) {
  const isNew = keyItem === null
  const [name, setName] = useState(keyItem?.name || '')
  const [remark, setRemark] = useState(keyItem?.remark || '')
  const [period, setPeriod] = useState(keyItem?.limits.period || '')
  const [credits, setCredits] = useState(
    keyItem?.limits.credits ? String(keyItem.limits.credits) : ''
  )
  const [binds, setBinds] = useState<string[]>(keyItem?.binds || [])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [secret, setSecret] = useState('')
  const [customKey, setCustomKey] = useState('')

  const sorted = useMemo(
    () => [...accounts].sort((a, b) => Number(b.healthy) - Number(a.healthy)),
    [accounts]
  )

  const submit = async () => {
    if (!name.trim()) {
      setErr('名称必填')
      return
    }
    if (period && !(Number(credits) > 0)) {
      setErr('选了额度周期就要填一个大于 0 的积分上限')
      return
    }
    // 绑定即独占：第一次绑定必须把后果说清楚，否则现象是「别的客户端突然 503」。
    if (isNew && binds.length > 0) {
      const ok = confirm(
        `这会把 ${binds.length} 个账号绑定为独占：\n\n` +
          `• 这把 Key 只用这些账号；\n` +
          `• 这些账号同时也不再服务主密钥与其他未绑定的 Key。\n\n` +
          `如果其他客户端还在用主密钥，它们会立刻用不到这些账号（可能报「无可用账号」）。\n确认绑定？`
      )
      if (!ok) return
    }

    setBusy(true)
    setErr('')
    const body = {
      name: name.trim(),
      remark: remark.trim(),
      binds,
      limits: period ? { period, credits: Number(credits) } : { period: '', credits: 0 },
      ...(customKey.trim() ? { key: customKey.trim() } : {}),
    }
    try {
      if (isNew) {
        const d = await api<{ key?: string }>('client_keys', { method: 'POST', body })
        if (d.key) setSecret(d.key)
        else onSaved()
        onToast('已创建', 'ok')
      } else {
        await api(`client_keys/${encodeURIComponent(keyItem.id)}`, { method: 'POST', body })
        // 编辑时填了自定义 Key：Update 不改明文，需再轮换一次到指定值。
        if (customKey.trim()) {
          const d = await api<{ key?: string }>(`client_keys/${encodeURIComponent(keyItem.id)}/rotate`, {
            method: 'POST',
            body: { key: customKey.trim() },
          })
          if (d.key) setSecret(d.key)
        }
        onToast(customKey.trim() ? '已保存并轮换到自定义 Key' : '已保存', 'ok')
        if (!customKey.trim()) onSaved()
      }
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="veil on" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 620 }}>
        <h3>{isNew ? '新建客户 Key' : '编辑客户 Key'}</h3>

        <div className="grid2">
          <div className="fld">
            <span>名称（必填）</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例：团队A" />
          </div>
          <div className="fld">
            <span>备注</span>
            <input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="可选" />
          </div>
          <div className="fld">
            <span>额度周期</span>
            <select value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="">不限额</option>
              <option value="day">每日重置（北京时间 0 点）</option>
              <option value="total">累计总额（需手动重置）</option>
            </select>
          </div>
          <div className="fld">
            <span>积分上限</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={credits}
              disabled={!period}
              onChange={(e) => setCredits(e.target.value)}
              placeholder="例：100"
            />
          </div>
        </div>

        <div className="fld" style={{ marginBottom: 10 }}>
          <span>
            自定义 Key（可选）
            <span className="dim"> 留空自动生成 gw- 前缀随机 Key；填了则用它（8–128 位，无空格）</span>
          </span>
          <input
            value={customKey}
            onChange={(e) => setCustomKey(e.target.value)}
            placeholder={isNew ? '留空 = 自动生成' : '留空 = 不修改明文'}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="ck-bind-hd">
          <span>绑定账号（绑定即独占）</span>
          <div className="grow" />
          <button className="btn sm ghost" onClick={() => setBinds(sorted.map((a) => a.uid))}>
            全选
          </button>
          <button className="btn sm ghost" onClick={() => setBinds([])}>
            清空
          </button>
        </div>
        <div className="ck-bind-list">
          {sorted.length === 0 ? (
            <div className="dim">没有可绑定的账号</div>
          ) : (
            sorted.map((a) => (
              <label className="ck-bind-row" key={a.uid}>
                <input
                  type="checkbox"
                  checked={binds.includes(a.uid)}
                  onChange={(e) =>
                    setBinds((prev) =>
                      e.target.checked ? [...prev, a.uid] : prev.filter((x) => x !== a.uid)
                    )
                  }
                />
                <span className="ck-bind-name">{a.nickname || a.uid.slice(0, 10)}</span>
                <span className="ck-bind-meta">
                  {a.healthy ? '健康' : '不可用'} · {a.credits}
                </span>
                {a.owner ? <span className="ck-bind-owner">已被「{a.owner}」使用</span> : null}
              </label>
            ))
          )}
        </div>

        {err ? <div className="note err">{err}</div> : null}

        {secret ? (
          <div className="ck-secret-box">
            <div className="note warn" style={{ marginBottom: 8 }}>
              这是唯一一次显示明文，关掉就再也看不到（丢了只能轮换）。
            </div>
            <div className="ck-secret">{secret}</div>
            <div className="row-actions" style={{ marginTop: 10 }}>
              <button
                className="btn sm ghost"
                onClick={() => {
                  void navigator.clipboard?.writeText(secret)
                  onToast('已复制', 'ok')
                }}
              >
                复制
              </button>
              <button className="btn sm primary" onClick={onSaved}>
                我已保存好
              </button>
            </div>
          </div>
        ) : (
          <div className="row-actions" style={{ marginTop: 18, justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button className="btn primary" onClick={() => void submit()} disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
