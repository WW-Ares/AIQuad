/**
 * 输入可用性终局对比（修正版）：
 *   - 先在"可见但屏幕外"的状态下调整尺寸（Chrome 在隐藏时会忽略 resize）
 *   - 先设好窗口区域再移到最终位置（避免工具栏闪现）
 *   - 用 SendInput + KEYEVENTF_UNICODE 发真实键盘事件（不依赖键盘布局/扫描码）
 *
 * 对比 A. 顶级窗口（不嵌入） 与 B. 子窗口（SetParent 嵌入）的键盘可用性。
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
const gdi32 = koffi.load('gdi32.dll')
const SetCursorPos = user32.func('SetCursorPos', 'int', ['int', 'int'])
const mouse_event = user32.func('mouse_event', 'void', ['uint32', 'uint32', 'uint32', 'uint32', 'uint64'])
const SendInput = user32.func('SendInput', 'uint32', ['uint32', 'uint8 *', 'int'])
const SetForegroundWindow = user32.func('SetForegroundWindow', 'int', ['uint64'])
const GetForegroundWindow = user32.func('GetForegroundWindow', 'uint64', [])
const CreateRectRgn = gdi32.func('CreateRectRgn', 'uint64', ['int', 'int', 'int', 'int'])
const SetWindowRgn = user32.func('SetWindowRgn', 'int', ['uint64', 'uint64', 'int'])

const INPUT_SIZE = 40
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004

/** 用 SendInput 以 Unicode 方式逐字符发送（不经过 IME，验证键盘事件能否到达页面） */
function sendUnicode(text) {
  const buf = Buffer.alloc(INPUT_SIZE)
  const send = (ch, up) => {
    buf.fill(0)
    buf.writeUInt32LE(1, 0)                                   // INPUT_KEYBOARD
    buf.writeUInt16LE(0, 8)                                   // wVk
    buf.writeUInt16LE(ch.charCodeAt(0), 10)                   // wScan = 字符
    buf.writeUInt32LE(KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0), 12)
    return SendInput(1, buf, INPUT_SIZE)
  }
  let sent = 0
  for (const ch of text) {
    sent += send(ch, false)
    sent += send(ch, true)
  }
  return sent
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rectOf = (h) => {
  const r = w32.getWindowRect(h)
  return r ? { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top } : null
}

async function clickAt(x, y) {
  SetCursorPos(x, y)
  await sleep(150)
  mouse_event(0x0002, 0, 0, 0, 0n)
  await sleep(80)
  mouse_event(0x0004, 0, 0, 0, 0n)
  await sleep(300)
}

let B = null

