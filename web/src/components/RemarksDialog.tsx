import { useEffect, useState } from 'react'
import { remarkKey, useRemarks } from '../lib/remarks'

type Row = { key: string; who: string }

type Props = {
  /** 当前账号列表（用于列出可编辑的行）。 */
  accounts: { uid: string; nickname?: string }[]
  onClose: () => void
  onToast: (msg: string, kind?: 'ok' | 'err') => void
}

/**
 * 账号备注编辑器。
 *
 * 行来自当前账号列表，另外补上「已有备注但列表里没有」的键——账号被移除后
 * 备注还留着，不该在编辑器里凭空消失（否则用户没法清掉它）。
 */
export default function RemarksDialog({ accounts, onClose, onToast }: Props) {
  const { map, save, clear } = useRemarks()
  const [rows, setRows] = useState<Row[]>([])
  const [draft, setDraft] = useState<Record<string, string>>({})

  useEffect(() => {
    const list: Row[] = accounts
      .map((a) => ({ key: remarkKey(a.uid), who: a.nickname || remarkKey(a.uid) }))
      .filter((r) => r.key)
    for (const k of Object.keys(map)) {
      if (!list.some((r) => r.key === k)) list.push({ key: k, who: k + '（已不在账号池）' })
    }
    // 同一 uid 前缀可能撞车（极少见），按 key 去重避免 React 重复 key
    const seen = new Set<string>()
    const uniq = list.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)))
    setRows(uniq)
    setDraft(Object.fromEntries(uniq.map((r) => [r.key, map[r.key] || ''])))
  }, [accounts, map])

  const commit = () => {
    const next: Record<string, string> = {}
    for (const [k, v] of Object.entries(draft)) {
      const t = v.trim()
      if (t) next[k] = t
    }
    const ok = save(next)
    onToast(ok ? '备注已保存（仅本机浏览器）' : '备注未能写入浏览器存储（隐私模式或空间已满），刷新后会丢失', ok ? 'ok' : 'err')
    if (ok) onClose()
  }

  return (
    <div className="veil on" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dlg dlg-hd-pad remark-dlg" role="dialog" aria-modal="true" aria-label="账号备注">
        <div className="dlg-hd">
          <h3>账号备注</h3>
          <button className="btn xs" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="dlg-bd">
          <div className="note">
            备注只保存在这台浏览器，不会同步到服务器，也不影响选号、计费或鉴权。
          </div>
          {rows.length === 0 ? (
            <div className="empty">
              <div className="empty-desc">暂无账号。先在「账号池」加载一次账号列表。</div>
            </div>
          ) : (
            <div className="rm-list">
              {rows.map((r) => (
                <div className="rm-row" key={r.key}>
                  <span className="rm-who" title={r.who}>
                    {r.who}
                  </span>
                  <input
                    className="inp"
                    type="text"
                    maxLength={24}
                    placeholder="备注（留空即清除）"
                    value={draft[r.key] ?? ''}
                    onChange={(e) => setDraft((s) => ({ ...s, [r.key]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="dlg-ft">
          <button
            className="btn ghost"
            onClick={() => {
              const ok = clear()
              onToast(ok ? '已清空全部备注' : '清空未能写入浏览器存储，刷新后备注会回来', ok ? 'ok' : 'err')
              if (ok) onClose()
            }}
          >
            清空全部
          </button>
          <div className="grow" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={commit}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
