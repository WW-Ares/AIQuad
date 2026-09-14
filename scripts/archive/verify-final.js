/**
 * 最终方案验证（顶级窗口 + 窗口区域裁剪 + SWP_NOSENDCHANGING）
 *
 * 方案要点：
 *   1. 浏览器窗口保持**顶级窗口**（不 SetParent）→ 键盘 / 输入法原生可用
 *   2. `SWP_NOSENDCHANGING` 绕过 Chrome 的最小宽度钳制（标准窗口默认最小 516px）
 *   3. `SetWindowRgn` 把工具栏从可视区裁掉（不遮挡面板顶栏、不接收误点）
 *   4. `WS_EX_TOOLWINDOW` 不进任务栏 / Alt+Tab
 *
 * 输出：viewport 对齐精度、display-mode、insets 读数、真实键盘可用性。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const koffi = require('koffi')
const { detectBrowsers } = require('../dist/main/browser-detect')
const { CdpSession, pickPageTarget } = require('../dist/main/cdp')
const w32 = require('../dist/main/win32')

const user32 = koffi.load('user32.dll')
const SetCursorPos = user32.func('SetCursorPos', 'int', ['int', 'int'])
const mouse_event = user32.func('mouse_event', 'void', ['uint32', 'uint32', 'uint32', 'uint32', 'uint64'])
const SendInput = user32.func('SendInput', 'uint32', ['uint32', 'uint8 *', 'int'])
const GetForegroundWindow = user32.func('GetForegroundWindow', 'uint64', [])
const SetWindowPos = user32.func('SetWindowPos', 'int', ['uint64', 'uint64', 'int', 'int', 'int', 'int', 'uint32'])

const SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_NOSENDCHANGING = 0x0400

/** 关键：带 SWP_NOSENDCHANGING 的移动，绕过 Chrome 的最小尺寸钳制 */
function moveNoClamp(hwnd, x, y, w, h) {
  SetWindowPos(hwnd, 0, Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)),
    SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING)
}

