import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { screen } from 'electron'
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
  /**
   * 最近一次成功施加的可见区外接矩形（窗口内坐标）。
   * 用于"区域看门狗"判断区域有没有被外部（浏览器自己）改掉。
   */
  regionBox?: { left: number, top: number, right: number, bottom: number } | null
  /**
   * 最近一次成功施加的可见区里，被挖掉的那些小矩形（窗口内坐标）。
   * 外接矩形看不出洞，看门狗只能靠它判断"洞还在不在"。
   */
  holes?: Array<{ left: number, top: number, right: number, bottom: number }>
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

/**
 * 面板分格圆角（CSS 像素），必须与 styles.css 的 --radius-pane 同值。
 * 两个数一起改，否则网页的直角会把面板画的圆角从里面顶掉，看起来像没改。
 */
const PANE_RADIUS = 5
/**
 * 几何核对间隔（毫秒）。
 *
 * 这个值就是"浏览器偷偷改了窗口之后，用户看到异常的最长时间"。
 * 一轮只是几个只读调用：实测 getWindowRect 1.7µs、windowRegionBox 0.6µs、
 * chromeContentInsets 7.8µs，四格满打满算一轮不到 50µs，30ms 一跳等于 0.2% CPU，
 * 换来的是最多两三帧就能把翘出来的一截按回去（原来是 250ms，肉眼能看清）。
 */
