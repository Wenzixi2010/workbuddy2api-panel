import { useEffect, useRef, useState } from 'react'
import { api, postForm } from '../lib/api'
import { errText } from '../lib/format'

/**
 * 添加账号对话框：三个入口对齐旧面板。
 *
 *   1. 浏览器登录（OAuth）—— 主流方式，扫码/点链接授权，前端轮询结果；
 *   2. API Key —— 直接贴 token，适合企业版/无个人成长体系的账号；
 *   3. JSON 导入 —— 从 cockpit 等工具导出的凭据文件批量导入。
 *
 * 为什么不用 <dialog>：项目里已有 .veil/.dlg 这套弹层样式（旧面板沿用的），
 * 复用它能让新加的弹窗与既有弹窗外观一致，也省掉一套自绘遮罩的焦点管理。
 */

type Tab = 'login' | 'apikey' | 'import'

type Props = {
  onClose: () => void
  onDone: (msg: string) => void | Promise<void>
  onToast: (msg: string, kind?: 'ok' | 'err' | '') => void
}

/** OAuth 轮询间隔。上游授权页往返通常 10–30s，2s 一次足够且不压上游。 */
const POLL_MS = 2000
/** 轮询上限：超过就提示用户重来，避免一个死会话无限期打上游。 */
const POLL_LIMIT_MS = 5 * 60 * 1000

