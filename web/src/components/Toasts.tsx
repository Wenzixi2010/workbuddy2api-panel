export type ToastItem = { id: number; msg: string; kind: 'ok' | 'err' | '' }

/** 追加一条 toast，最多保留 4 条（多到堆叠会盖住表格内容）。 */
export function pushToast(prev: ToastItem[], item: ToastItem): ToastItem[] {
  const next = [...prev, item]
  return next.length > 4 ? next.slice(next.length - 4) : next
}

export default function Toasts({ items }: { items: ToastItem[] }) {
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={'tst ' + t.kind}>
          {t.msg}
        </div>
      ))}
    </div>
  )
}
