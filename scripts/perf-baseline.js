/**
 * 性能基线。
 *
 * 为什么要有它（2026-09-15）：优化之前手上一条基线数据都没有——冷启动多少毫秒、
 * 收起态占多少内存、那 4 个进程各自负责什么、4 个 AI 页面又各占多少。
 * 没有基线，优化就是盲改，改完也不知道有没有效。
 *
 * 本脚本量四件事，全部落到 `.tmp/perf-baseline-*.txt`：
 *   1. 冷启动      —— spawn 到"渲染进程出现"、到"浏览器实例进程出现"的耗时
 *   2. 收起态      —— 面板未显示时，应用自身各进程的内存与角色
 *   3. 展开态      —— 呼出面板（Alt+Space）并起满 4 分格后的内存与进程数
 *   4. AI 页面     —— 应用拉起的那些 Chrome 进程各占多少（这块很可能比面板本身大得多）
 *
 * 用法：
 *   node scripts/perf-baseline.js
 *   AIQUAD_TEST_PORT=9280 node scripts/perf-baseline.js --hold 20
 *
 * 注意：脚本会真的呼出面板（用 PowerShell 发全局快捷键 Alt+Space）。
 * 想只量收起态就加 `--no-show`。跑之前把已运行的 AIQuad 关掉，否则单实例锁会让
 * 新起的这个直接退出（窗口没有、日志正常、退出码 0，很坑）。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')

const projectRoot = path.join(__dirname, '..')
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const args = process.argv.slice(2)
const NO_SHOW = args.includes('--no-show')
const HOLD = Number((args[args.indexOf('--hold') + 1]) || 0)

const outDir = path.join(projectRoot, '.tmp')
fs.mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outPath = path.join(outDir, `perf-baseline-${stamp}.txt`)

const lines = []
function log(s) {
  lines.push(s)
  console.log(s)
}

/* ---------------- 采样：走 PowerShell，一次拿全 ---------------- */

const PS = `
$ErrorActionPreference='SilentlyContinue'
$app = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'") + @(Get-CimInstance Win32_Process -Filter "Name='AIQuad.exe'")
$chrome = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*aiquad*' })
$now = Get-Date
function Mk($p, $kind) {
  $age = if ($p.CreationDate) { [math]::Round((New-TimeSpan -Start $p.CreationDate -End $now).TotalSeconds, 1) } else { -1 }
  [pscustomobject]@{
    kind = $kind
    pid = $p.ProcessId
    mb = [math]::Round($p.WorkingSetSize/1MB, 1)
    age = $age
    cmd = ($p.CommandLine -replace '"','')
  }
}
$rows = @()
foreach ($p in $app) { $rows += Mk $p 'app' }
foreach ($p in $chrome) { $rows += Mk $p 'chrome' }
$rows | ConvertTo-Json -Depth 4
`

/** @returns {{app: any[], chrome: any[]}} */
function sample() {
  const raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  let rows
  try {
    rows = JSON.parse(raw)
  }
  catch {
    return { app: [], chrome: [] }
  }
  if (!Array.isArray(rows)) rows = [rows]
  return {
    app: rows.filter((r) => r.kind === 'app'),
    chrome: rows.filter((r) => r.kind === 'chrome'),
  }
}

/** 按命令行里的 --type= 判断 Electron 进程的角色 */
function roleOf(cmd) {
  const m = /--type=([^\s]+)/.exec(cmd || '')
  if (!m) return 'main（主进程）'
  const t = m[1]
  const map = {
    gpu: 'GPU 进程',
    renderer: '渲染进程（面板 UI）',
    utility: '工具进程',
    'crashpad-handler': '崩溃上报',
    browser: 'browser',
  }
  return map[t] || t
}

function reportApp(title, rows) {
  const total = rows.reduce((s, r) => s + r.mb, 0)
  log(`  ${title}：${rows.length} 个进程，工作集合计 ${total.toFixed(1)}MB`)
  const sorted = [...rows].sort((a, b) => b.mb - a.mb)
  for (const r of sorted) {
    log(`    ${String(Math.round(r.mb)).padStart(5)}MB  pid=${String(r.pid).padStart(6)}  ${roleOf(r.cmd)}`)
  }
  return total
}