const INPUT_SIZE = 40
function sendUnicode(text) {
  const buf = Buffer.alloc(INPUT_SIZE)
  const one = (ch, up) => {
    buf.fill(0)
    buf.writeUInt32LE(1, 0)
    buf.writeUInt16LE(ch.charCodeAt(0), 10)
    buf.writeUInt32LE(0x0004 | (up ? 0x0002 : 0), 12)
    return SendInput(1, buf, INPUT_SIZE)
  }
  let n = 0
  for (const ch of text) { n += one(ch, false); n += one(ch, true) }
  return n
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rectOf = (h) => { const r = w32.getWindowRect(h); return r ? { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top } : null }
async function clickAt(x, y) {
  SetCursorPos(x, y); await sleep(180)
  mouse_event(0x0002, 0, 0, 0, 0n); await sleep(90)
  mouse_event(0x0004, 0, 0, 0, 0n); await sleep(400)
}

/** 对给定分格尺寸做一次完整流程，返回各项结果 */
async function runCase(B, page, host, hostR, pane, label) {
  const dir = path.join(os.tmpdir(), `aiquad-final-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  const proc = spawn(B.exePath, [
    `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--hide-crash-restore-bubble', '--disable-blink-features=AutomationControlled', '--disable-background-networking',
    '--window-position=-32000,-32000', '--window-size=1000,760', page,
  ], { stdio: 'ignore' })

  let hwnd = 0
  const t0 = Date.now()
  while (Date.now() - t0 < 40000) {
    const h = w32.findBrowserWindowByPid(proc.pid)
    if (h) { const r = rectOf(h); if (r && r.w > 200 && r.h > 150) { hwnd = h; break } }
    await sleep(300)
  }
  if (!hwnd) { console.log(`  ${label}: FAIL 无窗口`); return null }
  let port = 0
  const pf = path.join(dir, 'DevToolsActivePort')
  for (let i = 0; i < 120 && !port; i++) { try { if (fs.existsSync(pf)) port = Number(fs.readFileSync(pf, 'utf8').trim().split(/\r?\n/)[0]) } catch {}; if (!port) await sleep(200) }
  const target = await pickPageTarget(port, '127.0.0.1')
  const cdp = new CdpSession(target.webSocketDebuggerUrl)
  await cdp.connect()
  const num = async (e) => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.value

  // 进任务栏隐藏（需在隐藏状态下改 ex-style）
  w32.showWindow(hwnd, w32.SW_HIDE)
  await sleep(250)
  w32.makeToolWindow(hwnd)
  w32.showWindow(hwnd, w32.SW_SHOW)

  // 目标内容区（屏幕坐标）= 面板位置 + 分格相对偏移
  const contentX = hostR.x + pane.x
  const contentY = hostR.y + pane.y

  // 第一轮：以估算值定位（此时窗口移到屏幕内，insets 才测得准）
  let ins = { left: 8, right: 8, bottom: 8 }
  let ui = await num('Math.max(0, Math.round(window.outerHeight - window.innerHeight))')
  let topStrip = Math.max(0, ui - ins.bottom)
  let geo = null
  for (let i = 0; i < 4; i++) {
    geo = {
      x: contentX - ins.left, y: contentY - topStrip,
      w: pane.w + ins.left + ins.right, h: pane.h + topStrip + ins.bottom,
    }
    moveNoClamp(hwnd, geo.x, geo.y, geo.w, geo.h)
    await sleep(600)
    const ni = w32.windowFrameInsets(hwnd)
    const nu = await num('Math.max(0, Math.round(window.outerHeight - window.innerHeight))')
    const sane = ni && ni.left >= 0 && ni.left < 40 && ni.bottom >= 0 && ni.bottom < 40
    const nextIns = sane ? { left: ni.left, right: ni.right, bottom: ni.bottom } : ins
    const nextTop = Math.max(0, (nu > 0 ? nu : ui) - nextIns.bottom)
    const converged = nextIns.left === ins.left && nextIns.bottom === ins.bottom && Math.abs(nextTop - topStrip) <= 1
    ins = nextIns; ui = nu > 0 ? nu : ui; topStrip = nextTop
    if (converged) break
  }

  // 闭环校准宽度/高度：以页面 viewport 为准修正窗口尺寸
  let dw = 0, dh = 0
  for (let i = 0; i < 3; i++) {
    const iw = await num('window.innerWidth'), ih = await num('window.innerHeight')
    const ew = pane.w - iw, eh = pane.h - ih
    if (Math.abs(ew) <= 2 && Math.abs(eh) <= 2) break
    dw += ew; dh += eh
    moveNoClamp(hwnd, geo.x, geo.y, geo.w + dw, geo.h + dh)
    await sleep(500)
  }
  geo.w += dw; geo.h += dh

  // 区域裁剪 + 精确落位
  w32.setWindowRegion(hwnd, { x: ins.left, y: topStrip, width: pane.w, height: pane.h }, 0)
  moveNoClamp(hwnd, geo.x, geo.y, geo.w, geo.h)
  await sleep(500)

  const r = rectOf(hwnd)
  const iw = await num('window.innerWidth'), ih = await num('window.innerHeight')
  const dmB = await num(`matchMedia('(display-mode: browser)').matches`)
  const dmS = await num(`matchMedia('(display-mode: standalone)').matches`)
  const wd = await num('navigator.webdriver')
  const ex = Number(w32.getWindowLong(hwnd, -20))
  console.log(`  [${label}] 窗口 ${r.w}×${r.h} @(${r.x},${r.y})  期望 ${geo.w}×${geo.h} @(${geo.x},${geo.y})`)
  console.log(`  [${label}] uiHeight=${ui} topStrip=${topStrip} insets=${JSON.stringify(ins)}`)
  console.log(`  [${label}] viewport ${iw}×${ih}（目标 ${pane.w}×${pane.h}）误差 ${iw - pane.w},${ih - pane.h}`)
  console.log(`  [${label}] display-mode browser=${dmB} standalone=${dmS}  webdriver=${wd}  TOOLWINDOW=${(ex & 0x80) !== 0}`)

  // 真实点击 + 真实键盘（Unicode 注入）
  let typed = null
  if (label.startsWith('A') || label.startsWith('C')) {
    const box = await num(`(() => { const b = document.getElementById('box').getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height} })()`)
    if (box) {
      const hitX = Math.round(r.x + ins.left + box.x + box.w / 2)
      const hitY = Math.round(r.y + topStrip + box.y + box.h / 2)
      await clickAt(hitX, hitY)
      const fg = Number(GetForegroundWindow())
      await num(`document.getElementById('box').value=''`)
      await sleep(150)
      sendUnicode('aiz')
      await sleep(600)
      typed = await num(`document.getElementById('box').value`)
      console.log(`  [${label}] 点击(${hitX},${hitY}) 前台=0x${fg.toString(16)}${fg === hwnd ? '(浏览器✅)' : '(非浏览器)'}  activeElement=${await num('document.activeElement ? document.activeElement.id : null')}`)
      console.log(`  [${label}] >> 键盘输入 = ${JSON.stringify(typed)}  ${typed === 'aiz' ? '✅ 可用' : '❌ 不可用'}`)
    }
  }

  cdp.close()
  try { process.kill(proc.pid) } catch {}
  await sleep(600)
  return {
    ok: Math.abs(iw - pane.w) <= 2 && Math.abs(ih - pane.h) <= 2,
    dmB, dmS, wd, typed, toolbarHidden: null,
  }
}

