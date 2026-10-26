import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { errText, fmtCredit } from '../lib/format'
import { Card, Stat, Stats, View, ViewHead } from '../components/Layout'
import VouchersDialog from '../components/VouchersDialog'
import type { ViewProps } from './types'

/**
 * 任务中心。
 *
 * 三块内容对应后端三套东西，别混：
 *   - 成长任务队列（tasks/queue）：点「扫描」把各账号待做任务扫进队列，点「跑队列」
 *     才真正逐条执行。扫描与执行分开，是为了让人先看清要做什么再决定做不做。
 *   - 账号后台作业（tasks/jobs）：单账号「一键全自动」的进度，跨页面可见。
 *   - 官方补偿（compensation）：上游发的补偿额度，有截止时间，过期就真没了。
 */

type QueueItem = {
  uid: string
  nickname: string
  kind: string
  code: string
  title?: string
  status: 'pending' | 'running' | 'done' | 'skipped' | 'error'
  message?: string
  credit?: number
  energy?: number
}

type QueueState = {
  running: boolean
  total: number
  conc: number
  started: boolean
  started_at?: string
  seq: number
  items: QueueItem[]
}

type TaskJob = {
  id: string
  uid: string
  nickname: string
  realm: string
  trigger: string
  status: 'pending' | 'running' | 'finished' | 'interrupted' | 'error'
  started_at: string
  updated_at: string
  finished_at?: string
  current_task?: string
  completed: number
  total: number
  message?: string
  error?: string
}

type CompAccount = {
  uid: string
  nickname?: string
  skip?: boolean
  skip_reason?: string
  error?: string
  active?: boolean
  claimed?: boolean
  credit?: number
  end_time?: string
}

const STATUS_TAG: Record<QueueItem['status'], { cls: string; label: string }> = {
  pending: { cls: 'mute', label: '待执行' },
  running: { cls: 'warn', label: '执行中' },
  done: { cls: 'ok', label: '完成' },
  skipped: { cls: 'mute', label: '跳过' },
  error: { cls: 'bad', label: '失败' },
}

const JOB_TAG: Record<TaskJob['status'], { cls: string; label: string }> = {
  pending: { cls: 'mute', label: '排队' },
  running: { cls: 'warn', label: '进行中' },
  finished: { cls: 'ok', label: '已完成' },
  interrupted: { cls: 'warn', label: '已中断' },
  error: { cls: 'bad', label: '失败' },
}

/** 补偿截止按 +08:00 解释：上游给的是不带时区的本地时间串。 */
function endMs(text?: string): number | null {
  const t = String(text || '').trim()
  if (!t) return null
  const ms = Date.parse(t.replace(' ', 'T') + '+08:00')
  return Number.isFinite(ms) ? ms : null
}

function remainText(ms: number | null): string {
  if (ms === null) return '—'
  const diff = ms - Date.now()
  if (diff <= 0) return '已截止'
  const h = Math.floor(diff / 3600000)
  if (h < 48) return `${h} 小时`
  return `${Math.ceil(diff / 86400000)} 天`
}

