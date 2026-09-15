/**
 * 验证脚本的收尾清理。**必须用 `taskkill /F /T /PID`，不能只用 `process.kill(pid)`。**
 *
 * 踩过的坑：`shot-packaged.js` 收尾只调了 `process.kill(child.pid)`，
 * 结果**打包版的 AIQuad.exe 没被彻底结束**（留下 main + gpu + 两个 renderer 共 4 个进程），
 * 它一直占着 `%APPDATA%\aiquad` 的**单实例锁**。
 * 之后所有源码版启动都会走到 `requestSingleInstanceLock() === false` →
 * 立刻 `app.quit()`：**窗口没有、日志正常、退出码 0**，排查了半小时才想到是残留进程。
 *
 * 所以收尾一律走「杀进程树 + 按映像名兜底清扫」。
 *
 * ⚠️ **2026-09-15 事故：兜底清扫的"默认值"误伤了用户正在用的程序。**
 * `cleanupRun(pid)` 原先默认 `images = ['chrome.exe']`，于是**每次跑回归脚本收尾都会
 * `taskkill /F /T /IM chrome.exe` —— 无差别强杀机器上所有 Chrome**。而 AIQuad 给每个分格
 * 承载网页用的就是 Chrome：用户正开着 AIQuad 时，那一刀会把他面板里所有分格窗口一起杀掉，
 * 表现是**面板只剩框架、预览器（网页）整片消失**，而且"偶尔才发生"（只在我们跑脚本时）。
 * 更别提他自己的 Chrome 标签页、没提交的表单也一起没了。
 * → 现在**默认不再按映像名全杀**：被测应用拉起的浏览器是它的**子进程**（`detached: false`），
 * `killTree(pid)` 已经覆盖；真要清"用户自己开的浏览器"，得显式传 `images` 或给
 * `AIQUAD_FORCE_KILL_BROWSERS=1`。**改动这里前先读这几行。**
 */
const { execFileSync } = require('node:child_process')

/** 杀掉整棵进程树（/T 连子进程一起），失败不抛 */
function killTree(pid) {
  if (!pid) return
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
  }
  catch {}
}

/** 按映像名兜底清扫（Electron 名下的 gpu/utility/renderer 子进程可能已被重新挂到别处） */
function killImage(name) {
  try {
    execFileSync('taskkill', ['/F', '/T', '/IM', name], { stdio: 'ignore' })
  }
  catch {}
}

/**
 * 收尾：杀被测应用进程树（连带它拉起的浏览器子进程），按需再精确清本应用的浏览器。
 *
 * ⚠️ `images` 默认**空** —— 别再改回 `['chrome.exe']`，那会强杀用户自己开着的 Chrome，
 * 以及用户那台机器上正在运行的 AIQuad 实例里的分格窗口（见文件头的事故记录）。
 *
 * @param {number} [pid] 被测应用主进程 pid
 * @param {string[]} [images] 额外按映像名**全量**清扫的映像（默认不扫）
 * @param {string} [profilesRoot] 本应用的浏览器档案根目录；给了就只清命令行里带它的那些浏览器进程
 */
function cleanupRun(pid, images = [], profilesRoot = null) {
  killTree(pid)
  if (profilesRoot) killBrowsersUnder(profilesRoot)
  for (const img of images) killImage(img)
  // 显式开关：确实要把整个用户机器上的浏览器清干净时用（会造成上面那个事故，慎用）
  if (process.env.AIQUAD_FORCE_KILL_BROWSERS) killImage('chrome.exe')
}

/**
 * 只结束**属于本应用**的浏览器进程。
 *
 * 不要用 `taskkill /F /IM chrome.exe`：那是无差别强杀，会把用户自己正开着的
 * Chrome 一并干掉（标签页、未提交的表单全丢）。本应用给每个分格传了
 * `--user-data-dir=<profilesRoot>/...`，命令行里带着这个档案根目录，
 * 拿它当判据就能精确命中自己拉起来的那些窗口。
 *
 * @param {string} profilesRoot 本应用的浏览器档案根目录（userData/profiles）
 * @returns {number} 结束掉的进程数
 */
function killBrowsersUnder(profilesRoot) {
  if (!profilesRoot) return 0
  const needle = String(profilesRoot).replace(/'/g, "''")
  const ps = `$p = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" `
    + `| Where-Object { $_.CommandLine -like '*${needle}*' }; `
    + `$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; `
    + `($p | Measure-Object).Count`
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })
    return Number(String(out).trim()) || 0
  }
  catch { return 0 }
}

/**
 * 列出属于本应用的浏览器进程 pid（判据同 killBrowsersUnder）。
 * 需要"先温和关闭、再强杀"时用它筛窗口：`listBrowserWindows()` 返回的是
 * **系统里所有** Chrome_WidgetWin_1，不过滤就会把用户自己开的浏览器一起关掉。
 * @param {string} profilesRoot 本应用的浏览器档案根目录
 * @returns {number[]}
 */
function browserPidsUnder(profilesRoot) {
  if (!profilesRoot) return []
  const needle = String(profilesRoot).replace(/'/g, "''")
  const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" `
    + `| Where-Object { $_.CommandLine -like '*${needle}*' } `
    + `| Select-Object -ExpandProperty ProcessId`
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })
    return String(out).split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean)
  }
  catch { return [] }
}

module.exports = { killTree, killImage, cleanupRun, killBrowsersUnder, browserPidsUnder }
