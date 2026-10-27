import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { errText } from '../lib/format'
import { Card, View } from '../components/Layout'
import { displayVersion } from '../lib/version'
import type { ViewProps } from './types'

type ConfigResp = {
  config?: Record<string, unknown>
  path?: string
  environment_managed_fields?: string[]
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
 *
 * 「定时任务」是独立于 JSON 编辑器之外的 `.box`：它直接读写 cfg.schedule 深路径，
 * 回填来自 config 接口、改动后单独 POST 一个只含 schedule.* 子对象的 body（后端
 * mergeConfigMaps 深合并，只覆盖它提交的键）。这样表单与 JSON 编辑器共存、互不覆盖。
 */

/* ── 定时任务表单 schema ───────────────────────────────────────────
 * 严格对应旧版 internal/panel/app.js 的 CFG_MAP 里 schedule.* 的路径。
 * type: 'bool' 渲染 .switch 开关；'num' 渲染 type=number；'text' 渲染文本框；
 *       'hours' 渲染逗号分隔的小时列表文本（保存时 split 成 number[]）。
 * key 是 cfg.schedule 下的字段名，path 是 environment_managed_fields 里用的点路径。
 */
type ScheduleFieldDef = {
  key: string
  type: 'bool' | 'num' | 'text' | 'hours'
  label: string
  hint?: string
  placeholder?: string
  min?: number
  max?: number
}

/** 开关类字段（.switch checkbox，bool 语义）。 */
const SCHEDULE_SWITCHES: ScheduleFieldDef[] = [
  { key: 'checkin_enabled', type: 'bool', label: '自动签到' },
  { key: 'keepalive_enabled', type: 'bool', label: 'Token 保活' },
  { key: 'travel_enabled', type: 'bool', label: '猫猫旅行' },
  { key: 'activity_enabled', type: 'bool', label: '活跃上报' },
  { key: 'growth_enabled', type: 'bool', label: '成长任务队列' },
  { key: 'blackcat_enabled', type: 'bool', label: '夜猫子' },
  { key: 'balance_refresh_enabled', type: 'bool', label: '后台刷新余额' },
  { key: 'task_sweep_enabled', type: 'bool', label: '补领清扫（达标未领自动补领）' },
  { key: 'include_disabled_in_tasks', type: 'bool', label: '保号任务覆盖已禁用账号' },
]

/** 字段类字段（label.fld input）。 */
const SCHEDULE_FIELDS: ScheduleFieldDef[] = [
  {
    key: 'checkin_hours', type: 'hours', label: '签到时点（小时，逗号分隔）', placeholder: '9, 21',
  },
  {
    key: 'keepalive_hours', type: 'hours', label: '保活时点（小时，逗号分隔）', placeholder: '22',
  },
  {
    key: 'keepalive_refresh_window', type: 'text', label: '保活临期窗口（Go 时长）', placeholder: '168h',
    hint: '仅刷新剩余有效期不超过该时长的凭证；已过期/无到期时间的账号始终刷新。留空 = 沿用现值',
  },
  {
    key: 'travel_hours', type: 'hours', label: '旅行时点（小时，逗号分隔）', placeholder: '9, 21',
    hint: '一趟派出 + 一趟领奖闭环',
  },
  {
    key: 'activity_hours', type: 'hours', label: '上报时点（小时，逗号分隔）', placeholder: '10',
    hint: '点亮连登 + 解锁领养前置',
  },
  {
    key: 'growth_hours', type: 'hours', label: '执行时点（小时，逗号分隔）', placeholder: '11',
    hint: '开关同时控制新增国区账号和每日后台执行。每日到点推进未完成项，建议设在零点后。',
  },
  {
    key: 'growth_concurrency', type: 'num', label: '账号间并发', placeholder: '1', min: 1, max: 4,
    hint: '1-4；调高更快，上游风控暴露面更大',
  },
  {
    key: 'blackcat_hours', type: 'hours', label: '补足时点（小时，逗号分隔）', placeholder: '23',
    hint: '只在 23:00–08:00 计数窗口内生效，窗口外自动跳过',
  },
  {
    key: 'balance_refresh_minutes', type: 'num', label: '刷新间隔（分钟）', placeholder: '5', min: 1,
  },
  {
    key: 'task_sweep_minutes', type: 'num', label: '清扫间隔（分钟）', placeholder: '15', min: 1,
  },
  {
    key: 'account_spread_minutes', type: 'num', label: '账号摊开窗口（分钟）', placeholder: '0', min: 0, max: 1440,
    hint: '0 = 关闭（同一秒打全池）。>0 时签到 / 旅行 / 活跃上报 / 保活 / 夜猫子把账号错开在窗口内各自的时刻。手动触发不受影响。窗口应小于相邻时点间隔。',
  },
  {
    key: 'account_spread_min_gap_seconds', type: 'num', label: '账号最小间隔（秒）', placeholder: '0', min: 0, max: 3600,
    hint: '0 = 只做随机。两个账号撞在同一时段时把后者推开；账号数 × 该值接近窗口时末尾会挤在一起。',
  },
]

const MANAGED_TIP = '此项由启动环境变量设置，请在部署配置中修改。'

/** 服务 / 账号池与流量治理 / 上游与高级 / 日志 的字段定义（与旧版 CFG_MAP 同款）。 */
type CfgFieldDef = {
  key: string
  label: string
  type: 'text' | 'num' | 'bool' | 'select'
  placeholder?: string
  hint?: string
  options?: { value: string; label: string }[]
  /** 需重启进程才能生效的提示。 */
  restart?: boolean
}

const SERVICE_FIELDS: CfgFieldDef[] = [
  { key: 'listen', label: '监听地址', type: 'text', placeholder: ':7863', hint: '改动需重启进程' },
  { key: 'api_key', label: 'API 密钥', type: 'text', placeholder: '留空 = 不鉴权', hint: '立即生效（含面板自身）' },
  { key: 'package_detail_limit', label: '单账号明细默认展示条数', type: 'num', placeholder: '5', hint: '积分构成页按最早到期展示，其余未用完包聚合' },
  { key: 'poll_interval_sec', label: '面板自动刷新间隔（秒）', type: 'num', placeholder: '0', hint: '0 = 缺省 5 秒；负数 = 关闭自动刷新（仅手动更新）' },
]

const POOL_FIELDS: CfgFieldDef[] = [
  { key: 'max_in_flight', label: '单账号最大在途', type: 'num', placeholder: '3', hint: '0 = 不限制' },
  { key: 'max_in_flight_global', label: '国际版在途上限', type: 'num', placeholder: '2', hint: 'global 域风控更紧，默认 2' },
  { key: 'breaker_threshold', label: '连续失败熔断阈值', type: 'num', placeholder: '3' },
  { key: 'soft_rate', label: '软限流冷却基数', type: 'text', placeholder: '600s' },
  { key: 'soft_rate_max', label: '软冷却退避上限', type: 'text', placeholder: '2h' },
  { key: 'breaker_cooldown', label: '熔断基础时长', type: 'text', placeholder: '30m' },
  { key: 'breaker_cooldown_max', label: '熔断退避上限', type: 'text', placeholder: '6h' },
  { key: 'degrade_threshold', label: '连败降权阈值', type: 'num', placeholder: '5', hint: '未知错误连败 N 次临时出池' },
  { key: 'degrade_cooldown', label: '连败降权时长', type: 'text', placeholder: '10m' },
  { key: 'degrade_cooldown_max', label: '连败降权上限', type: 'text', placeholder: '2h' },
  { key: 'idle_weight_per_hour', label: '闲置补偿 / 小时', type: 'num', placeholder: '0.5' },
  { key: 'idle_weight_max', label: '闲置补偿上限', type: 'num', placeholder: '5' },
  { key: 'cost_explore_interval', label: '成本探索窗口', type: 'text', placeholder: '30m', hint: '垄断破除：免费层垄断时定期搭车探索未知号；0 关停' },
  { key: 'credit_floor', label: '积分保底', type: 'num', placeholder: '100', hint: '余额低于此值不再接实测收费模型（保住免费模型可用）；0 关闭' },
  { key: 'credit_floor_max_rate', label: '保底倍率上限', type: 'num', placeholder: '0', hint: '无实测账本时，目录倍率 ≤ 此值才放行；0 = 任何已知收费倍率都拦' },
  { key: 'expiring_soon', label: '快过期路由窗口', type: 'text', placeholder: '168h', hint: '窗口内有快过期批次的账号选号权重 ×3；0 关闭' },
  { key: 'ttl', label: '会话粘性 TTL', type: 'text', placeholder: '30m', hint: '改动需重启进程' },
  { key: 'reserve_credits', label: '保留积分', type: 'num', placeholder: '10', hint: '余额低于该值的账号停止接单（0 = 关闭，缺省 10）' },
]

const POOL_SWITCHES: CfgFieldDef[] = [{ key: 'prefer_expiring', label: '快过期积分优先', type: 'bool' }]

const UPSTREAM_FIELDS: CfgFieldDef[] = [
  { key: 'timeout_seconds', label: '短请求超时', type: 'num', placeholder: '120', hint: '需重启', restart: true },
  { key: 'header_timeout_seconds', label: '聊天首字节超时', type: 'num', placeholder: '120', hint: '需重启', restart: true },
  { key: 'idle_timeout_seconds', label: '流空闲超时', type: 'num', placeholder: '300', hint: '需重启', restart: true },
  { key: 'user_agent', label: '出站 User-Agent', type: 'text', placeholder: '留空 = CLI/2.63.2 CodeBuddy/2.63.2', hint: '影响官网积分记录「使用端」显示；需重启', restart: true },
  { key: 'models_hidden', label: '模型黑名单', type: 'text', placeholder: 'deepseek-pro, cn:legacy-model', hint: '逗号分隔；裸名隐藏两域，cn: / global: 只隐藏该域；保存即热生效' },
  { key: 'models_allowed', label: '模型白名单', type: 'text', placeholder: 'glm-5.2, global:gpt-5.4', hint: '逗号/空白分隔；空 = 不启用（默认全部放行）；清空即关闭白名单，保存即热生效' },
  { key: 'models_aliases', label: '模型映射', type: 'text', placeholder: 'claude-opus-4=glm-5.2, gpt-5=global:gpt-5.4', hint: '逗号分隔的「客户端名=真实模型名」；目标仍受黑名单约束，保存即热生效' },
  {
    key: 'prompt_mode', label: '系统提示词模式', type: 'select', hint: '需重启', restart: true,
    options: [
      { value: 'custom', label: 'custom — 网关自有提示词（避免指纹误报）' },
      { value: 'append', label: 'append — 客户端 system 后插网关提示词（并用）' },
      { value: 'passthrough', label: 'passthrough — 透传客户端原始 system' },
    ],
  },
  { key: 'prompt_file', label: '提示词文件路径', type: 'text', placeholder: '留空 = 内置默认提示词', hint: '需重启', restart: true },
  {
    key: 'sanitize_brand_scope', label: '品牌词规则作用域', type: 'select',
    hint: '指纹脱敏总开关打开时生效。all 会改写 user / assistant / tool 历史里的同名文本；identity 只改身份消息。',
    options: [
      { value: 'all', label: 'all — 所有消息角色（默认，与上游一致）' },
      { value: 'identity', label: 'identity — 仅 system / developer' },
    ],
  },
]

const UPSTREAM_SWITCHES: CfgFieldDef[] = [
  { key: 'sanitize_blacklist_fingerprints', label: '出站请求指纹脱敏', type: 'bool' },
  { key: 'session_sticky_enabled', label: '会话粘性路由', type: 'bool' },
]

const LOG_SWITCHES: CfgFieldDef[] = [
  { key: 'request_client_info', label: '记录调用来源（客户端 IP / User-Agent）', type: 'bool' },
]

export default function ConfigView({ onToast }: ViewProps) {
  const [d, setD] = useState<ConfigResp | null>(null)
  const [err, setErr] = useState('')
  const [upd, setUpd] = useState<UpdateResp | null>(null)
  const [checking, setChecking] = useState(false)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [restartFields, setRestartFields] = useState<string[]>([])
  // 定时任务表单的字符串值（checkbox 用 '1'/'0' 记，其余存原始文本）。
  // 用字符串存，避免与「用户正在打字」的状态纠缠；回填时统一 stringify。
  const [scheduleVals, setScheduleVals] = useState<Record<string, string>>({})
  const [scheduleSaving, setScheduleSaving] = useState(false)
  const [scheduleRestart, setScheduleRestart] = useState<string[]>([])
  // 旧版结构化表单（服务 / 账号池与流量治理 / 上游与高级 / 日志）的字符串值。
  // checkbox 用 '1'/'0' 记；其余存原始文本，空 = 不下发（沿用现值）。
  const [formVals, setFormVals] = useState<Record<string, string>>({})
  const [formSaving, setFormSaving] = useState(false)
  const [formRestart, setFormRestart] = useState<string[]>([])
  // 用户是否动过编辑器。用 ref 而不是 state：load() 里要读它的最新值，
  // 用 state 会闭包到旧值，导致"正在编辑时被轮询覆盖"。
  const touchedRef = useRef(false)

  /** 从后端 config 对象里取 schedule 子对象（用于回填表单）。 */
  const scheduleCfg = (cfg: Record<string, unknown>): Record<string, unknown> => {
    const s = (cfg as Record<string, unknown>).schedule
    return s && typeof s === 'object' ? (s as Record<string, unknown>) : {}
  }

  const load = useCallback(async () => {
    try {
      const r = await api<ConfigResp>('config')
      setD(r)
      // 首次加载或后端配置真的变了才重置编辑器；否则会覆盖用户正在改的内容。
      setText((prev) => (prev === '' || !touchedRef.current ? JSON.stringify(r.config || {}, null, 2) : prev))
      // 回填定时任务表单（仅在未处于「正在保存」时覆盖；普通轮询刷新也回填最新值）。
      const sc = scheduleCfg(r.config || {})
      const next: Record<string, string> = {}
      for (const f of [...SCHEDULE_SWITCHES, ...SCHEDULE_FIELDS]) {
        next[f.key] = scheduleValToString(sc[f.key])
      }
      setScheduleVals(next)
      // 回填结构化表单（服务 / 账号池 / 上游 / 日志）：从 config 对象读现值。
      const c = r.config || {}
      const fv: Record<string, string> = {}
      for (const f of [...SERVICE_FIELDS, ...POOL_FIELDS, ...POOL_SWITCHES, ...UPSTREAM_FIELDS, ...UPSTREAM_SWITCHES, ...LOG_SWITCHES]) {
        const v = (c as Record<string, unknown>)[f.key]
        if (f.type === 'bool') fv[f.key] = v ? '1' : '0'
        else if (v === null || v === undefined) fv[f.key] = ''
        else if (Array.isArray(v)) fv[f.key] = v.join(', ')
        else fv[f.key] = String(v)
      }
      setFormVals(fv)
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

  /** 更新表单里某个字段的字符串值。 */
  const setScheduleVal = (key: string, v: string) => {
    setScheduleVals((prev) => ({ ...prev, [key]: v }))
  }

  /** 收集定时任务表单 → schedule.* 子对象（类型转换照旧版 collectConfig）。 */
  const collectSchedule = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    const put = (key: string, v: unknown) => {
      if (v !== undefined) out[key] = v
    }
    for (const f of SCHEDULE_SWITCHES) {
      put(f.key, scheduleVals[f.key] === '1')
    }
    for (const f of SCHEDULE_FIELDS) {
      const raw = (scheduleVals[f.key] ?? '').trim()
      if (f.type === 'num') {
        put(f.key, raw === '' ? undefined : Number(raw))
      } else if (f.type === 'hours') {
        put(f.key, raw === '' ? undefined : raw.split(/[,，\s]+/).filter(Boolean).map(Number))
      } else {
        // text：空 = 不下发（沿用现值），非空照发
        put(f.key, raw === '' ? undefined : raw)
      }
    }
    return out
  }

  /** 保存定时任务表单：只 POST 一个 { schedule: {...} } 子对象。 */
  const saveSchedule = async () => {
    setScheduleSaving(true)
    setScheduleRestart([])
    try {
      const patch = { schedule: collectSchedule() }
      const r = await api<{ restart_required?: string[] }>('config', {
        method: 'POST',
        body: patch,
      })
      setScheduleRestart(r.restart_required || [])
      onToast(
        r.restart_required?.length
          ? `已保存，${r.restart_required.length} 个字段需重启生效`
          : '定时任务配置已保存并热生效',
        'ok',
      )
      await load()
    } catch (e) {
      onToast('保存失败：' + errText(e), 'err')
    } finally {
      setScheduleSaving(false)
    }
  }

  /** 收集结构化表单 → 顶层补丁对象（与旧版 collectConfig 同口径：空 = 不下发）。 */
  const collectForm = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const f of [...SERVICE_FIELDS, ...POOL_FIELDS, ...POOL_SWITCHES, ...UPSTREAM_FIELDS, ...UPSTREAM_SWITCHES, ...LOG_SWITCHES]) {
      const raw = (formVals[f.key] ?? '').trim()
      if (f.type === 'bool') out[f.key] = raw === '1'
      else if (f.type === 'num') {
        if (raw !== '') out[f.key] = Number(raw)
      } else if (f.type === 'select') {
        if (raw !== '') out[f.key] = raw
      } else if (raw !== '') out[f.key] = raw
    }
    return out
  }

  /** 保存结构化表单：POST 顶层补丁（后端按字段合并热生效）。 */
  const saveForm = async () => {
    setFormSaving(true)
    setFormRestart([])
    try {
      const r = await api<{ restart_required?: string[] }>('config', {
        method: 'POST',
        body: collectForm(),
      })
      setFormRestart(r.restart_required || [])
      onToast(
        r.restart_required?.length
          ? `已保存，${r.restart_required.length} 个字段需重启生效`
          : '配置已保存并热生效',
        'ok',
      )
      await load()
    } catch (e) {
      onToast('保存失败：' + errText(e), 'err')
    } finally {
      setFormSaving(false)
    }
  }

  /** 放弃修改：重新从服务器拉一份（表单与编辑器一起回滚）。 */
  const discardForm = async () => {
    setText('')
    touchedRef.current = false
    await load()
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

  const managed = d.environment_managed_fields || []
  const isManaged = (key: string) => managed.includes('schedule.' + key)

  /** 渲染一个 .switch 开关。 */
  const renderSwitch = (f: ScheduleFieldDef) => {
    const disabled = isManaged(f.key)
    return (
      <div className="switch" key={f.key}>
        <span className="lb">{f.label}</span>
        <input
          type="checkbox"
          checked={scheduleVals[f.key] === '1'}
          disabled={disabled}
          title={disabled ? MANAGED_TIP : undefined}
          onChange={(e) => setScheduleVal(f.key, e.target.checked ? '1' : '0')}
        />
      </div>
    )
  }

  /** 渲染一个 label.fld 字段。 */
  const renderField = (f: ScheduleFieldDef) => {
    const disabled = isManaged(f.key)
    return (
      <label className="fld" key={f.key}>
        <span className="lb">{f.label}</span>
        <input
          type={f.type === 'num' ? 'number' : 'text'}
          value={scheduleVals[f.key] ?? ''}
          placeholder={f.placeholder}
          min={f.min}
          max={f.max}
          disabled={disabled}
          title={disabled ? MANAGED_TIP : undefined}
          onChange={(e) => setScheduleVal(f.key, e.target.value)}
        />
        {f.hint ? <span className="hint">{f.hint}</span> : null}
      </label>
    )
  }

  const scheduleDirty = scheduleValsIsDirty(scheduleVals, scheduleCfg(cfg))

  /** 结构化表单：渲染一个 .switch 开关。 */
  const renderFormSwitch = (f: CfgFieldDef) => (
    <div className="switch" key={f.key}>
      <span className="lb">{f.label}</span>
      <input
        type="checkbox"
        checked={formVals[f.key] === '1'}
        onChange={(e) => setFormVals((p) => ({ ...p, [f.key]: e.target.checked ? '1' : '0' }))}
      />
    </div>
  )

  /** 结构化表单：渲染一个 label.fld 字段。 */
  const renderFormField = (f: CfgFieldDef) => (
    <label className="fld" key={f.key}>
      <span className="lb">{f.label}</span>
      {f.type === 'select' ? (
        <select value={formVals[f.key] ?? ''} onChange={(e) => setFormVals((p) => ({ ...p, [f.key]: e.target.value }))}>
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={f.type === 'num' ? 'number' : 'text'}
          value={formVals[f.key] ?? ''}
          placeholder={f.placeholder}
          onChange={(e) => setFormVals((p) => ({ ...p, [f.key]: e.target.value }))}
        />
      )}
      {f.hint ? <span className="hint">{f.hint}</span> : null}
    </label>
  )

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

      {/* 服务：与旧版同构（监听 / API 密钥 / 明细条数 / 自动刷新）。 */}
      <Card title="服务">
        <div className="grid2">
          {renderFormField(SERVICE_FIELDS[0])}
          {renderFormField(SERVICE_FIELDS[1])}
        </div>
        {renderFormField(SERVICE_FIELDS[2])}
        {renderFormField(SERVICE_FIELDS[3])}
      </Card>

      <Card
        title="定时任务"
        hint={scheduleDirty ? '有未保存的修改' : '修改后点保存，热生效'}
        actions={
          <button
            className="btn sm primary"
            disabled={!scheduleDirty || scheduleSaving}
            onClick={() => void saveSchedule()}
          >
            {scheduleSaving ? '保存中…' : '保存定时任务'}
          </button>
        }
      >
        {/* 开关区：与旧版一致，grid2 两列 + hr 分隔 */}
        <div className="grid2">
          <div>
            {renderSwitch(SCHEDULE_SWITCHES[0])}
            {renderField(SCHEDULE_FIELDS[0])}
          </div>
          <div>
            {renderSwitch(SCHEDULE_SWITCHES[1])}
            {renderField(SCHEDULE_FIELDS[1])}
            {renderField(SCHEDULE_FIELDS[2])}
          </div>
        </div>
        <div className="hr"></div>
        <div className="grid2">
          <div>
            {renderSwitch(SCHEDULE_SWITCHES[2])}
            {renderField(SCHEDULE_FIELDS[3])}
          </div>
          <div>
            {renderSwitch(SCHEDULE_SWITCHES[3])}
            {renderField(SCHEDULE_FIELDS[4])}
          </div>
        </div>
        <div className="hr"></div>
        <div className="grid2">
          <div>
            {renderSwitch(SCHEDULE_SWITCHES[4])}
            {renderField(SCHEDULE_FIELDS[5])}
            {renderField(SCHEDULE_FIELDS[6])}
          </div>
          <div>
            {renderSwitch(SCHEDULE_SWITCHES[5])}
            {renderField(SCHEDULE_FIELDS[7])}
          </div>
        </div>
        <div className="hr"></div>
        <div className="grid2">
          <div>
            {renderSwitch(SCHEDULE_SWITCHES[6])}
            {renderField(SCHEDULE_FIELDS[8])}
          </div>
          <div></div>
        </div>
        <div className="hr"></div>
        <div className="grid2">
          <div>
            {renderSwitch(SCHEDULE_SWITCHES[7])}
            {renderField(SCHEDULE_FIELDS[9])}
          </div>
          <div></div>
        </div>
        <div className="hr"></div>
        <div className="grid2">
          <div>
            {renderField(SCHEDULE_FIELDS[10])}
            {renderField(SCHEDULE_FIELDS[11])}
          </div>
          <div></div>
        </div>
        <div className="hr"></div>
        {renderSwitch(SCHEDULE_SWITCHES[8])}
        <div className="hint">
          禁用只关选号：打开后已禁用的账号仍会签到 / 活跃上报 / 保活 / 刷新余额（依旧不参与选号）。适合「一次只放开一个账号、用禁用做流量开关」的轮换养号用法，默认关闭。
        </div>
        {scheduleRestart.length ? (
          <div className="note">
            以下字段需要重启进程才能生效：
            <code>{scheduleRestart.join(', ')}</code>
          </div>
        ) : null}
      </Card>

      {/* 账号池与流量治理：与旧版同构（grid3 字段组 + 快过期优先开关）。 */}
      <Card title="账号池与流量治理">
        <div className="grid3">
          {renderFormField(POOL_FIELDS[0])}
          {renderFormField(POOL_FIELDS[1])}
          {renderFormField(POOL_FIELDS[2])}
        </div>
        <div className="grid3">
          {renderFormField(POOL_FIELDS[3])}
          {renderFormField(POOL_FIELDS[4])}
          {renderFormField(POOL_FIELDS[5])}
        </div>
        <div className="grid3">
          {renderFormField(POOL_FIELDS[6])}
          {renderFormField(POOL_FIELDS[7])}
          {renderFormField(POOL_FIELDS[8])}
        </div>
        <div className="grid3">
          {renderFormField(POOL_FIELDS[9])}
          {renderFormField(POOL_FIELDS[10])}
          {renderFormField(POOL_FIELDS[11])}
        </div>
        <div className="grid3">
          {renderFormField(POOL_FIELDS[12])}
          {renderFormField(POOL_FIELDS[13])}
          {renderFormField(POOL_FIELDS[14])}
        </div>
        <div className="grid3">
          {renderFormField(POOL_FIELDS[15])}
          {renderFormField(POOL_FIELDS[16])}
          {renderFormField(POOL_FIELDS[17])}
        </div>
        {renderFormSwitch(POOL_SWITCHES[0])}
      </Card>

      {/* 上游与高级：与旧版同构（超时 / UA / 模型三表 / 提示词 / 指纹脱敏 / 粘性路由）。 */}
      <Card title="上游与高级">
        <div className="grid3">
          {renderFormField(UPSTREAM_FIELDS[0])}
          {renderFormField(UPSTREAM_FIELDS[1])}
          {renderFormField(UPSTREAM_FIELDS[2])}
        </div>
        <div className="hr"></div>
        {renderFormField(UPSTREAM_FIELDS[3])}
        <div className="hr"></div>
        <div className="grid2">
          {renderFormField(UPSTREAM_FIELDS[4])}
          {renderFormField(UPSTREAM_FIELDS[5])}
          {renderFormField(UPSTREAM_FIELDS[6])}
        </div>
        <div className="hr"></div>
        <div className="grid2">
          {renderFormField(UPSTREAM_FIELDS[7])}
          {renderFormField(UPSTREAM_FIELDS[8])}
        </div>
        <div className="hr"></div>
        {renderFormSwitch(UPSTREAM_SWITCHES[0])}
        {renderFormField(UPSTREAM_FIELDS[9])}
        {renderFormSwitch(UPSTREAM_SWITCHES[1])}
      </Card>

      {/* 日志：与旧版同构（记录调用来源开关）。 */}
      <Card title="日志">
        {renderFormSwitch(LOG_SWITCHES[0])}
        <div className="hint">
          开启后，「运行日志」页的请求记录会显示每次调用来自哪个 IP、用什么客户端；关闭则归档与面板都不再出现来源信息。改动即时生效，无需重启。
        </div>
      </Card>

      {/* 保存栏：与旧版同构（放弃修改 / 保存配置 + 重启提示）。 */}
      <div className="savebar">
        <span className="grow" />
        {formRestart.length ? (
          <span className="restart-note">
            需重启生效：<code>{formRestart.join(', ')}</code>
          </span>
        ) : null}
        <button className="btn" disabled={formSaving} onClick={() => void discardForm()}>
          放弃修改
        </button>
        <button className="btn primary" disabled={formSaving} onClick={() => void saveForm()}>
          {formSaving ? '保存中…' : '保存配置'}
        </button>
      </div>

      <Card
        title="配置编辑（高级）"
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

/** 定时任务表单是否相对当前后端 schedule 有改动。 */
function scheduleValsIsDirty(
  vals: Record<string, string>,
  sc: Record<string, unknown>,
): boolean {
  for (const f of [...SCHEDULE_SWITCHES, ...SCHEDULE_FIELDS]) {
    const cur = (vals[f.key] ?? '').trim()
    const orig = scheduleValToString(sc[f.key]).trim()
    if (cur !== orig) return true
  }
  return false
}

/** 把 schedule 里的一个值转成表单文本框里的字符串（供 dirty 比较复用）。 */
function scheduleValToString(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'boolean') return v ? '1' : '0'
  return String(v)
}
