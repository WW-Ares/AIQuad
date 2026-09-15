import { app, BrowserWindow, dialog } from 'electron'
/**
 * 注意别从 'electron' 引 autoUpdater——那是 Electron 内置的 Squirrel 更新器，
 * 只认 Squirrel 的 feed，我们用 GitHub Releases，得引 electron-updater 的这一份。
 */
import { autoUpdater } from 'electron-updater'

/**
 * 自动更新。
 *
 * 为什么需要它（2026-09-15）：AIQuad 是托盘常驻工具，以前每次升级都要用户手工
 * 去 GitHub 下一个 99MB 的安装包重装一遍。electron-updater 走的是差分更新
 * （只下 blockmap 里变过的块），单版本通常几 MB，对常驻类工具这是性价比最高的一项。
 *
 * 配置来源：打包后 electron-builder 会在 resources 里放一份 `app-update.yml`，
 * 内容来自 package.json 的 `build.publish`。**开发态没有这个文件**，
 * autoUpdater 会直接抛错，所以入口统一包一层 try/catch。
 */

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export type UpdateState = {
  status: UpdateStatus
  /** 新版本号（available / downloading / downloaded 时有值） */
  version?: string
  /** 下载进度 0~100 */
  percent?: number
  /** 已下载 / 总字节 */
  transferred?: number
  total?: number
  /** 出错时的说明 */
  message?: string
  /** 当前版本 */
  current: string
}

let state: UpdateState = { status: 'idle', current: app.getVersion() }
let initialized = false
/** 用户手动点的检查：这种情况即使"已是最新"也要给反馈 */
let manualPending = false

let changeHook: ((s: UpdateState, prevStatus: UpdateStatus) => void) | null = null

/**
 * 是否正在为"装更新"而退出。
 *
 * `quitAndInstall` 会先把安装程序拉起来、再让应用退出，安装程序要等本进程结束。
 * 主进程那边为了清缓存把退出延后了几秒，这里就得多等几秒；
 * 万一它自己 `app.exit()` 提前收尾，还可能把安装打断。所以装更新的退出走原路。
 */
let quittingForUpdate = false

/** 供主进程在退出流程里判断"这次退出是不是为了装更新" */
export function isQuittingForUpdate() {
  return quittingForUpdate
}

function setState(patch: Partial<UpdateState>) {
  const prevStatus = state.status
  state = { ...state, ...patch, current: app.getVersion() }
  broadcast()
  changeHook?.(state, prevStatus)
}

/** 主进程订阅状态变化（托盘菜单要跟着改文字） */
export function onUpdateChange(fn: ((s: UpdateState, prevStatus: UpdateStatus) => void) | null) {
  changeHook = fn
}

function broadcast() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('update-status', state)
  }
}

function currentState(): UpdateState {
  return state
}

/**
 * 初始化。只在**打包后**真正生效。
 *
 * 开发态（`app.isPackaged === false`）直接跳过：那时没有 `app-update.yml`，
 * autoUpdater 一上来就会抛 "Update feed URL is not set"，噪音而已。
 */
