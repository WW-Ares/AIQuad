import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, shell, Tray } from 'electron'
import { normalizeAccelerator } from './accelerator'
import { ConfigStore } from './config'
import { detectBrowsers, pickBrowser, type BrowserInfo } from './browser-detect'
import { InstanceManager } from './instance-manager'
import { getSystemProxy, profilesRoot, testProxy } from './proxy'
import { waitForNetworkReady, type StartupGateTarget } from './startup-gate'
import { clearProfileCache, clearProfileCacheSync, humanSize, scanProfileCache, type CacheCleanResult, type CacheStat } from './cache-cleaner'
import { isQuittingForUpdate, updater } from './updater'
import * as w32 from './win32'
import type { AppConfig, LayoutId, PaneRect } from './types'
import { AUTO_CLEAN_THRESHOLD_BYTES } from './types'
import { installFileLog } from './log'

let config: ConfigStore
let manager: InstanceManager | null = null
let panelWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let tray: Tray | null = null
let browserInfo: BrowserInfo | null = null
let isQuitting = false

/** 写在登录项命令行里的标记：把「开机自启」和「手动双击」区分开 */
const AUTOSTART_ARG = '--aiquad-autostart=1'
let startupGatePending = false
let startupGateInterrupted = false
let wakeStartupGate: (() => void) | null = null

/**
 * 把主进程日志复制一份到 <userData>/logs/main.log。
 *
 * 打包后的安装版**没有控制台**，主进程的 console.* 哪都不去 ——
 * "链接拦截器没装上"这类降级路径用户与开发者都看不见。
 * 见 log.ts 的说明；写日志失败一律静默，不影响主流程。
 */
try {
  installFileLog(app.getPath('userData'))
}
catch {}

// 最后一道防线。主进程里任何未捕获异常，Electron 都会弹一个原生错误框
// "A JavaScript error occurred in the main process"，用户只能点"确定"——
// 实测被这条弹框坑过一次（浏览器升级后附带的 spawn ENOENT）。
// 记日志并继续运行，怎么都比整个应用崩掉好。
process.on('uncaughtException', (err) => {
  console.error('[AIQuad] 未捕获异常（已拦下，应用继续运行）:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[AIQuad] 未处理的 Promise 拒绝:', reason)
})

const layoutCount: Record<LayoutId, number> = { '1': 1, '2': 2, '4': 4 }

function rendererFile(name: string) {
  return path.join(__dirname, '..', '..', 'src', 'renderer', name)
}

function appIcon() {
  return path.join(__dirname, '..', '..', 'src', 'renderer', 'icon.ico')
}

function scaleOf(win: BrowserWindow) {
  try {
    return screen.getDisplayMatching(win.getBounds()).scaleFactor || 1
  }
  catch {
    return 1
  }
}

function hwndOf(win: BrowserWindow) {
  try {
    return w32.parseHwnd(win.getNativeWindowHandle())
  }
  catch {
    return 0
  }
}

/** 把面板窗口的位置/缩放/置顶状态同步给实例管理器 */
function syncPanelToManager() {
  if (!manager || !panelWindow || panelWindow.isDestroyed()) return
  const b = panelWindow.getBounds()
  manager.setPanel({ x: b.x, y: b.y }, scaleOf(panelWindow), hwndOf(panelWindow), topMostWanted())
}

/**
 * 面板要不要置顶，现在是**用户的选择**（顶栏那个图钉开关 / 设置页的开关）。
 *
 * 早先写死为 true，理由是"面板必须压住浏览器窗口，否则顶栏会被浏览器的工具栏盖掉"。
 * 那句只对了一半：真正压得住的是**同带内的相对次序**，由 Z 序看门狗维持，
 * 与"是否属于置顶层"无关。关掉置顶之后面板仍在浏览器窗口之上，
 * 只是和别的程序一样可以被别的窗口盖住——这正是用户想要的效果。
 */
function topMostWanted(): boolean {
  return config?.get().alwaysOnTop !== false
}

/* ---------------- 面板尺寸计算（贴屏幕左/右，占屏宽比例，全高） ---------------- */

function targetBounds() {
  const cfg = config.get()
  const display = screen.getPrimaryDisplay()
  const wa = display.workArea
  const width = Math.max(320, Math.round(wa.width * cfg.windowWidthRatio))
  const height = wa.height
  const x = cfg.position === 'left' ? wa.x : wa.x + wa.width - width
  return { x, y: wa.y, width, height }
}

/** 面板完全移出屏幕后的横向坐标 */
function offscreenX(bounds: { x: number; width: number }) {
  return config.get().position === 'left' ? bounds.x - bounds.width : bounds.x + bounds.width
}

/* ---------------- 滑动动画（子窗口随父窗口移动，无需额外同步） ---------------- */

let animTimer: NodeJS.Timeout | null = null

/**
 * 是否正在滑动。
 *
 * 滑动期间面板的 `move` 事件也会逐帧触发，如果那条路再同步一次位置，就是
 * 一帧两次批量移动，白白加倍开销还可能互相踩；所以这段时间由 slideTo 独占。
 */
let animating = false

/**
 * 当前动画的收尾回调。
 *
 * `done` 在动画**正常跑完**时调用，`abort` 在动画**被下一次滑动打断**时调用。
 * 分成两路是必须的：showPanel 的收尾（校准穿透、摘任务栏、通知渲染层）被打断时
 * 也得补一次（否则面板停在算错的穿透状态，表现为"呼出后几秒点不动"）；
 * 而 hidePanel 的收尾（`win.hide()`）**绝不能**在呼出过程中被补跑——
 * 它会把刚滑进来的面板又藏起来。所以只有声明了 `abort` 的调用才会被补。
 */
let animSettle: { done: () => void, abort?: () => void } | null = null

/** 只停机、不触发任何收尾（强制打断 / 退出流程用） */
function stopAnim() {
  if (animTimer) {
    clearTimeout(animTimer)
    animTimer = null
  }
  animating = false
  animSettle = null
}

/** 停机并按原因触发收尾：被打断走 `abort`，正常结束走 `done` */
function settleAnim(interrupted: boolean) {
  const s = animSettle
  stopAnim()
  if (!s) return
  if (interrupted) s.abort?.()
  else s.done()
}

/**
 * 收起动画结束后、把面板挪回停靠位的那个延迟任务。
 *
 * 它是在**动画结束之后**才排的，那时 `animTimer` 已经清空，`stopAnim()` 管不到它。
 * 如果你在收起后 180ms 内又呼出面板，这个任务会照旧触发，把正在滑入的面板
 * 瞬移回停靠位——呼出动画跑到一半被拽回去。所以 `showPanel()` 里必须能取消它。
 */
let hideSettleTimer: NodeJS.Timeout | null = null

function cancelHideSettle() {
  if (hideSettleTimer) {
    clearTimeout(hideSettleTimer)
    hideSettleTimer = null
  }
}

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

/**
 * 上一次真正下发给窗口的穿透值，`null` 表示"还没下发过"。
 *
 * `slideTo` 会**逐帧**精算穿透（见 slideTo 的 trackPassthrough），值没变时再调一次
 * `setIgnoreMouseEvents` 纯属白费；渲染层的上报也走这一个记账，否则两边会把对方
 * 刚设好的值当成"变了"再设一遍。
 */
let lastThrough: boolean | null = null

/**
 * 指针是不是压在面板的"顶栏带"上（面板顶边 → 第一行分格的上沿）。
 *
 * 这条带子里只有面板自己的 UI：品牌区、图标按钮、拖动热区。**任何情况下都不许穿透**
 * —— 面板一旦在那上面保持穿透，点"收起 / 置顶 / 设置"的点击就会直接落到下面的窗口上，
 * 而那个位置通常正好是别的程序的 ✕ / 最大化 / 最小化按钮（面板贴着屏幕右上角，
 * 用户的窗口往往也是最大化的），于是"点一下收起，把人家正在编辑的窗口关了"。
 *
 * 判据只用**几何事实**：顶栏带的坐标来自分格矩形（渲染层量出来的 DOM 矩形），
 * 指针位置取自 `screen.getCursorScreenPoint()`。两边都是主进程手上的即时值，
 * 不经过渲染层的 `elementFromPoint`，所以不受"转发鼠标消息坐标算偏"的影响。
 *
 * 返回 false 的情况（一律不设防）：面板没显示、还没收到分格矩形、拿不到指针位置。
 * 宁可漏一次，也不要因为判据出错把网页区也锁死 —— 那是"呼出后点不动"这类老毛病。
 */
function cursorInChromeBand(): boolean {
  if (!panelWindow || panelWindow.isDestroyed() || !panelWindow.isVisible()) return false
  const band = manager?.paneTopBand() ?? 0
  if (!band) return false
  let pt: { x: number, y: number }
  let b: { x: number, y: number, width: number, height: number }
  try {
    pt = screen.getCursorScreenPoint()
    b = panelWindow.getBounds()
  }
  catch {
    return false
  }
  return pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + band
}