function reportChrome(title, rows) {
  if (!rows.length) {
    log(`  ${title}：0 个浏览器进程`)
    return 0
  }
  const total = rows.reduce((s, r) => s + r.mb, 0)
  log(`  ${title}：${rows.length} 个 Chrome 进程，工作集合计 ${total.toFixed(1)}MB`)
  const sorted = [...rows].sort((a, b) => b.mb - a.mb)
  for (const r of sorted.slice(0, 12)) {
    const isMain = /--type=/.test(r.cmd || '') ? '' : ' (浏览器主进程)'
    log(`    ${String(Math.round(r.mb)).padStart(5)}MB  pid=${String(r.pid).padStart(6)}${isMain}`)
  }
  return total
}

const VK = {
  Alt: 0x12, Control: 0x11, Ctrl: 0x11, Shift: 0x10, Meta: 0x5B, Super: 0x5B,
  Space: 0x20, Enter: 0x0D, Tab: 0x09, Esc: 0x1B, Backspace: 0x08,
}

/** 把 'Alt+Space' / 'Ctrl+Alt+1' 解析成虚拟键码数组 */
function parseAccelerator(acc) {
  const parts = String(acc || '').split('+').map((s) => s.trim()).filter(Boolean)
  const codes = []
  for (const p of parts) {
    if (VK[p] !== undefined) codes.push(VK[p])
    else if (/^[A-Z]$/.test(p)) codes.push(p.charCodeAt(0))
    else if (/^[a-z]$/.test(p)) codes.push(p.toUpperCase().charCodeAt(0))
    else if (/^[0-9]$/.test(p)) codes.push(0x30 + Number(p))
    else if (/^F([1-9]|1[0-2])$/.test(p)) codes.push(0x6F + Number(p.slice(1)))
    else if (p === ' ') codes.push(0x20)
  }
  return codes
}

/**
 * 发全局快捷键把面板呼出来。
 *
 * 一开始用的是 `SendKeys::SendWait("%{ }")`，实测在非交互会话里发不出去（返回成功但
 * 快捷键没触发）。改用 `keybd_event` 直接投按键。
 *
 * 快捷键从应用自己的 config.json 里读（`shortcuts.toggleFloat`），用户改过也能对上；
 * 也可以 `--key "Ctrl+Alt+Q"` 手动指定。
 */
function pressToggle(acc) {
  const codes = parseAccelerator(acc)
  if (!codes.length) return false
  const down = codes.map((c) => `[K]::keybd_event(${c},0,0,0)`).join('\n')
  const up = [...codes].reverse().map((c) => `[K]::keybd_event(${c},0,2,0)`).join('\n')
  const ps = `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class K{[DllImport("user32.dll")]public static extern void keybd_event(byte bVk,byte bScan,uint f,uint e);}
"@
${down}
${up}
`
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' })
    return true
  }
  catch {
    return false
  }
}

/** 应用自己的配置（拿呼出快捷键和当前分格数） */
function readAppConfig() {
  const p = path.join(process.env.APPDATA || '', 'aiquad', 'config.json')
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  catch {
    return null
  }
}

/**
 * 面板窗口是否已经可见。
 *
 * 判据是「有标题为 AIQuad 的窗口且可见」。浏览器实例窗口虽然也是
 * `Chrome_WidgetWin_1`，但标题是网页标题，不会撞。
 */