export default function AddAccountDialog({ onClose, onDone, onToast }: Props) {
  const [tab, setTab] = useState<Tab>('login')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // ── OAuth 登录态 ──
  const [site, setSite] = useState<'cn' | 'intl'>('cn')
  const [authURL, setAuthURL] = useState('')
  const [state, setState] = useState('')
  const [pollMsg, setPollMsg] = useState('')
  const pollTimer = useRef<number | null>(null)
  const pollStart = useRef(0)

  // ── API Key ──
  const [token, setToken] = useState('')
  const [nickname, setNickname] = useState('')

  const stopPoll = () => {
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current)
      pollTimer.current = null
    }
  }

  // 关闭时务必停掉轮询，否则弹窗关了还在后台打接口。
  useEffect(() => stopPoll, [])

  const poll = async (st: string) => {
    if (Date.now() - pollStart.current > POLL_LIMIT_MS) {
      setPollMsg('等待超时，请重新发起登录。')
      stopPoll()
      return
    }
    try {
      const r = await api<{
        done: boolean
        message?: string
        uid?: string
        nickname?: string
        realm?: string
        credits?: number
        balance_error?: string
      }>(`login/poll?state=${encodeURIComponent(st)}`)
      if (r.done) {
        stopPoll()
        const who = r.nickname || r.uid || '新账号'
        await onDone(`已添加账号 ${who}`)
        onClose()
        return
      }
      setPollMsg(r.message || '等待授权…')
    } catch (e) {
      // 轮询里的单次失败不终止整个流程（上游偶发 502 很常见），
      // 只把原因显示出来，下一轮继续。
      setPollMsg(errText(e))
    }
    pollTimer.current = window.setTimeout(() => void poll(st), POLL_MS)
  }

  const startLogin = async () => {
    setErr('')
    setBusy(true)
    try {
      const r = await api<{ url: string; state: string }>('login/start', { body: { site } })
      setAuthURL(r.url)
      setState(r.state)
      setPollMsg('等待授权…')
      pollStart.current = Date.now()
      stopPoll()
      pollTimer.current = window.setTimeout(() => void poll(r.state), POLL_MS)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const copyURL = async () => {
    try {
      await navigator.clipboard.writeText(authURL)
      onToast('链接已复制', 'ok')
    } catch {
      onToast('复制失败，请手动选中复制', 'err')
    }
  }

  const submitAPIKey = async () => {
    setErr('')
    if (!token.trim()) {
      setErr('请填写 API Key')
      return
    }
    setBusy(true)
    try {
      await api('accounts/add_apikey', {
        body: { access_token: token.trim(), nickname: nickname.trim() },
      })
      await onDone(nickname.trim() ? `已添加 ${nickname.trim()}` : '已添加 API Key 账号')
      onClose()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const submitImport = async (file: File) => {
    setErr('')
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await postForm<{ total: number; imported: number; skipped: number; errors?: string[] }>(
        'import/cockpit',
        fd,
      )
      const msg =
        `导入完成：共 ${r.total}，新增 ${r.imported}` + (r.skipped ? `，跳过 ${r.skipped}` : '')
      await onDone(msg)
      onClose()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="veil on" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dlg add-dlg" role="dialog" aria-modal="true" aria-label="添加账号">
        <header className="dlg-hd">
          <h3>添加账号</h3>
          <button className="btn xs ghost" onClick={onClose} aria-label="关闭">
            关闭
          </button>
        </header>

        <div className="dlg-bd">
          <div className="seg add-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === 'login'}
              className={tab === 'login' ? 'on' : ''}
              onClick={() => setTab('login')}
            >
              浏览器登录
            </button>
            <button
              role="tab"
              aria-selected={tab === 'apikey'}
              className={tab === 'apikey' ? 'on' : ''}
              onClick={() => setTab('apikey')}
            >
              API Key
            </button>
            <button
              role="tab"
              aria-selected={tab === 'import'}
              className={tab === 'import' ? 'on' : ''}
              onClick={() => setTab('import')}
            >
              JSON 导入
            </button>
          </div>

          {err ? <div className="note err">{err}</div> : null}

          {tab === 'login' ? (
            <div className="add-pane">
              <div className="fld">
                <label>站点</label>
                <div className="seg">
                  <button
                    className={site === 'cn' ? 'on' : ''}
                    onClick={() => setSite('cn')}
                    disabled={busy || !!state}
                  >
                    国内版
                  </button>
                  <button
                    className={site === 'intl' ? 'on' : ''}
                    onClick={() => setSite('intl')}
                    disabled={busy || !!state}
                  >
                    国际版
                  </button>
                </div>
              </div>

              {!state ? (
                <>
                  <p className="note">
                    点「发起登录」后会生成一个授权链接。在浏览器里打开并完成登录，
                    本页会自动检测并写入账号，无需重启。
                  </p>
                  <button className="btn primary" disabled={busy} onClick={() => void startLogin()}>
                    {busy ? '正在发起…' : '发起登录'}
                  </button>
                </>
              ) : (
                <>
                  <div className="fld">
                    <label>授权链接</label>
                    <div className="url-row">
                      <input className="inp mono" readOnly value={authURL} onFocus={(e) => e.currentTarget.select()} />
                      <button className="btn sm" onClick={() => void copyURL()}>
                        复制
                      </button>
                      <a className="btn sm" href={authURL} target="_blank" rel="noopener noreferrer">
                        打开
                      </a>
                    </div>
                  </div>
                  <div className="poll-state">
                    <span className="pulse on" />
                    {pollMsg}
                  </div>
                  <button
                    className="btn sm"
                    onClick={() => {
                      stopPoll()
                      setState('')
                      setAuthURL('')
                      setPollMsg('')
                    }}
                  >
                    重新发起
                  </button>
                </>
              )}
            </div>
          ) : null}

          {tab === 'apikey' ? (
            <div className="add-pane">
              <p className="note">
                直接粘贴上游 API Key。适用于企业版或不支持签到/成长任务的账号——
                这类账号不参与成长体系，额度走企业口径查询。
              </p>
              <div className="fld">
                <label>API Key</label>
                <input
                  className="inp mono"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="粘贴 access token"
                />
              </div>
              <div className="fld">
                <label>备注名（可选）</label>
                <input
                  className="inp"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder="留空则用上游昵称"
                />
              </div>
              <button className="btn primary" disabled={busy} onClick={() => void submitAPIKey()}>
                {busy ? '正在添加…' : '添加账号'}
              </button>
            </div>
          ) : null}

          {tab === 'import' ? (
            <div className="add-pane">
              <p className="note">
                选择 cockpit 等工具导出的 JSON 凭据文件。文件内多个账号会逐个导入，
                已存在的 UID 自动跳过。
              </p>
              <label className={'file-drop' + (busy ? ' busy' : '')}>
                <input
                  type="file"
                  accept="application/json,.json"
                  hidden
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void submitImport(f)
                    e.target.value = ''
                  }}
                />
                <span className="file-drop-main">{busy ? '正在导入…' : '点击选择 JSON 文件'}</span>
                <span className="file-drop-hint">支持单账号或账号数组</span>
              </label>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