/**
 * 顶栏带上的"永不穿透"保险巡逻（25ms）。
 *
 * `setThrough` 里那道判断只在**有人改穿透状态时**才生效；万一状态早就停在 `true`
 * （指针刚才在网页上），之后渲染层再也没纠正过（转发消息丢了、坐标算偏、渲染进程忙），
 * 面板就会一直穿透下去。这条巡逻补的就是"没人再来纠正"这一种：
 * 只要指针进了顶栏带，就把穿透收回面板。
 *
 * 只做单向纠正（true → false）：反过来（在网页上强制 false）会直接撞上"点不动网页"，
 * 那条路仍然只由渲染层的 `elementFromPoint` 决定（它还得区分悬浮胶囊和下拉菜单）。
 */
let chromeGuardTimer: NodeJS.Timeout | null = null

/**
 * 负向对照开关（只给回归脚本用）：关掉顶栏带的硬保险。
 *
 * 有它，`scripts/verify-chrome-guard.js` 才能自证"测的不是空气"——同一个点击，
 * 关掉保险时必须穿透过去（面板不收起），开着时必须被面板收下。没有这条对照，
 * 脚本报绿也可能只是"本来就不会穿透"。
 * 与 `AIQUAD_TEST_KEEP_FRAME` / `AIQUAD_TEST_KEEP_BACKDROP` 同一套约定。
 */
const CHROME_GUARD_OFF = process.env.AIQUAD_TEST_NO_CHROME_GUARD === '1'

function startChromeGuard() {
  if (CHROME_GUARD_OFF) return
  if (chromeGuardTimer) return
  chromeGuardTimer = setInterval(() => {
    // 绝大多时候面板是不穿透的，先看这个最便宜的判断，别每 25ms 去问一次系统
    if (lastThrough !== true) return
    if (!panelWindow || panelWindow.isDestroyed()) return
    if (!cursorInChromeBand()) return
    console.log('[passthrough] 指针在顶栏带上，强制收回穿透（否则点击会落到下面的窗口）')
    setThrough(panelWindow, false)
    // 渲染层缓存里还是 true，不让它作废的话指针走回网页时它不会再上报（见 invalidateRendererPassthrough）
    invalidateRendererPassthrough(panelWindow)
  }, 25)
  chromeGuardTimer.unref?.()
}

function stopChromeGuard() {
  if (!chromeGuardTimer) return
  clearInterval(chromeGuardTimer)
  chromeGuardTimer = null
}

/**
 * 让渲染层的穿透缓存作废（它下个 `mousemove` 会重新算一遍并上报）。
 *
 * 为什么必须有这一步：渲染层只在**翻转**时才发 IPC（`if (through === passthrough) return`）。
 * 主进程这边一旦不打招呼地把值改成 `false`（顶栏带保险），渲染层手上还记着 `true`，
 * 指针走回网页时它会认为"值没变"而**一声不响**，面板于是永远保持不穿透 ——
 * 那正好是老毛病"网页点不动"。发这一条等于告诉它"你手上的不作数了"。
 *
 * 与 `panel-shown` 里那句 `passthrough = null` 是同一套约定（那边也是只作废、不主动上报）。
 */
function invalidateRendererPassthrough(win: BrowserWindow) {
  try {
    win.webContents.send('passthrough-reset')
  }
  catch {}
}

function setThrough(win: BrowserWindow, through: boolean) {
  /**
   * ⚠️ 顶栏带上**永远**不穿透，这一句是硬保险，别删。
   *
   * 所有设置穿透的路径（渲染层 IPC、呼出动画逐帧精算、收尾校准）最后都汇到这里，
   * 在这里判一次等于给每条路都上了锁。起因见 `cursorInChromeBand` 的说明：
   * 渲染层算错的后果不是"按钮点不动"，而是**把点击送给下面那个程序**。
   */
  let overridden = false
  if (through && !CHROME_GUARD_OFF && cursorInChromeBand()) {
    through = false
    overridden = true
  }
  if (through === lastThrough) return
  lastThrough = through
  try {
    win.setIgnoreMouseEvents(through, { forward: true })
  }
  catch {
    // 窗口正在销毁时 setIgnoreMouseEvents 会抛，忽略即可
  }
  // 被保险挡回去的那一次要通知渲染层作废缓存，否则它会以为"还是穿透"而不再上报
  if (overridden) invalidateRendererPassthrough(win)
}

/**
 * 按指针当前位置刷新面板的鼠标穿透状态。
 *
 * 指针停在分格（网页）上就穿透，让点击落到下面的浏览器窗口；
 * 停在顶栏 / 中缝 / 悬浮胶囊上就不穿透，让面板自己收下点击。
 *
 * `origin` 是"按哪个位置算分格"，见 `cursorOverPane`。呼出动画期间必须逐帧传当前原点，
 * 否则算出来的永远是"鼠标不在分格上"（因为面板自己还在屏幕外，分格跟着它一起在屏幕外）。
 */
function applyPassthrough(win: BrowserWindow, origin?: { x: number, y: number }) {
  if (!win || win.isDestroyed()) return
  setThrough(win, !!manager?.cursorOverPane(origin))
}

/**
 * 横向滑动动画。
 *
 * 关键点是**每一帧都带着浏览器窗口一起走**：面板和分格里的原生浏览器窗口是两个
 * 互不相干的顶级窗口，面板自己动、网页不动，看到的就是"面板滑进来、内容晚一拍
 * 才出现"的断层。这里每帧把当前 x 交给实例管理器，由它用一次批量提交把面板和
 * 所有分格窗口放到同一帧里。
 *
 * 帧间隔取 8ms 而不是 16ms：Windows 的定时器精度本来就在 15.6ms 上下跳，
 * 按 16ms 排会稳定掉到 ~30fps；给密一点，实际落到 60fps 附近更稳。
 */
function slideTo(
  fromX: number,
  toX: number,
  bounds: { y: number; width: number; height: number },
  duration: number,
  onDone?: () => void,
  onAbort?: () => void,
  /** 呼出用 true：滑动过程中逐帧精算穿透（见 step 里的说明） */
  trackPassthrough = false,
) {
  // 打断上一次滑动：它若声明了"被打断也要收尾"，就在这里补上（见 animSettle）
  settleAnim(true)
  animating = true
  animSettle = (onDone || onAbort) ? { done: onDone ?? (() => {}), abort: onAbort } : null
  // 滑动期间冻结几何校准，否则内衬重测带来的几像素抖动会一路干扰动画（见 setSliding）
  manager?.setSliding(true)
  const started = Date.now()
  const step = () => {
    if (!panelWindow || panelWindow.isDestroyed()) {
      // 窗口都没了，收尾按"被打断"处理（回调里自带 isDestroyed 守卫）
      manager?.setSliding(false)
      settleAnim(true)
      return
    }
    const t = Math.min(1, (Date.now() - started) / duration)
    const x = Math.round(fromX + (toX - fromX) * easeInOutCubic(t))
    panelWindow.setBounds({ x, y: bounds.y, width: bounds.width, height: bounds.height })
    // 面板的新位置立刻交给浏览器窗口，同帧移动
    manager?.setPanelPosition(x, bounds.y)
    /**
     * 呼出动画期间**逐帧**精算穿透。
     *
     * 面板是从屏幕外滑进来的，所以"按面板实时位置算"的结果会自然地从
     * 「鼠标不在分格上」过渡到「在」，恰好等于用户看到的事实：分格还没滑到指针底下时
     * 先不穿透（免得点击穿透到下面那个无关程序），滑到了立刻穿透（这一下要落到网页上）。
     *
     * 不逐帧算、只等动画结束后的收尾纠正一次的话，实测要等到 **+338ms** 才变对，
     * 手指快一点的第一下点击正好落在错窗里，表现就是"呼出后第一下点不动"。
     */
    if (trackPassthrough) applyPassthrough(panelWindow, { x, y: bounds.y })
    if (t >= 1) {
      // 先解除冻结（会补一次完整校准），再交给收尾逻辑
      manager?.setSliding(false)
      settleAnim(false)
      return
    }
    animTimer = setTimeout(step, 8)
  }
  step()
}

/* ---------------- 面板窗口 ---------------- */

function applyAlwaysOnTop() {
  const on = topMostWanted()
  panelWindow?.setAlwaysOnTop(on)
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.setAlwaysOnTop(on)
  manager?.setTopMost(on)
  manager?.raiseAll()
}

