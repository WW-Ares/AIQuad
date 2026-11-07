import { proxyForAi, testProxy } from './proxy'
import type { AiService, AppConfig, ProxyConfig } from './types'

/**
 * 开机自启时的「网络就绪门」。
 *
 * 症状：AIQuad 被登录项拉起时，网卡/代理软件还没就绪，浏览器分格却已经按命令行
 * 把 URL 加载完了 —— Chrome 落到错误页之后**不会**因为网络恢复而重新发请求，
 * 于是用户看到的就是一片「网络不通」。
 *
 * 做法：只在这**一次启动**里，先按当前代理配置把各分格要打开的网址真实探一遍，
 * 全通了再继续 bootstrap（面板、托盘、浏览器进程都还没建，所以「一出来就是好的」）。
 * 每轮重读系统代理，因为梯子往往是在 AIQuad 之后才把代理写进注册表。
 *
 * 这个模块**不依赖 Electron**，探测/时钟/睡眠都可注入，便于用纯 Node 断言脚本验证状态机。
 */

export interface StartupGateTarget {
  url: string
  ai: Pick<AiService, 'proxyMode' | 'proxy'>
}

export interface StartupGateOptions {
  cfg: AppConfig
  targets: StartupGateTarget[]
  /** 每轮重读一次系统代理后的全局代理快照 */
  refreshGlobalProxy: () => Promise<ProxyConfig>
  probe?: (proxy: ProxyConfig | null, url: string) => Promise<{ ok: boolean; error?: string }>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  interrupted?: () => boolean
  backoffMs?: number[]
  log?: (msg: string) => void
}

export type StartupGateReason = 'disabled' | 'no-target' | 'ready' | 'timeout' | 'interrupted'

export interface StartupGateResult {
  reason: StartupGateReason
  waitedMs: number
  rounds: number
  lastErrors: string[]
}

/** 首轮立刻探，之后退避；最后一档一直复用到超时为止 */
const BACKOFF_MS = [0, 2000, 4000, 8000, 16000, 30000]

/**
 * 整轮探测的硬上限。
 *
 * testProxy 自己有 10 秒 deadline，但「每轮都探」叠加起来仍可能越过总时限；
 * 这里再按总 deadline 兜一道，到点（或用户手动启动打断）一定返回，绝不把启动卡死。
 */
function withDeadline<T>(
  p: Promise<T>,
  deadline: number,
  now: () => number,
  interrupted?: () => boolean,
): Promise<{ value: T | null; interrupted: boolean }> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: T | null, wasInterrupted: boolean) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      resolve({ value, interrupted: wasInterrupted })
    }
    const timer = setInterval(() => {
      if (settled) return
      if (interrupted?.()) finish(null, true)
      else if (now() >= deadline) finish(null, false)
    }, 50)
    p.then((v) => finish(v, false), () => finish(null, false))
    if (now() >= deadline) finish(null, false)
  })
}

export async function waitForNetworkReady(opts: StartupGateOptions): Promise<StartupGateResult> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const probe = opts.probe ?? testProxy
  const backoff = opts.backoffMs ?? BACKOFF_MS
  const log = opts.log ?? (() => {})
  const started = now()
  const done = (reason: StartupGateReason, rounds = 0, lastErrors: string[] = []): StartupGateResult => ({
    reason,
    waitedMs: now() - started,
    rounds,
    lastErrors,
  })

  const cfg = opts.cfg
  if (!cfg.startupWaitNetwork || Number(cfg.startupWaitMaxSec) <= 0) return done('disabled')
  if (!opts.targets.length) return done('no-target')

  const shared = cfg.sharedSession !== false
  const deadline = started + Number(cfg.startupWaitMaxSec) * 1000
  let rounds = 0
  let lastErrors: string[] = []

  for (let i = 0; ; i += 1) {
    const wait = backoff[Math.min(i, backoff.length - 1)]
    const remaining = deadline - now()
    if (remaining <= 0) {
      log(`[startup] 等待到上限（${cfg.startupWaitMaxSec}s）仍未全通，照常启动`)
      return done('timeout', rounds, lastErrors)
    }
    if (wait > 0) await sleep(Math.min(wait, remaining))
    if (opts.interrupted?.()) return done('interrupted', rounds, lastErrors)
    if (now() >= deadline) {
      log(`[startup] 等待到上限（${cfg.startupWaitMaxSec}s）仍未全通，照常启动`)
      return done('timeout', rounds, lastErrors)
    }

    // 梯子常在 AIQuad 之后才写系统代理，所以每轮都要拿最新的那份
    let globalProxy = cfg.proxy
    try {
      globalProxy = await opts.refreshGlobalProxy()
    }
    catch (e) {
      log(`[startup] 重读系统代理失败，沿用现有配置：${String((e as Error)?.message || e)}`)
    }

    rounds += 1
    const jobs = opts.targets.map(async (t) => {
      const proxy = proxyForAi(t.ai, globalProxy, shared)
      try {
        const r = await probe(proxy, t.url)
        return { ok: r.ok, error: r.error, host: safeHost(t.url) }
      }
      catch (e) {
        return { ok: false, error: String((e as Error)?.message || e), host: safeHost(t.url) }
      }
    })
    const settled = await withDeadline(Promise.all(jobs), deadline, now, opts.interrupted)
    if (settled.interrupted) return done('interrupted', rounds, lastErrors)
    if (!settled.value) return done('timeout', rounds, lastErrors)

    const failures = settled.value.filter((r) => !r.ok)
    lastErrors = failures.map((r) => `${r.host}: ${r.error || '不可达'}`)
    if (!failures.length) {
      log(`[startup] 第 ${rounds} 轮：${opts.targets.length} 个目标全部可达，放行（累计 ${now() - started}ms）`)
      return done('ready', rounds, [])
    }
    log(`[startup] 第 ${rounds} 轮未就绪：${lastErrors.slice(0, 3).join(' / ')}（累计 ${now() - started}ms）`)
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  }
  catch {
    return String(url).slice(0, 40)
  }
}
