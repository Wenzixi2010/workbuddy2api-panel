import { useCallback, useEffect, useState } from 'react'

/**
 * 账号备注：**只存本机浏览器，不写回后端**。
 *
 * 为什么是前端本地存储而不是加个后端字段：备注是纯展示信息（"这是我大号"
 * "备用，别用"），不参与选号、计费、鉴权中的任何一环。放进账号池存储会把
 * 它同步到所有访问者，一个人改了备注别人也跟着变，反而更奇怪。
 *
 * 键取 uid 前 8 位——与用量视图账号维度的 key、积分明细表的 uid 前缀同源，
 * 几个表格因此能直接 join。
 */
const LS_KEY = 'wb2api.remarks.v1'

type Map = Record<string, string>

/** 与旧面板一致：uid 前 8 位做键。 */
export function remarkKey(uid: string | number | undefined | null): string {
  return String(uid ?? '').slice(0, 8)
}

function read(): Map {
  try {
    const raw = localStorage.getItem(LS_KEY)
    const v = raw ? JSON.parse(raw) : {}
    return v && typeof v === 'object' ? (v as Map) : {}
  } catch {
    return {}
  }
}

/** 返回是否真的写成功。localStorage 在隐私模式/配额满时会抛异常，
 *  吞掉就等于"界面说保存了、刷新后全没了"，调用方必须把 false 报给用户。 */
function write(m: Map): boolean {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(m))
    return true
  } catch {
    return false
  }
}

/**
 * 备注读写。多个视图共用同一份数据，所以订阅同一个自定义事件做跨组件同步——
 * 在账号池改完备注切到用量页，不该看到旧值。
 */
const BUS = 'wb2api:remarks-changed'

export function useRemarks() {
  const [map, setMap] = useState<Map>(() => read())

  useEffect(() => {
    const sync = () => setMap(read())
    window.addEventListener(BUS, sync)
    // 其他标签页改了也要跟上
    const onStorage = (e: StorageEvent) => {
      if (e.key === LS_KEY) sync()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(BUS, sync)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const save = useCallback((next: Map): boolean => {
    const ok = write(next)
    if (ok) {
      setMap(next)
      window.dispatchEvent(new Event(BUS))
    }
    return ok
  }, [])

  const clear = useCallback((): boolean => {
    const ok = write({})
    if (ok) {
      setMap({})
      window.dispatchEvent(new Event(BUS))
    }
    return ok
  }, [])

  const of = useCallback((uid: string | number | undefined | null) => {
    const k = remarkKey(uid)
    return k ? map[k] || '' : ''
  }, [map])

  return { map, save, clear, of }
}