function createPanelWindow() {
  const cfg = config.get()
  const b = targetBounds()

  // 新窗口的初始穿透状态是"不穿透"，记账跟着归零，免得沿用上一个窗口的值而漏下发
  lastThrough = null

  panelWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 320,
    minHeight: 420,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    /**
     * 面板必须**始终**置顶，且**不透明部分靠渲染层的 alpha**。
     *
     * 为什么（2026-09-14，Win11 那一台的真实事故）：
     * Win11 上 Chromium 的窗口带 `WS_EX_NOREDIRECTIONBITMAP`，内容由 DirectComposition
     * 交换链直接合成，**DWM 合成时会忽略 GDI 的 `SetWindowRgn` 区域**——
     * 于是"把浏览器自带的标题栏/工具栏从可视区裁掉"这件事只在命中测试上生效
     * （点是点得到的），画面上却照旧显示，浏览器那 96px 高的浅色标题栏整条压在面板顶栏上，
     * 顶栏和下拉菜单都成了"看得见位置、点得着、但读不出内容"的白块。
     *
     * 结论：不能再指望"裁浏览器窗口"这条视觉路径。改成
     *   ① 面板整窗 `transparent`——分格处渲染层输出 alpha=0，这是**合成器通道**，
     *      不受 GDI 区域限制，浏览器窗口从透明处自然透出；
     *   ② 面板**置顶**——顶栏/悬浮胶囊/下拉菜单都画在面板上，压住浏览器窗口，天然可见；
     *   ③ 面板窗口再叠一层 `SetWindowRgn` 把分格挖掉——**只为了输入穿透**
     *      （视觉上失效没关系，命中测试用的就是它）。
     * 视觉靠 alpha、输入靠区域，两条路各自绕开对方的短处。
     */
    transparent: true,
    hasShadow: false,
    // 置顶与否由开关决定（见 topMostWanted）。默认值 true 沿用老行为
    alwaysOnTop: cfg.alwaysOnTop !== false,
    backgroundColor: '#00000000',
    title: 'AIQuad',
    /**
     * 面板是常驻托盘的工具窗口，不该在任务栏占一个按钮。
     * Windows 上 `skipTaskbar` 会带 `WS_EX_TOOLWINDOW`，任务栏和 Alt+Tab 里都不会出现，
     * 只在右下角托盘留图标 —— 就是"呼出时无痕"的观感。
     * 浏览器实例窗口早就是这么做的，面板漏了。
     */
    skipTaskbar: true,
    icon: appIcon(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /**
       * 关掉后台节流。这是"收纳后再呼出偶尔卡住"的根治（2026-09-15）。
       *
       * 面板 `hide()` 之后页面进入 hidden 态，Chromium 会对它做 intensive
       * throttling：`setTimeout` 被对齐到 1 分钟一次，`requestAnimationFrame`
       * **完全停止**。渲染层里 `reportRects` 的延迟上报（120ms 那个 timer）和
       * 依赖 rAF 的重绘就都停摆了。于是呼出来的时候，主进程拿到的还是收起前的
       * 分格矩形，落位和 UI 停在旧状态，看起来就是"卡住"；
       * 而"切一下 AI 再切回来"会强制触发一次上报 + 重绘，卡死状态被打破——
       * 症状完全对得上。
       *
       * 关掉之后面板即使隐藏也照常跑 timer 和 rAF，呼出即可用。
       * 代价是收起期间渲染层仍会执行（面板 UI 是纯本地 DOM，开销可忽略）。
       */
      backgroundThrottling: false,
    },
  })
  Menu.setApplicationMenu(null)
  /**
   * 面板要真的"无痕"，还得自己补一步。
   *
   * Electron 的 `skipTaskbar: true` 只把窗口从**任务栏**摘掉（内部走
   * `ITaskbarList::DeleteTab`），**Alt+Tab 里仍然挂着**。要连 Alt+Tab 一起消失，
   * 只能把窗口标成 `WS_EX_TOOLWINDOW`。
   * 时机很关键：该样式在窗口**可见时改动不生效**，而这里刚 new 出来还是
   * `show:false` 的隐藏态，正好是唯一能改的窗口期——所以放在加载页面之前。
   */
  const panelHwnd = hwndOf(panelWindow)
  if (panelHwnd) w32.makeToolWindow(panelHwnd)
  panelWindow.loadFile(rendererFile('main.html'))

  panelWindow.on('resize', () => {
    syncPanelToManager()
    panelWindow?.webContents.send('request-rects')
  })
  /**
   * 实例窗口是独立顶级窗口（不是子窗口），面板移动时必须主动同步它们的位置。
   *
   * 拖动顶栏时这条就是逐帧跟随；滑动动画期间则跳过——那段时间位置由 slideTo
   * 每帧直接推送，两条路并行只会重复劳动。
   */
  let moveTimer: NodeJS.Timeout | null = null
  const onMove = () => {
    if (animating) return
    if (manager && panelWindow && !panelWindow.isDestroyed()) {
      const nb = panelWindow.getBounds()
      // 只重定位不重算区域：平移不改变窗口内坐标，一帧一次全量重算会直接拖垮动画
      manager.setPanelPosition(nb.x, nb.y)
    }
    if (moveTimer) clearTimeout(moveTimer)
    moveTimer = setTimeout(() => {
      moveTimer = null
      // 落位后再校准一次（缩放/置顶等状态），不请求 rects——位置变化不影响窗口内几何
      syncPanelToManager()
    }, 220)
  }
  panelWindow.on('move', onMove)
  panelWindow.on('moved', onMove)
  // 面板被激活后把层级理一遍：置顶带里的次序会被系统重排，浏览器窗口可能压到面板上
  panelWindow.on('focus', () => manager?.raiseAll())
  panelWindow.on('closed', () => {
    stopChromeGuard()
    panelWindow = null
  })
  // 关闭（无边框窗口没有系统关闭键，兜底）→ 收到托盘
  panelWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      hidePanel()
    }
  })

  return panelWindow
}

function showPanel() {
  // 可能是收起后 180ms 内又呼出：先取消那个"把面板挪回停靠位"的延迟任务
  cancelHideSettle()
  if (!panelWindow) createPanelWindow()
  const win = panelWindow!
  const b = targetBounds()
  const offX = offscreenX(b)

  // 先把窗口放到屏幕外，再滑入，避免出现"闪一下"
  win.setBounds({ x: offX, y: b.y, width: b.width, height: b.height })
  /**
   * 每次显示前都要补一次 WS_EX_TOOLWINDOW。
   *
   * `transparent: true` 的窗口会被 Electron 重新写一遍扩展样式（它要补上
   * WS_EX_LAYERED 来承载 alpha），顺手把创建时加的 WS_EX_TOOLWINDOW 冲掉了——
   * 于是一开透明，面板就又回到任务栏和 Alt+Tab 里，"无痕"当场失效（实测
   * exstyle 从 0x188 变成 0x80088，少了 0x100）。
   * 这个样式只有窗口**隐藏时**改得动，所以必须赶在 show() 之前。
   */
  if (!win.isVisible()) {
    const h = hwndOf(win)
    if (h) w32.makeToolWindow(h)
  }
  win.show()
  // 顶栏带的"永不穿透"巡逻从这一刻开始跑（见 startChromeGuard）
  startChromeGuard()
  // 显示这一刻 Electron 才把 WS_EX_LAYERED 补上，顺手冲掉了 TOOLWINDOW，
  // 所以可见之后还要再补一次（这次带 refresh，让系统重新套用样式）
  {
    const h = hwndOf(win)
    if (h) w32.makeToolWindow(h, true)
  }
  // 面板必须压在浏览器窗口之上：顶栏与悬浮胶囊都画在它上面。
  // 注意这跟"是不是置顶窗口"是两件事——置顶只决定和别的程序比谁在上，
  // 面板与浏览器窗口之间的相对次序由 Z 序看门狗维持（见 applyAlwaysOnTop）
  applyAlwaysOnTop()
  /**
   * 滑入期间实例窗口**保持显示**，跟着面板一起滑进来。
   *
   * 以前这里是先 `setSuppressed(true)` 把浏览器窗口全藏起来、等动画结束再亮出来，
   * 因为当时它们是独立顶级窗口、跟不动动画，露着就会看到页面脱在面板外面。
   * 现在位置由 `slideTo` 每帧批量推送（见 link 到 setPanelPosition 的说明），
   * 网页和面板严丝合缝，藏起来反而成了"面板先滑进来、内容晚一拍才蹦出来"的断层。
   */
  syncPanelToManager()
  manager?.setSuppressed(false)
  win.webContents.send('request-rects')

  /**
   * 呼出的第一帧先按"不穿透"落地 —— 此刻面板整个还在屏幕外，分格也跟着在屏幕外，
   * "指针是不是压在分格上"这个问题此刻本来就无从谈起（主进程拿不到别的答案）。
   * 好处是滑动期间的点击先由面板吃掉，不会穿透到下面那个无关的程序上去。
   *
   * ⚠️ 这一步必须排在 `setSuppressed(false)` 之后：`cursorOverPane()` 只统计
   * `inst.shown === true` 的分格，而收起时 `hidePanel()` 调过 `setSuppressed(true)`
   * 把所有格的 `shown` 都置了 false。排在前面的话，之后 `slideTo` 的逐帧精算会一路
   * 算成"不穿透"，直到落位后收尾才纠正 —— 那 300 多毫秒就是"呼出后第一下点不动"。
   *
   * 真正的穿透判定交给两处：`slideTo` 逐帧精算（见 trackPassthrough），
   * 以及落位后的收尾 `settleAfterShow`。
   */
  applyPassthrough(win)

  slideTo(offX, b.x, b, 240, () => {
    /**
     * 这里**不要**再 syncPanelToManager()。
     *
     * 它会走一遍完整落位（含重测浏览器内衬），而位置在动画里已经逐帧对齐到最终值了，
     * 再校准一次就是"动画结束、网页又自己挪几像素"。记账（面板原点）在动画期间
     * 每帧都由 setPanelPosition 更新，本来就是最新的。区域由 setSliding(false) 补。
     */
    setTimeout(() => settleAfterShow(win), 40)
  }, () => {
    /**
     * 呼出动画被打断（连按两下快捷键"收起→呼出"、动画没跑完就关面板）时，
     * 收尾同样要补一次，否则面板会停在算错的穿透状态上（见 settleAfterShow）。
     */
    settleAfterShow(win)
  }, true)
}

