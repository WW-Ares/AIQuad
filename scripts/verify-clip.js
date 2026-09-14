/**
 * 验证「标准窗口 + 工具栏裁剪」方案的关键数学：
 *
 *   目标：让页面内容区（viewport）精确落在分格矩形内，浏览器工具栏被裁到可视区之外。
 *
 * 做法：MoveWindow 到 (X, Y, W, H) 后，
 *   - 窗口宽 W 应使客户区宽 ≈ innerWidth → W = r.width + 左边框 + 右边框
 *   - 窗口高 H 与 viewport 高应满足 innerHeight = H - uiHeight
 * 本脚本在真实 Chrome 上实测这些量，确认公式可用。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { detectBrowsers } = require('../dist/main/browser-detect')
const { CdpSession, pickPageTarget } = require('../dist/main/cdp')
const w32 = require('../dist/main/win32')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function rectOf(hwnd) {
  const r = w32.getWindowRect(hwnd)
  if (!r) return null
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }
}

async function waitWindow(pid, timeoutMs = 45000) {
  const start = Date.now()
  let hwnd = 0
  while (Date.now() - start < timeoutMs) {
    const h = w32.findBrowserWindowByPid(pid)
    if (h) {
      const r = rectOf(h)
      if (r && r.w > 200 && r.h > 200) {
        hwnd = h
        break
      }
    }
    await sleep(350)
  }
  if (!hwnd) return 0
  await sleep(1500)
  return w32.findBrowserWindowByPid(pid) || hwnd
}

async function waitDevToolsPort(profileDir, timeoutMs = 30000) {
  const file = path.join(profileDir, 'DevToolsActivePort')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (fs.existsSync(file)) {
        const port = Number(fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)[0])
        if (port > 0) return port
      }
    }
    catch {}
    await sleep(200)
  }
  return 0
}

async function main() {
  const browsers = await detectBrowsers()
  const b = browsers.find((x) => x.channel === 'chrome') || browsers[0]
  console.log('浏览器:', b.name, b.version)

  const profileDir = path.join(os.tmpdir(), `aiquad-clip-${Date.now()}`)
  fs.mkdirSync(profileDir, { recursive: true })

  console.log('\n=== 1. 以标准窗口启动（非 --app） ===')
  const args = [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1000,760',
    'https://example.com',
  ]
  const proc = spawn(b.exePath, args, { stdio: 'ignore' })
  const port = await waitDevToolsPort(profileDir)
  if (!port) {
    console.error('FAIL: 未拿到调试端口')
    process.exit(1)
  }
  const hwnd = await waitWindow(proc.pid)
  if (!hwnd) {
    console.error('FAIL: 未找到浏览器窗口')
    process.exit(1)
  }
  console.log('  调试端口:', port, ' HWND: 0x' + hwnd.toString(16))

  // 诊断：该进程下所有候选窗口，确认是否有多个窗口导致张冠李戴
  await sleep(1200)
  const all = w32.findWindowsByPid(proc.pid)
  console.log('  进程窗口清单:')
  for (const h of all) {
    const cls = w32.getClassName(h)
    const r = rectOf(h)
    console.log(`    HWND 0x${h.toString(16)}  类名=${cls}  尺寸=${r ? `${r.w}×${r.h}` : 'n/a'}${h === hwnd ? '  ← 选中' : ''}`)
  }
  const pages = await (async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      return await res.json()
    }
    catch {
      return []
    }
  })()
  console.log('  CDP 页面清单:')
  for (const p of pages.filter((x) => x.type === 'page')) {
    console.log(`    ${p.url}  title=${JSON.stringify(p.title)}`)
  }

  const target = await pickPageTarget(port, 'example.com')
  const cdp = new CdpSession(target.webSocketDebuggerUrl)
  await cdp.connect()

  const evalNum = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
    return r?.result?.value
  }

  console.log('\n=== 2. 测量浏览器自身特征 ===')
  const displayMode = await evalNum(`matchMedia('(display-mode: browser)').matches`)
  const standalone = await evalNum(`matchMedia('(display-mode: standalone)').matches`)
  const uiHeight = await cdp.measureChromeUiHeight()
  console.log(`  display-mode: browser = ${displayMode}   standalone = ${standalone}`)
  console.log(`  浏览器 UI 高度 uiHeight = ${uiHeight}px（标签栏+地址栏+边框）`)
  if (displayMode !== true || standalone !== false) {
    console.error('  ❌ 标准窗口模式下 display-mode 不是 browser，方案前提被破坏')
  }
  else {
    console.log('  ✅ 页面认为自己运行在普通浏览器窗口里')
  }

  const insets = w32.windowFrameInsets(hwnd)
  console.log(`  边框内衬: left=${insets.left} top=${insets.top} right=${insets.right} bottom=${insets.bottom}`)

  console.log('\n=== 3. 按裁剪公式定位窗口，验证内容区尺寸 ===')
  // 模拟分格矩形（相对宿主客户区；此处直接当作屏幕坐标测试）
  const pane = { x: 120, y: 140, w: 720, h: 480 }
  const X = pane.x - insets.left
  const Y = pane.y - Math.max(0, uiHeight - insets.bottom)
  const W = pane.w + insets.left + insets.right
  const H = pane.h + uiHeight
  console.log(`  目标分格: ${pane.w}×${pane.h} @ (${pane.x},${pane.y})`)
  console.log(`  → MoveWindow(${X}, ${Y}, ${W}, ${H})`)
  w32.moveWindow(hwnd, X, Y, W, H)
  await sleep(900)

  const got = rectOf(hwnd)
  console.log(`  实际窗口矩形: ${got.w}×${got.h} @ (${got.x},${got.y})`)

  const innerW = await evalNum('window.innerWidth')
  const innerH = await evalNum('window.innerHeight')
  console.log(`  页面 viewport: ${innerW}×${innerH}`)
  const expectInnerH = H - uiHeight
  console.log(`  期望 viewport 高 = 窗口高 ${H} - uiHeight ${uiHeight} = ${expectInnerH}`)

  const okH = Math.abs(innerH - pane.h) <= 2
  const okW = Math.abs(innerW - pane.w) <= 20
  console.log(`  纵向对齐: ${okH ? '✅ 精确吻合' : `⚠️ 偏差 ${innerH - pane.h}px`}`)
  console.log(`  横向对齐: ${okW ? '✅ 吻合（差值来自垂直滚动条）' : `⚠️ 偏差 ${innerW - pane.w}px`}`)

  console.log('\n=== 4. 嵌入宿主窗口验证（用记事本作宿主） ===')
  let hostPid = 0
  try {
    const np = spawn('notepad.exe', [], { stdio: 'ignore' })
    hostPid = np.pid
    await sleep(2500)
    const wins = w32.findWindowsByPid(hostPid)
    let host = 0
    for (const h of wins) {
      const r = rectOf(h)
      if (r && r.w > 200 && r.h > 200) {
        host = h
        break
      }
    }
    if (!host) {
      console.log('  跳过：未找到记事本窗口（Windows 11 新版记事本为 UWP，可能延迟较大）')
    }
    else {
      console.log(`  宿主 HWND: 0x${host.toString(16)}  类名=${w32.getClassName(host)}`)
      // 用宿主做嵌入，分格取宿主客户区内的一个矩形
      const hostRect = rectOf(host)
      w32.makeChildWindow(hwnd)
      w32.setParent(hwnd, host)
      w32.makeChildWindow(hwnd)
      const inner = { x: 40, y: 60, w: hostRect.w - 80, h: hostRect.h - 100 }
      const ins2 = w32.windowFrameInsets(hwnd)
      w32.moveWindow(
        hwnd,
        inner.x - ins2.left,
        inner.y - Math.max(0, uiHeight - ins2.bottom),
        inner.w + ins2.left + ins2.right,
        inner.h + uiHeight,
      )
      w32.showWindow(hwnd, w32.SW_SHOW)
      await sleep(1200)
      const innerW2 = await evalNum('window.innerWidth')
      const innerH2 = await evalNum('window.innerHeight')
      console.log(`  嵌入后 viewport: ${innerW2}×${innerH2}（期望 ${inner.w}×${inner.h}）`)
      const ok2 = Math.abs(innerH2 - inner.h) <= 3 && Math.abs(innerW2 - inner.w) <= 25
      console.log(`  ${ok2 ? '✅ 嵌入后内容区与目标矩形对齐（工具栏已被裁掉）' : '⚠️ 嵌入后存在偏差，需检查'}`)
      console.log('  注：记事本窗口会残留一个被嵌入的 Chrome 窗口，脚本会一并关闭')
    }
    try { process.kill(hostPid) } catch {}
  }
  catch (e) {
    console.log('  宿主验证跳过:', e.message)
  }

  console.log('\n=== 5. 清理 ===')
  try { cdp.close() } catch {}
  try { process.kill(proc.pid) } catch {}
  await sleep(800)
  console.log('完成')
  process.exit(0)
}

main().catch((e) => {
  console.error('VERIFY FAILED:', e)
  process.exit(1)
})
