/** 后端 JSON 形状的类型声明。
 *
 * 来源：internal/pool/entry.go 的 Status、internal/panel/panel.go 的 overview 等。
 * 只声明前端真正读到的字段——把后端整体形状照抄一遍会得到一个永远不同步的巨型
 * interface，读字段时反而不知道该信哪份。
 */

export type ModelCostStatus = {
  model: string
  cost_per_1k: number
  last_seen: string
  samples?: number
}

export type RateLimitedModel = {
  model: string
  until?: string
  remaining_sec?: number
}

export type ExpiryBucket = {
  date: string
  expires_at: string
  remain: number
}

export type TokenUsage = {
  input?: number
  output?: number
  total?: number
}

export type AccountStatus = {
  uid: string
  nickname?: string
  credits: number
  credits_total?: number
  credits_expiring?: number
  credits_earliest_expiry?: string
  credits_earliest_remaining?: number
  credits_expiry_buckets?: ExpiryBucket[]
  reserve_blocked?: boolean
  session_dead_fails?: number
  priority?: number
  share?: number
  cooling: boolean
  cool_kind?: string
  cool_remaining_sec?: number
  until?: string
  reason?: string
  soft_streak?: number
  rate_limited_models?: RateLimitedModel[]
  realm?: string
  enterprise?: boolean
  api_key?: boolean
  disabled: boolean
  disabled_reason?: string
  disabled_at?: string
  paused?: boolean
  success_count?: number
  err_total?: number
  last_success?: string
  last_err?: string
  checkin_done?: boolean
  token_usage?: TokenUsage
  model_costs?: ModelCostStatus[]
  consecutive_fails: number
  degrade_until?: string
  in_flight: number
  breaker_fails: number
  breaker_until?: string
}

export type UpdateInfo = {
  current?: string
  latest?: string
  available?: boolean
  installing?: boolean
  can_install?: boolean
  notes?: string
  url?: string
  error?: string
}

export type Overview = {
  version?: string
  poll_interval_sec?: number
  update?: UpdateInfo
  uptime_sec?: number
  auth_required?: boolean
  redis_mode?: string
  sticky_sessions?: number
  total?: number
  healthy?: number
  cooling?: number
  disabled?: number
  paused?: number
  in_flight_full?: number
  model_fallback?: Record<string, string>
  accounts?: AccountStatus[]
  model_locks?: unknown[] | null
  balance_refresh_sec?: number
  balance_refreshed_at?: string
}

export type ClientKey = {
  id: string
  name: string
  remark: string
  key_hint: string
  key?: string
  group?: string
  binds: string[]
  binds_all: boolean
  limits: { period: string; credits: number }
  used: number
  day?: string
  remaining: number
  requests: number
  unknown_credits: number
  disabled: boolean
  created_at: string
  updated_at: string
  last_used_at: string
  exhausted: boolean
}

export type ClientKeysResp = {
  enabled: boolean
  keys?: ClientKey[]
  path?: string
  error?: string
}

export type Group = {
  id: string
  name: string
  models: string[]
  created_at: string
  updated_at: string
}

export type GroupsResp = {
  enabled: boolean
  groups?: Group[]
  path?: string
  error?: string
}

export type BindableAccount = {
  uid: string
  nickname: string
  healthy: boolean
  disabled: boolean
  credits: number
  owner?: string
}