/**
 * 呼出之后的收尾：把"这一帧之后必须到位"的动作集中在这里，让**每条退出路径都跑到**。
 *
 * 原来这几件事散在 `slideTo` 的 `onDone` 里，而 `onDone` 只在动画正常跑完时才调用。
 * 交织操作会把它整个跳过（连按两下快捷键、动画没跑完就关面板、动画期间退出）：
 * 轻则面板带着算错的穿透状态（"呼出后几秒点不动"），重则面板留在任务栏 / Alt+Tab。
 * 现在由 `settleAnim` 统一触发——正常结束走 `done`，被打断走 `abort`，两边都落到这里。
 *
 * 幂等：所有动作读的都是当前状态，重复执行无副作用。
 */
function settleAfterShow(win: BrowserWindow) {
  if (!win || win.isDestroyed()) return
  /**
   * 面板已经收起了就别再抢焦点。
   *
   * 走到"被打断"这条路时紧接着就是收起面板，此时 `focus()` 会把焦点从用户正在
   * 操作的地方抢走。但穿透校准与摘任务栏照旧执行——它们对"下次呼出"同样有效。
   */
  if (win.isVisible()) win.focus()
  // 落位完成后矩形已刷新，用最新值再定一次穿透（show 前那次可能矩形还没上报）
  applyPassthrough(win)
  win.webContents.send('panel-shown')
  /**
   * 落位之后再把面板从任务栏摘掉。
   *
   * `transparent: true` 的窗口，Electron 是在 `show()` 之后才把窗口切成
   * layered（补 WS_EX_LAYERED）的，这一下会把创建时加的 WS_EX_TOOLWINDOW
   * 一并冲掉。实测此时再想补回那个样式位已经补不上了——窗口可见时直接
   * SetWindowLongPtr 改 GWL_EXSTYLE 会被 Chromium 原样退回（先藏后改也没用），
   * 所以只能退而求其次走 Electron 自己的 `setSkipTaskbar`，至少任务栏上不留按钮。
   *
   * 已知取舍：这种情况下面板会短暂出现在 Alt+Tab 列表里。
   */
  win.setSkipTaskbar(true)
  if (win.isVisible()) setTimeout(() => manager?.focusAll(), 80)
}

function hidePanel() {
  if (!panelWindow || panelWindow.isDestroyed() || !panelWindow.isVisible()) return
  const b = panelWindow.getBounds()
  const offX = offscreenX(b)
  /**
   * 收起时同样让浏览器窗口跟着一起滑出去，滑完再一起隐藏。
   *
   * 浏览器窗口是独立顶级窗口，`win.hide()` 带不走它们——面板滑走了网页还停在
   * 停靠位，就是"收起到一半内容还挂着"的那种脏结尾。所以位置照旧逐帧同步，
   * 只在动画结束、面板都不在了之后才把它们藏掉。
   */
  slideTo(b.x, offX, b, 200, () => {
    const win = panelWindow
    if (!win || win.isDestroyed()) return
    manager?.setSuppressed(true)
    win.hide()
    // 面板都收起来了，巡逻没有对象了；下次呼出时再由 showPanel 拉起
    stopChromeGuard()
    // 等隐藏真正生效后再回到停靠位，避免在可见状态下改变位置造成闪烁
    cancelHideSettle()
    hideSettleTimer = setTimeout(() => {
      hideSettleTimer = null
      if (!panelWindow || panelWindow.isDestroyed()) return
      const target = targetBounds()
      panelWindow.setBounds({ x: target.x, y: target.y, width: target.width, height: target.height })
      // 面板位置已回到停靠位，让实例的记账跟着回到原位（此刻它们都是隐藏的）
      syncPanelToManager()
    }, 180)
  })
}

function togglePanel() {
  if (panelWindow && panelWindow.isVisible()) hidePanel()
  else showPanel()
}

/** 配置变化后重新贴边（位置 / 宽度比例 / 置顶） */
function applyPanelBounds() {
  if (!panelWindow || panelWindow.isDestroyed()) return
  const cfg = config.get()
  const b = targetBounds()
  // 置顶与否听用户的（必要时在 openSettings 里也会被同步）
  panelWindow.setAlwaysOnTop(topMostWanted())
  manager?.setTopMost(topMostWanted())
  if (!panelWindow.isVisible()) {
    panelWindow.setBounds(b)
    syncPanelToManager()
    return
  }
  const cur = panelWindow.getBounds()
  /**
   * 宽度变了就别滑了，直接落位。
   *
   * 滑动动画每帧推给浏览器窗口的几何，是按**上一次渲染层上报的分格矩形**算的；
   * 宽度一改，那些矩形立刻作废，得等渲染层重新量完才准。动画期间拿旧矩形铺新宽度，
   * 网页会一路错位地滑过去，落地才跳正——比不做动画更难看。
   * 位置变化（贴左/贴右）不涉及这个问题，照旧走动画。
   */
  if (cur.width !== b.width) {
    panelWindow.setBounds(b)
    syncPanelToManager()
    panelWindow.webContents.send('request-rects')
    return
  }
  // 只是切了置顶开关、几何一个像素没变时别滑：白白 200ms 动画，浏览器窗口跟着抖一下
  if (cur.x === b.x && cur.y === b.y && cur.width === b.width && cur.height === b.height) {
    syncPanelToManager()
    return
  }
  slideTo(cur.x, b.x, b, 200, () => {
    panelWindow?.setBounds(b)
    syncPanelToManager()
    panelWindow?.webContents.send('request-rects')
  })
}

/* ---------------- 设置窗口 ---------------- */

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 800,
    height: 720,
    minWidth: 660,
    minHeight: 520,
    title: 'AIQuad · 设置',
    backgroundColor: '#15181f',
    autoHideMenuBar: true,
    /**
     * ⚠️ 摘掉系统标题栏，改由页面里那条 `.st-head` 自己当标题栏。
     *
     * 起因：Windows 的**非激活**标题栏会被系统换一套配色重绘，而设置页是深色的
     * —— 鼠标一离开窗口，顶上就白一条（用户看到的就是「标题栏时黑时白，全看有没有焦点」）。
     * 自绘之后颜色只有 CSS 一个来源，失焦不再变脸。
     * `titleBarOverlay` 保留最小化/最大化/关闭三个系统按钮，它的底色是静态的，
     * 同样不随激活状态变。
     *
     * 三个必须记住的代价：
     *   1. 拖动窗口改由 `.st-head` 的 `-webkit-app-region: drag` 承担；
     *   2. `color` 必须与 `--panel-bg` 同值（否则叠加层那块矩形的底色与标题栏出色差）；
     *      `height` 必须**比 `styles.css` 里 `.st-head` 的 height 小 2**（现在 38 vs 40）。
     *      ⚠️ 别写成同值：叠加层是一块画在页面**之上**的不透明矩形，同高时它的底边正好
     *      压住标题栏下沿那一行像素，那条 1px 分割线会在右上角三个按钮下面整段消失
     *      （2026-09-15 用纯洋红底竖向扫描实测：窗口矩形 830,322 901×805，标题栏底边
     *      在物理第 366 行，高度 40 的叠加层恰好盖到第 366 行 → 右侧 160px 全被吃）。
     *      矮 2px 让线整个落到叠加层之外，下面那 2px 由 `.st-head` 自己的底色补上，
     *      颜色同值所以看不出来；按钮只是整体上移 1px，肉眼无感。
     *   3. 没有系统标题栏 = 没有系统菜单，双击标题栏的最大化也没了（不是问题，但别以为坏了）。
     */
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#15181f', symbolColor: '#c9d1e0', height: 38 },
    /**
     * 面板可能置顶（用户开着的那个开关），设置窗口不跟着走就会被面板整个挡住；
     * 面板没置顶时也跟着放下来，免得它反过来压住别的程序。
     */
    alwaysOnTop: config.get().alwaysOnTop !== false,
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  settingsWindow.loadFile(rendererFile('settings.html'))
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

/* ---------------- 广播 ---------------- */

function eachWindow(fn: (w: BrowserWindow) => void) {
  for (const w of [panelWindow, settingsWindow]) {
    if (w && !w.isDestroyed()) fn(w)
  }
}

function broadcastConfig() {
  const data = config.get()
  eachWindow((w) => w.webContents.send('config-updated', data))
}

function broadcastStatus() {
  const list = manager?.list() ?? []
  eachWindow((w) => w.webContents.send('instances-updated', list))
}

