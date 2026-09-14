import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, shell, Tray } from 'electron'
import { normalizeAccelerator } from './accelerator'
import { ConfigStore } from './config'
import { detectBrowsers, pickBrowser, type BrowserInfo } from './browser-detect'
import { InstanceManager } from './instance-manager'
import { getSystemProxy, profilesRoot, testProxy } from './proxy'
import * as w32 from './win32'
import type { AppConfig, LayoutId, PaneRect } from './types'

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
  manager.setPanel({ x: b.x, y: b.y }, scaleOf(panelWindow), hwndOf(panelWindow), config.get().alwaysOnTop)
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

function stopAnim() {
  if (animTimer) {
    clearInterval(animTimer)
    animTimer = null
  }
}

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

function slideTo(fromX: number, toX: number, bounds: { y: number; width: number; height: number }, duration: number, onDone?: () => void) {
  stopAnim()
  const started = Date.now()
  animTimer = setInterval(() => {
    if (!panelWindow || panelWindow.isDestroyed()) {
      stopAnim()
      return
    }
    const t = Math.min(1, (Date.now() - started) / duration)
    const x = Math.round(fromX + (toX - fromX) * easeInOutCubic(t))
    panelWindow.setBounds({ x, y: bounds.y, width: bounds.width, height: bounds.height })
    if (t >= 1) {
      stopAnim()
      onDone?.()
    }
  }, 16)
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
    alwaysOnTop: cfg.alwaysOnTop,
    backgroundColor: '#15181f',
    title: 'AI 助手',
    icon: appIcon(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  Menu.setApplicationMenu(null)
  panelWindow.loadFile(rendererFile('main.html'))

  panelWindow.on('resize', () => {
    syncPanelToManager()
    panelWindow?.webContents.send('request-rects')
  })
  // 实例窗口是独立顶级窗口（不是子窗口），面板移动时必须主动同步它们的位置
  let moveTimer: NodeJS.Timeout | null = null
  const onMove = () => {
    // 立即同步，避免实例窗口滞后于面板
    if (manager && panelWindow && !panelWindow.isDestroyed()) {
      const nb = panelWindow.getBounds()
      manager.setPanelPosition(nb.x, nb.y)
    }
    if (moveTimer) clearTimeout(moveTimer)
    moveTimer = setTimeout(() => {
      moveTimer = null
      syncPanelToManager()
      panelWindow?.webContents.send('request-rects')
    }, 220)
  }
  panelWindow.on('move', onMove)
  panelWindow.on('moved', onMove)
  // 面板被激活后，把实例窗口重新提到面板之上（两者同为置顶层级）
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
  if (!panelWindow) createPanelWindow()
  const win = panelWindow!
  const b = targetBounds()
  const offX = offscreenX(b)

  // 先把窗口放到屏幕外，再滑入，避免出现"闪一下"
  win.setBounds({ x: offX, y: b.y, width: b.width, height: b.height })
  win.show()
  win.setAlwaysOnTop(config.get().alwaysOnTop)

  // 滑入期间隐藏实例窗口：它们是独立顶级窗口，无法与动画逐帧同步，
  // 否则会看到浏览器页面跑到面板外面
  manager?.setSuppressed(true)
  syncPanelToManager()
  win.webContents.send('request-rects')

  slideTo(offX, b.x, b, 190, () => {
    syncPanelToManager()
    // 落位后再显示实例内容，避免工具栏/位置在动画末帧闪现
    setTimeout(() => {
      manager?.setSuppressed(false)
      win.focus()
      win.webContents.send('panel-shown')
      setTimeout(() => manager?.focusAll(), 80)
    }, 40)
  })
}

function hidePanel() {
  if (!panelWindow || panelWindow.isDestroyed() || !panelWindow.isVisible()) return
  const b = panelWindow.getBounds()
  const offX = offscreenX(b)
  // 关键：先把所有原生浏览器窗口隐藏，再收起面板。
  // 它们是独立顶级窗口，不会随面板隐藏，否则会在收起的瞬间停在停靠位闪一下。
  manager?.setSuppressed(true)
  slideTo(b.x, offX, b, 170, () => {
    const win = panelWindow
    if (!win || win.isDestroyed()) return
    win.hide()
    // 等隐藏真正生效后再回到停靠位，避免在可见状态下改变位置造成闪烁
    setTimeout(() => {
      if (!panelWindow || panelWindow.isDestroyed()) return
      const target = targetBounds()
      panelWindow.setBounds({ x: target.x, y: target.y, width: target.width, height: target.height })
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
  panelWindow.setAlwaysOnTop(cfg.alwaysOnTop)
  manager?.setTopMost(cfg.alwaysOnTop)
  if (!panelWindow.isVisible()) {
    panelWindow.setBounds(b)
    syncPanelToManager()
    return
  }
  const cur = panelWindow.getBounds()
  // 宽度变化会改变分格尺寸，滑动期间先隐藏实例避免不同步
  manager?.setSuppressed(true)
  slideTo(cur.x, b.x, b, 170, () => {
    panelWindow?.setBounds(b)
    syncPanelToManager()
    panelWindow?.webContents.send('request-rects')
    setTimeout(() => manager?.setSuppressed(false), 60)
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
    title: 'AI 助手 · 设置',
    backgroundColor: '#15181f',
    autoHideMenuBar: true,
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
  tray.setToolTip('AI 助手')
  const menu = Menu.buildFromTemplate([
    { label: '呼出面板', click: () => showPanel() },
    { label: '收起面板', click: () => hidePanel() },
    { label: '设置', click: () => openSettings() },
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
  tray.on('click', () => togglePanel())
}

/* ---------------- IPC ---------------- */

function setupIpc() {
  ipcMain.handle('get-config', () => config.get())
  ipcMain.handle('get-app-info', async () => ({
    version: app.getVersion(),
    userData: app.getPath('userData'),
    profiles: profilesRoot(app.getPath('userData')),
    browser: browserInfo ?? null,
    browsers: await detectBrowsers(),
  }))

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
  ipcMain.handle('panel-toggle', () => togglePanel())
  ipcMain.handle('panel-hide', () => hidePanel())
  ipcMain.handle('sync-instances', async () => {
    await syncInstances()
  })
  ipcMain.handle('test-proxy', async (_e, proxy: any, url: string) => testProxy(proxy, url))
  ipcMain.handle('open-path', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('open-external', (_e, url: string) => shell.openExternal(url))

  ipcMain.handle('set-always-on-top', (_e, value: boolean) => {
    config.update({ alwaysOnTop: value })
    panelWindow?.setAlwaysOnTop(value)
    manager?.setTopMost(value)
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
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  stopAnim()
  globalShortcut.unregisterAll()
  manager?.killAll()
})

app.on('window-all-closed', () => {
  // 托盘常驻，不随窗口关闭退出
})
