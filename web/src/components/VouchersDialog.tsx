import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { errText } from '../lib/format'
import QRCode from './QRCode'

/** 上游 SchoolVoucher 的前端投影。 */
type Voucher = {
  grant_id: number
  sku_code?: string
  prize_name?: string
  code: string
  valid_from?: string
  valid_to?: string
  granted_at?: string
}

type Row = {
  uid: string
  nickname: string
  vouchers?: Voucher[]
  error?: string
}

type Props = {
  onClose: () => void
  onToast: (msg: string, kind?: 'ok' | 'err') => void
}

/** clipboard API 只在 secure context 可用，远程 http 面板要降级到 execCommand。 */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text)
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  try {
    if (!document.execCommand('copy')) throw new Error('copy failed')
  } finally {
    ta.remove()
  }
}

export default function VouchersDialog({ onClose, onToast }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [err, setErr] = useState('')
  const [qrOf, setQrOf] = useState<string>('')

  const load = useCallback(async () => {
    setRows(null)
    setErr('')
    try {
      const d = await api<{ accounts: Row[] }>('school/vouchers')
      setRows(d.accounts || [])
    } catch (e) {
      setErr(errText(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const okRows = (rows || []).filter((r) => !r.error)
  const errRows = (rows || []).filter((r) => r.error)
  const total = okRows.reduce((s, r) => s + (r.vouchers?.length || 0), 0)

  return (
    <div className="veil on" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dlg dlg-hd-pad vc-dlg" role="dialog" aria-modal="true" aria-label="我的券码">
        <div className="dlg-hd">
          <h3>我的券码</h3>
          {rows ? <span className="hint">{total} 张</span> : null}
          <div className="grow" />
          <button className="btn xs" onClick={() => void load()} disabled={rows === null}>
            重新查询
          </button>
          <button className="btn xs" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="dlg-bd">
          {err ? <div className="note err">{err}</div> : null}
          {rows === null ? (
            <div className="empty">
              <div className="empty-desc">正在逐个账号查询券码…</div>
            </div>
          ) : total === 0 && okRows.length === 0 ? (
            <div className="empty">
              <div className="empty-desc">还没有账号可查询。</div>
            </div>
          ) : (
            <>
              {okRows
                .filter((r) => (r.vouchers?.length || 0) > 0)
                .map((r) => (
                  <div className="vc-acct" key={r.uid}>
                    <div className="vc-acct-hd">
                      <span className="nm">{r.nickname || r.uid.slice(0, 10)}</span>
                      <span className="dim">{r.vouchers?.length} 张</span>
                    </div>
                    <div className="vc-grid">
                      {(r.vouchers || []).map((v) => {
                        const expired = v.valid_to ? new Date(v.valid_to) < new Date() : false
                        return (
                          <div className={'vc' + (expired ? ' expired' : '')} key={v.grant_id}>
                            <div className="vc-hd">
                              <span className="nm">{v.prize_name || v.sku_code || '券'}</span>
                              <span className={'tag ' + (expired ? 'bad' : 'ok')}>
                                {expired ? '已过期' : '可使用'}
                              </span>
                            </div>
                            <div className="vc-meta">
                              {v.valid_to ? `有效期至 ${v.valid_to}` : '长期有效'}
                              {v.granted_at ? ` · ${v.granted_at.slice(0, 10)} 抽中` : ''}
                            </div>
                            <div className="vc-code">
                              <code>{v.code || '—'}</code>
                            </div>
                            <div className="vc-acts">
                              {v.code ? (
                                <button
                                  className="btn xs"
                                  onClick={() => setQrOf(qrOf === v.code ? '' : v.code)}
                                >
                                  {qrOf === v.code ? '收起' : '二维码'}
                                </button>
                              ) : null}
                              <button
                                className="btn xs"
                                onClick={async () => {
                                  try {
                                    await copyText(v.code || '')
                                    onToast('券码已复制', 'ok')
                                  } catch {
                                    onToast('复制失败，请手动选择文本', 'err')
                                  }
                                }}
                              >
                                复制
                              </button>
                            </div>
                            {qrOf === v.code ? (
                              <div className="vc-qr">
                                <QRCode text={v.code} size={132} />
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              {total === 0 ? (
                <div className="empty">
                  <div className="empty-title">还没有抽到券</div>
                  <div className="empty-desc">活动期间完成抽奖后，券码会出现在这里。</div>
                </div>
              ) : null}
              {errRows.length ? (
                <div className="note err">
                  查询失败：
                  {errRows.map((r) => `${r.nickname || r.uid.slice(0, 8)}（${r.error}）`).join('、')}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
