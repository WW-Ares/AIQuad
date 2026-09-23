/**
 * 启动冒烟：用**隔离 userData** 起一个开发实例，确认主进程能正常起来、7 秒不退出。
 *
 * 为什么需要隔离目录：Electron 的单实例锁按 userData 路径取（不是按 APPDATA 环境变量），
 * 用同一份目录会和大王正开着的实例撞锁 → 静默退出，看着像"程序坏了"。
 *
 * 本脚本把 panes 置空、并把浏览器启动参数里的 --window-position 交给我们自己的 buildArgs，
 * 所以不会在屏幕上弹分格。收尾只 kill 本进程树（/PID /T），**绝不按映像名全杀**。
 */
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const udd = path.join(os.tmpdir(), 'aiquad-smoke-' + Date.now())

fs.mkdirSync(udd, { recursive: true })
fs.writeFileSync(path.join(udd, 'config.json'), JSON.stringify({
  version: 6,
  layout: '1',
  panes: [],
  cacheCleanup: 'off',
  aiList: [],
  shortcuts: { toggleFloat: 'Alt+Space', layout1: '', layout2: '', layout4: '' },
}))

/**
 * ⚠️ 沙箱会把 `ELECTRON_RUN_AS_NODE=1` 注入环境。带着它启动 electron.exe，进程会以
 * **纯 node 模式**运行：`require('electron')` 返回的是可执行文件路径字符串、而不是 API
 * 对象，主进程第一句 `electron.app.getVersion()`（updater.js）就会抛
 * `Cannot read properties of undefined`。所以必须先把它摘掉。
 */
const env = { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, [root, `--user-data-dir=${udd}`, '--in-process-gpu', '--disable-gpu'], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (d) => { out += d.toString() })
child.stderr.on('data', (d) => { out += d.toString() })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  await wait(7000)
  const alive = child.exitCode === null && !child.killed
  let procs = ''
  try {
    procs = execFileSync('C:\\Windows\\System32\\tasklist.exe', ['/FI', `PID eq ${child.pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
  }
  catch {}
  console.log(`主进程存活: ${alive}   exitCode=${child.exitCode}`)
  console.log(`tasklist : ${procs.trim() || '(无)'}`)
  console.log('--- 应用输出（末尾 40 行）---')
  console.log(out.split(/\r?\n/).slice(-40).join('\n') || '(无输出)')
  // 收尾：只杀掉本实例的进程树（浏览器是它的子进程，detached=false，/T 够用）
  try { execFileSync('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) }
  catch {}
  await wait(1500)
  try { fs.rmSync(udd, { recursive: true, force: true }) } catch {}
  console.log(alive ? '\n冒烟通过 ✅（主进程 7 秒未退出）' : '\n冒烟失败 ❌（主进程提前退出）')
  process.exit(alive ? 0 : 1)
})()
