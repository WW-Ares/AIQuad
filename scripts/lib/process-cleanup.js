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

module.exports = { killTree, killImage, cleanupRun }