const GEOMETRY_WATCH_MS = 30
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
  /** 每格"悬浮 AI 切换器"的矩形（分格内容区坐标），随分格矩形一起从渲染层上报 */
  private anchors = new Map<string, { x: number, y: number, width: number, height: number }>()
  /** 被 UI 浮层临时遮挡的格子（下拉展开时需隐藏原生浏览器窗口） */
  private occluded = new Set<string>()
  /** 面板整体收起时为 true：所有实例窗口强制隐藏，避免收起瞬间闪出 */
  private suppressed = false
  /** 面板正在滑动时为 true：冻结几何校准（见 setSliding） */
  private sliding = false
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
  /** 几何看门狗定时器（见 watchGeometry / verifyGeometry） */
  private geomTimer: NodeJS.Timeout | null = null
  /** 已经就"窗口被外部改掉"告警过的格子，避免每轮都刷日志 */
  private driftLogged = new Set<string>()
  /** 同一格反复被外部改动时的节流（见 verifyGeometry 的防打斗） */
  private repositionGuard = new Map<string, { count: number, since: number }>()
  private loopWarned = new Set<string>()
  /** 每个格子在"刚显示出来"前后的补施定时器（见 settleRegion） */
  private settleTimers = new Map<string, NodeJS.Timeout[]>()
  /** 层级看门狗定时器（见 watchZOrder） */
  private zTimer: NodeJS.Timeout | null = null
  /** 前台窗口事件的退订函数（见 watchForeground → onForeground） */
  private unForeground: (() => void) | null = null

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
    const s = scale || 1
    /**
     * 只在缩放值变化时打一行日志。
     *
     * 为什么值得留：所有"浏览器窗口跑到面板外面"的事故，根子都是
     * 面板原点（DIP）与分格偏移（DIP）混用/漏乘缩放。有这行日志，
     * 直接就能算出期望的物理坐标，不必再靠截图反推（上次排查就是这样熬过来的）。
     */
    if (s !== this.panel.scale) {
      console.log(`[panel] 屏幕缩放 ${s}｜面板原点 DIP(${bounds.x},${bounds.y}) → 物理(${Math.round(bounds.x * s)},${Math.round(bounds.y * s)})`)
    }
    this.panel.x = bounds.x
    this.panel.y = bounds.y
    this.panel.scale = s
    this.panel.hwnd = hwnd
    this.panel.topMost = topMost
    // 几何看门狗：浏览器会偷偷改掉我们的可见区、挪动窗口、重排自己的外壳（见 verifyGeometry）
    this.watchGeometry()
    // 层级看门狗：置顶带里的次序会被系统重排，得盯着（见 enforceZOrder）
    this.watchZOrder()
    // 前台窗口事件：用户一点某个分格，那个浏览器窗口就被抬到面板之上（见 onForeground）
    if (!this.unForeground) this.unForeground = w32.watchForeground((h) => this.onForeground(h))
    for (const inst of this.instances.values()) {
      if (inst.hwnd && w32.isWindow(inst.hwnd)) {
        /**
         * ⚠️ 这里**不能**再 `setOwner(inst.hwnd, panelHwnd)`。
         *
         * owner 关系是硬性的：被拥有的窗口永远画在拥有者之上。面板现在必须反过来压在
         * 浏览器窗口之上（顶栏、悬浮胶囊、下拉菜单都画在面板上，靠面板那层 alpha 让
         * 分格透出网页），owner 一挂上就永远实现不了——点开网页的瞬间面板就会被盖掉。
         *
         * 去掉 owner 的代价：面板隐藏时浏览器窗口不再自动跟着隐藏。这条已经由
         * setSuppressed() 显式兜住了（面板收起会把每一格都 setShown(false)）。
         */
        w32.setTopMost(inst.hwnd, topMost)
      }
    }
    this.applyRects()
    this.enforceZOrder()
  }

  /**
   * 面板位置变化（拖动 / 滑动动画逐帧）时同步实例位置。
   *
   * 这里只重定位、**不重算区域**：窗口的可视区用的是窗口内坐标，整体平移不会
   * 改变它。而 `applyRects()` 会连着做 SetWindowRgn + 排 4 个补偿定时器，
   * 一帧一次的话动画必然掉帧（见 relocateAll）。
   */
  setPanelPosition(x: number, y: number) {
    this.panel.x = x
    this.panel.y = y
    this.relocateAll()
  }

  /**
   * 轻量重定位：把所有已显示的实例窗口按当前面板原点挪过去。
   *
   * 拖动顶栏和滑动动画都是"面板整体平移"，每帧只做这一件事：位置。**不重算区域**
   * （可视区用的是窗口内坐标，平移不改变它）、**不排 settle 定时器**、**不重测内衬**
   * ——那三样才是原来动画掉帧的主因，它们全都只在几何真正变化时才需要。
   *
   * 为什么不用 `BeginDeferWindowPos` 批量提交（理论上能让这些窗口和面板落在同一批）：
   * 实测 `DeferWindowPos` 不接受 `SWP_NOSENDCHANGING`（带上传入直接返回 NULL，
   * 整批失败），而那个标志是防 Chrome 把窄分格钳到 516px 的关键。
   * 换个角度想也没必要——这些同步调用都在同一个 tick 里完成，DWM 下一次合成时
   * 拿到的是全部窗口的新位置，呈现出来就是同帧的。
   */
  relocateAll() {
    for (const inst of this.instances.values()) {
      const hwnd = inst.hwnd
      if (!hwnd || !w32.isWindow(hwnd)) continue
      // 用 desiredVisible 而不是 shown：面板刚呼出时窗口还藏着的，也得先挪到位再亮
      if (!inst.desiredVisible) continue
      const g = this.geometry(inst)
      if (!g) continue
      w32.moveWindowNoClamp(hwnd, g.x, g.y, g.w, g.h, false)
    }
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
      return
    }
    /**
     * 恢复显示走"先挪后亮"的轻量路径。
     *
     * 顺序不能反：这些窗口此刻还停在**收起前的位置**（被 suppressed 挡着，位置没更新过），
     * 先亮出来就会在停靠位闪一下，再被拽到出发位。所以先按新面板原点把它们挪过去，
     * 全部挪完再显示。
     *
     * 也不走 applyRects：那会连带重测内衬、重排 settle 定时器，正好堵在动画起跑线上。
     * 唯一必须走完整定位的是"从没施加过区域"的窗口（新启动就被收起打断的），
     * 少了这一步它的标题栏不会被裁掉。
     */
    this.relocateAll()
    for (const inst of this.instances.values()) {
      if (!inst.desiredVisible) continue
      if (inst.regionBox) this.setShown(inst, true)
      else this.positionWindow(inst, true)
    }
  }

  /**
   * 面板滑动动画的起止通知。
   *
   * 结束时**只补区域、不重定位**：位置在动画里已经逐帧对齐过了，这时再来一次完整
   * 校准（内含重测内衬）只会把窗口再推几像素——用户看到的就是"动画跑完、网页莫名
   * 挪一下"。区域另说：渲染层在动画期间上报的矩形可能带新的挖洞（下拉菜单、
   * 悬浮切换器），那部分必须落到窗口上，所以要补。
   */
  setSliding(on: boolean) {
    if (this.sliding === on) return
    this.sliding = on
    if (!on) this.applyRegionsOnly()
  }

  /** 只重设"可见区"，不动窗口位置 */
  private applyRegionsOnly() {
    for (const inst of this.instances.values()) {
      if (!inst.hwnd || !w32.isWindow(inst.hwnd) || !inst.shown) continue
      const g = this.geometry(inst)
      if (g) this.applyRegion(inst, g)
    }
  }

  get(paneId: string) {
    return this.instances.get(paneId)
  }

  /** 这个窗口句柄是不是某个分格的浏览器窗口（主进程判断"点到面板外面没有"时用） */
  hasWindow(hwnd: number): boolean {
    const h = Number(hwnd)
    if (!h) return false
    for (const inst of this.instances.values()) {
      if (inst.hwnd && Number(inst.hwnd) === h) return true
    }
    return false
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
      // 不设 owner（理由见 setPanel 的长注释）；置顶状态与面板保持一致，
      // 否则面板浮在别的程序之上、网页却被别的程序盖住，只剩一圈黑边。
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

  setRects(rects: Array<{ paneId: string, x: number, y: number, width: number, height: number, anchor?: { x: number, y: number, width: number, height: number } | null }>) {
    this.rects.clear()
    this.anchors.clear()
    for (const r of rects) {
      this.rects.set(r.paneId, { x: r.x, y: r.y, width: r.width, height: r.height })
      // 悬浮切换器（"灵动岛"）那一块要一直从浏览器窗口里挖掉。
      // 存在 map 里而不是实例上：实例可能后于矩形上报才创建。
      if (r.anchor) this.anchors.set(r.paneId, r.anchor)
    }
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
    /**
     * 滑动期间冻结几何校准。
     *
     * `applyRect` 每次都重测浏览器内衬（枚举 Chrome 的子窗口找内容区），量出来的
     * 结果会有几像素的浮动——平时这是好事（用户开了书签栏能自动跟上），但滑动
     * 动画正跑着的时候，一次重测就是一次"网页突然挪了 8px、宽度变了 16px"的抖动。
     * 渲染层在这期间上报的矩形照常收下（下一帧跟随就用新值），只是不做那套重定位。
     * 动画结束后 setSliding(false) 会补一次完整校准。
     */
    if (this.sliding) return
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

    /**
     * ⚠️ 单位：`panel.x/y` 来自 `win.getBounds()`，是 **DIP**（设备无关像素）；
     *    `r.x/y` 来自渲染层 `getBoundingClientRect()`，也按 DIP 计；
     *    而 `SetWindowPos` 要的是**物理像素**，`ins`（窗口内衬）也是物理像素。
     *    所以必须把「面板原点 + 分格偏移」**整体**乘 s 再减内衬。
     *
     * 踩过的坑：早期只把 `r.x * s` 乘了 scale，面板原点却按 DIP 加，
     * 于是这块偏移只在 s == 1 时成立。100% 缩放的机器上一切正常，
     * 一到 110% / 125% / 150% 的机器，浏览器窗口就整体左移 panel.x*(s-1) 像素
     * （实测 2560×1440 @110%：偏了约 170px，用户看到「网页跑到面板外面去了」）。
     */
    return {
      x: Math.round((this.panel.x + r.x) * s - ins.left),
      y: Math.round((this.panel.y + r.y) * s - ins.top),
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
    this.applyRegion(inst, g!)
    this.setShown(inst, true)
    this.settleRegion(inst)
  }

  /**
   * 刚显示出来那一下是区域最容易被顶掉的时候。
   *
   * Chrome 往往在窗口**首次可见**时才给自己的窗口设区域（移动/改尺寸也会触发它
   * 重画自绘边框），正好把刚设好的"裁掉标题栏"切掉。看门狗 500ms 一轮虽能兜住，
   * 但首屏那半秒用户看得见——就是那条盖住顶栏的白带。所以再补几次重施：
   * 时间点取 40/120/320/800ms，够覆盖 Chrome 设区域的那几个时机，又不长期开销。
   */
  private settleRegion(inst: ManagedInstance) {
    const hwnd = inst.hwnd
    if (!hwnd) return
    const old = this.settleTimers.get(inst.paneId)
    if (old) for (const t of old) clearTimeout(t)
    const timers: NodeJS.Timeout[] = []
    for (const ms of [40, 120, 320, 800]) {
      const t = setTimeout(() => {
        if (!w32.isWindow(hwnd) || !inst.shown) return
        const g = this.geometry(inst)
        if (g) this.applyRegion(inst, g)
      }, ms)
      ;(t as { unref?: () => void }).unref?.()
      timers.push(t)
    }
    this.settleTimers.set(inst.paneId, timers)
  }

  /**
   * 施加"可见区"：内容区 −（常驻的悬浮切换器）−（展开中的下拉菜单）。
   *
   * ⚠️ 单位：`hole`/`anchor` 来自渲染层 `getBoundingClientRect()`，是 **DIP**；
   *    `region` 是窗口内坐标的**物理像素**。和 geometry() 是同一类坑——
   *    不乘 s 的话，110%/125% 的机器上洞只挖开了 1/s，
   *    下拉菜单/切换器的右下角会被原生浏览器窗口盖住。
   */
  private applyRegion(inst: ManagedInstance, g: NonNullable<ReturnType<InstanceManager['geometry']>>) {
    const hs = g.s
    const rects = [g.region]
    const push = (h: { x: number, y: number, width: number, height: number } | null | undefined) => {
      if (!h || h.width < 2 || h.height < 2) return
      rects.push({
        x: g.region.x + Math.round(h.x * hs),
        y: g.region.y + Math.round(h.y * hs),
        width: Math.max(1, Math.round(h.width * hs)),
        height: Math.max(1, Math.round(h.height * hs)),
      })
    }
    // 常驻：悬浮在网页上的 AI 切换器（底部不再预留条带，它靠挖洞才看得见）
    push(this.anchors.get(inst.paneId))
    // 临时：展开中的下拉菜单
    push(inst.hole)

    w32.setWindowRegionRects(inst.hwnd!, rects, g.radius)
    // 记账：内容区外接矩形。圆角与内部挖洞都不改变外接矩形，看门狗据此判断是否被改掉。
    inst.regionBox = {
      left: g.region.x,
      top: g.region.y,
      right: g.region.x + g.region.width,
      bottom: g.region.y + g.region.height,
    }
    // 洞单独记账：外接矩形相同、洞没了这种情况，只有逐点判断才看得出来
    inst.holes = rects.slice(1).map((r) => ({
      left: r.x,
      top: r.y,
      right: r.x + r.width,
      bottom: r.y + r.height,
    }))
  }

  /**
   * 几何看门狗的挂载点。
   *
   * 踩过的现场（2026-09-14）：Win11 上顶部控制栏被一块浅灰盖住，完全看不清按钮
   * ——那就是 Chrome 自己的窗口标题栏没被裁掉，直接压在面板上。
   * 本机（Win10 + 软件渲染）Chrome 不给窗口设区域，所以怎么都复现不出来。
   *
   * 结论：定位完不能"设一次就完事"，得持续核对（见 verifyGeometry）。
   */
  private watchGeometry() {
    if (this.geomTimer) return
    this.geomTimer = setInterval(() => this.verifyGeometry(), GEOMETRY_WATCH_MS)
    // 不要因为这个保活定时器把进程钉住
    ;(this.geomTimer as { unref?: () => void }).unref?.()
  }

  /**
   * 逐格核对三件事，任何一件不对就修回去：
   *
   * ① 浏览器"外壳"厚度（内衬）——`chromeContentInsets` 量出来的顶部偏移就是标题栏+工具栏
   *    那一截。这个数**会变**：Chrome 在激活/失活、换皮肤、显示资料气泡时会重新排布
   *    自己的窗口，子窗口位置跟着动。内衬一旦过期，几何就是按旧厚度算的，
   *    窗口位置、要裁掉的高度全都偏——表现正是"点一下网页，顶上冒出一条浏览器的边"。
   * ② 窗口矩形——浏览器自己会挪窗口、改尺寸（Chrome 会按自己的记忆恢复窗口状态，
   *    也会在重排时把宽度钳到最小值）。位置错了就整块内容跟着错位。
   * ③ 可见区（区域）——被外部改掉时，"被裁掉的那截浏览器外壳"就会露出来。
   *
   * 这三样原来只查了③，①② 没人在看：只要浏览器动过窗口而不是动区域，
   * 看门狗就认为"一切正常"。现在合成一轮，代价仍然是几个微秒级的只读调用
   * （实测 getWindowRect 1.7µs、windowRegionBox 0.6µs、chromeContentInsets 7.8µs），
   * 所以间隔可以压到 30ms —— 也就是最多两三帧就能纠正，而不是原来那半秒。
   */
  private verifyGeometry() {
    // 滑动动画期间窗口位置由 relocateAll 逐帧对齐，这里插一脚只会打架
    if (this.sliding) return
    for (const inst of this.instances.values()) {
      const hwnd = inst.hwnd
      if (!hwnd || !inst.regionBox || !w32.isWindow(hwnd)) continue
      if (!inst.shown) {
        /**
         * "该显示却藏着"也要补：分格里的窗口一旦被藏起来，面板那格是透明的，
         * 用户看到的就是桌面上的一块空洞。能走到这里说明没人要它藏
         * （不是收起面板、不是浮层让位、也不是要被清理的格子），那就亮出来。
         */
        if (inst.desiredVisible && !this.occluded.has(inst.paneId) && !this.suppressed) {
          this.positionWindow(inst, true)
        }
        continue
      }
      // 我们记的是"已经显示"，可窗口其实被别人藏掉了（inst.shown 只由本进程维护，
      // 外部的 ShowWindow 我们看不见）。一并补上，否则那一格会一直是个空洞。
      if (!w32.isWindowVisible(hwnd)) {
        if (inst.desiredVisible && !this.occluded.has(inst.paneId) && !this.suppressed) {
          this.positionWindow(inst, true)
        }
        continue
      }

      let rebuild = false

      // ① 内衬变了（浏览器重排了自己的外壳）
      const native = w32.chromeContentInsets(hwnd)
      if (native && this.saneInsets(native)) {
        const cur = inst.insets
        if (!cur
          || Math.abs(cur.top - native.top) > 1 || Math.abs(cur.left - native.left) > 1
          || Math.abs(cur.right - native.right) > 1 || Math.abs(cur.bottom - native.bottom) > 1) {
          if (!this.driftLogged.has(inst.paneId)) {
            this.driftLogged.add(inst.paneId)
            const was = cur ? `${cur.left},${cur.top},${cur.right},${cur.bottom}` : '未测'
            console.warn(`[panel] ${inst.paneId} 的浏览器外壳厚度变了（${was} → ${native.left},${native.top},${native.right},${native.bottom}）→ 已按新厚度重新定位`)
          }
          inst.insets = native
          rebuild = true
        }
      }

      const g = this.geometry(inst)
      if (!g) continue

      // ② 窗口被挪走/改了大小
      if (!rebuild) {
        const rect = w32.getWindowRect(hwnd)
        if (rect && (Math.abs(rect.left - g.x) > 1 || Math.abs(rect.top - g.y) > 1
          || Math.abs((rect.right - rect.left) - g.w) > 1 || Math.abs((rect.bottom - rect.top) - g.h) > 1)) {
          if (!this.driftLogged.has(inst.paneId)) {
            this.driftLogged.add(inst.paneId)
            console.warn(`[panel] ${inst.paneId} 的窗口被外部挪动/缩放（实测 ${rect.left},${rect.top} ${rect.right - rect.left}x${rect.bottom - rect.top}｜期望 ${g.x},${g.y} ${g.w}x${g.h}）→ 已摆回`)
          }
          rebuild = true
        }
      }

      if (rebuild) {
        /**
         * 防打斗：正常情况下一次就摆平。要是某个窗口每轮都对不上，
         * 说明有别的程序在跟我们抢这个窗口——那时候每 30ms 硬掰一次会让它
         * 肉眼可见地抖，还白烧 CPU。修够次数就收手，只保证"别露边"（区域），
         * 位置交给下一次真正的几何变化（切布局、拖面板）去纠正。
         */
        const rec = this.repositionGuard.get(inst.paneId)
        const now = Date.now()
        const cur = !rec || now - rec.since > 5000 ? { count: 0, since: now } : rec
        cur.count += 1
        this.repositionGuard.set(inst.paneId, cur)
        if (cur.count > 20) {
          if (!this.loopWarned.has(inst.paneId)) {
            this.loopWarned.add(inst.paneId)
            console.warn(`[panel] ${inst.paneId} 的窗口反复被外部改动（5 秒内 ${cur.count} 次），停止重复摆位以免抖动`)
          }
          this.applyRegion(inst, g)
          continue
        }
        w32.moveWindowNoClamp(hwnd, g.x, g.y, g.w, g.h, false)
        this.applyRegion(inst, g)
        continue
      }
      this.repositionGuard.delete(inst.paneId)

      // ③ 可见区被改掉
      const box = w32.windowRegionBox(hwnd)
      const w = inst.regionBox!
      const same = !!box
        && Math.abs(box.left - w.left) <= 2 && Math.abs(box.top - w.top) <= 2
        && Math.abs(box.right - w.right) <= 2 && Math.abs(box.bottom - w.bottom) <= 2
      if (same) {
        /**
         * 外接矩形一样，洞也可能没了（切换器胶囊 / 展开中的下拉菜单会被网页盖住）。
         * GetRgnBox 看不出洞，只能拿洞心去问"这个点现在是不是可见"。
         */
        const lost = (inst.holes || []).find((h) => {
          const cx = Math.round((h.left + h.right) / 2)
          const cy = Math.round((h.top + h.bottom) / 2)
          // true = 这个点现在是可见的，也就是洞没了；null = 读不出来，别自作主张重设
          return w32.pointInWindowRegion(hwnd, cx, cy) === true
        })
        if (!lost) continue
        if (!this.driftLogged.has(inst.paneId)) {
          this.driftLogged.add(inst.paneId)
          console.warn(`[panel] ${inst.paneId} 的挖洞被外部抹掉（${lost.left},${lost.top},${lost.right},${lost.bottom}）→ 已重新施加`)
        }
        this.applyRegion(inst, g)
        continue
      }
      if (!this.driftLogged.has(inst.paneId)) {
        this.driftLogged.add(inst.paneId)
        const got = box ? `${box.left},${box.top},${box.right},${box.bottom}` : '无区域'
        console.warn(`[panel] ${inst.paneId} 的窗口可见区被外部改动（实测 ${got}｜期望 ${w.left},${w.top},${w.right},${w.bottom}）→ 已重新施加`)
      }
      this.applyRegion(inst, g)
    }
  }

  /**
   * 退出前的收尾：把两个看门狗、补施定时器和前台事件钩子都拆掉。
   *
   * 之前只定义了停止方法却没人调用（`unForeground` 存了退订函数也没用过），
   * 属于纯死代码；退出流程里显式收一遍，进程能干净结束，
   * 也不会在 killAll 之后还去核对已经不存在的窗口。
   */
  dispose() {
    if (this.geomTimer) {
      clearInterval(this.geomTimer)
      this.geomTimer = null
    }
    if (this.zTimer) {
      clearInterval(this.zTimer)
      this.zTimer = null
    }
    for (const timers of this.settleTimers.values()) for (const t of timers) clearTimeout(t)
    this.settleTimers.clear()
    try {
      this.unForeground?.()
    }
    catch {}
    this.unForeground = null
  }

  private setShown(inst: ManagedInstance, visible: boolean) {
    const hwnd = inst.hwnd
    if (!hwnd || !w32.isWindow(hwnd)) return
    if (inst.shown === visible) return
    w32.showWindow(hwnd, visible ? w32.SW_SHOW : w32.SW_HIDE)
    inst.shown = visible
    // 新显示出来的窗口要提到面板正下方（同为置顶带，次序由我们维护）
    if (visible) {
      w32.raiseWindow(hwnd, this.panel.topMost)
      this.enforceZOrder()
    }
  }

  /**
   * 面板重新激活后把层级理一遍。
   *
   * 置顶带内的次序会被系统重排（用户点网页 → 那个浏览器窗口被提到带顶 →
   * 面板被压下去 → 顶栏又被浏览器标题栏盖住），所以每次面板被激活都要把
   * 浏览器窗口按回面板下方。
   */
  raiseAll() {
    this.enforceZOrder()
  }

  /**
   * 层级看门狗。
   *
   * 面板和浏览器窗口现在**同一个置顶带**（这样别的程序既盖不住面板、也盖不住
   * 网页，不会出现"面板浮着、网页被盖住只剩黑边"的分裂观感）。但同一带里，
   * 系统会依照激活顺序重排次序：任何一次点击网页、切分格、切站点，都可能把某个
   * 浏览器窗口顶到带顶，那一瞬间它就会盖住面板顶栏。
   *
   * 修法不是"事后补救"，而是持续维持——每 200ms 检查一次面板上面有没有自己的
   * 浏览器窗口，有就按回去。纯查询的开销可以忽略，只有真的错了才动 Z 序，
   * 所以不会打断用户操作、也不会闪。
   *
   * 间隔取 200ms：这个值就是"点了网页之后顶栏被浏览器标题栏盖住"的最长历时。
   * 再短收益不大（人眼在那几十毫秒里看不出差别），再长就开始能被察觉了。
   */
  private watchZOrder() {
    if (this.zTimer) return
    const t = setInterval(() => this.enforceZOrder(), 200)
    ;(t as { unref?: () => void }).unref?.()
    this.zTimer = t
  }

  /**
   * 前台窗口变了（事件驱动，由 `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` 投递）。
   *
   * 用户点某一个分格里的网页时，系统会做两件事：把这个浏览器窗口提到置顶带顶端
   * （= 浮到面板之上），并且很可能顺手把它的窗口区域重设一遍——而我们正是靠那个
   * 区域把浏览器的标签栏 / 工具栏从可视区裁掉的。两件事叠起来的后果：
   *   · 第一行分格（1 / 2 格布局）被抬上去的那截正好压在顶栏 → 顶栏闪一下白；
   *   · 第二行分格（4 格布局里的 3 / 4）压在它**上一格**的底部 → 那块既没画网页
   *     也没画面板（面板在分格处是透明的），看上去就是一块透明区域。
   *
   * 轮询看门狗只能把这件事在 200ms 内纠正回来，那半帧是看得见的；
   * 这条回调在**前台切换的那一刻**就把落下的活补完。
   *
   * 代价可以忽略：一次前台变化才跑一次，而且只在真的压到自己的窗口时才动 Win32。
   */
  private onForeground(hwnd: number) {
    if (!this.panel.hwnd) return
    const mine = Array.from(this.instances.values()).filter(
      (i) => i.shown && i.hwnd && Number(i.hwnd) === hwnd,
    )
    if (!mine.length) {
      // 前台跑到别处去了（可能是别的程序、也可能是面板自己）。
      // 那一刻没有谁刚爬到面板上面，只顺手把整体次序收一遍。
      this.enforceZOrder()
      return
    }
    try {
      for (const inst of mine) {
        this.syncInsets(inst)
        const g = this.geometry(inst)
        if (!g) continue
        // 位置 + 区域同一帧补回去：激活会触发 Chrome 自己重画边框，
        // 那时它很可能顺手把宽度钳回最小值（窄分格尤其明显）。
        w32.moveWindowNoClamp(inst.hwnd!, g.x, g.y, g.w, g.h, false)
        this.applyRegion(inst, g)
      }
      this.enforceZOrder()
    }
    catch (e) {
      console.warn('[instance] 处理前台变化时出错', e)
    }
  }

  /** 把落在面板之上的实例窗口按回面板下方 */
  private enforceZOrder() {
    const ph = this.panel.hwnd
    if (!ph || !w32.isWindow(ph)) return
    const mine = new Set<number>()
    for (const inst of this.instances.values()) {
      if (inst.hwnd && inst.shown && w32.isWindow(inst.hwnd)) mine.add(inst.hwnd)
    }
    if (!mine.size) return

    // 从 Z 序最顶层往下走，遇到面板之前碰到自己的窗口，就说明它跑到面板上面了
    const above: number[] = []
    let h = w32.getTopWindow()
    let guard = 0
    while (h && h !== ph && guard++ < 5000) {
      if (mine.has(h)) above.push(h)
      h = w32.getWindow(h, w32.GW_HWNDNEXT)
    }
    if (!above.length) return
    // 从最靠下的开始按，最后按的离面板最近，最终次序与插入顺序一致
    for (let i = above.length - 1; i >= 0; i--) w32.placeBelow(above[i], ph)
  }

  /**
   * 鼠标是否落在某个**已就位**的分格上（坐标取 DIP 屏幕坐标系）。
   *
   * 用途只有一个：面板显示的那一瞬间，主进程要靠它决定面板的初始鼠标穿透状态。
   * 之后再靠渲染层的 mousemove 逐帧修正——主进程收不到鼠标移动，只能算这一下。
   */
  cursorOverPane(): boolean {
    let pt: { x: number, y: number }
    try {
      pt = screen.getCursorScreenPoint()
    }
    catch {
      return false
    }
    const px = this.panel.x
    const py = this.panel.y
    for (const inst of this.instances.values()) {
      if (!inst.shown) continue
      const r = this.rects.get(inst.paneId)
      if (!r) continue
      if (pt.x >= px + r.x && pt.x < px + r.x + r.width && pt.y >= py + r.y && pt.y < py + r.y + r.height) return true
    }
    return false
  }

  /**
   * 面板置顶状态变化。
   *
   * 浏览器窗口跟着一起走，两者始终同一层级——这是"整体一块"的观感来源：
   * 置顶时任何程序都盖不住面板也盖不住网页；不置顶时两者一起让开。
   * 只让面板置顶会让两者分裂，用户看到的就是"黑边浮在最上面、网页被别的程序盖住"。
   */
  setTopMost(on: boolean) {
    this.panel.topMost = on
    for (const inst of this.instances.values()) {
      if (inst.hwnd && w32.isWindow(inst.hwnd)) w32.setTopMost(inst.hwnd, on)
    }
    this.enforceZOrder()
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
    if (!inst) return
    /**
     * 冻不了的情况（共享会话 / 还没起来 / 拿不到进程）一律降级为"隐藏窗口"。
     * 这里不能只是 return：切布局时 syncInstances 靠它把不再显示的分格收起来，
     * 一旦什么都不做，浏览器窗口就留在屏幕上变成孤儿窗口。
     */
    if (inst.shared || !inst.pid || inst.status !== 'ready') {
      this.hide(paneId)
      return
    }
    // 共享会话下所有分格在同一个浏览器进程里，挂起进程会把所有分格一起冻住
    if (w32.suspendProcess(inst.pid)) this.emit(inst, 'suspended')
    else this.hide(paneId)
  }

  resume(paneId: string) {
    const inst = this.instances.get(paneId)
    if (!inst?.pid || inst.status !== 'suspended') return
    if (w32.resumeProcess(inst.pid)) this.emit(inst, 'ready')
  }

  /**
   * 把所有处于"休眠"（进程被挂起）的实例解冻。
   *
   * 退出前必须做一次：挂起的进程收不到 `WM_CLOSE`，窗口不会自己走退出流程，
   * 只能等兜底超时强杀，档案里的登录态就有写不完整的风险。见 killAll 的注释。
   */
  resumeAll() {
    for (const inst of this.instances.values()) {
      if (inst.status !== 'suspended' || !inst.pid) continue
      // 解冻只是让进程能处理消息，不改"这一格该不该显示"
      if (w32.resumeProcess(inst.pid)) this.emit(inst, 'ready')
    }
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
    /**
     * 被冻住的实例必须先解冻。
     *
     * `suspend()` 是用 `NtSuspendProcess` 把浏览器进程的所有线程停住（"后台分格休眠"），
     * 这种进程收不到 `WM_CLOSE`——消息泵本身停了，窗口不会走退出流程，
     * 于是这里只能等 `shutdownAll` 的兜底超时（6 秒）再强杀，Cookie / Local Storage
     * 这类"退出时才落盘"的东西就有丢掉的风险。
     * 先 resume 一下，它们就能正常优雅退出。
     */
    this.resumeAll()
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