export function initUpdater() {
  if (initialized) return
  initialized = true

  if (!app.isPackaged) {
    setState({ status: 'idle', message: '开发态不检查更新' })
    return
  }

  try {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    // GitHub 未发布 draft / prerelease 时不提示，只跟正式版
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false
    /**
     * NSIS 默认给每个用户单独装一份（`%LOCALAPPDATA%\Programs`），
     * 装的时候不涉及 UAC。保留默认即可，electron-updater 会自动识别。
     */
  }
  catch (err) {
    setState({ status: 'error', message: `初始化失败: ${String(err)}` })
    return
  }

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }))

  autoUpdater.on('update-available', (info) => {
    setState({ status: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', (info) => {
    setState({ status: 'not-available', version: info?.version })
    if (manualPending) {
      manualPending = false
      notifyManual(`当前已是最新版本（${app.getVersion()}）`)
    }
  })

  autoUpdater.on('download-progress', (p) => {
    setState({
      status: 'downloading',
      percent: Math.round(p.percent * 10) / 10,
      transferred: p.transferred,
      total: p.total,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    setState({ status: 'downloaded', version: info.version, percent: 100 })
    /**
     * 装更新要重启应用，而应用此刻多半正在跑着 4 个 AI 页面。
     * 所以不自己重启，弹个框让用户挑时机——直接重启会把没发出去的话弄丢。
     */
    promptInstall(info.version)
  })

  autoUpdater.on('error', (err) => {
    const msg = friendlyError(err)
    setState({ status: 'error', message: msg })
    if (manualPending) {
      manualPending = false
      notifyManual(`检查更新失败：${msg}`)
    }
  })

  // 启动 6 秒后再查，避开启动高峰（那会儿正在拉浏览器实例）
  setTimeout(() => { void checkForUpdates(false) }, 6000)
  // 之后每 6 小时查一次
  setInterval(() => { void checkForUpdates(false) }, 6 * 3600 * 1000)
}

/**
 * 把更新器那串英文堆栈翻成人话。
 *
 * 最常撞到的是这一条：GitHub Release 里没上传 `latest.yml`（它就是更新索引，
 * electron-updater 靠它知道最新版是哪个、差分块在哪）。少了它，检查更新必然
 * 报 404 ——内容是一页 rcedit / builder-util-runtime 的堆栈，用户完全读不懂。
 */
function friendlyError(err: unknown): string {
  const raw = String((err as any)?.message ?? err)
  if (/latest(-[a-z0-9]+)?\.yml/i.test(raw) && /404/.test(raw)) {
    return '发布里缺更新索引 latest.yml，暂时无法在线升级；请到 GitHub Releases 下载安装包手动覆盖安装'
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network|proxy/i.test(raw)) {
    return `网络不通：${raw.split('\n')[0]}`
  }
  if (/Update feed URL/i.test(raw)) {
    return '未找到更新配置（只有打包版才带），开发态不支持检查更新'
  }
  return raw
}

export function checkForUpdates(manual: boolean) {
  if (!app.isPackaged) {
    if (manual) notifyManual('开发态不支持检查更新')
    return
  }
  manualPending = manual
  try {
    // checkForUpdates 返回 Promise，失败会走 error 事件；这里再兜一层防止 unhandled rejection
    const p = autoUpdater.checkForUpdates() as unknown as Promise<unknown> | undefined
    if (p && typeof (p as Promise<unknown>).catch === 'function') {
      (p as Promise<unknown>).catch(() => {})
    }
  }
  catch (err) {
    manualPending = false
    setState({ status: 'error', message: String(err) })
    if (manual) notifyManual(`检查更新失败：${String(err)}`)
  }
}

/** 下载完之后的询问框。只弹一次，关闭后还能从托盘菜单/设置页再装。 */
let installPrompted = false

function promptInstall(version: string) {
  if (installPrompted) return
  installPrompted = true
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible())
  const opts = {
    type: 'info' as const,
    title: 'AIQuad 更新已就绪',
    message: `新版本 ${version} 已下载完成`,
    detail: '现在重启安装？未发送的内容会丢失，建议先把对话发完。',
    buttons: ['立即重启安装', '稍后我自己装'],
    defaultId: 0,
    cancelId: 1,
  }
  const cb = (res: number) => {
    if (res === 0) {
      installPrompted = false
      quittingForUpdate = true
      autoUpdater.quitAndInstall(false, true)
    }
  }
  if (win) dialog.showMessageBox(win, opts).then((r) => cb(r.response))
  else dialog.showMessageBox(opts).then((r) => cb(r.response))
}

function notifyManual(text: string) {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible())
  const opts = { type: 'info' as const, title: 'AIQuad 更新', message: text, buttons: ['好的'] }
  if (win) void dialog.showMessageBox(win, opts)
  else void dialog.showMessageBox(opts)
}

/** 托盘菜单用的状态：有可用更新时把菜单项换成安装动作 */
export function updateMenuLabel(): string {
  switch (state.status) {
    case 'checking': return '正在检查更新…'
    case 'available': return '正在下载更新…'
    case 'downloading': return `正在下载更新 ${state.percent ?? 0}%`
    case 'downloaded': return `安装更新 ${state.version ?? ''} 并重启`
    case 'error': return '检查更新（上次失败）'
    default: return '检查更新'
  }
}

export function updateState(): UpdateState {
  return currentState()
}

export const updater = {
  init: initUpdater,
  check: checkForUpdates,
  state: updateState,
  menuLabel: updateMenuLabel,
  onChange: onUpdateChange,
  /**
   * 下载完成后点托盘菜单就装。返回 true 表示已经接手（要退出应用了）。
   */
  installIfReady(): boolean {
    if (state.status === 'downloaded') {
      installPrompted = false
      quittingForUpdate = true
      autoUpdater.quitAndInstall(false, true)
      return true
    }
    return false
  },
  /** 供渲染层订阅（preload 里包一层 on('update-status')） */
  broadcast,
}