async function main() {
  const browsers = await detectBrowsers()
  const B = browsers.find((x) => x.channel === 'chrome') || browsers[0]
  console.log('浏览器:', B.name, B.version)

  const testHtml = fs.readFileSync(path.join(__dirname, '..', '.tmp', 'input-test.html'))
  const server = http.createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(testHtml) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const page = `http://127.0.0.1:${server.address().port}/`

  const np = spawn('notepad.exe', [], { stdio: 'ignore' })
  await sleep(2500)
  let host = 0
  for (const h of w32.findWindowsByPid(np.pid)) { const r = rectOf(h); if (r && r.w > 300 && r.h > 300) { host = h; break } }
  w32.moveWindow(host, 1180, 0, 740, 1040)
  await sleep(500)
  const hostR = rectOf(host)
  console.log('面板模拟窗口:', JSON.stringify(hostR))

  // 1920×1080 屏幕、面板宽 576px（30%）时的真实分格尺寸
  console.log('\n=== 单格（内容区 536×960）===')
  const c1 = await runCase(B, page, host, hostR, { x: 20, y: 54, w: 536, h: 960 }, 'A 单格')

  console.log('\n=== 上下两格（每格内容区 536×450）===')
  const c2 = await runCase(B, page, host, hostR, { x: 20, y: 54, w: 536, h: 450 }, 'B 两格窄高')

  console.log('\n=== 2×2 四格（每格内容区 271×450 — 原来会被钳制到 516px）===')
  const c4 = await runCase(B, page, host, hostR, { x: 20, y: 54, w: 271, h: 450 }, 'C 四格')

  console.log('\n================ 结论 ================')
  for (const [n, c] of [['单格', c1], ['两格', c2], ['四格', c4]]) {
    if (!c) { console.log(`${n}: 未完成`); continue }
    console.log(`${n}: viewport 对齐 ${c.ok ? '✅' : '❌'}  display-mode browser=${c.dmB} standalone=${c.dmS}  webdriver=${c.wd}  键盘=${c.typed === 'aiz' ? '✅可用' : (c.typed === null ? '未测' : '❌不可用')}`)
  }

  try { server.close() } catch {}
  try { process.kill(np.pid) } catch {}
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
