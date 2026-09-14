import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { AiService, AppConfig } from './types'
import type { BrowserInfo } from './browser-detect'
import { CdpSession, listPageTargets } from './cdp'
import { buildBypassArg, buildProxyServerArg } from './proxy'
import * as w32 from './win32'

export type InstanceStatus = 'idle' | 'starting' | 'ready' | 'failed' | 'suspended'

/** 网页内容区相对窗口左上角的偏移与内衬（物理像素） */
export interface InstanceInsets {
  left: number
  top: number
  right: number
  bottom: number
}

export interface ManagedInstance {
  paneId: string
  aiId: string
  url: string
  status: InstanceStatus
  /** 承载本格窗口的浏览器进程（共享会话下多个分格是同一个 pid） */
  pid?: number
  hwnd?: number
  port?: number
  /** 是否属于"共享会话"（所有分格共用一个浏览器档案 / 进程） */
  shared: boolean
  profileDir: string
  /** 由 `Chrome_RenderWidgetHostHWND` 子窗口实测得到，不依赖 CDP */
  insets?: InstanceInsets
  cdp?: CdpSession
  targetId?: string
  error?: string
  /** 期望可见性（与"当前是否已 ShowWindow"分开，避免位置刷新把隐藏的实例又显出来） */
  desiredVisible: boolean
  /**
   * 需要在可视区里"挖掉"的小矩形（分格内容区坐标）。
   * 分格底部展开 AI 下拉时用它把菜单那一块从浏览器窗口裁掉，
   * 页面其余部分保持可见——比整窗隐藏观感好得多。
   */
  hole?: { x: number; y: number; width: number; height: number } | null
  /** 当前是否已处于显示状态，避免反复 ShowWindow 造成闪烁 */
  shown?: boolean
}

interface SharedBrowser {
  pid: number
  port: number
  profileDir: string
  proc: ChildProcess
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 面板分格圆角（CSS 像素），与界面上的 --radius-pane 保持一致 */
const PANE_RADIUS = 10
/**
 * 实测不到网页内容区时的兜底内衬。
 * 数值来自 Chrome 150 / 100% DPI / 标准窗口的实测（见 win32.chromeContentInsets）。
 * 只在原生子窗口与 CDP 两条测量路径都失败时才会用到。
 */
const FALLBACK_INSETS: InstanceInsets = { left: 8, top: 87, right: 8, bottom: 8 }
/** 共享会话的档案目录名 */
const SHARED_DIR_NAME = 'shared'

function slug(name: string) {
  return name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_').slice(0, 40) || 'ai'
}

function pidAlive(pid: number) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

let counter = 0

/**
 * 真实浏览器实例管理器。
 *
 * ## 架构（v0.4）
 *
 * 每个分格 = 一个**顶级**浏览器窗口（不做 SetParent 嵌入），
 * 多个分格可以是同一个浏览器进程里的多个窗口。
 *
 * ### 为什么不做 SetParent 子窗口嵌入（v0.2 的做法）
 * 实测表明，跨进程 reparent 后 Windows 的系统焦点仍留在宿主线程上，
 * 键盘事件无法路由到嵌入的浏览器窗口（AttachThreadInput 也无效），
 * 表现为"能点不能打字"，中文输入法更是完全不可用。
 *
 * ### 为什么改成"共享会话"（v0.4）
 * v0.3 给每个分格开了**独立档案**，于是同一个 Gemini 在 2 格登录两次。
 * Chrome 的档案（Cookie / localStorage / 登录态）是**进程级单例**：
 * 同一个 `--user-data-dir` 第二次启动时，新进程会把命令行交给已在运行的实例
 * （实测：子进程 85ms 后以 code 0 退出），由它再开一个窗口——
 * 于是所有分格天然共享同一份登录态。这就是"在任意分格登录，其它分格都能用"的实现。
 * 代价是代理变成进程级设置（共享会话下按全局代理走，不再支持按 AI 单独设代理）。
 *
 * ### 顶级窗口如何"看起来仍嵌在分格里"
 * 1. `SWP_NOSENDCHANGING` 绕过 Chrome 的最小宽度钳制（标准窗口默认 ≥516px），
 *    窄分格（如 271px）也能精确落位；
 * 2. `SetWindowRgn` 把浏览器自带的标题栏/标签栏/地址栏从可视区裁掉，
 *    被裁掉的区域既不绘制也不接收鼠标 → 面板顶栏与 UI 恢复正常；
 * 3. `WS_EX_TOOLWINDOW` 让它不进任务栏、不出现在 Alt+Tab；
 * 4. 网页内容区的偏移由子窗口 `Chrome_RenderWidgetHostHWND` **实测**得到
 *    （它同时就是 viewport），因此对齐是精确且免 CDP 的；
 * 5. 跟随面板的置顶状态，并保证浮在面板之上。
 */
export class InstanceManager {
  private instances = new Map<string, ManagedInstance>()
  /** 面板窗口的屏幕矩形与缩放（物理像素），实例位置由它换算 */
  private panel = { x: 0, y: 0, scale: 1, hwnd: 0, topMost: true }
  private rects = new Map<string, { x: number, y: number, width: number, height: number }>()
  /** 被 UI 浮层临时遮挡的格子（下拉展开时需隐藏原生浏览器窗口） */
  private occluded = new Set<string>()
  /** 面板整体收起时为 true：所有实例窗口强制隐藏，避免收起瞬间闪出 */
  private suppressed = false
  /** 共享会话的浏览器（所有分格共用） */
  private shared: SharedBrowser | null = null
  /** 已被某个分格占用的浏览器窗口，窗口差分时用来排除 */
  private claimed = new Set<number>()
  private onStatus?: (paneId: string, status: InstanceStatus, error?: string) => void
  /**
   * 启动串行化。两个分格同时去抢同一个档案时，Chrome 会判定"档案正在使用"
   * 并弹对话框；排队启动可以彻底避免。
   */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private opts: {
      browser: BrowserInfo
      profilesRoot: string
      config: () => AppConfig
      /**
       * 重新探测浏览器可执行文件。
       *
       * 浏览器升级会把安装位置整体搬走（实测：Chrome 从
       * `%LOCALAPPDATA%\Google\Chrome\Application` 迁到 `%ProgramFiles%\...`，
       * 原路径被删掉），启动瞬间解析出来的 `browser.exePath` 就此失效，
       * `spawn` 会抛 ENOENT。所以每次启动前都要能重新解析。
       */
      resolveBrowser?: () => Promise<BrowserInfo | null>
    },
  ) {}

