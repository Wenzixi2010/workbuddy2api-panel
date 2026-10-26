/** 通用格式化与工具函数（从旧 app.js 迁移，语义保持一致）。 */

/** HTML 转义。React 默认就转义，但少数场景需要拼字符串（如 <title> 内容）。 */
export function esc(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 3 天前；空或零值显示「—」。 */
export function ago(iso?: string | null): string {
  if (!iso || iso.startsWith('0001-')) return '—'
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return '—'
  const s = (Date.now() - t) / 1000
  if (s < 0) return '刚刚'
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

/** 时长：秒 → 1.2s / 3m12s / 2h5m。 */
export function dur(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—'
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (m < 60) return s ? `${m}m${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

/** token 数紧凑显示：1234 → 1.2K，1234567 → 1.2M。 */
export function fmtK(n: number): string {
  n = Number(n || 0)
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1000) return Math.round(n / 1000) + 'K'
  return String(n)
}

/** 积分：保留两位小数；空值显示「—」。 */
export function fmtCredit(v: unknown): string {
  const n = Number(v)
  if (v === null || v === undefined || !Number.isFinite(n)) return '—'
  return n.toFixed(2)
}

/** 延迟：毫秒 → 123ms / 1.2s。 */
export function fmtLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 本地日期时间（YYYY-MM-DD HH:MM:SS）。 */
export function fmtLocalDateTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`
}

/** 把任意错误翻成一句可展示的话。 */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
