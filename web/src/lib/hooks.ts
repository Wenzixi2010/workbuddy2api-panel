import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { errText } from '../lib/format'

/** useApi：拉一次数据 + 重试，把 loading/error/data 三态收在一处。 */
export function useApi<T>(path: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      setData(await api<T>(path))
    } catch (e) {
      setErr(errText(e))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setErr('')
    api<T>(path)
      .then((d) => {
        if (alive) setData(d)
      })
      .catch((e) => {
        if (alive) setErr(errText(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps])

  return { data, err, loading, reload: load }
}

/** 轮询：视图存活期间按间隔重新拉取（面板多数表格是 5s 级刷新）。 */
export function usePoll(fn: () => void, ms: number, enabled = true) {
  useEffect(() => {
    if (!enabled || ms <= 0) return
    const t = setInterval(fn, ms)
    return () => clearInterval(t)
  }, [fn, ms, enabled])
}