/* ---------------- 快捷键 ---------------- */

interface ShortcutIssue {
  key: string
  label: string
  acc: string
  reason: 'invalid' | 'taken' | 'duplicate'
  /** duplicate 时指出和谁撞了 */
  conflictWith?: string
}

const SHORTCUT_LABELS: Record<string, string> = {
  toggleFloat: '呼出快捷键',
  layout1: '分格切换 1',
  layout2: '分格切换 2',
  layout4: '分格切换 4',
}

/** 当前配置对应的四个绑定（顺序即界面顺序） */
function shortcutBindings(s: AppConfig['shortcuts']) {
  return [
    { key: 'toggleFloat', acc: s?.toggleFloat ?? '', run: () => togglePanel() },
    { key: 'layout1', acc: s?.layout1 ?? '', run: () => setLayout('1') },
    { key: 'layout2', acc: s?.layout2 ?? '', run: () => setLayout('2') },
    { key: 'layout4', acc: s?.layout4 ?? '', run: () => setLayout('4') },
  ]
}

let lastShortcutIssues: ShortcutIssue[] = []

/**
 * 重新注册全部全局快捷键，并把**失败原因**带回来。
 *
 * 旧实现把失败吞掉了：语法非法抛异常被 catch 成一行 warn，被别的程序占用则
 * 返回 false 而返回值直接丢弃。用户唯一能感知的现象是"按了没反应"，
 * 所以这里必须把结果结构化返回，由设置页显示出来。
 */
function registerShortcuts(): ShortcutIssue[] {
  globalShortcut.unregisterAll()
  const issues: ShortcutIssue[] = []
  const taken = new Map<string, string>() // 规范化后的 acc → 已占用它的 label

  for (const b of shortcutBindings(config.get().shortcuts)) {
    const label = SHORTCUT_LABELS[b.key] || b.key
    const raw = String(b.acc || '').trim()
    if (!raw) continue // 空值 = 用户主动禁用

    const norm = normalizeAccelerator(raw)
    if (!norm) {
      issues.push({ key: b.key, label, acc: raw, reason: 'invalid' })
      continue
    }
    const dupOf = taken.get(norm.toLowerCase())
    if (dupOf) {
      issues.push({ key: b.key, label, acc: norm, reason: 'duplicate', conflictWith: dupOf })
      continue
    }
    taken.set(norm.toLowerCase(), label)

    let ok = false
    try {
      ok = globalShortcut.register(norm, b.run)
    }
    catch (e) {
      console.warn('[shortcut] register threw', norm, e)
    }
    if (!ok) issues.push({ key: b.key, label, acc: norm, reason: 'taken' })
  }

  lastShortcutIssues = issues
  return issues
}

/**
 * 探测某个组合是否**被其它程序**占用（不改变现有绑定）。
 *
 * `globalShortcut.register` 对"已被本应用注册"和"被别的程序占用"都返回 false，
 * 所以若该组合正属于本应用，必须先让出再试，否则会把"自己的键"误报成被占用。
 */
function probeShortcut(raw: string): { ok: boolean, reason?: 'invalid' | 'taken' } {
  const acc = String(raw || '').trim()
  if (!acc) return { ok: true }
  const norm = normalizeAccelerator(acc)
  if (!norm) return { ok: false, reason: 'invalid' }

  let owned = false
  try {
    owned = globalShortcut.isRegistered(norm)
  }
  catch {}

  if (owned) {
    try { globalShortcut.unregister(norm) }
    catch {}
  }

  let ok = false
  try {
    ok = globalShortcut.register(norm, () => {})
  }
  catch {
    ok = false
  }
  if (ok) {
    try { globalShortcut.unregister(norm) }
    catch {}
  }

  // 让出过的键必须还回去；还回去时若有别的项注册不上，会更新 lastShortcutIssues
  if (owned) registerShortcuts()

  return ok ? { ok: true } : { ok: false, reason: 'taken' }
}

function setLayout(layout: LayoutId) {
  config.update({ layout })
  broadcastConfig()
  panelWindow?.webContents.send('layout-changed', layout)
  setTimeout(syncInstances, 120)
  // 布局一变就重新开始倒计时：刚被藏起来的那几个格子还留着，切回去才不用重开浏览器
  schedulePaneCleanup()
}

/* ---------------- 实例同步 ---------------- */

function visiblePaneIds(): string[] {
  const cfg = config.get()
  const n = layoutCount[cfg.layout] || 1
  return cfg.panes.slice(0, n).map((p) => p.id)
}

let syncRunning = false
let syncPending = false

/**
 * 是不是"自己家的窗口"。
 *
 * 用途只有一个：点到面板外面（别的程序 / 桌面）时通知渲染层把展开的 AI 列表收起来。
 * 列表展开期间面板会把鼠标收回来（否则点击会穿透落到下面的网页上），
 * 面板内部怎么点它都知道；唯独点在面板外面的世界里的事主进程才看得见。
 */
function ownWindow(hwnd: number): boolean {
  if (!hwnd) return false
  if (panelWindow && !panelWindow.isDestroyed() && hwndOf(panelWindow) === hwnd) return true
  if (settingsWindow && !settingsWindow.isDestroyed() && hwndOf(settingsWindow) === hwnd) return true
  return manager?.hasWindow(hwnd) ?? false
}

function watchOutsideClicks() {
  w32.watchForeground((hwnd) => {
    if (!hwnd || ownWindow(hwnd)) return
    eachWindow((w) => w.webContents.send('outside-click'))
  })
}

/**
 * 未使用分格的定时清理。
 *
 * 切到 1 格之后，原来 2 / 4 格的窗口只是**藏起来**（`desiredVisible = false`），
 * 页面还活着：4 个 AI 页面的常驻内存是 1GB 级别（见 scripts/perf-baseline.js），
 * 而收起态一点都省不下来。所以这里给它们一个倒计时——超过设定分钟数还没被
 * 切回来，就把那几个格子的浏览器窗口真正关掉。
 *
 * 为什么要等：来回切布局是高频操作，立刻关掉的话每次切回去都要重新拉浏览器。
 * 每次布局变化都会重置这个计时器，只有真的闲置够久才动手。
 */
let paneCleanupTimer: NodeJS.Timeout | null = null

function schedulePaneCleanup() {
  if (paneCleanupTimer) {
    clearTimeout(paneCleanupTimer)
    paneCleanupTimer = null
  }
  const cfg = config.get()
  if (!manager || cfg.paneCleanup === false) return
  const minutes = Math.max(1, Number(cfg.paneCleanupDelayMin) || 10)
  const t = setTimeout(() => {
    paneCleanupTimer = null
    const keep = visiblePaneIds()
    let closed = 0
    for (const inst of manager?.list() ?? []) {
      if (keep.includes(inst.paneId)) continue
      manager?.kill(inst.paneId, true)
      closed += 1
    }
    if (closed) {
      console.log(`[pane] 已清理 ${closed} 个闲置分格（闲置超过 ${minutes} 分钟）`)
      broadcastStatus()
    }
  }, minutes * 60_000)
  t.unref?.()
  paneCleanupTimer = t
}

async function syncInstances() {
  if (!manager || !browserInfo) return
  // 已经有同步在跑时不能直接丢掉这次请求（例如保存配置触发的重启会被吞掉），
  // 标记一下，等当前这轮结束后补跑一次
  if (syncRunning) {
    syncPending = true
    return
  }
  syncRunning = true
  try {
    const cfg = config.get()
    const ids = visiblePaneIds()
    for (const id of ids) {
      const pane = cfg.panes.find((p) => p.id === id)
      if (!pane) continue
      const ai = cfg.aiList.find((a) => a.id === pane.aiId) ?? cfg.aiList[0]
      if (!ai) continue
      const inst = manager.get(id)
      if (!inst || inst.aiId !== ai.id || inst.status === 'failed') {
        await manager.launch(id, ai)
      }
    }
    for (const inst of manager.list()) {
      if (!ids.includes(inst.paneId)) {
        if (cfg.hibernateBackground) manager.suspend(inst.paneId)
        else manager.hide(inst.paneId)
      }
      else {
        if (inst.status === 'suspended') manager.resume(inst.paneId)
        manager.show(inst.paneId)
      }
    }
    broadcastStatus()
  }
  finally {
    syncRunning = false
    schedulePaneCleanup()
    if (syncPending) {
      syncPending = false
      setTimeout(() => void syncInstances(), 60)
    }
  }
}

/* ---------------- 启动 ---------------- */

/**
 * Windows 的登录项（Run 键）允许带命令行参数 —— 用它把「这次是被开机自启拉起的」
 * 和「用户手动双击图标」区分开：只有前者需要等网络，手动打开一律立刻起。
 *
 * ⚠️ setLoginItemSettings 传了 args 之后，getLoginItemSettings 也必须传同样的 args
 * 才能读到正确的 openAtLogin（Electron 文档明确写了）。本项目目前只读开关状态、
 * 不回读系统值，但两处写入统一走 setAutoStart，免得将来加回读时漏配。
 */