export default function TasksCenterView({ onToast }: ViewProps) {
  const [q, setQ] = useState<QueueState | null>(null)
  const [jobs, setJobs] = useState<TaskJob[]>([])
  const [comp, setComp] = useState<CompAccount[] | null>(null)
  const [busy, setBusy] = useState('')
  const [vcOpen, setVcOpen] = useState(false)
  const [err, setErr] = useState('')
  const [conc, setConc] = useState(3)
  const [hideDone, setHideDone] = useState(true)
  const [hideNa, setHideNa] = useState(false)
  /** 只看当前这一轮：避免上一轮残留的 items 混进新扫描结果。 */
  const wantSeq = useRef(0)
  const timer = useRef<number | null>(null)

  const loadJobs = useCallback(async () => {
    try {
      const r = await api<{ jobs: TaskJob[] }>('tasks/jobs')
      setJobs(r.jobs || [])
    } catch {
      /* 作业列表只做展示，取不到不影响其他块 */
    }
  }, [])

  const loadQueue = useCallback(async () => {
    try {
      const r = await api<QueueState>('tasks/queue')
      setQ(r)
      return r
    } catch (e) {
      setErr(errText(e))
      return null
    }
  }, [])

  useEffect(() => {
    void loadQueue()
    void loadJobs()
  }, [loadQueue, loadJobs])

  // 队列在跑时轮询。跑完就停——不能让一个空闲页面每秒打接口。
  useEffect(() => {
    const running = q?.running === true
    if (!running) {
      if (timer.current !== null) {
        window.clearInterval(timer.current)
        timer.current = null
      }
      return
    }
    if (timer.current !== null) return
    timer.current = window.setInterval(() => {
      void loadQueue()
      void loadJobs()
    }, 1500)
    return () => {
      if (timer.current !== null) {
        window.clearInterval(timer.current)
        timer.current = null
      }
    }
  }, [q?.running, loadQueue, loadJobs])

  const scan = async () => {
    setBusy('scan')
    try {
      await api('tasks/scan_all', { body: {} })
      onToast('扫描完成', 'ok')
      await loadQueue()
    } catch (e) {
      onToast(errText(e), 'err')
    } finally {
      setBusy('')
    }
  }

  const runQueue = async () => {
    setBusy('run')
    try {
      await api('tasks/run_queue', { body: { growth: true, concurrency: conc } })
      wantSeq.current = (q?.seq ?? 0) + 1
      onToast('队列已启动', 'ok')
      await loadQueue()
    } catch (e) {
      onToast(errText(e), 'err')
    } finally {
      setBusy('')
    }
  }

  const loadComp = async () => {
    setBusy('comp')
    try {
      const r = await api<{ accounts: CompAccount[] }>('compensation')
      setComp(r.accounts || [])
    } catch (e) {
      onToast(errText(e), 'err')
    } finally {
      setBusy('')
    }
  }

  const claimAll = async () => {
    setBusy('compall')
    try {
      await api('compensation_all', { body: {} })
      onToast('已提交全量领取', 'ok')
      await loadComp()
    } catch (e) {
      onToast(errText(e), 'err')
    } finally {
      setBusy('')
    }
  }

  const claim = async (uid: string) => {
    setBusy('c' + uid)
    try {
      await api(`accounts/${encodeURIComponent(uid)}/compensation`, { body: {} })
      onToast('已领取', 'ok')
      await loadComp()
    } catch (e) {
      onToast(errText(e), 'err')
    } finally {
      setBusy('')
    }
  }

  const items = useMemo(() => {
    const list = q?.items || []
    return list.filter((it) => {
      if (hideDone && (it.status === 'done' || it.status === 'skipped')) return false
      return true
    })
  }, [q?.items, hideDone])

  const doneCount = (q?.items || []).filter((i) => i.status === 'done').length
  const errCount = (q?.items || []).filter((i) => i.status === 'error').length
  const pendingCount = (q?.items || []).filter((i) => i.status === 'pending' || i.status === 'running').length
  const gained = (q?.items || []).reduce((s, i) => s + (i.credit || 0), 0)

  const compRows = (comp || []).filter((r) => (hideNa ? !r.skip : true))
  const compPending = compRows.filter(
    (r) => !r.skip && !r.error && r.active && !r.claimed && (r.credit || 0) > 0,
  ).length

  const activeJobs = jobs.filter((j) => j.status === 'running' || j.status === 'pending')

  return (
    <View>
      <ViewHead
        title="任务中心"
        desc="成长任务队列、账号后台作业与官方补偿。扫描只是把待做任务列出来，点「跑队列」才真正执行。"
        actions={
          <>
            <button className="btn sm" onClick={() => setVcOpen(true)}>
              我的券码
            </button>
            <button className="btn sm" disabled={!!busy} onClick={() => void scan()}>
              {busy === 'scan' ? '扫描中…' : '扫描任务'}
            </button>
            <button className="btn sm primary" disabled={!!busy || q?.running} onClick={() => void runQueue()}>
              {q?.running ? '队列运行中…' : '跑队列'}
            </button>
          </>
        }
      />

      {err ? <div className="note err">{err}</div> : null}

      <Stats>
        <Stat label="队列状态" value={q?.running ? '运行中' : q?.started ? '已结束' : '未启动'} tone={q?.running ? 'warn' : undefined} sub={q ? `并发 ${q.conc}` : undefined} />
        <Stat label="待执行" value={pendingCount} tone={pendingCount ? 'accent' : undefined} />
        <Stat label="已完成" value={doneCount} tone="good" />
        <Stat label="失败" value={errCount} tone={errCount ? 'bad' : undefined} />
        <Stat label="本轮获得" value={fmtCredit(gained)} tone={gained ? 'good' : undefined} />
        <Stat label="进行中作业" value={activeJobs.length} />
      </Stats>

      <Card
        title="成长任务队列"
        hint={q ? `共 ${q.total} 项` : undefined}
        actions={
          <>
            <span className="sel-note">
              并发
              <select className="inp sm" value={conc} onChange={(e) => setConc(Number(e.target.value))}>
                {[1, 2, 3, 5, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </span>
            <label className="sel-note">
              <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
              隐藏已完成
            </label>
          </>
        }
        flush
      >
        {items.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">
              {q?.total ? '队列里没有待执行的任务（可能都已跑完）。' : '还没有扫描过。点右上角「扫描任务」，把各账号待做的成长任务列进来。'}
            </div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>任务</th>
                  <th>状态</th>
                  <th className="num">获得</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const tag = STATUS_TAG[it.status] || STATUS_TAG.pending
                  return (
                    <tr key={it.uid + it.code}>
                      <td>{it.nickname || String(it.uid).slice(0, 10)}</td>
                      <td>
                        <div>{it.title || it.code}</div>
                        {it.title ? <div className="who-id mono">{it.code}</div> : null}
                      </td>
                      <td>
                        <span className={'tag ' + tag.cls}>{tag.label}</span>
                      </td>
                      <td className="num mono">
                        {it.credit ? fmtCredit(it.credit) : '—'}
                        {it.energy ? <span className="dim"> · {it.energy} 能量</span> : null}
                      </td>
                      <td className="dim row-reason" title={it.message}>
                        {it.message || '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="账号后台作业" hint={`${jobs.length} 条`} actions={<button className="btn sm" onClick={() => void loadJobs()}>刷新</button>} flush>
        {jobs.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">还没有后台作业。在账号池里点某账号的「任务」可以启动一键全自动。</div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>触发</th>
                  <th>状态</th>
                  <th>进度</th>
                  <th>当前</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const tag = JOB_TAG[j.status] || JOB_TAG.pending
                  const pct = j.total > 0 ? Math.round((j.completed / j.total) * 100) : 0
                  return (
                    <tr key={j.id}>
                      <td>{j.nickname || String(j.uid).slice(0, 10)}</td>
                      <td className="dim">{j.trigger || '—'}</td>
                      <td>
                        <span className={'tag ' + tag.cls}>{tag.label}</span>
                        {j.error ? <div className="row-reason" title={j.error}>{j.error}</div> : null}
                      </td>
                      <td className="num mono">
                        {j.completed}/{j.total}
                        <div className="cred-bar">
                          <i style={{ width: pct + '%' }} />
                        </div>
                      </td>
                      <td className="dim">{j.current_task || '—'}</td>
                      <td className="dim nowrap">{j.updated_at ? new Date(j.updated_at).toLocaleString() : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="官方补偿"
        hint={comp ? (compPending ? `${compPending} 个待领` : '无待领') : '未查询'}
        actions={
          <>
            <label className="sel-note">
              <input type="checkbox" checked={hideNa} onChange={(e) => setHideNa(e.target.checked)} />
              隐藏不适用
            </label>
            <button className="btn sm" disabled={!!busy} onClick={() => void loadComp()}>
              {busy === 'comp' ? '查询中…' : '检查'}
            </button>
            <button className="btn sm primary" disabled={!!busy || !compPending} onClick={() => void claimAll()}>
              全部领取
            </button>
          </>
        }
        flush
      >
        {!comp ? (
          <div className="empty">
            <div className="empty-desc">
              补偿没有随 overview 一起下发（逐账号查上游，很慢），所以默认不查。点「检查」拉取当前状态。
            </div>
          </div>
        ) : compRows.length === 0 ? (
          <div className="empty">
            <div className="empty-desc">没有可显示的补偿记录。</div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>状态</th>
                  <th className="num">额度</th>
                  <th className="num">截止</th>
                  <th className="acts-col" />
                </tr>
              </thead>
              <tbody>
                {compRows.map((r) => {
                  const pending = !r.skip && !r.error && r.active && !r.claimed && (r.credit || 0) > 0
                  const ms = endMs(r.end_time)
                  const soon = ms !== null && ms - Date.now() <= 48 * 3600 * 1000
                  let state = <span className="tag mute">无活动</span>
                  if (r.skip) state = <span className="tag mute">{r.skip_reason || '不适用'}</span>
                  else if (r.error) state = <span className="tag bad">查询失败</span>
                  else if (r.claimed) state = <span className="tag ok">已领</span>
                  else if (pending) state = <span className="tag warn">待领</span>
                  return (
                    <tr key={r.uid}>
                      <td>{r.nickname || String(r.uid).slice(0, 10)}</td>
                      <td>{state}</td>
                      <td className="num mono">{r.credit ? fmtCredit(r.credit) : '—'}</td>
                      <td className={'num nowrap' + (soon ? ' bad-text' : ' dim')}>{remainText(ms)}</td>
                      <td className="acts-col">
                        {pending ? (
                          <button className="btn xs primary" disabled={!!busy} onClick={() => void claim(r.uid)}>
                            领取
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {vcOpen ? <VouchersDialog onClose={() => setVcOpen(false)} onToast={onToast} /> : null}
    </View>
  )
}
