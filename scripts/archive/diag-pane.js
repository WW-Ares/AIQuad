/**
 * 分格适配诊断：找出「预览器显示不完全 / 点击错位 / 顶栏被盖住」的真正原因。
 *
 * 测量项：
 *   A. 标准窗口模式下的**最小窗口尺寸**（Chrome 会因为工具栏而拒绝缩小）
 *   B. 应用窗口（--app）模式下的最小尺寸（作为对照）
 *   C. SetWindowRgn 能否用来裁掉工具栏（区域是否会被 Chrome 重置）
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const koffi = require('koffi')
const { detectBrowsers } = require('../dist/main/browser-detect')
const w32 = require('../dist/main/win32')

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')
const CreateRectRgn = gdi32.func('CreateRectRgn', 'uint64', ['int', 'int', 'int', 'int'])
const SetWindowRgn = user32.func('SetWindowRgn', 'int', ['uint64', 'uint64', 'int'])
const GetWindowRgn = user32.func('GetWindowRgn', 'int', ['uint64', 'uint64'])
const GetRgnBox = gdi32.func('GetRgnBox', 'int', ['uint64', 'uint8 *'])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rectOf = (h) => {
  const r = w32.getWindowRect(h)
  return r ? { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top } : null
}

async function waitDevToolsPort(dir, timeoutMs = 40000) {
  const file = path.join(dir, 'DevToolsActivePort')
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (fs.existsSync(file)) {
        const p = Number(fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)[0])
        if (p > 0) return p
      }
    }
    catch {}
    await sleep(200)
  }
  return 0
}

async function waitWindow(pid, timeoutMs = 40000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const h = w32.findBrowserWindowByPid(pid)
    if (h) {
      const r = rectOf(h)
      if (r && r.w > 150 && r.h > 150) return h
    }
    await sleep(300)
  }
  return 0
}

function regionBox(hwnd) {
  const rgn = CreateRectRgn(0, 0, 0, 0)
  const kind = GetWindowRgn(hwnd, rgn)
  if (kind === 0) return null
  const buf = Buffer.alloc(16)
  GetRgnBox(rgn, buf)
  return {
    left: buf.readInt32LE(0), top: buf.readInt32LE(4),
    right: buf.readInt32LE(8), bottom: buf.readInt32LE(12),
  }
}

async function testMode(label, extraArgs) {
  console.log(`\n=== ${label} ===`)
  const dir = path.join(os.tmpdir(), `aiquad-pane-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  const proc = spawn(B.exePath, [
    `--user-data-dir=${dir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-blink-features=AutomationControlled',
    ...extraArgs,
  ], { stdio: 'ignore' })

  const port = await waitDevToolsPort(dir)
  const hwnd = await waitWindow(proc.pid)
  if (!hwnd) {
    console.log('  ❌ 未找到窗口')
    try { process.kill(proc.pid) } catch {}
    return null
  }
  await sleep(1500)
  const startRect = rectOf(hwnd)
  console.log(`  HWND 0x${hwnd.toString(16)}  启动尺寸 ${startRect.w}×${startRect.h}  类名 ${w32.getClassName(hwnd)}`)

  // 列出该进程所有窗口，确认选中的是主窗口
  console.log('  进程窗口:')
  for (const h of w32.findWindowsByPid(proc.pid)) {
    const r = rectOf(h)
    console.log(`    0x${h.toString(16)} ${w32.getClassName(h).padEnd(20)} ${r ? `${r.w}×${r.h}` : 'n/a'} visible=${w32.isWindowVisible(h)}${h === hwnd ? '  ← 选中' : ''}`)
  }

  // ---- A. 最小尺寸测试 ----
  console.log('  --- 尺寸写入测试（请求 → 实际）---')
  const sizes = [[240, 300], [270, 340], [300, 300], [360, 300], [420, 340], [480, 360], [520, 400], [640, 480], [760, 560]]
  const results = []
  for (const [w, h] of sizes) {
    w32.moveWindow(hwnd, 60, 60, w, h)
    await sleep(500)
    const got = rectOf(hwnd)
    const clamped = got.w > w + 4 || got.h > h + 4
    results.push({ w, h, gw: got.w, gh: got.h })
    console.log(`    请求 ${String(w).padStart(4)}×${String(h).padStart(4)}  →  实际 ${String(got.w).padStart(4)}×${String(got.h).padStart(4)}   ${clamped ? '⚠️ 被放大' : 'ok'}`)
  }
  const minW = Math.min(...results.filter((r) => r.gw > r.w + 4).map((r) => r.gw))
  console.log(`  ⇒ 最小可达到宽度 ≈ ${Number.isFinite(minW) ? minW : results[0].gw}px`)

  // ---- C. 区域裁剪测试 ----
  console.log('  --- SetWindowRgn 裁剪测试 ---')
  w32.moveWindow(hwnd, 60, 60, 700, 600)
  await sleep(600)
  const ins = w32.windowFrameInsets(hwnd)
  const topStrip = Math.max(0, (await measureUi(port)) - (ins?.bottom ?? 0))
  console.log(`  uiHeight=${await measureUi(port)}  insets.top=${ins?.top} topStrip=${topStrip}`)
  const rgn = CreateRectRgn(0, topStrip, 700, 600)
  const okSet = SetWindowRgn(hwnd, rgn, 1)
  await sleep(400)
  console.log(`  SetWindowRgn ret=${okSet}  立即读回区域: ${JSON.stringify(regionBox(hwnd))}`)
  await sleep(2500)
  console.log(`  2.5s 后读回区域: ${JSON.stringify(regionBox(hwnd))}   ${regionBox(hwnd) ? '✅ 区域保持' : '❌ 区域被 Chrome 重置'}`)
  // 触发一次 Chrome 自身尺寸变更后再看
  w32.moveWindow(hwnd, 60, 60, 660, 560)
  await sleep(1200)
  console.log(`  改变尺寸后区域: ${JSON.stringify(regionBox(hwnd))}`)

  try { process.kill(proc.pid) } catch {}
  await sleep(500)
  return { hwnd, minW }
}

async function measureUi(port) {
  try {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = pages.find((p) => p.type === 'page' && /^https?:/.test(p.url))
    if (!page) return 0
    const { CdpSession } = require('../dist/main/cdp')
    const cdp = new CdpSession(page.webSocketDebuggerUrl)
    await cdp.connect()
    const v = await cdp.measureChromeUiHeight()
    cdp.close()
    return v
  }
  catch {
    return 0
  }
}

let B = null

async function main() {
  const browsers = await detectBrowsers()
  B = browsers.find((x) => x.channel === 'chrome') || browsers[0]
  console.log('浏览器:', B.name, B.version)

  const std = await testMode('A/B. 标准窗口模式（当前实现）', ['--window-size=1000,760', 'https://example.com'])
  await sleep(1500)
  const app = await testMode('对照：--app 应用窗口模式', ['--app=https://example.com'])

  console.log('\n================ 结论 ================')
  console.log(`标准窗口最小宽度: ${std ? std.minW : 'n/a'}px   --app 最小宽度: ${app ? app.minW : 'n/a'}px`)
  console.log('若标准窗口最小宽度 > 分格宽度，则窄分格下浏览器窗口会溢出分格，')
  console.log('表现为：内容显示不全、遮挡相邻分格的按钮、点击位置错位。')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
