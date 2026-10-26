import { useState } from 'react'
import CodebuddyMark from './CodebuddyMark'

type Props = {
  onSubmit: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>
  /** 未配置登录账号时的说明（后端返回 panel_auth_not_configured）。 */
  notConfigured?: boolean
}

/** 面板登录页。 */
export default function LoginPage({ onSubmit, notConfigured }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async () => {
    if (!username.trim() || !password) {
      setErr('请输入账号和密码')
      return
    }
    setBusy(true)
    setErr('')
    const res = await onSubmit(username.trim(), password)
    if (!res.ok) setErr(res.error || '登录失败')
    setBusy(false)
  }

  return (
    <div className="login-wrap">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="login-brand">
          <div className="login-logo" aria-hidden>
            <CodebuddyMark size={26} />
          </div>
          <div>
            <div className="login-title">WorkBuddy2API</div>
            <div className="login-sub">控制台登录</div>
          </div>
        </div>

        {notConfigured ? (
          <div className="login-note warn">
            面板还没有配置登录账号。请在 <code>config.json</code> 里设置：
            <pre>{`"panel_auth": {
  "username": "wenzixi",
  "password": "你的密码"
}`}</pre>
            保存后重启生效。
          </div>
        ) : null}

        <label className="fld">
          <span>账号</span>
          <input
            value={username}
            autoFocus
            autoComplete="username"
            disabled={notConfigured}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="fld">
          <span>密码</span>
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            disabled={notConfigured}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {err ? <div className="note err login-err">{err}</div> : null}

        <button className="btn primary login-btn" type="submit" disabled={busy || notConfigured}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
