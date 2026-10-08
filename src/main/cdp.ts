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

/**
 * 注入脚本：把页面里的**链接点击**改成"交给系统默认浏览器打开"，
 * 而不是让这个分格自己跳过去。
 *
 * ## 为什么需要它（2026-10-08）
 *
 * 大王的需求：AI 给的链接点了之后**不要**把 AI 对话窗口换掉。
 * 实测量了 GPT 的真实形态（`scripts/diag-link-shape.js`）：
 *   · 回答里的链接 8 个，**全是 `target="_blank"`**（`rel="noopener"`）；
 *   · 另有 2 个无 target 的，都指向 `chatgpt.com` 自己（跳至内容 / 回首页）。
 * 也就是说：AI 给的链接本来开的是**新标签**，可这个新标签开在**分格那个 Chrome 窗口**里
 * —— 于是分格被换掉，看起来就是"直接跳了"。
 *
 * ## 做法：捕获阶段的 click + `console.log` 回传
 *
 * 为什么用 `console.log` 而不是在页面里挂 `window.aiquad` 之类的全局：
 * 共享会话（`--user-data-dir` 同一份）下所有分格在**同一个渲染进程网络**里，
 * 给任意页面挂全局是污染；`console.log` 走 CDP 的 `Runtime.consoleAPICalled` 事件，
 * **主进程被动收，不往页面里塞任何东西**，页面侧只有一段一次性的监听。
 *
 * ⚠️ 必须用 `Page.addScriptToEvaluateOnNewDocument` 注册：
 * 它对**之后的每次导航都生效**，而 `Runtime.evaluate` 只管当前这一页、
 * 一刷新就没了。两者都要：注册保证以后，现在跑一次保证"已经打开的那页"也生效。
 *
 * ## 为什么 `preventDefault` 是必须的
 *
 * 不拦住的话，`target=_blank` 会照常开新标签 —— 而那个新标签就落在分格窗口里，
 * 分格照样被换掉。所以**先拦住页面自己的跳转**，再由主进程转交系统浏览器。
 *
 * ## 放行规则（有意留下几个口子）
 *
 * · **纯修饰键点击**（Ctrl/Cmd/Shift/Alt 或中键）→ 不拦。让用户能主动"在这一格看看"，
 *   免得把唯一能临时开新标签的路也堵死。
 * · **非 http/https 一律不拦**（`mailto:`、`tel:`、`blob:`、`data:`…）——
 *   交给页面自己处理。系统浏览器打不开 `blob:`，拦下来只会变成"点了没反应"。
 * · **下载链接**（`download` 属性）→ 不拦，否则会静默失败。
 * · **纯锚点同页跳转**（`href="#foo"`）→ 不拦，那是页内定位，外部打开毫无意义。
 * · ⚠️ **同站链接（域名与当前页相同）→ 不拦**，见下面那段。
 *
 * ## ⚠️ 同站链接必须放行：0.4.14 踩过的坑（2026-10-08）
 *
 * 最初这版只看协议不看域名，于是把 AI 网站**站内导航**也全部转交了系统浏览器。
 * 大王当场发现："**切换历史会话直接跳到系统预览器了**"。
 * 现场实测（`scripts/diag-link-shape.js` 量 GPT，38 个可见链接）**全部在 `chatgpt.com`**：
 *   · 历史会话 → `/c/6ac6fa1c-…`（换会话是 AI 网站最核心的操作）
 *   · 侧栏入口 → `/`、`/images`、`/library`、`/projects`、`/scheduled`、`/plugins`
 * 而这些"换会话 / 换栏目"的动作**本来就该在分格里发生** ——
 * 转交给浏览器等于把整个 AI 站点从分格里踢出去，功能直接不可用。
 *
 * 所以判据补上**域名**：`SITE_HOSTS` 里的域名**原地导航**，只有**外部域名**才转交。
 * 这正好是当初列过又为了"全外部"放弃掉的方案 C，早晚要捡回来 ——
 * "外部"真正该管的是**外部网站**，不是"离开当前页面的任何跳转"。
 *
 * ⚠️ 域名用**精确相等**（`new URL().host` 全串比对），不做后缀匹配：
 * 后缀写错会把 `evil-chatgpt.com` 也当成自己人，那是反向的安全漏洞。
 */
