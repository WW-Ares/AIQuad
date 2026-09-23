/**
 * 验证「浏览器顶层窗口所属进程的 pid === 启动它的那个进程 pid」。
 *
 * 这是"认领前验身"能不能靠 pid 做判据的前提：
 * 如果成立，就可以要求"候选窗口的 pid 必须是我自己 spawn 出来的那个进程"
 * —— 这是唯一能区分「AIQuad 起的 Chrome」与「用户自己开的 Chrome」的判据，
 * 因为两者的 exe 完全相同（都是系统 Chrome）。
 *
 * 用法：node scripts/verify-chrome-window-pid.js
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const w32 = require(path.join(ROOT, 'dist', 'main', 'win32.js'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

async function main() {
  const exe = CANDIDATES.find((p) => fs.existsSync(p))
  if (!exe) throw new Error('没找到 Chrome / Edge')
  console.log('浏览器：', exe)

  const profile = path.join(ROOT, '.tmp', 'appdata', 'q-pid', 'profile')
  fs.mkdirSync(profile, { recursive: true })

  const before = new Set(w32.listBrowserWindows().map((w) => w.hwnd))
  console.log('启动前已有的浏览器窗口：', before.size)

  const args = [
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--new-window', 'about:blank',
  ]
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exe, args, { detached: false, stdio: 'ignore' })
  console.log('spawn 出来的进程 pid =', child.pid)

  let win = null
  for (let i = 0; i < 100 && !win; i++) {
    await sleep(200)
    win = w32.listBrowserWindows().find((w) => !before.has(w.hwnd))
  }
  if (!win) throw new Error('没等到新窗口')

  const winExe = w32.processImagePath(win.pid)
  const createdAt = w32.processCreationTime(win.pid)
  const spawnAt = Date.now()

  console.log('\n===== 新窗口 =====')
  console.log('  hwnd       =', win.hwnd)
  console.log('  窗口 pid   =', win.pid)
  console.log('  spawn pid  =', child.pid)
  console.log('  进程 exe   =', winExe)
  console.log('  创建时间   =', new Date(createdAt).toLocaleString())
  console.log('  pid 是否一致 =', win.pid === child.pid ? '✅ 一致' : `❌ 不一致（差 ${win.pid - child.pid}）`)

  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  // ⚠️ 光杀进程树不够：窗口可能挂在一个**不是我们 spawn 的**进程上（见上方输出），
  // 那种进程杀不到，会在桌面上留下一个孤儿窗口。按档案目录再扫一遍才干净。
  try { require(path.join(ROOT, 'scripts', 'lib', 'process-cleanup')).killBrowsersUnder(profile) } catch {}
  await sleep(600)
  process.exitCode = win.pid === child.pid ? 0 : 3
}

main().catch((e) => { console.log('失败：', String(e?.message || e)); process.exitCode = 1 })
