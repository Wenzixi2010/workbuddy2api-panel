/**
 * 版本号展示。
 *
 * 后端 appVersion 在本地构建时是 "dev"，发布构建才由 ldflags 注入 "2025.10.26.1830"
 * 这类日期版本。以前 Nav 里直接写 `'v' + version`，于是本地构建显示成 "vdev" ——
 * 看着像个错误的版本号，其实只是把 "v" 前缀无脑拼了上去。
 *
 * 这里的规则与旧面板 app.js 的 displayVersion() 保持一致：
 *   - 先剥掉可能已有的 "v" 前缀（后端/更新接口两处来源格式不完全统一）；
 *   - 剥完是 "dev" → 原样显示 "dev"（开发构建，不是版本号）；
 *   - 其它 → 补 "v" 前缀，显示成后缀组件能用的样子。
 */
export function displayVersion(version?: string | null): string {
  const raw = String(version ?? '').trim()
  if (!raw) return 'dev'
  const bare = raw.replace(/^v/i, '')
  if (!bare) return 'dev'
  // 开发构建/未知版本：不补 v，避免出现 vdev / vunknown 这种假版本号。
  if (bare === 'dev' || bare === 'unknown') return bare
  return 'v' + bare
}