  setStatusSink(fn: (paneId: string, status: InstanceStatus, error?: string) => void) {
    this.onStatus = fn
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => {})
    return next
  }

  /* ---------------- 面板绑定 ---------------- */

  /** 绑定面板窗口：记录其屏幕位置、缩放与置顶状态，实例据此定位 */
  setPanel(bounds: { x: number, y: number }, scale: number, hwnd: number, topMost: boolean) {
    this.panel.x = bounds.x
    this.panel.y = bounds.y
    this.panel.scale = scale || 1
    this.panel.hwnd = hwnd
    this.panel.topMost = topMost
    for (const inst of this.instances.values()) {
      if (inst.hwnd && w32.isWindow(inst.hwnd)) {
        w32.setOwner(inst.hwnd, hwnd)
        w32.setTopMost(inst.hwnd, topMost)
      }
    }
    this.applyRects()
  }

  /** 面板位置变化时同步实例位置 */
  setPanelPosition(x: number, y: number) {
    this.panel.x = x
    this.panel.y = y
    this.applyRects()
  }

  /**
   * 面板收起/展开。收起时必须先把所有原生浏览器窗口隐藏掉：
   * 它们是独立的顶级窗口，父窗口 hide 不会带走它们。
   */
  setSuppressed(on: boolean) {
    if (this.suppressed === on) return
    this.suppressed = on
    if (on) {
      for (const inst of this.instances.values()) this.setShown(inst, false)
    }
    else {
      this.applyRects()
    }
  }

  get(paneId: string) {
    return this.instances.get(paneId)
  }

  list() {
    return Array.from(this.instances.values()).map((i) => ({
      paneId: i.paneId,
      aiId: i.aiId,
      status: i.status,
      pid: i.pid,
      error: i.error,
      url: i.url,
    }))
  }

  private emit(inst: ManagedInstance, status: InstanceStatus, error?: string) {
    inst.status = status
    inst.error = error
    this.onStatus?.(inst.paneId, status, error)
  }

  /* ---------------- 启动 ---------------- */

  /** 启动（或复用）一个分格对应的真实浏览器实例 */
  async launch(paneId: string, ai: AiService, force = false): Promise<ManagedInstance> {
    return this.run(() => this.doLaunch(paneId, ai, force))
  }

  /** 重建某一格（重新加载 / 手动重启）：先开新窗口，就位后再关旧窗口 */
  async restart(paneId: string) {
    const inst = this.instances.get(paneId)
    if (!inst) return
    const ai = this.opts.config().aiList.find((a) => a.id === inst.aiId)
    if (!ai) return
    await this.launch(paneId, ai, true)
  }

  private async doLaunch(paneId: string, ai: AiService, force: boolean): Promise<ManagedInstance> {
    const cfg = this.opts.config()
    const useShared = cfg.sharedSession !== false
    const existing = this.instances.get(paneId)
    let previous: ManagedInstance | null = null

    if (existing) {
      const usable = !!(existing.hwnd && w32.isWindow(existing.hwnd) && existing.status === 'ready')
      if (!force && usable && existing.aiId === ai.id) {
        existing.desiredVisible = true
        this.applyRect(paneId)
        return existing
      }
      // 换 AI：共享会话下所有分格本来就是同一份登录态，
      // 直接把窗口导航过去即可，窗口句柄、位置、几何都不用重建
      if (!force && usable && existing.cdp) {
        existing.aiId = ai.id
        existing.url = ai.url
        try {
          await existing.cdp.navigate(ai.url)
          await existing.cdp.bringToFront()
        }
        catch {}
        this.applyRect(paneId)
        return existing
      }
      // 要重建。注意顺序：**先开新窗口、再关旧窗口**。
      // 反过来做的话，旧窗口释放掉的 HWND 可能被 Windows 立刻回收给新窗口，
      // 于是"新出现的窗口"差分就认不出来，这一格会卡在超时。
      previous = existing
      try {
        previous.cdp?.close()
      }
      catch {}
    }

    const profileDir = useShared
      ? path.join(this.opts.profilesRoot, SHARED_DIR_NAME)
      : path.join(this.opts.profilesRoot, `${slug(ai.id)}_${paneId}`)
    fs.mkdirSync(profileDir, { recursive: true })

    const inst: ManagedInstance = {
      paneId,
      aiId: ai.id,
      url: ai.url,
      status: 'starting',
      shared: useShared,
      profileDir,
      desiredVisible: false,
    }
    this.instances.set(paneId, inst)
    this.emit(inst, 'starting')

    try {
      const live = useShared ? this.liveShared() : null

      // 差分基线：浏览器的 page 目标 + 桌面上的浏览器窗口。
      // 串行启动保证"新出现的那一个"必然是本格的。
      const beforeTargets = live?.port ? (await listPageTargets(live.port)).map((t) => t.id) : []
      const beforeWindows = new Set(w32.listBrowserWindows().map((w) => w.hwnd))

      // 浏览器没在跑时才动档案：清掉过期端口文件、压制首启 UI、修正上次强杀留下的 Crashed 标记
      if (!live) this.prepareProfile(profileDir)

      let exitCode: number | null = null
      const proc = await this.spawnBrowser(this.buildArgs(ai, profileDir, useShared))
      proc.on('exit', (code) => {
        exitCode = code
      })
      // 成功 spawn 之后再出错的路径也要有人接住，否则又是一个未捕获异常
      proc.on('error', (e) => {
        console.warn('[instance] 浏览器进程出错', e)
      })
      // 共享会话下这次启动只是把命令行交给已在运行的浏览器，子进程会立刻正常退出，
      // 所以不能把退出当失败——真正的判据是"窗口有没有出现"
      proc.unref()

      const win = await this.waitNewWindow(beforeWindows, 45000)
      if (!win) {
        throw new Error(`未找到浏览器窗口${exitCode !== null ? `（启动进程已退出 code ${exitCode}）` : ''}`)
      }
      inst.hwnd = win.hwnd
      inst.pid = win.pid
      this.claimed.add(win.hwnd)
      // 新窗口已就位，现在才关掉旧的那个
      if (previous) this.releaseWindow(previous)

      // 窗口此刻是隐藏的：改扩展样式（任务栏/Alt+Tab 隐藏）必须在隐藏状态下才生效
      w32.makeToolWindow(win.hwnd)
      w32.setOwner(win.hwnd, this.panel.hwnd)
      w32.setTopMost(win.hwnd, this.panel.topMost)

      // 调试端口：共享会话下直接复用，独立档案则等浏览器写出来
      const port = live?.port ?? await this.waitDevToolsPort(profileDir, live ? 1000 : 20000)
      if (port) {
        inst.port = port
        if (useShared) this.shared = { pid: win.pid, port, profileDir, proc }
      }

      // CDP 只是增强（聚焦输入框 / 重载 / 换站点免重开），失败不影响任何主功能
      if (port) await this.attachCdp(inst, beforeTargets)

      this.syncInsets(inst)
      this.positionWindow(inst, true)

      this.emit(inst, 'ready')
      return inst
    }
    catch (e: any) {
      const msg = String(e?.message || e)
      // 新窗口没起来：把旧窗口还回去，至少这一格还是能用的
      if (previous && previous.hwnd && w32.isWindow(previous.hwnd)) {
        this.instances.set(paneId, previous)
        this.emit(previous, 'failed', msg)
        return previous
      }
      this.emit(inst, 'failed', msg)
      return inst
    }
  }

  private buildArgs(ai: AiService, profileDir: string, shared: boolean): string[] {
    const cfg = this.opts.config()
    const windowMode = cfg.windowMode === 'app' ? 'app' : 'standard'
    const args: string[] = [
      `--user-data-dir=${profileDir}`,
      '--profile-directory=Default',
      '--remote-debugging-port=0',
      // 首启 / 推广类 UI 一律压制：分格只是屏幕上的一小块，任何推广气泡都会破坏观感
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,TranslateUI,OptimizationHints,MediaRouter,ChromeWhatsNewUI',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      // 关掉后台网络（含 Google Update 检查）与组件更新，
      // 否则自定义档案下 Chrome 会弹"无法更新"对话框；
      // 同时抑制各类错误对话框，避免误弹窗被当成浏览器主窗口
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--no-service-autorun',
      '--noerrdialogs',
      '--disable-prompt-on-repost',
      '--disable-external-intent-requests',
      // 启动即在屏幕外，避免实例窗口在定位前于屏幕上闪现
      '--window-position=-32000,-32000',
      '--window-size=1000,760',
      // 指纹：只要开了调试端口（我们用 CDP 做聚焦/重载），navigator.webdriver 就是 true，
      // 站点风控与 Google 登录都会看见，所以必须显式关掉。
      // 但光加 --disable-blink-features 会让 Chrome 在页面顶部常驻一条
      // "您使用的是不受支持的命令行标记" 黄色警示条（实测会把内容区从 87px 压到 143px），
      // --test-type 正是用来豁免这条警告的开关——两者必须成对出现。
      // 实测：不加=webdriver true；只加前者=webdriver false 但有警示条；
      //       两者都加=webdriver false 且无警示条。
      '--disable-blink-features=AutomationControlled',
      '--test-type',
    ]

    if (windowMode === 'app') {
      // 应用窗口：无浏览器工具栏，但 display-mode 会变成 standalone，
      // 部分站点（尤其 Google 登录）据此判定为"应用内嵌浏览器"而拒绝。
      args.push(`--app=${ai.url}`)
    }
    else {
      // 标准窗口：display-mode 保持 browser，与用户手动打开浏览器完全一致。
      // 自带工具栏由 SetWindowRgn 从可视区裁掉，视觉上依然是"干净的一张网页"。
      // --new-window 在"浏览器已在运行"的共享会话下正是"再开一个窗口"的开关。
      args.push('--new-window', ai.url)
    }

    // 代理：共享会话下所有分格属于同一个浏览器进程，代理是进程级设置，只能走全局配置
    let proxy = cfg.proxy
    if (!shared) {
      if (ai.proxyMode === 'custom' && ai.proxy) proxy = { ...ai.proxy, mode: ai.proxy.mode }
      else if (ai.proxyMode === 'direct') proxy = { ...cfg.proxy, mode: 'none' }
    }

    const server = buildProxyServerArg(proxy)
    if (server) {
      args.push(`--proxy-server=${server}`)
      args.push(`--proxy-bypass-list=${buildBypassArg(proxy)}`)
    }
    return args
  }

  /** 浏览器已在运行、且进程还活着 */
  private liveShared(): SharedBrowser | null {
    const s = this.shared
    if (!s) return null
    if (!pidAlive(s.pid)) {
      this.shared = null
      return null
    }
    return s
  }

  /**
   * 启动前的档案准备（只在浏览器没运行时调用）。
   * 这些字段都不影响用户自己改过的设置，只是把"分格场景下必定要关掉的东西"关掉。
   */
  /**
   * 启动浏览器进程。
   *
   * 两个必须点：
   * 1. `spawn` 失败是通过 ChildProcess 的 `'error'` 事件上报的，
   *    **没有监听器就是未捕获异常** —— 实测会直接干掉主进程并弹出
   *    "A JavaScript error occurred in the main process / Error: spawn ENOENT"。
   * 2. 浏览器升级会把安装目录整体搬走，缓存下来的 `exePath` 随之失效；
   *    这时必须**重新探测再试一次**，否则用户一升级浏览器，应用就再也起不来了。
   */
  private async spawnBrowser(args: string[]): Promise<ChildProcess> {
    // 路径已经不在时先重新探测，省掉一次必然失败的 spawn
    if (!fs.existsSync(this.opts.browser.exePath)) await this.refreshBrowser()

    try {
      return await this.spawnOnce(this.opts.browser.exePath, args)
    }
    catch (e: any) {
      if (e?.code !== 'ENOENT') throw e
      const fresh = await this.refreshBrowser()
      if (!fresh) {
        throw new Error(`浏览器已不在 ${this.opts.browser.exePath}，重新探测也没找到 Chrome / Edge`)
      }
      return await this.spawnOnce(fresh.exePath, args)
    }
  }

  /** 重新探测浏览器；成功则更新缓存路径，返回最新结果 */
  private async refreshBrowser(): Promise<BrowserInfo | null> {
    if (!this.opts.resolveBrowser) return null
    try {
      const fresh = await this.opts.resolveBrowser()
      if (fresh) {
        if (fresh.exePath !== this.opts.browser.exePath) {
          console.warn(`[instance] 浏览器路径已更新：${this.opts.browser.exePath} → ${fresh.exePath}`)
        }
        this.opts.browser = fresh
      }
      return fresh
    }
    catch (e) {
      console.warn('[instance] 重新探测浏览器失败', e)
      return null
    }
  }

  /** 单次 spawn，把 `error` 事件转换成 promise rejection */
  private spawnOnce(exePath: string, args: string[]): Promise<ChildProcess> {
    return new Promise<ChildProcess>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(exePath, args, { detached: false, stdio: 'ignore', windowsHide: false })
      }
      catch (e) {
        reject(e)
        return
      }
      const onError = (err: NodeJS.ErrnoException) => {
        child.removeListener('spawn', onSpawn)
        reject(err)
      }
      const onSpawn = () => {
        child.removeListener('error', onError)
        resolve(child)
      }
      child.once('error', onError)
      child.once('spawn', onSpawn)
    })
  }

  private prepareProfile(dir: string) {
    try {
      // 上一次运行留下的调试端口文件必须清掉，否则会读到过期端口
      try {
        fs.rmSync(path.join(dir, 'DevToolsActivePort'), { force: true })
      }
      catch {}

      const prefFile = path.join(dir, 'Default', 'Preferences')
      let prefs: any = {}
      if (fs.existsSync(prefFile)) {
        try {
          prefs = JSON.parse(fs.readFileSync(prefFile, 'utf8')) || {}
        }
        catch {
          prefs = {}
        }
      }

      // 翻译必须关：英文站点会弹出"翻译此页？"气泡，
      // 它是**独立的原生顶层窗口**，会浮在分格甚至相邻分格之上
      prefs.translate = { ...(prefs.translate || {}), enabled: false }
      // 已看过欢迎页：压掉首启的"定制你的 Chrome / 登录以同步"引导
      prefs.browser = { ...(prefs.browser || {}), has_seen_welcome_page: true, check_default_browser: false }
      prefs.distribution = { ...(prefs.distribution || {}), skip_first_run_ui: true, make_chrome_default: false }
      // 上次被强杀会留下 Crashed，导致本次启动弹"恢复页面"
      prefs.profile = { ...(prefs.profile || {}), exit_type: 'Normal', exited_cleanly: true }

      fs.mkdirSync(path.dirname(prefFile), { recursive: true })
      fs.writeFileSync(prefFile, JSON.stringify(prefs), 'utf8')

      // ── Local State：Chrome 升级后"重新让你选账号登录"的根因 ──
      //
      // "已看过欢迎页 / 首启已完成"这类标记有一部分不在 Default/Preferences，
      // 而在档案根目录的 Local State 里（对照组：用户真实档案的
      // Local State 带 `profile.picker_shown: true` 与
      // `browser.first_run_finished: true`，我们这份两条都没有）。
      // Chrome 版本一升，缺这些标记就会**重新**弹首启引导 /
      // "谁在使用 Chrome"档案选择器 —— 实测升级到 153 后必现。
      const stateFile = path.join(dir, 'Local State')
      let state: any = {}
      if (fs.existsSync(stateFile)) {
        try {
          state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}
        }
        catch {
          state = {}
        }
      }
      const order = state.profile?.profiles_order
      state.profile = {
        ...(state.profile || {}),
        last_used: 'Default',
        // 只认 Default 一个档案，避免启动时弹"谁在使用 Chrome"选择器
        profiles_order: Array.isArray(order) && order.length ? order : ['Default'],
        picker_shown: true,
      }
      state.browser = {
        ...(state.browser || {}),
        has_seen_welcome_page: true,
        first_run_finished: true,
      }
      state.distribution = { ...(state.distribution || {}), skip_first_run_ui: true }
      fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8')

      // "First Run" 哨兵：Chrome 靠它判断是否仍处于首次运行，缺了它首启 UI 会反复冒出来
      const sentinel = path.join(dir, 'First Run')
      if (!fs.existsSync(sentinel)) fs.writeFileSync(sentinel, '', 'utf8')
    }
    catch (e) {
      console.warn('[instance] prepareProfile failed', e)
    }
  }

  private readDevToolsPort(dir: string): number | null {
    try {
      const content = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/)
      const port = Number(content[0])
      return port > 0 && port < 65535 ? port : null
    }
    catch {
      return null
    }
  }

  private async waitDevToolsPort(dir: string, timeoutMs: number): Promise<number | null> {
    const start = Date.now()
    for (;;) {
      const p = this.readDevToolsPort(dir)
      if (p) return p
      if (Date.now() - start >= timeoutMs) return null
      await sleep(200)
    }
  }

  /**
   * 等待本次启动新出现的浏览器窗口。
   *
   * 判据是"桌面上多了一个装着网页的浏览器窗口"（见 win32.listBrowserWindows），
   * 而不是"某个 pid 的窗口"——共享会话下新窗口属于**已经在运行**的进程，
   * 刚 spawn 的那个子进程只是把命令行交出去就退了，PID 根本对不上。
   */
  private async waitNewWindow(before: Set<number>, timeoutMs: number): Promise<w32.BrowserWindowInfo | null> {
    const start = Date.now()
    for (;;) {
      const fresh = w32.listBrowserWindows()
        .filter((w) => !before.has(w.hwnd) && !this.claimed.has(w.hwnd))
      if (fresh.length) {
        // 极端情况下可能同时冒出多个（浏览器顺带弹出的页面），取面积最大的主窗口
        fresh.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)
        const pick = fresh[0]
        // 立刻藏起来：窗口刚才是可见的，不藏就会在屏幕上闪一下
        w32.showWindow(pick.hwnd, w32.SW_HIDE)
        await sleep(600)
        if (w32.isWindow(pick.hwnd)) return pick
      }
      if (Date.now() - start >= timeoutMs) return null
      await sleep(60)
    }
  }

  /** 接到本格对应的 CDP 目标（新出现的那一个），失败静默降级 */
  private async attachCdp(inst: ManagedInstance, before: string[]) {
    const port = inst.port
    if (!port) return
    for (let i = 0; i < 6; i++) {
      const fresh = (await listPageTargets(port)).find((t) => !before.includes(t.id))
      if (fresh?.webSocketDebuggerUrl) {
        try {
          const cdp = new CdpSession(fresh.webSocketDebuggerUrl)
          await cdp.connect(3000)
          inst.cdp = cdp
          inst.targetId = fresh.id
        }
        catch (e) {
          console.warn('[instance] cdp attach skipped:', e)
        }
        return
      }
      await sleep(400)
    }
  }

  /* ---------------- 几何 ---------------- */

  setRects(rects: Array<{ paneId: string, x: number, y: number, width: number, height: number }>) {
    this.rects.clear()
    for (const r of rects) this.rects.set(r.paneId, { x: r.x, y: r.y, width: r.width, height: r.height })
    this.applyRects()
  }

  /**
   * 展开下拉等 UI 浮层时，让该格的浏览器窗口"让位"。
   *
   * 首选**挖洞**：传入浮层的矩形（分格内容区坐标），把它从浏览器可视区域里减掉，
   * 页面其余部分照旧可见可点，视觉上就相当于下拉浮在网页之上。
   * 拿不到矩形（例如菜单还没渲染出来）时退化为整窗隐藏，保证浮层一定看得见。
   */
  occlude(paneId: string, on: boolean, hole?: { x: number, y: number, width: number, height: number } | null) {
    const inst = this.instances.get(paneId)
    if (!inst) return
    if (on) {
      const usable = !!hole && hole.width >= 4 && hole.height >= 4
      inst.hole = usable ? hole : null
      if (usable) {
        this.occluded.delete(paneId)
        this.applyRect(paneId)
      }
      else {
        this.occluded.add(paneId)
        this.setShown(inst, false)
      }
    }
    else {
      inst.hole = null
      this.occluded.delete(paneId)
      this.applyRect(paneId)
    }
  }

  private applyRects() {
    for (const inst of this.instances.values()) this.applyRect(inst.paneId)
  }

  private applyRect(paneId: string) {
    const inst = this.instances.get(paneId)
    if (!inst) return
    if (!inst.hwnd || !w32.isWindow(inst.hwnd)) return
    // 每次落位都顺手重测一次：用户若在浏览器里打开了书签栏，偏移会变，这样能自动跟上
    this.syncInsets(inst)
    this.positionWindow(inst)
  }

  /**
   * 实测网页内容区的偏移与内衬。
   *
   * 主路径是**原生子窗口**（`Chrome_RenderWidgetHostHWND` 的矩形就是 viewport），
   * 同步、免费、和页面是否加载完无关；
   * 只有它失败时才退回 CDP 的 `outerHeight - innerHeight`，再不行才用兜底值。
   */
  private syncInsets(inst: ManagedInstance) {
    const hwnd = inst.hwnd
    if (!hwnd || !w32.isWindow(hwnd)) return
    const native = w32.chromeContentInsets(hwnd)
    if (native && this.saneInsets(native)) {
      inst.insets = native
      return
    }
    if (inst.insets) return
    inst.insets = FALLBACK_INSETS
  }

  private saneInsets(i: InstanceInsets) {
    return i.left >= 0 && i.left < 60
      && i.top >= 0 && i.top < 400
      && i.right >= 0 && i.right < 60
      && i.bottom >= 0 && i.bottom < 60
  }

  /**
   * 计算实例窗口的几何：
   * 窗口矩形 = 分格内容区向外扩出浏览器自身的 UI 与边框，
   * 再用窗口区域把扩出来的部分裁掉（被裁区域既不绘制也不接收鼠标）。
   */
  private geometry(inst: ManagedInstance) {
    const r = this.rects.get(inst.paneId)
    if (!r) return null
    const s = this.panel.scale || 1
    const ins = inst.insets ?? FALLBACK_INSETS
    const pw = Math.max(1, Math.round(r.width * s))
    const ph = Math.max(1, Math.round(r.height * s))

    return {
      x: Math.round(this.panel.x + r.x * s - ins.left),
      y: Math.round(this.panel.y + r.y * s - ins.top),
      w: Math.max(1, pw + ins.left + ins.right),
      h: Math.max(1, ph + ins.top + ins.bottom),
      region: { x: ins.left, y: ins.top, width: pw, height: ph },
      radius: PANE_RADIUS * s,
      s,
    }
  }

  /** 只定位、不改变期望可见性 */
  private positionWindow(inst: ManagedInstance, desiredVisible?: boolean) {
    if (desiredVisible !== undefined) inst.desiredVisible = desiredVisible
    const hwnd = inst.hwnd
    if (!hwnd || !w32.isWindow(hwnd)) return

    const g = this.geometry(inst)
    const usable = !!g && g.region.width >= 60 && g.region.height >= 60

    if (!usable || !inst.desiredVisible || this.occluded.has(inst.paneId) || this.suppressed) {
      this.setShown(inst, false)
      return
    }

    // 同步移动+改尺寸：跨进程 SetWindowPos 带 ASYNC 会被 Chrome 丢弃（见 win32 注释）
    w32.moveWindowNoClamp(hwnd, g!.x, g!.y, g!.w, g!.h, false)
    // 可视区域 = 内容区 −（可选的）下拉浮层矩形
    const rects = [g!.region]
    if (inst.hole) {
      rects.push({
        x: g!.region.x + inst.hole.x,
        y: g!.region.y + inst.hole.y,
        width: inst.hole.width,
        height: inst.hole.height,
      })
    }
    w32.setWindowRegionRects(hwnd, rects, g!.radius)
    this.setShown(inst, true)
  }

  private setShown(inst: ManagedInstance, visible: boolean) {
    const hwnd = inst.hwnd
    if (!hwnd || !w32.isWindow(hwnd)) return
    if (inst.shown === visible) return
    w32.showWindow(hwnd, visible ? w32.SW_SHOW : w32.SW_HIDE)
    inst.shown = visible
    if (visible) w32.raiseWindow(hwnd, this.panel.topMost)
  }

  /** 面板重新激活后，把实例窗口重新提到面板之上（两者同为置顶层级时顺序会变） */
  raiseAll() {
    for (const inst of this.instances.values()) {
      if (inst.hwnd && inst.shown && w32.isWindow(inst.hwnd)) {
        w32.raiseWindow(inst.hwnd, this.panel.topMost)
      }
    }
  }

  /** 面板置顶状态变化 */
  setTopMost(on: boolean) {
    this.panel.topMost = on
    for (const inst of this.instances.values()) {
      if (inst.hwnd && w32.isWindow(inst.hwnd)) w32.setTopMost(inst.hwnd, on)
    }
  }

  /* ---------------- 交互 ---------------- */

  focus(paneId: string) {
    const inst = this.instances.get(paneId)
    if (!inst?.hwnd) return
    w32.focusWindow(inst.hwnd)
    inst.cdp?.focusInput()
  }

  async reload(paneId: string) {
    const inst = this.instances.get(paneId)
    if (!inst) return
    if (inst.cdp) {
      await inst.cdp.reload()
      return
    }
    // 没有 CDP 时退化成"关掉重开"。共享会话下档案是同一份，登录态不会丢
    await this.restart(paneId)
  }

  /** 面板呼出时把焦点交给第一格，用户可以直接开始输入 */
  async focusAll() {
    const first = Array.from(this.instances.values()).find((i) => i.desiredVisible)
    try {
      await first?.cdp?.focusInput()
    }
    catch {}
  }
  suspend(paneId: string) {
    const inst = this.instances.get(paneId)
    if (!inst?.pid) return
    if (inst.shared) {
      // 共享会话下所有分格在同一个浏览器进程里，挂起进程会把所有分格一起冻住，
      // 所以这里降级为"隐藏窗口"（浏览器继续在后台跑）
      this.hide(paneId)
      return
    }
    if (inst.status !== 'ready') return
    if (w32.suspendProcess(inst.pid)) this.emit(inst, 'suspended')
  }

  resume(paneId: string) {
    const inst = this.instances.get(paneId)
    if (!inst?.pid || inst.status !== 'suspended') return
    if (w32.resumeProcess(inst.pid)) this.emit(inst, 'ready')
  }

  hide(paneId: string) {
    const inst = this.instances.get(paneId)
    if (!inst) return
    inst.desiredVisible = false
    this.setShown(inst, false)
  }

  show(paneId: string) {
    const inst = this.instances.get(paneId)
    if (!inst) return
    inst.desiredVisible = true
    if (!inst.hwnd || !w32.isWindow(inst.hwnd)) return
    this.applyRect(paneId)
  }

  /* ---------------- 关闭 ---------------- */

  /** 关掉本格窗口（共享会话下浏览器进程留着；独立档案模式下进程随之退出） */
  private releaseWindow(inst: ManagedInstance) {
    const hwnd = inst.hwnd
    inst.hwnd = undefined
    inst.shown = false
    inst.cdp = undefined
    inst.targetId = undefined
    if (!hwnd) return
    this.claimed.delete(hwnd)
    // 用 WM_CLOSE 而不是强杀：浏览器会走完整的退出流程，
    // 刚登录写下的 Cookie 才会真正落盘
    if (w32.isWindow(hwnd)) w32.postClose(hwnd)
  }

  kill(paneId: string, remove = true) {
    const inst = this.instances.get(paneId)
    if (!inst) return
    try {
      inst.cdp?.close()
    }
    catch {}
    this.releaseWindow(inst)
    if (!inst.shared && inst.pid) {
      try {
        process.kill(inst.pid)
      }
      catch {}
    }
    if (remove) this.instances.delete(paneId)
  }

  /**
   * 关掉所有分格窗口，但**不强杀**浏览器进程：
   * 窗口全部关闭后浏览器会自己退出，这样档案（含登录态）才是干净落盘的。
   */
  killAll() {
    for (const inst of this.instances.values()) {
      try {
        inst.cdp?.close()
      }
      catch {}
      this.releaseWindow(inst)
    }
    this.instances.clear()
    this.claimed.clear()
    this.shared = null
  }

  /**
   * 关掉所有实例并**等到浏览器进程真正退出**。
   * 换代理 / 换浏览器 / 切换共享会话这些改启动参数的场景必须用它：
   * 新旧进程抢同一个档案会弹"个人资料正在使用中"。
   */
  async shutdownAll(timeoutMs = 6000) {
    const pids: number[] = []
    if (this.shared) pids.push(this.shared.pid)
    for (const inst of this.instances.values()) {
      if (!inst.shared && inst.pid) pids.push(inst.pid)
    }
    this.killAll()
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (pids.every((p) => !pidAlive(p))) return
      await sleep(150)
    }
    for (const p of pids) {
      try {
        process.kill(p)
      }
      catch {}
    }
  }

  openProfileDir(paneId: string) {
    const inst = this.instances.get(paneId)
    if (inst) return inst.profileDir
    return this.opts.config().sharedSession !== false
      ? path.join(this.opts.profilesRoot, SHARED_DIR_NAME)
      : null
  }
}

export async function portInUse(port: number) {
  return new Promise<boolean>((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(true))
    s.once('listening', () => s.close(() => resolve(false)))
    s.listen(port, '127.0.0.1')
  })
}
