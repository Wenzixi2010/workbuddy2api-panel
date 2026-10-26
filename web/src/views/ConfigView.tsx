import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { errText } from '../lib/format'
import { Card, View } from '../components/Layout'
import { displayVersion } from '../lib/version'
import type { ViewProps } from './types'

type ConfigResp = {
  config?: Record<string, unknown>
  path?: string
  error?: string
}

type UpdateResp = {
  current?: string
  latest?: string
  update_available?: boolean
  can_install?: boolean
  installing?: boolean
  release_url?: string
  last_error?: string
}

/**
 * 配置视图。
 *
 * 这里**没有**「客户 API Key 开关」：旧面板是直接建 Key 的，多一道总开关只会让人
 * 找不到入口（后端也已改成默认开启）。想整体停用请改 config 里的 client_keys.enabled，
 * 那属于配置文件层面的事，不该在界面上做成一个容易被误点的按钮——
 * 它一关就是"所有客户 Key 立刻失效"，误触代价太大。
 */
export default function ConfigView({ onToast }: ViewProps) {
  const [d, setD] = useState<ConfigResp | null>(null)
  const [err, setErr] = useState('')
  const [upd, setUpd] = useState<UpdateResp | null>(null)
  const [checking, setChecking] = useState(false)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [restartFields, setRestartFields] = useState<string[]>([])
  // 用户是否动过编辑器。用 ref 而不是 state：load() 里要读它的最新值，
  // 用 state 会闭包到旧值，导致"正在编辑时被轮询覆盖"。
  const touchedRef = useRef(false)

  const load = useCallback(async () => {
    try {
      const r = await api<ConfigResp>('config')
      setD(r)
      // 首次加载或后端配置真的变了才重置编辑器；否则会覆盖用户正在改的内容。
      setText((prev) => (prev === '' || !touchedRef.current ? JSON.stringify(r.config || {}, null, 2) : prev))
      setErr('')
    } catch (e) {
      setErr(errText(e))
    }
  }, [])

  useEffect(() => {
    void load()
    api<UpdateResp>('update')
      .then(setUpd)
      .catch(() => {
        /* 更新信息只做展示，取不到就不显示那一块 */
      })
  }, [load])

  const pretty = () => JSON.stringify(cfgNow(), null, 2)

  /** 保存配置：把编辑器里的 JSON 原文交给后端（后端自己校验并热生效）。 */
  const saveCfg = async () => {
    setSaving(true)
    setRestartFields([])
    try {
      const r = await api<{ restart_required?: string[] }>('config', {
        body: JSON.parse(text),
      })
      setRestartFields(r.restart_required || [])
      onToast(
        r.restart_required?.length
          ? `已保存，${r.restart_required.length} 个字段需重启生效`
          : '配置已保存并热生效',
        'ok',
      )
      touchedRef.current = false
      await load()
    } catch (e) {
      onToast('保存失败：' + errText(e), 'err')
    } finally {
      setSaving(false)
    }
  }

  const checkUpdate = async () => {
    setChecking(true)
    try {
      const r = await api<UpdateResp>('update/check', { body: {} })
      setUpd(r)
      onToast(r.update_available ? `发现新版本 v${r.latest}` : '当前已是最新版本', 'ok')
    } catch (e) {
      onToast('检查更新失败：' + errText(e), 'err')
    } finally {
      setChecking(false)
    }
  }

  if (err && !d) return <View><div className="empty err">读取失败：{err}</div></View>
  if (!d) return <View><div className="empty">加载中…</div></View>

  const cfg = d.config || {}
  const cfgNow = () => {
    try {
      return JSON.parse(text || '{}')
    } catch {
      return {}
    }
  }
  let parseErr = ''
  try {
    if (text.trim()) JSON.parse(text)
  } catch (e) {
    parseErr = (e as Error).message
  }
  const dirty = text.trim() !== '' && text !== JSON.stringify(cfg, null, 2)

  return (
    <View>
      <Card
        title="版本"
        actions={
          <>
            <button className="btn sm" onClick={() => void load()}>
              重新读取
            </button>
            <button className="btn sm" disabled={checking} onClick={() => void checkUpdate()}>
              {checking ? '检查中…' : '检查更新'}
            </button>
            {upd?.update_available && upd.can_install ? (
              <button
                className="btn sm primary"
                disabled={!!upd.installing}
                onClick={async () => {
                  if (!confirm(`将安装 v${upd.latest} 并重启服务，期间会短暂中断。继续？`)) return
                  try {
                    await api('update/install', { body: {} })
                    onToast('更新已准备，服务即将重启', 'ok')
                  } catch (e) {
                    onToast('更新失败：' + errText(e), 'err')
                  }
                }}
              >
                立即更新
              </button>
            ) : null}
            {upd?.update_available && !upd.can_install && upd.release_url ? (
              <a className="btn sm" href={upd.release_url} target="_blank" rel="noopener noreferrer">
                手动下载
              </a>
            ) : null}
          </>
        }
      >
        <div className="kv-grid">
          <div className="kv">
            <span className="kv-k">当前版本</span>
            <span className="kv-v mono">{displayVersion(upd?.current || (cfg.version as string))}</span>
          </div>
          <div className="kv">
            <span className="kv-k">最新版本</span>
            <span className="kv-v mono">{upd?.latest ? displayVersion(upd.latest) : '未检查'}</span>
          </div>
          <div className="kv">
            <span className="kv-k">状态</span>
            <span className="kv-v">
              {upd?.installing ? (
                <span className="tag warn">正在准备更新…</span>
              ) : upd?.last_error ? (
                <span className="tag bad" title={upd.last_error}>
                  更新失败
                </span>
              ) : upd?.update_available ? (
                <span className="tag warn">有可用更新</span>
              ) : upd?.latest ? (
                <span className="tag ok">已是最新</span>
              ) : (
                <span className="tag mute">尚未检查</span>
              )}
            </span>
          </div>
          {d.path ? (
            <div className="kv kv-wide">
              <span className="kv-k">配置文件</span>
              <span className="kv-v mono">{d.path}</span>
            </div>
          ) : null}
        </div>
      </Card>

      <Card
        title="配置编辑"
        hint={dirty ? '有未保存的修改' : '编辑后点保存，热生效'}
        actions={
          <>
            {dirty ? (
              <button
                className="btn sm ghost"
                onClick={() => {
                  touchedRef.current = false
                  setText(pretty())
                }}
              >
                放弃修改
              </button>
            ) : null}
            <button className="btn sm primary" disabled={!dirty || saving} onClick={() => void saveCfg()}>
              {saving ? '保存中…' : '保存配置'}
            </button>
          </>
        }
      >
        {parseErr ? (
          <div className="note err">
            JSON 语法错误：{parseErr}
            <div className="dim">修好之后才能保存。保存按钮在语法错误时不可用。</div>
          </div>
        ) : null}
        <textarea
          className={'cfg-editor' + (parseErr ? ' invalid' : '')}
          spellCheck={false}
          value={text}
          onChange={(e) => {
            touchedRef.current = true
            setText(e.target.value)
          }}
        />
        {restartFields.length ? (
          <div className="note">
            以下字段需要重启进程才能生效：
            <code>{restartFields.join(', ')}</code>
          </div>
        ) : null}
      </Card>

      <Card title="只读快照" hint="服务端当前加载的配置" flush>
        <pre className="cfg-json">{JSON.stringify(cfg, null, 2)}</pre>
      </Card>
    </View>
  )
}