function setAutoStart(on: boolean) {
  // 未打包的开发实例（包括全部回归脚本起的隔离实例）绝不碰用户的登录项：
  // 它们用的是自己的 userData，config.autoStart 跟真实设置无关，一启动就会
  // 把 Run 项删掉，或者更糟 —— 改成指向 node_modules 里的 electron.exe。
  if (!app.isPackaged) {
    console.log(`[startup] 开发实例不写登录项（openAtLogin=${on}）`)
    return
  }
  try {
    app.setLoginItemSettings({ openAtLogin: on, args: on ? [AUTOSTART_ARG] : [] })
  }
  catch (e) {
    console.warn('[startup] 写入开机自启失败', e)
  }
}

function launchedAtLogin(): boolean {
  return process.argv.includes(AUTOSTART_ARG) || app.commandLine.hasSwitch('aiquad-autostart')
}

/**
 * 读一次系统代理并落进 config。
 *
 * 放在门控里每轮重跑，而不是只在启动瞬间跑一次：梯子往往比 AIQuad 晚，
 * 它会**在之后**才把 ProxyEnable / ProxyServer 写进注册表。只快照一次的话，
 * 等它起来时我们手里的还是「没有代理」，探测与随后的 Chrome 启动参数都是错的。
 */
async function refreshSystemProxySnapshot(): Promise<AppConfig['proxy']> {
  const cfg = config.get()
  try {
    const sp = await getSystemProxy()
    if (sp.enabled && sp.server) {
      const type: 'http' | 'https' | 'socks5' = /socks/i.test(sp.server) ? 'socks5' : 'http'
      let changed = false
      if (cfg.proxy.systemServer !== sp.server) { cfg.proxy.systemServer = sp.server; changed = true }
      if (cfg.proxy.systemType !== type) { cfg.proxy.systemType = type; changed = true }
      if (!cfg.proxy.host && cfg.proxy.mode !== 'system') { cfg.proxy.mode = 'system'; changed = true }
      if (changed) config.save()
    }
  }
  catch {}
  return cfg.proxy
}

/** 当前布局里真正会打开的那些网址（去重）——就绪门按这张清单探 */
function startupGateTargets(): StartupGateTarget[] {
  const cfg = config.get()
  const n = layoutCount[cfg.layout] || 1
  const seen = new Set<string>()
  const out: StartupGateTarget[] = []
  for (const pane of cfg.panes.slice(0, n)) {
    const ai = cfg.aiList.find((a) => a.id === pane.aiId)
    if (!ai?.url || seen.has(ai.url)) continue
    seen.add(ai.url)
    out.push({ url: ai.url, ai: { proxyMode: ai.proxyMode, proxy: ai.proxy } })
  }
  return out
}

/** 可被「用户手动启动」立刻叫醒的睡眠；等待期间不创建任何窗口 */
function interruptibleSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => { wakeStartupGate = null; resolve() }, ms)
    wakeStartupGate = () => { clearTimeout(timer); wakeStartupGate = null; resolve() }
  })
}

/**
 * 一次性启动门：只在「开机自启」那一次启动生效，手动打开一律立刻起。
 *
 * 两段，互相独立、都能单独关：
 * ① 固定延时 N 秒 —— 给网卡、DNS、梯子进程的启动留缓冲，之后才开始探测；
 * ② 网络就绪门 —— 按当前代理把各分格网址真实探一遍，全通了才放行，
 *    到上限仍未全通就照常启动（今天没开梯子不能让程序一直不出现）。
 *
 * 等待期间**不创建面板、托盘和浏览器进程**，所以用户看到的是「程序晚一点出现，
 * 一出来页面就是好的」。运行中不做任何常驻网络监听。
 */
async function applyStartupGate() {
  if (!launchedAtLogin()) return
  const cfg = config.get()
  const delaySec = Math.max(0, Number(cfg.startupDelaySec) || 0)
  const gateOn = !!cfg.startupWaitNetwork && cfg.startupWaitMaxSec > 0
  if (!delaySec && !gateOn) return

  startupGatePending = true
  startupGateInterrupted = false
  const startedAt = Date.now()
  try {
    if (delaySec) {
      console.log(`[startup] 开机自启：固定延时 ${delaySec}s`)
      await interruptibleSleep(delaySec * 1000)
      if (startupGateInterrupted) return
    }
    if (!gateOn) return

    const targets = startupGateTargets()
    console.log(`[startup] 开机自启：等待 ${targets.length} 个分格网址可达（上限 ${cfg.startupWaitMaxSec}s）`)
    const r = await waitForNetworkReady({
      cfg,
      targets,
      refreshGlobalProxy: refreshSystemProxySnapshot,
      log: (m) => console.log(m),
      interrupted: () => startupGateInterrupted,
      sleep: interruptibleSleep,
    })
    console.log(`[startup] 放行（${r.reason}）：累计等待 ${Date.now() - startedAt}ms，探测 ${r.rounds} 轮`)
    if (r.lastErrors.length) console.log(`[startup] 最后未通：${r.lastErrors.join(' / ')}`)
  }
  finally {
    startupGatePending = false
  }
}

async function bootstrap() {
  config = new ConfigStore(app.getPath('userData'))

  // 记一份系统代理快照；门控内部每轮还会重读
  await refreshSystemProxySnapshot()
  // 自启的这一次：固定延时 + 等网络/代理就绪，再建界面与浏览器进程
  await applyStartupGate()

  browserInfo = await pickBrowser(config.get().browserPreference, config.get().customBrowserPath)
  if (!browserInfo) {
    console.error('未检测到 Chrome / Edge')
  }
  else {
    manager = new InstanceManager({
      browser: browserInfo,
      profilesRoot: profilesRoot(app.getPath('userData')),
      config: () => config.get(),
      // 浏览器升级会把安装目录搬走（实测 Chrome 从 %LOCALAPPDATA% 迁到 %ProgramFiles%），
      // 启动时缓存的路径随时可能失效 —— 交出一个"随时可重新探测"的回调，
      // 让实例管理器在 spawn 失败时能自愈，而不是弹一个 ENOENT 崩溃框。
      resolveBrowser: async () => {
        const cfg = config.get()
        const fresh = await pickBrowser(cfg.browserPreference, cfg.customBrowserPath)
        if (fresh && fresh.exePath !== browserInfo?.exePath) browserInfo = fresh
        return fresh
      },
      /**
       * 页面里点了链接 → 用系统默认浏览器打开，别把 AI 对话那一格换掉
       * （2026-10-08）。复用现成的 `openExternalWeb`，**不另起一份白名单** ——
       * 它已经只放行 http/https，这是唯一的入口，一份就够。
       */
      openExternal: (url) => {
        openExternalWeb(url).then((ok) => {
          if (!ok) console.warn(`[external] 页面链接被白名单拒绝：${url}`)
        })
      },
    })
    manager.setStatusSink(() => broadcastStatus())
  }

  createPanelWindow()
  applyTray()
  registerShortcuts()
  // 点到面板外面（别的窗口 / 桌面）时通知渲染层收起 AI 列表
  watchOutsideClicks()

  panelWindow?.once('ready-to-show', () => {
    showPanel()
    // 走到这里说明这次启动活下来了（GPU 路径没把进程打死）——
    // 回填状态，下次启动就不会再误判成"上次崩了"。
    writeStartupState(true, gpuFallback)
  })
  panelWindow?.webContents.once('did-finish-load', () => {
    syncPanelToManager()
    setTimeout(() => {
      syncInstances()
      panelWindow?.webContents.send('request-rects')
    }, 350)
  })

  // 开机自启（登录项带标记参数，见 launchedAtLogin）
  setAutoStart(config.get().autoStart)
}

/**
 * 网络/梯子后来才恢复时的人工兜底：把当前布局里所有分格重新加载一遍。
 * 只在用户点托盘菜单时跑一次，不做任何自动重试或常驻监听。
 */
async function reloadAllPanes() {
  if (!manager) return
  const ids = visiblePaneIds()
  await Promise.all(ids.map(async (id) => {
    try {
      await manager?.reload(id)
    }
    catch (e) {
      console.warn(`[reload] ${id} 刷新失败`, e)
    }
  }))
  broadcastStatus()
}

