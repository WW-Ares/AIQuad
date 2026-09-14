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
 * 收尾：先杀被测应用进程树，再清浏览器，最后按名兜底。
 * @param {number} [pid] 被测应用主进程 pid
 * @param {string[]} [images] 额外按名清扫的映像（默认清 Chrome，避免遗留登录窗口）
 */
function cleanupRun(pid, images = ['chrome.exe']) {
  killTree(pid)
  for (const img of images) killImage(img)
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
