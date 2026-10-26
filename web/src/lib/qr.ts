/**
 * 极简 QR 编码器（byte 模式 + ECC L + 掩码 0），只支持 v1–v6。
 *
 * 为什么自己写而不装 `qrcode` 包：面板总共两处要二维码（券码、登录授权链接），
 * 引一个库会给静态产物加几十 KB，而这里的输入都是短串（券码 20 字节、授权链接
 * 约 108 字节）。另外面板 CSP 只允许 self，不能调外部 QR 图片服务。
 *
 * 正确性：与 python `qrcode` 库（强制 byte 模式 + mask 0）逐位比对验证 5/5。
 * 局限：只到 v6（136 数据码字），超长输入直接抛错而不是静默生成错码——
 * 宁可显示"生成失败"也不能给用户一个扫不出东西的图。
 */

// GF(256) 对数/指数表（本原多项式 0x11d）
const EXP = new Array<number>(512)
const LOG = new Array<number>(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
})()

const gmul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0)

// 各版本参数（下标 = 版本-1）：[数据码字总数, 每块纠错码字数, 块数]，ECC L。
const QR_V: [number, number, number][] = [
  [19, 7, 1],
  [34, 10, 1],
  [55, 15, 1],
  [80, 20, 1],
  [108, 26, 1],
  [136, 18, 2],
]
// 对齐图案中心坐标（v2+）
const QR_ALIGN: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]]
const QR_MASK = (r: number, c: number) => (r + c) % 2 === 0

function genPoly(deg: number): number[] {
  let g = [1]
  for (let i = 0; i < deg; i++) {
    const a = EXP[i]
    const ng = new Array<number>(g.length + 1).fill(0)
    ng[0] = g[0]
    for (let j = 1; j < g.length; j++) ng[j] = g[j] ^ gmul(a, g[j - 1])
    ng[g.length] = gmul(a, g[g.length - 1])
    g = ng
  }
  return g
}

/** Reed-Solomon 求余（综合除法），返回 deg 个纠错码字。 */
function rsRem(data: number[], deg: number): number[] {
  const g = genPoly(deg)
  const res = data.concat(new Array<number>(deg).fill(0))
  for (let i = 0; i < data.length; i++) {
    const f = res[i]
    if (f) for (let j = 0; j < g.length; j++) res[i + j] ^= gmul(g[j], f)
  }
  return res.slice(data.length)
}

/** 文本 → 数据码字（byte 模式：0100 + 8 位计数 + 数据 + 终止符 + 0xEC/0x11 填充）。 */
function dataCodewords(bytes: number[], cap: number): number[] {
  const bits: number[] = []
  const push = (val: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1)
  }
  push(4, 4)
  push(bytes.length, 8)
  for (const b of bytes) push(b, 8)
  push(0, Math.min(4, cap * 8 - bits.length))
  while (bits.length % 8) bits.push(0)
  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]
    out.push(v)
  }
  for (let p = 0; out.length < cap; p ^= 1) out.push(p ? 0x11 : 0xec)
  return out
}

export type QRMatrix = boolean[][]

/** 文本 → 布尔矩阵（true = 深色模块）。超长抛错。 */
export function qrMatrix(text: string): QRMatrix {
  const bytes = Array.from(new TextEncoder().encode(text))
  let ver = 0
  for (let v = 0; v < QR_V.length; v++) {
    if (bytes.length + 2 <= QR_V[v][0]) {
      ver = v + 1
      break
    }
  }
  if (!ver) throw new Error(`QR: 文本过长（>${QR_V[QR_V.length - 1][0] - 2} 字节）`)
  const [dataCap, ecCap, nblk] = QR_V[ver - 1]
  const n = 17 + 4 * ver

  const M: QRMatrix = Array.from({ length: n }, () => new Array<boolean>(n).fill(false))
  const F: QRMatrix = Array.from({ length: n }, () => new Array<boolean>(n).fill(false))
  const setF = (r: number, c: number, v: boolean) => {
    M[r][c] = v
    F[r][c] = true
  }

  // 定位图案 + 分隔带
  const finder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r
        const cc = c0 + c
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue
        const dark =
          r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
        setF(rr, cc, dark)
      }
    }
  }
  finder(0, 0)
  finder(0, n - 7)
  finder(n - 7, 0)

  // 校正图形（贯穿两定位图案之间：8..n-9，不覆盖定位图案本体）
  for (let r = 8; r <= n - 9; r++) setF(r, 6, r % 2 === 0)
  for (let c = 8; c <= n - 9; c++) setF(6, c, c % 2 === 0)

  // 对齐图案（v2+，跳过与定位重叠处）
  for (const ar of QR_ALIGN[ver - 1] || []) {
    for (const ac of QR_ALIGN[ver - 1] || []) {
      if (F[ar][ac]) continue
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          setF(ar + r, ac + c, Math.max(Math.abs(r), Math.abs(c)) !== 1)
        }
      }
    }
  }

  // 格式信息（ECC L=01，掩码 0）：BCH(15,5) + 0x5412 异或
  let fmt = (1 << 3) | 0
  let rem = fmt << 10
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10)
  fmt = ((fmt << 10) | rem) ^ 0x5412
  const fb = (i: number) => ((fmt >> i) & 1) === 1

  // 副本一（左上）
  for (let i = 0; i <= 5; i++) setF(i, 8, fb(i))
  setF(7, 8, fb(6))
  setF(8, 8, fb(7))
  // 副本一续 + 副本二（右下）
  for (let i = 8; i <= 14; i++) setF(n - 15 + i, 8, fb(i))
  for (let i = 0; i <= 7; i++) setF(8, n - 1 - i, fb(i))
  setF(8, 7, fb(8))
  for (let i = 9; i <= 14; i++) setF(8, 14 - i, fb(i))
  // 暗模块
  setF(n - 8, 8, true)

  // 数据 + 纠错码字 → 位流
  const dcw = dataCodewords(bytes, dataCap)
  const per = dataCap / nblk
  const blk = Array.from({ length: nblk }, (_, i) => dcw.slice(i * per, (i + 1) * per))
  const ecs = blk.map((b) => rsRem(b, ecCap))
  const cw: number[] = []
  for (let i = 0; i < per; i++) for (const b of blk) cw.push(b[i])
  for (let i = 0; i < ecCap; i++) for (const e of ecs) cw.push(e[i])
  const bits: number[] = []
  for (const b of cw) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1)

  // 蛇形放置（成对列，右向左，跳过第 6 列），写入时直接异或掩码
  let bi = 0
  let up = true
  for (let x = n - 1; x > 0; x -= 2) {
    if (x === 6) x--
    for (let i = 0; i < n; i++) {
      const r = up ? n - 1 - i : i
      for (const c of [x, x - 1]) {
        if (F[r][c]) continue
        const bit = bi < bits.length ? bits[bi++] : 0
        M[r][c] = bit ? !QR_MASK(r, c) : QR_MASK(r, c)
      }
    }
    up = !up
  }
  return M
}
