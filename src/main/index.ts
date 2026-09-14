import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, shell, Tray } from 'electron'
import { normalizeAccelerator } from './accelerator'
import { ConfigStore } from './config'
import { detectBrowsers, pickBrowser, type BrowserInfo } from './browser-detect'
import { InstanceManager } from './instance-manager'
import { getSystemProxy, profilesRoot, testProxy } from './proxy'
import { clearProfileCache, clearProfileCacheSync, humanSize, scanProfileCache, type CacheCleanResult, type CacheStat } from './cache-cleaner'
import { updater } from './updater'
import * as w32 from './win32'
import type { AppConfig, LayoutId, PaneRect } from './types'
import { AUTO_CLEAN_THRESHOLD_BYTES } from './types'

let config: ConfigStore
let manager: InstanceManager | null = null
let panelWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let tray: Tray | null = null
let browserInfo: BrowserInfo | null = null
let isQuitting = false

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
  manager.setPanel({ x: b.x, y: b.y }, scaleOf(panelWindow), hwndOf(panelWindow), true)
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

function stopAnim() {
  if (animTimer) {
    clearTimeout(animTimer)
    animTimer = null
  }
  animating = false
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
 * 按指针当前位置刷新面板的鼠标穿透状态。
 *
 * 指针停在分格（网页）上就穿透，让点击落到下面的浏览器窗口；
 * 停在顶栏 / 中缝 / 悬浮胶囊上就不穿透，让面板自己收下点击。
 */
function applyPassthrough(win: BrowserWindow) {
  if (!win || win.isDestroyed()) return
  try {
    win.setIgnoreMouseEvents(!!manager?.cursorOverPane(), { forward: true })
  }
  catch {
    // 窗口正在销毁时 setIgnoreMouseEvents 会抛，忽略即可
  }
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
function slideTo(fromX: number, toX: number, bounds: { y: number; width: number; height: number }, duration: number, onDone?: () => void) {
  stopAnim()
  animating = true
  // 滑动期间冻结几何校准，否则内衬重测带来的几像素抖动会一路干扰动画（见 setSliding）
  manager?.setSliding(true)
  const started = Date.now()
  const step = () => {
    if (!panelWindow || panelWindow.isDestroyed()) {
      stopAnim()
      animating = false
      manager?.setSliding(false)
      return
    }
    const t = Math.min(1, (Date.now() - started) / duration)
    const x = Math.round(fromX + (toX - fromX) * easeInOutCubic(t))
    panelWindow.setBounds({ x, y: bounds.y, width: bounds.width, height: bounds.height })
    // 面板的新位置立刻交给浏览器窗口，同帧移动
    manager?.setPanelPosition(x, bounds.y)
    if (t >= 1) {
      stopAnim()
      animating = false
      // 先解除冻结（会补一次完整校准），再交给收尾逻辑
      manager?.setSliding(false)
      onDone?.()
      return
    }
    animTimer = setTimeout(step, 8)
  }
  step()
}

/* ---------------- 面板窗口 ---------------- */

function createPanelWindow() {
  const cfg = config.get()
  const b = targetBounds()

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
    alwaysOnTop: true,
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
  // 显示这一刻 Electron 才把 WS_EX_LAYERED 补上，顺手冲掉了 TOOLWINDOW，
  // 所以可见之后还要再补一次（这次带 refresh，让系统重新套用样式）
  {
    const h = hwndOf(win)
    if (h) w32.makeToolWindow(h, true)
  }
  // 面板必须置顶：它是宿主，顶栏与悬浮胶囊都画在它上面来压住浏览器窗口
  win.setAlwaysOnTop(true)
  /**
   * 面板刚出现的这一帧先按**指针当前位置**定好穿透状态。
   *
   * 之后的每一次修正都靠渲染层的 mousemove，而主进程收不到鼠标移动；万一呼出面板时
   * 指针恰好就停在某一格上，不先算这一下，用户的第一次点击会被面板吃掉（网页点不动）。
   *
   * 注意 `cursorOverPane()` 内部是实时取 `screen.getCursorScreenPoint()` 的，
   * 但它依赖渲染层**上报过的**分格矩形；此刻矩形可能是空的（窗口刚建 / 页面还没量完），
   * 算出来会是不穿透——面板吃掉所有点击，直到渲染层发来第一次 mousemove 才纠正。
   * 所以动画结束后还要用刷新过的矩形再算一次（见 slideTo 的 onDone）。
   */
  applyPassthrough(win)

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

  slideTo(offX, b.x, b, 240, () => {
    /**
     * 这里**不要**再 syncPanelToManager()。
     *
     * 它会走一遍完整落位（含重测浏览器内衬），而位置在动画里已经逐帧对齐到最终值了，
     * 再校准一次就是"动画结束、网页又自己挪几像素"。记账（面板原点）在动画期间
     * 每帧都由 setPanelPosition 更新，本来就是最新的。区域由 setSliding(false) 补。
     */
    setTimeout(() => {
      win.focus()
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
      setTimeout(() => manager?.focusAll(), 80)
    }, 40)
  })
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
  // 恒为 true：面板要压住浏览器窗口，否则顶栏与悬浮胶囊被浏览器标题栏盖掉
  panelWindow.setAlwaysOnTop(true)
  manager?.setTopMost(true)
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
    width: 920,
    height: 720,
    title: 'AIQuad · 设置',
    backgroundColor: '#15181f',
    autoHideMenuBar: true,
    // 面板是置顶的，设置窗口不跟着置顶就会被面板整个挡住
    alwaysOnTop: true,
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
}

/* ---------------- 实例同步 ---------------- */

function visiblePaneIds(): string[] {
  const cfg = config.get()
  const n = layoutCount[cfg.layout] || 1
  return cfg.panes.slice(0, n).map((p) => p.id)
}

let syncRunning = false
let syncPending = false

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
    if (syncPending) {
      syncPending = false
      setTimeout(() => void syncInstances(), 60)
    }
  }
}

