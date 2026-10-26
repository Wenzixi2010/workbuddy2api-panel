import { useMemo } from 'react'
import { qrMatrix } from '../lib/qr'

type Props = {
  /** 要编码的文本。 */
  text: string
  /** 渲染边长（px）。 */
  size?: number
  className?: string
}

/**
 * 二维码（内联 SVG）。
 *
 * 白底是硬编码的：二维码的对比度语义与主题无关，深色主题下也必须保持浅底深码，
 * 否则很多扫码器会识别失败。
 */
export default function QRCode({ text, size = 132, className }: Props) {
  const m = useMemo(() => {
    try {
      return qrMatrix(text)
    } catch {
      return null
    }
  }, [text])

  if (!m) {
    return <div className="qr-fail">二维码生成失败（内容过长）</div>
  }

  const n = m.length
  const q = 4
  const total = n + q * 2
  const cells: string[] = []
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m[r][c]) cells.push(`M${c + q} ${r + q}h1v1h-1z`)
    }
  }

  return (
    <svg
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role="img"
      aria-label="二维码"
      className={'qr ' + (className || '')}
    >
      <rect width={total} height={total} fill="#fff" />
      <path d={cells.join('')} fill="#000" />
    </svg>
  )
}