async function runMode(label, embed, page, host, pane) {
  console.log(`\n=== ${label} ===`)
  const dir = path.join(os.tmpdir(), `aiquad-i2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  const proc = spawn(B.exePath, [
    `--user-data-dir=${dir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-networking',
    '--window-position=-32000,-32000',
    '--window-size=1000,760',
    page,
  ], { stdio: 'ignore' })

  let hwnd = 0
  const t0 = Date.now()
  while (Date.now() - t0 < 40000) {
    const h = w32.findBrowserWindowByPid(proc.pid)
    if (h) { const r = rectOf(h); if (r && r.w > 200 && r.h > 150) { hwnd = h; break } }
    await sleep(300)
  }
  if (!hwnd) { console.log('  FAIL: 无窗口'); return null }
  let port = 0
  const pf = path.join(dir, 'DevToolsActivePort')
  for (let i = 0; i < 120 && !port; i++) {
    try {
      if (fs.existsSync(pf)) port = Number(fs.readFileSync(pf, 'utf8').trim().split(/\r?\n/)[0])
    }
    catch {}
    if (!port) await sleep(200)
  }
  const target = await pickPageTarget(port, '127.0.0.1')
  const cdp = new CdpSession(target.webSocketDebuggerUrl)
  await cdp.connect()
  const ev = async (e) => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.value

  console.log(`  启动后窗口矩形 = ${JSON.stringify(rectOf(hwnd))}（应在屏幕外）`)

  if (embed) {
    w32.makeChildWindow(hwnd)
    w32.setParent(hwnd, host)
    w32.makeChildWindow(hwnd)
    await sleep(400)
  }

  const hostR = rectOf(host)
  const baseX = embed ? pane.x : hostR.x + pane.x
  const baseY = embed ? pane.y : hostR.y + pane.y

  // 迭代：可见状态下改尺寸 -> 测 ui -> 再改，直到收敛
  let ins = w32.windowFrameInsets(hwnd)
  let ui = await cdp.measureChromeUiHeight()
  let geo = null
  for (let i = 0; i < 3; i++) {
    const topStrip = Math.max(0, ui - ins.bottom)
    geo = {
      x: Math.round(baseX - ins.left),
      y: Math.round(baseY - topStrip),
      w: Math.round(pane.w + ins.left + ins.right),
      h: Math.round(pane.h + topStrip + ins.bottom),
      topStrip,
    }
    // 屏幕外同尺寸位置（保持可见，Chrome 才会处理 resize）
    w32.moveWindow(hwnd, geo.x, geo.y - 4000, geo.w, geo.h)
    await sleep(800)
    const next = await cdp.measureChromeUiHeight()
    const nextIns = w32.windowFrameInsets(hwnd)
    if (next > 0 && Math.abs(next - ui) <= 1 && Math.abs(nextIns.left - ins.left) <= 1) { ins = nextIns; break }
    ui = next > 0 ? next : ui
    ins = nextIns
  }
  console.log(`  uiHeight=${ui} insets=${JSON.stringify({ l: ins.left, r: ins.right, b: ins.bottom, t: ins.top })} topStrip=${geo.topStrip}`)

  // 先设区域（此时窗口在屏幕外），再移到最终位置 → 不会看到工具栏
  SetWindowRgn(hwnd, CreateRectRgn(ins.left, geo.topStrip, ins.left + pane.w, geo.topStrip + pane.h), 1)
  w32.moveWindow(hwnd, geo.x, geo.y, geo.w, geo.h)
  await sleep(700)

  const r = rectOf(hwnd)
  const iw = await ev('window.innerWidth')
  const ih = await ev('window.innerHeight')
  const dmB = await ev(`matchMedia('(display-mode: browser)').matches`)
  console.log(`  最终窗口矩形 ${JSON.stringify(r)}  viewport ${iw}×${ih}（目标 ${pane.w}×${pane.h}）  display-mode browser=${dmB}`)

  // 真实点击 + 真实键盘（Unicode 注入）
  SetForegroundWindow(host)
  await sleep(400)
  const box = await ev(`(() => { const b = document.getElementById('box').getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height} })()`)
  const contentX = embed ? r.x + ins.left : r.x + ins.left
  const contentY = embed ? r.y + ins.top + 0 : r.y + geo.topStrip
  const hitX = Math.round(contentX + box.x + box.w / 2)
  const hitY = Math.round((embed ? r.y + geo.topStrip : r.y + geo.topStrip) + box.y + box.h / 2)
  await clickAt(hitX, hitY)
  const fg = Number(GetForegroundWindow())
  const active = await ev('document.activeElement ? document.activeElement.id : null')
  console.log(`  点击 (${hitX},${hitY}) 后前台=0x${fg.toString(16)}${fg === hwnd ? '(浏览器)' : fg === host ? '(面板)' : '(其它)'}  activeElement=${active}  hasFocus=${await ev('document.hasFocus()')}`)

  await ev(`document.getElementById('box').value = ''`)
  await sleep(150)
  const sent = sendUnicode('aiz')
  await sleep(500)
  const v = await ev(`document.getElementById('box').value`)
  console.log(`  SendInput 发出 ${sent} 个事件，输入框内容 = ${JSON.stringify(v)}  ${v === 'aiz' ? '✅ 键盘可用' : '❌ 键盘不可用'}`)

  cdp.close()
  try { process.kill(proc.pid) } catch {}
  await sleep(800)
  return v === 'aiz'
}

async function main() {
  const browsers = await detectBrowsers()
  B = browsers.find((x) => x.channel === 'chrome') || browsers[0]
  console.log('浏览器:', B.name, B.version)

  const testHtml = fs.readFileSync(path.join(__dirname, '..', '.tmp', 'input-test.html'))
  const server = http.createServer((_q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(testHtml)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const page = `http://127.0.0.1:${server.address().port}/`

  const np = spawn('notepad.exe', [], { stdio: 'ignore' })
  await sleep(2500)
  let host = 0
  for (const h of w32.findWindowsByPid(np.pid)) {
    const r = rectOf(h)
    if (r && r.w > 300 && r.h > 300) { host = h; break }
  }
  w32.moveWindow(host, 1280, 0, 640, 1040)
  await sleep(500)
  console.log('宿主(面板模拟):', JSON.stringify(rectOf(host)))

  const pane = { x: 30, y: 60, w: 560, h: 900 }

  const topOk = await runMode('A. 顶级窗口（不嵌入）+ 区域裁剪', false, page, host, pane)
  const childOk = await runMode('B. 子窗口（SetParent 嵌入）+ 区域裁剪', true, page, host, pane)

  console.log('\n================ 结论 ================')
  console.log(`A 顶级窗口：键盘 ${topOk ? '可用 ✅' : '不可用 ❌'}`)
  console.log(`B 子窗口  ：键盘 ${childOk ? '可用 ✅' : '不可用 ❌'}`)

  try { server.close() } catch {}
  try { process.kill(np.pid) } catch {}
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