/* ---------------- 启动 ---------------- */

async function bootstrap() {
  config = new ConfigStore(app.getPath('userData'))

  // 探测系统代理，作为默认
  try {
    const sp = await getSystemProxy()
    const cfg = config.get()
    if (sp.enabled && sp.server) {
      cfg.proxy.systemServer = sp.server
      cfg.proxy.systemType = /socks/i.test(sp.server) ? 'socks5' : 'http'
      if (!cfg.proxy.host) cfg.proxy.mode = 'system'
      config.save()
    }
  }
  catch {}

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
    })
    manager.setStatusSink(() => broadcastStatus())
  }

  createPanelWindow()
  createTray()
  registerShortcuts()

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

  // 开机自启
  try {
    app.setLoginItemSettings({ openAtLogin: config.get().autoStart })
  }
  catch {}
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

/* ---------------- IPC ---------------- */

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
    if (patch.autoStart !== undefined) {
      try {
        app.setLoginItemSettings({ openAtLogin: !!patch.autoStart })
      }
      catch {}
    }
    if (patch.position !== undefined || patch.windowWidthRatio !== undefined || patch.alwaysOnTop !== undefined) {
      applyPanelBounds()
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
    panelWindow.setIgnoreMouseEvents(!!through, { forward: true })
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
        if (ai) shell.openExternal(ai.url)
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
  ipcMain.handle('open-external', (_e, url: string) => shell.openExternal(url))

  ipcMain.handle('set-always-on-top', (_e, _value: boolean) => {
    // 面板必须始终置顶（它要把顶栏/悬浮胶囊画在浏览器窗口之上），这里不再提供关闭
    config.update({ alwaysOnTop: true })
    panelWindow?.setAlwaysOnTop(true)
    manager?.setTopMost(true)
    manager?.raiseAll()
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
  app.on('second-instance', () => showPanel())
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

app.on('will-quit', () => {
  stopAnim()
  globalShortcut.unregisterAll()
  manager?.killAll()
  // 浏览器进程刚被杀掉，此刻缓存文件才腾得出手来删。
  // "退出时清理"选的就是这条时机，删不干净的（极少数被系统占着的）下次启动还会补一刀。
  if (config?.get().cacheCleanup === 'exit') {
    try {
      const r = clearProfileCacheSync(profilesRoot(app.getPath('userData')))
      console.log(`[cache] 退出清理：释放 ${humanSize(r.removedBytes)}`)
    }
    catch (e) {
      console.warn('[cache] 退出清理失败', e)
    }
  }
})

app.on('window-all-closed', () => {
  // 托盘常驻，不随窗口关闭退出
})