function panelVisible() {
  const ps = `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class W{
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string a,string b);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@
$h = [W]::FindWindow($null, 'AIQuad')
if ($h -ne [IntPtr]::Zero -and [W]::IsWindowVisible($h)) { '1' } else { '0' }
`
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })
    return out.trim().startsWith('1')
  }
  catch {
    return false
  }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  log('=== AIQuad 性能基线 ===')
  log(`时间 ${new Date().toLocaleString('zh-CN')}`)
  log(`模式 ${NO_SHOW ? '只量收起态' : '收起态 + 展开态'}`)
  log('')

  // 先确认没有残留实例，否则新起的这个会被单实例锁挡掉
  const before = sample()
  if (before.app.length) {
    log(`⚠ 检测到 ${before.app.length} 个已在运行的应用进程，请先关掉 AIQuad 再跑本脚本`)
    log('  （单实例锁会让新起的实例直接退出：窗口没有、日志正常、退出码 0）')
    fs.writeFileSync(outPath, lines.join('\n'))
    return
  }

  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  delete env.ELECTRON_RUN_AS_NODE

  const t0 = Date.now()
  const child = spawn(electronExe, [projectRoot, '--enable-logging'], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (d) => { output += d.toString() })
  child.stderr.on('data', (d) => { output += d.toString() })

  // 冷启动：轮询到渲染进程 / 浏览器进程出现为止
  let tRenderer = 0
  let tChrome = 0
  for (let i = 0; i < 120; i++) {
    await sleep(250)
    const s = sample()
    if (!tRenderer && s.app.some((r) => /--type=renderer/.test(r.cmd || ''))) tRenderer = Date.now() - t0
    if (!tChrome && s.chrome.length) tChrome = Date.now() - t0
    if (tRenderer && tChrome) break
  }

  log('--- 冷启动 ---')
  log(`  面板渲染进程出现：${tRenderer || '-'} ms`)
  log(`  浏览器实例进程出现：${tChrome || '-'} ms`)
  log('')

  // 让浏览器实例把页面加载完
  await sleep(6000)

  log('--- 收起态（面板未显示）---')
  const idle = sample()
  const idleApp = reportApp('应用自身', idle.app)
  const idleChrome = reportChrome('AI 页面', idle.chrome)
  log(`  合计 ${(idleApp + idleChrome).toFixed(1)}MB`)
  log('')

  let shownApp = 0
  let shownChrome = 0
  if (!NO_SHOW) {
    const appCfg = readAppConfig()
    const keyArg = args.indexOf('--key')
    const acc = keyArg >= 0 ? args[keyArg + 1] : (appCfg?.shortcuts?.toggleFloat || 'Alt+Space')
    log(`--- 呼出面板（快捷键 ${acc}${appCfg?.layout ? `，当前 ${appCfg.layout} 分格` : ''}）---`)
    const ok = pressToggle(acc)
    // 轮询确认面板真的出来了，最多等 6 秒（快捷键没生效就如实记录）
    let visible = false
    for (let i = 0; i < 12 && !visible; i++) {
      await sleep(500)
      visible = panelVisible()
    }
    log(`--- 展开态（快捷键${ok ? '已发送' : '发送失败'}，面板${visible ? '已呼出' : '未呼出 ⚠ 数据仍是收起态'}）---`)
    // 等 4 个分格的浏览器窗口落位
    await sleep(6000)
    const shown = sample()
    shownApp = reportApp('应用自身', shown.app)
    shownChrome = reportChrome('AI 页面', shown.chrome)
    log(`  合计 ${(shownApp + shownChrome).toFixed(1)}MB`)
    log('')

    log('--- 差值（展开 − 收起）---')
    log(`  应用自身 ${(shownApp - idleApp >= 0 ? '+' : '')}${(shownApp - idleApp).toFixed(1)}MB`)
    log(`  AI 页面   ${(shownChrome - idleChrome >= 0 ? '+' : '')}${(shownChrome - idleChrome).toFixed(1)}MB`)
    log('')
  }

  if (HOLD) await sleep(HOLD * 1000)

  log('--- 判读提示 ---')
  log('  1. 收起态的"应用自身"是纯常驻开销，优化目标主要看这一项')
  log('  2. "AI 页面"是外部 Chrome 进程，换外壳一分省不掉；实测它才是内存大头')
  log('  3. 进程角色按命令行 --type= 判断：gpu 是 GPU 进程，renderer 是面板 UI')
  log('  4. 反复跑几次取中位数，单次采样受页面加载进度影响很大')
  log('  5. 收起只是把浏览器窗口**隐藏**（suppressed），进程和页面都还在跑，')
  log('     所以收起态与展开态的"AI 页面"内存基本一样——要省这块得靠休眠，不是靠收起')
  log('  6. 若"面板未呼出"：脚本是在无桌面会话里发的键，keybd_event 不生效属正常，')
  log('     手动按一次快捷键或用 --hold 30 留时间给自己按')

  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  }
  catch {}
  try {
    execFileSync('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' })
  }
  catch {}
  // 只清本应用拉起的 Chrome（命令行带 aiquad 档案目录），别把用户自己开的浏览器杀了
  for (const p of sample().chrome) {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' })
    }
    catch {}
  }

  fs.writeFileSync(outPath, lines.join('\n'))
  console.log(`\n结果已写入 ${outPath}`)
  if (output.trim()) {
    const tail = output.trim().split('\n').slice(-25).join('\n')
    fs.writeFileSync(outPath.replace(/\.txt$/, '.log.txt'), tail)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error('FATAL', e)
  fs.writeFileSync(outPath, lines.join('\n') + '\nFATAL ' + String(e))
  process.exit(1)
})