export const EXTERNAL_LINK_SITE_HOSTS = ['chatgpt.com', 'chat.openai.com']

/**
 * 生成注入脚本。
 *
 * ⚠️ 做成**工厂**而不是常量字符串：站点域名是运行时要传给脚本的
 * （设置页能自定义 AI 站点，配置一变这份清单就得跟着变，写死在模板里没法改）。
 *
 * ⚠️ **重装靠"版本号"而不是单纯的布尔标记**（2026-10-08 实测踩到）：
 * 早先用 `if (window.__aiquadLinkHooked) return 'already'` 做幂等，
 * 结果**配置或判据变了之后也装不进去** —— 页面已经被打过标记，
 * 新脚本进来就 early-return，于是页面留着**旧判据**继续跑，
 * 现场表现为"代码明明改了、行为却一点没变"，极难查。
 * 现在标记里带一个版本常量：判据一改就换号，旧脚本自然被顶掉。
 */
export const EXTERNAL_LINK_HOOK_VERSION = 2

export function buildExternalLinkScript(siteHosts: string[] = EXTERNAL_LINK_SITE_HOSTS): string {
  return `
(() => {
  const VER = ${EXTERNAL_LINK_HOOK_VERSION};
  if (window.__aiquadLinkHooked === VER) return 'already';
  window.__aiquadLinkHooked = VER;
  const TAG = '[aiquad-ext-link]';
  // 本站域名：这些链接**原地导航**，绝不转交（见上面那段 0.4.13 的坑）
  const SITE_HOSTS = ${JSON.stringify(siteHosts.map(h => String(h).toLowerCase()))};
  const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };
  // ⚠️ 重装时**先把上一个监听器摘掉**：判据改版后要重装，而旧监听器还挂在
  // document 上。不摘的话两个监听器都会响应，点一次链接会转交两次
  // （表现是浏览器被打开两个标签），页面上还留着一份用旧判据的死代码。
  const OLD = '__aiquadLinkHandler';
  if (window[OLD]) { try { document.removeEventListener('click', window[OLD], true); } catch {} }
  const isPlainLeftClick = (e) =>
    e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
  const handler = (e) => {
    if (!isPlainLeftClick(e)) return;
    // 用 closest 兜住"套了 <span>/<div> 的链接"（AI 网站的卡片式链接常见）
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    if (a.hasAttribute('download')) return;
    let href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return;
    let abs;
    try { abs = new URL(href, document.baseURI).href; } catch { return; }
    let proto;
    try { proto = new URL(abs).protocol; } catch { return; }
    if (proto !== 'http:' && proto !== 'https:') return;
    // ⚠️ 本站链接放行：换历史会话、点侧栏栏位都靠它，转交会直接把整个站点踢出分格
    const host = hostOf(abs);
    if (host && SITE_HOSTS.indexOf(host) >= 0) return;
    e.preventDefault();
    e.stopPropagation();
    console.log(TAG + abs);
  };
  window[OLD] = handler;
  document.addEventListener('click', handler, true);
  return 'hooked';
})()
`
}

/** 注入脚本往 console 打出来的标记，主进程按它把 URL 取出来（见 buildExternalLinkScript） */
export const EXTERNAL_LINK_TAG = '[aiquad-ext-link]'

/**
 * 从配置里所有 AI 站点的网址取出**域名清单**（供 buildExternalLinkScript 用）。
 *
 * ⚠️ **不要硬编码域名**：大王在设置页加一个新的 AI 站点（DeepSeek、Kimi、Grok…）之后，
 * 它的历史会话、侧栏、栏位跳转**同样不该被转交**，而硬编码的清单里没有它
 * → 那些站内导航又会跳到系统浏览器去（0.4.14 那个坑换个站点复现一遍）。
 * 所以每次装钩子都现算一遍，配置一变就自动跟着变。
 */