function createTray() {
  tray = new Tray(path.join(__dirname, '..', '..', 'src', 'renderer', 'tray.png'))
  tray.setToolTip('AIQuad')
  /**
   * 更新那一项的文字是动态的（检查中 / 下载 37% / 点此安装），
   * 所以菜单每次打开前重建一次，而不是建好就不管。
   */
  const rebuild = () => {
    if (!tray || tray.isDestroyed()) return
    const menu = Menu.buildFromTemplate([
      { label: '呼出面板', click: () => showPanel() },
      { label: '收起面板', click: () => hidePanel() },
      { label: '重新加载全部网页', click: () => { void reloadAllPanes() } },
      { label: '设置', click: () => openSettings() },
      { type: 'separator' },
      {
        label: updater.menuLabel(),
        click: () => {
          // 已经下载完就装，否则触发一次（手动）检查
          if (!updater.installIfReady()) updater.check(true)
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ])
    tray.setContextMenu(menu)
  }
  rebuild()
  tray.on('click', () => togglePanel())
  trayRebuild = rebuild
  // 状态阶段变了就重挂菜单；下载进度的百分比变化太密，不跟着刷
  updater.onChange((_s, prevStatus) => {
    if (prevStatus !== _s.status) rebuild()
  })
}

let trayRebuild: (() => void) | null = null

/**
 * 按配置决定托盘图标在不在（`hideTray`）。
 *
 * 为什么不在 createTray 里自己判断：托盘图标可以被**随时**收起来或放回去（设置页那个
 * 开关是即时生效的），所以"建"和"撤"必须是同一件事的两个方向，由这里统一调停。
 *
 * ⚠️ `tray.destroy()` 而不是 `tray = null`：只把引用置空并不会把图标从通知区摘掉，
 *    那个图标会一直留在右下角、点开还是旧菜单（`rebuild` 里虽然有 isDestroyed 守卫，
 *    但窗口已经不在了，用户看到的仍是它）。重建时 Electron 会重新加一个图标，重复调用
 *    本函数是安全的 —— `createTray` 里那个 updater 回调是单槽（见 updater.onChange），
 *    不会越挂越多。
 */
function applyTray() {
  const want = !config.get().hideTray
  if (!want) {
    if (tray && !tray.isDestroyed()) {
      tray.destroy()
      console.log('[tray] 已按设置隐藏托盘图标')
    }
    tray = null
    return
  }
  if (tray && !tray.isDestroyed()) return
  createTray()
  console.log('[tray] 托盘图标已显示')
}

/* ---------------- IPC ---------------- */

/**
 * 只放行 http/https 地"用默认浏览器打开"。
 *
 * `shell.openExternal` 会把地址交给系统去挑默认程序，`file:`、`ms-msdt:`、
 * `ms-settings:` 这类同样照单全收。"在浏览器里打开"这个入口的语义就只是网页，
 * 别让它变成一条能启动本地程序的通道——AI 服务的地址是用户在设置里自己填的，
 * 填错或被人塞进一条奇怪的地址时不该有这个口子。
 */
async function openExternalWeb(url: string): Promise<boolean> {
  const raw = String(url || '')
  let u: URL
  try {
    u = new URL(raw)
  }
  catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    console.warn(`[open-external] 已拦截非网页地址：${raw}`)
    return false
  }
  await shell.openExternal(u.toString())
  return true
}

function setupIpc() {
  ipcMain.handle('get-config', () => config.get())
  ipcMain.handle('get-app-info', async () => ({
    version: app.getVersion(),
    userData: app.getPath('userData'),
    profiles: profilesRoot(app.getPath('userData')),
    browser: browserInfo ?? null,
    browsers: await detectBrowsers(),
    // 给设置页算"面板宽度预览像素"用：宽度比例乘的就是这块宽度
    screenWidth: screen.getPrimaryDisplay().workArea.width,
    electron: process.versions.electron || '-',
    node: process.versions.node || '-',
    chrome: process.versions.chrome || '-',
  }))

  ipcMain.handle('get-cache-stats', async (): Promise<CacheStat & { cacheText: string; totalText: string }> => {
    const stat = await scanProfileCache(profilesRoot(app.getPath('userData')))
    return { ...stat, cacheText: humanSize(stat.cacheBytes), totalText: humanSize(stat.totalBytes) }
  })

  ipcMain.handle('clear-cache', async (): Promise<CacheCleanResult & { removedText: string }> => {
    const r = await clearProfileCache(profilesRoot(app.getPath('userData')))
    if (r.removedBytes || r.skipped.length) {
      console.log(`[cache] 手动清理：释放 ${humanSize(r.removedBytes)}，${r.skipped.length} 项被占用`)
    }
    return { ...r, removedText: humanSize(r.removedBytes) }
  })

  ipcMain.handle('save-config', async (_e, patch: Partial<AppConfig>) => {
    const before = config.get()
    const next = config.update(patch)
    // 快捷键保存后必须立刻重新注册，并且把"注册不上"的原因回传给设置页
    const shortcutIssues = patch.shortcuts ? registerShortcuts() : lastShortcutIssues
    if (patch.autoStart !== undefined) setAutoStart(!!patch.autoStart)
    // 托盘开关是即时生效的：勾上/去掉就该立刻看到图标消失/出现，不用重启
    if (patch.hideTray !== undefined) applyTray()
    const alwaysOnTopChanged = before.alwaysOnTop !== next.alwaysOnTop
    if (alwaysOnTopChanged) applyAlwaysOnTop()
    if (patch.position !== undefined || patch.windowWidthRatio !== undefined || alwaysOnTopChanged) {
      applyPanelBounds()
    }
    if (patch.paneCleanup !== undefined || patch.paneCleanupDelayMin !== undefined) {
      schedulePaneCleanup()
    }
    // 这些改动写进了浏览器的启动参数，必须重启实例才能生效——
    // 否则用户改了代理/窗口形态却看不到任何反应，会以为是坏的
    const needsRestart
      = JSON.stringify(before.proxy) !== JSON.stringify(next.proxy)
      || before.windowMode !== next.windowMode
      || before.sharedSession !== next.sharedSession
      || before.browserPreference !== next.browserPreference
      || before.customBrowserPath !== next.customBrowserPath
    if (needsRestart) {
      // 必须等旧浏览器**真正退出**再重启：新旧进程抢同一个档案目录时，
      // Chrome 会弹"个人资料正在使用中"对话框，分格直接起不来
      await manager?.shutdownAll()
      void syncInstances()
    }
    broadcastConfig()
    return { config: next, shortcutIssues }
  })

  // 抓取到组合后立刻探测"有没有被别的程序占用"，让用户当场看到结果
  ipcMain.handle('probe-shortcut', (_e, acc: string) => probeShortcut(acc))
  // 打开设置页时问一次当前状态：启动时注册失败的项也要能显示出来
  ipcMain.handle('get-shortcut-issues', () => lastShortcutIssues)

  ipcMain.handle('set-pane-ai', async (_e, paneId: string, aiId: string) => {
    const cfg = config.get()
    const panes = cfg.panes.map((p) => (p.id === paneId ? { ...p, aiId } : p))
    config.update({ panes })
    broadcastConfig()
    await syncInstances()
    return config.get()
  })

  ipcMain.handle('set-layout', async (_e, layout: LayoutId) => {
    setLayout(layout)
    return config.get()
  })

  ipcMain.handle('pane-rects', (_e, rects: PaneRect[]) => {
    manager?.setRects(rects)
  })

  /**
   * 面板"按需鼠标穿透"。
   *
   * 渲染层每次判断出指针压在分格（网页区）上时就把它打进来，主进程据此让面板
   * 忽略鼠标，点击于是落到那一格下面的浏览器窗口；压到顶栏/悬浮胶囊/下拉菜单上时反向打回来。
   *
   * 为什么不用 SetWindowRgn 挖洞（0.4.5 踩过，务必别改回去）：
   * 给**面板**这个 Electron 窗口设 GDI 区域，在**屏幕缩放 ≠ 100%** 时会直接把主进程打崩
   * （退出码 0xC0000409，Chromium 内部 CHECK 失败）。100% 时物理像素与 DIP 恰好相等，
   * 侥幸不崩；实测同一份代码 1.0 稳、1.1 与 1.25 一启动就闪退。
   * `setIgnoreMouseEvents` 是 Electron 自己的机制，不碰 GDI 区域，各缩放档位都稳。
   */
  ipcMain.on('mouse-passthrough', (_e, through: boolean) => {
    if (!panelWindow || panelWindow.isDestroyed()) return
    // 走 setThrough 记账：渲染层上报的值也要进 lastThrough，
    // 否则 slideTo 的逐帧精算会把自己或对方刚设好的值再设一遍
    setThrough(panelWindow, !!through)
  })

  ipcMain.handle('pane-occlude', (_e, paneId: string, on: boolean, hole?: { x: number; y: number; width: number; height: number } | null) => {
    manager?.occlude(paneId, on, hole)
  })

  ipcMain.handle('instance-action', async (_e, paneId: string, action: 'reload' | 'focus' | 'open-external' | 'restart' | 'open-profile') => {
    const inst = manager?.get(paneId)
    const cfg = config.get()
    const pane = cfg.panes.find((p) => p.id === paneId)
    const ai = cfg.aiList.find((a) => a.id === pane?.aiId)
    switch (action) {
      case 'reload':
        await manager?.reload(paneId)
        break
      case 'focus':
        manager?.focus(paneId)
        break
      case 'open-external':
        if (ai) await openExternalWeb(ai.url)
        break
      case 'restart':
        manager?.kill(paneId)
        await syncInstances()
        break
      case 'open-profile':
        if (inst) shell.openPath(inst.profileDir)
        break
    }
    broadcastStatus()
  })

  ipcMain.handle('open-settings', () => openSettings())
  ipcMain.handle('check-update', () => {
    // 已在后台下好就直接问要不要装，否则手动查一次（手动查会给"已是最新"的反馈）
    if (!updater.installIfReady()) updater.check(true)
    return updater.state()
  })
  ipcMain.handle('get-update-state', () => updater.state())
  ipcMain.handle('panel-toggle', () => togglePanel())
  ipcMain.handle('panel-hide', () => hidePanel())
  /**
   * 顶栏拖动。
   *
   * 原来顶栏用的是 CSS `-webkit-app-region: drag`（无边框窗口的"可拖拽区"）。
   * 那套东西最终由系统按**标题栏**语义处理：Win11 上系统会把这一条按自己的
   * 标题栏配色重新画一遍（浅色模式就是一条 #F1F1F1 的白带），把面板自己画的
   * 深色顶栏盖掉——于是顶栏变成白底、白字看不见，但按钮还能点。
   * Win10 上不复现，所以只在那台机器上炸。改成自己算位移挪窗口，就不会再有
   * 任何系统标题栏参与。
   */
  let panelDragBase: { x: number, y: number } | null = null
  ipcMain.handle('panel-drag-start', () => {
    if (!panelWindow || panelWindow.isDestroyed()) { panelDragBase = null; return }
    const b = panelWindow.getBounds()
    panelDragBase = { x: b.x, y: b.y }
  })
  ipcMain.handle('panel-drag-move', (_e, dx: number, dy: number) => {
    if (!panelWindow || panelWindow.isDestroyed() || !panelDragBase) return
    panelWindow.setBounds({
      x: Math.round(panelDragBase.x + dx),
      y: Math.round(panelDragBase.y + dy),
    })
  })
  ipcMain.handle('panel-drag-end', () => { panelDragBase = null })
  ipcMain.handle('sync-instances', async () => {
    await syncInstances()
  })
  ipcMain.handle('test-proxy', async (_e, proxy: any, url: string) => testProxy(proxy, url))
  ipcMain.handle('open-path', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('open-external', (_e, url: string) => openExternalWeb(url))

  ipcMain.handle('set-always-on-top', (_e, value: boolean) => {
    config.update({ alwaysOnTop: !!value })
    applyAlwaysOnTop()
    broadcastConfig()
  })
}

// ── 启动自愈：GPU 进程起不来时自动降级 ────────────────────────────────────
//
// 症状：在容器 / 无显卡虚拟机 / 受策略限制的远程桌面里，Chromium 的 GPU 进程会
// 反复崩溃，随后 FATAL "GPU process isn't usable. Goodbye."，整个应用立刻退出，
// 连窗口都看不到 —— 用户视角就是"双击了没反应"。
//
// 实测（本机 VM）：只关硬件加速还不够，必须同时关掉 Chromium 的进程沙箱才恢复；
// 关沙箱会牺牲进程隔离，所以只在"上一次启动连窗口都没起来"时才自动启用。
//
// 判定方式：把「上一次是否活着走到 ready」记在 userData/startup-state.json。
//   上一次死在 ready 之前 → 本次自动降级，并且**粘住**（否则下次又走 GPU 路径，
//   陷入"崩一次、好一次"的循环）。
// 想重新尝试 GPU：带 AIQUAD_FORCE_GPU=1 启动一次即可解除粘性。
const startupStateFile = () => {
  try { return path.join(app.getPath('userData'), 'startup-state.json') }
  catch { return '' }
}

function readStartupState(): { reachedReady?: boolean; autoFallback?: boolean } | null {
  try {
    const f = startupStateFile()
    if (!f || !fs.existsSync(f)) return null
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  }
  catch { return null }
}

function writeStartupState(reachedReady: boolean, autoFallback: boolean) {
  try {
    const f = startupStateFile()
    if (!f) return
    fs.writeFileSync(f, JSON.stringify({ reachedReady, autoFallback, ts: Date.now() }))
  }
  catch {}
}

const forceGpu = !!process.env.AIQUAD_FORCE_GPU
const prevState = readStartupState()
// 上次没走到 ready = 启动阶段就死了（GPU 崩溃的典型特征）
const diedBeforeReady = !!prevState && prevState.reachedReady === false
const gpuFallback = !forceGpu && (
  !!process.env.AIQUAD_DISABLE_GPU         // 手动指定
  || diedBeforeReady                       // 上次启动崩了 → 自愈
  || !!prevState?.autoFallback             // 已经确认这台机器走不通 → 保持
)

if (gpuFallback) {
  console.warn('[AIQuad] 启用软件渲染降级（GPU 进程不可用）')
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  // 受限环境里光降级还不够，进程沙箱本身让 GPU 进程起不来，必须一起关掉
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}
else if (process.env.AIQUAD_NO_SANDBOX) {
  // 单独要关沙箱但不关硬件加速的旧开关，保留兼容
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 注意：这里必须早退，且**不能**写 startup-state ——
  // 第二个实例写 reachedReady:false 会让下一次真正的启动误判成"上次崩了"。
  app.quit()
}
else {
  // 拿到锁才算一次真正的启动尝试；能否活到 ready 由后面的 showPanel 回填
  writeStartupState(false, gpuFallback)
  app.on('second-instance', () => {
    // 还卡在「等网络」时用户主动双击了图标：别等了，立刻放行启动。
    // 这里不能调 showPanel() —— 那会在 bootstrap 之前就创建面板窗口，
    // 而 did-finish-load 的监听还没挂上，窗口会出来但分格永远不加载。
    if (startupGatePending) {
      startupGateInterrupted = true
      wakeStartupGate?.()
      console.log('[startup] 用户手动启动，跳过网络等待')
      return
    }
    showPanel()
  })
}

app.whenReady().then(async () => {
  setupIpc()
  await bootstrap()
  // 放最后：它自己会延时 6 秒再查，不跟启动抢资源
  updater.init()
  // 缓存自动清理推迟到界面稳定之后：扫描是全盘 stat，放在启动关键路径上会拖慢首帧
  setTimeout(runAutoCacheCleanup, 3000)
})

/**
 * 启动时按阈值清一次缓存。
 *
 * 只清 Cache / Code Cache / 着色器缓存这些浏览器随时能重新生成的东西，
 * Cookies 与 Local Storage 不动 —— 否则每次启动都要重新登录 AI 站，那就本末倒置了。
 */
function runAutoCacheCleanup() {
  if (config?.get().cacheCleanup !== 'auto') return
  void (async () => {
    try {
      const root = profilesRoot(app.getPath('userData'))
      // cap 设成阈值：数到 500MB 就收，不用把整个档案树走完
      const stat = await scanProfileCache(root, AUTO_CLEAN_THRESHOLD_BYTES)
      if (stat.cacheBytes < AUTO_CLEAN_THRESHOLD_BYTES) return
      const r = await clearProfileCache(root)
      console.log(`[cache] 缓存 ${humanSize(stat.cacheBytes)} 超过阈值，自动清理释放 ${humanSize(r.removedBytes)}，${r.skipped.length} 项被占用`)
    }
    catch (e) {
      console.warn('[cache] 自动清理失败', e)
    }
  })()
}

app.on('before-quit', () => {
  isQuitting = true
})

/**
 * 退出流程。
 *
 * 不能像以前那样在 `will-quit` 里同步干完：`killAll()` 只是给浏览器窗口发 `WM_CLOSE`，
 * 那一刻浏览器进程还活着，Cache / Code Cache 这些文件仍被占着，删不掉，
 * 而且浏览器走完自己的退出流程时还会把它们再写回去 —— "退出时清理"等于白做。
 * 改成先关窗口、等浏览器进程真的退出、再动手删，最后自己调 `app.exit()` 收尾。
 */
let quitFinalized = false
app.on('will-quit', (e) => {
  if (quitFinalized) return
  quitFinalized = true
  stopAnim()
  stopChromeGuard()
  globalShortcut.unregisterAll()
  manager?.dispose()
  // 为了装更新而退出时别插手：安装程序已经拉起来了，只等本进程结束，
  // 我们再把退出延后（甚至自己 app.exit）只会拖住它、甚至把它打断
  if (isQuittingForUpdate()) {
    manager?.killAll()
    return
  }
  e.preventDefault()
  void (async () => {
    try {
      // 4 秒足够浏览器优雅落盘；超时就强杀，不能让退出卡死
      await manager?.shutdownAll(4000)
      // 浏览器进程已经没了，此刻缓存文件才腾得出手来删。
      // "退出时清理"选的就是这条时机，删不干净的（极少数被系统占着的）下次启动还会补一刀。
      if (config?.get().cacheCleanup === 'exit') {
        const r = clearProfileCacheSync(profilesRoot(app.getPath('userData')))
        console.log(`[cache] 退出清理：释放 ${humanSize(r.removedBytes)}`)
      }
    }
    catch (e) {
      console.warn('[cache] 退出清理失败', e)
    }
    finally {
      // 退出已经被 preventDefault 拦下了，必须自己收尾，
      // 否则中途任何一步抛异常都会把进程永久留在"退不掉"的状态
      app.exit(0)
    }
  })()
})

app.on('window-all-closed', () => {
  // 托盘常驻，不随窗口关闭退出
})
