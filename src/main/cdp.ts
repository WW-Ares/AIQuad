/**
 * 极简 CDP 客户端：只用稳定域（Target/Page/Runtime），
 * 依赖 Node 22 内置 WebSocket，不引入第三方依赖。
 */

const FOCUS_SCRIPT = `
(() => {
  const sels = ['textarea', 'div[contenteditable="true"]', '[contenteditable="true"]', 'input[type="text"]'];
  for (const s of sels) {
    const el = document.querySelector(s);
    if (el) { el.focus(); return true; }
  }
  return false;
})()
`

export interface CdpTarget {
  id: string
  type: string
  url: string
  title: string
  webSocketDebuggerUrl: string
}

export class CdpSession {
  private ws: any = null
  private msgId = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
  private listeners = new Map<string, Set<(p: any) => void>>()
  private closed = false

  constructor(private wsUrl: string) {}

  get url() {
    return this.wsUrl
  }

  async connect(timeoutMs = 8000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs)
      try {
        const ws: any = new (globalThis as any).WebSocket(this.wsUrl, [], { perMessageDeflate: false })
        this.ws = ws
        ws.onopen = () => {
          clearTimeout(timer)
          resolve()
        }
        ws.onerror = (e: any) => {
          clearTimeout(timer)
          reject(new Error('CDP socket error'))
        }
        ws.onclose = () => {
          this.closed = true
          this.flushPending(new Error('CDP closed'))
        }
        ws.onmessage = (ev: any) => {
          try {
            const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
            if (msg.id && this.pending.has(msg.id)) {
              const p = this.pending.get(msg.id)!
              this.pending.delete(msg.id)
              msg.error ? p.reject(new Error(msg.error.message || 'cdp error')) : p.resolve(msg.result)
            }
            else if (msg.method) {
              this.listeners.get(msg.method)?.forEach((fn) => fn(msg.params))
            }
          }
          catch {}
        }
      }
      catch (e) {
        clearTimeout(timer)
        reject(e)
      }
    })
  }

  private flushPending(err: Error) {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }

  on(method: string, fn: (params: any) => void) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method)!.add(fn)
  }

  async send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 8000): Promise<T> {
    if (!this.ws || this.closed) throw new Error('CDP not connected')
    const id = ++this.msgId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async focusInput(): Promise<boolean> {
    try {
      const r = await this.send('Runtime.evaluate', { expression: FOCUS_SCRIPT, returnByValue: true, userGesture: true })
      return r?.result?.value === true
    }
    catch {
      return false
    }
  }

  /**
   * 测量浏览器自身 UI（标签栏 + 地址栏 + 边框）占用的高度（CSS 像素）。
   * 标准窗口模式下用它把页面内容精确对齐到分格：窗口整体上移这么多，
   * 浏览器工具栏就被裁到分格可视区之外，页面顶部正好落在分格顶部。
   */
  async measureChromeUiHeight(): Promise<number> {
    try {
      const r = await this.send(
        'Runtime.evaluate',
        {
          expression: 'Math.max(0, Math.round(window.outerHeight - window.innerHeight))',
          returnByValue: true,
        },
        5000,
      )
      const v = Number(r?.result?.value)
      return Number.isFinite(v) && v >= 0 && v < 400 ? v : 0
    }
    catch {
      return 0
    }
  }

  async navigate(url: string) {
    await this.send('Page.navigate', { url })
  }

  /** 读取页面 viewport 尺寸，用于把网页内容区闭环校准到分格矩形 */
  async viewportSize(): Promise<{ width: number; height: number } | null> {
    try {
      const r = await this.send(
        'Runtime.evaluate',
        { expression: '({ w: window.innerWidth, h: window.innerHeight })', returnByValue: true },
        5000,
      )
      const v = r?.result?.value
      const width = Number(v?.w)
      const height = Number(v?.h)
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
      return { width, height }
    }
    catch {
      return null
    }
  }

  async reload() {
    try {
      await this.send('Page.reload', { ignoreCache: false })
    }
    catch {}
  }

  async bringToFront() {
    try {
      await this.send('Page.bringToFront')
    }
    catch {}
  }

  async screenshot(): Promise<string | null> {
    try {
      const r = await this.send('Page.captureScreenshot', { format: 'png' }, 15000)
      return r?.data ?? null
    }
    catch {
      return null
    }
  }

  close() {
    this.closed = true
    try {
      this.ws?.close()
    }
    catch {}
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** DevTools HTTP 端点在浏览器刚启动时可能还没监听，带重试 */
export async function listTargets(port: number, retries = 6): Promise<CdpTarget[]> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      return (await res.json()) as CdpTarget[]
    }
    catch {
      await sleep(800)
    }
  }
  return []
}

/**
 * 列出所有承载真实网页的目标（包含刚创建、暂时还是 about:blank 的窗口）。
 *
 * 用途：启动一个新分格前后各取一次，**差分**出"本次新开的那个 page 目标"——
 * 共享会话下所有分格在同一个浏览器进程里，按 URL 匹配会把同站点的两个分格认错，
 * 只有差分才能确定归属。
 */
export async function listPageTargets(port: number): Promise<CdpTarget[]> {
  const targets = await listTargets(port, 1)
  return targets.filter((t) => t.type === 'page' && /^(https?|about|chrome):/i.test(t.url))
}

export async function pickPageTarget(port: number, matchUrl?: string): Promise<CdpTarget | null> {
  const targets = await listTargets(port, 8)
  // 只取真实网页，排除扩展后台页与内部页
  const pages = targets.filter((t) => t.type === 'page' && /^https?:/i.test(t.url))
  if (!pages.length) return null
  if (matchUrl) {
    const host = safeHost(matchUrl)
    const hit = pages.find((p) => safeHost(p.url).includes(host))
    if (hit) return hit
  }
  return pages[0]
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  }
  catch {
    return url
  }
}