export function siteHostsFromUrls(urls: string[]): string[] {
  const out = new Set<string>()
  for (const u of urls) {
    try { out.add(new URL(String(u)).host.toLowerCase()) }
    catch {}
  }
  return [...out]
}

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
    // 依赖运行时内置的 WebSocket（Node 22+ / Electron 32+）。
    // 老运行时上是 undefined，直接 new 会抛 TypeError，外面只当"这一格连不上"处理，
    // 问题就永远查不出来，所以这里先显式报清楚。
    const WS = (globalThis as any).WebSocket
    if (typeof WS !== 'function') {
      throw new Error(`CDP 需要运行时内置 WebSocket，当前 Node ${process.versions.node} 没有；请升级 Electron`)
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), timeoutMs)
      try {
        const ws: any = new WS(this.wsUrl, [], { perMessageDeflate: false })
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

  /** 退订某个方法的所有回调（见 instance-manager 的 closeCdp） */
  off(method: string) {
    this.listeners.delete(method)
  }

  /**
   * 装上"链接交给系统浏览器"的拦截器（见 EXTERNAL_LINK_SCRIPT）。
   *
   * 两步都要做，缺一不可：
   *   ① `Page.addScriptToEvaluateOnNewDocument` —— 对**之后的每次导航**生效；
   *   ② `Runtime.evaluate` —— 让**已经打开的那一页**立刻也生效（否则用户得刷新一次）。
   *
   * `onUrl` 会在页面点了链接时被调用，参数是那个绝对 URL。
   * ⚠️ 靠 `Runtime.consoleAPICalled` 收 URL，而不是往页面里挂全局 ——
   * 共享会话下所有分格共用同一份档案，给每个页面塞全局是污染（理由见脚本注释）。
   *
   * ⚠️⚠️ **`Runtime.enable` 是必须的前置步骤**，漏了它整个功能静默失效：
   * CDP **默认不转发页面的 console 输出**，不显式 `Runtime.enable` 的话
   * `Runtime.consoleAPICalled` 永远不来。而拦截器本身**是好的** ——
   * 实测页面那侧 `dispatchEvent` 返回 `defaultPrevented: true`（确实拦下了），
   * 只是 URL 送不到主进程。这种"页面行为对了、数据没回来"的半截状态最难查，
   * 所以这里把 `Runtime.enable` 放在**注册监听之前**，失败要降级但要说清楚。
   *
   * 失败只降级（返回 false），绝不影响这一格正常用：CDP 是增强，不是依赖。
   */
  async installExternalLinkHook(
    onUrl: (url: string) => void,
    siteHosts: string[] = EXTERNAL_LINK_SITE_HOSTS,
  ): Promise<boolean> {
    if (this.closed || !this.ws) return false
    try {
      // 不开这个，`Runtime.consoleAPICalled` 根本不会触发（见上面的警告）
      await this.send('Runtime.enable')
    }
    catch (e) {
      console.warn('[cdp] Runtime.enable 失败，链接拦截器装不上（该格链接仍会本格跳转）', e)
      return false
    }
    this.off('Runtime.consoleAPICalled')
    this.on('Runtime.consoleAPICalled', (p) => {
      const args = p?.args
      if (!Array.isArray(args)) return
      for (const a of args) {
        const v = a?.value
        if (typeof v === 'string' && v.startsWith(EXTERNAL_LINK_TAG)) {
          const url = v.slice(EXTERNAL_LINK_TAG.length)
          if (url) onUrl(url)
        }
      }
    })
    /**
     * 同一个脚本要注册两次，但**必须带同一个 `siteHosts`** ——
     * 不一致的话"之后导航"和"当前页"会用两套判据，行为会随时间漂移。
     */
    const source = buildExternalLinkScript(siteHosts)
    try {
      await this.send('Page.addScriptToEvaluateOnNewDocument', { source })
    }
    catch (e) {
      console.warn('[cdp] 链接拦截器注册失败（只影响已打开的页面）', e)
    }
    try {
      await this.send('Runtime.evaluate', { expression: source, returnByValue: true })
      return true
    }
    catch (e) {
      console.warn('[cdp] 链接拦截器在当前页面安装失败', e)
      return false
    }
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
