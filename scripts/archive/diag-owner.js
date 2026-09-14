/**
 * 聚焦验证：顶级浏览器窗口 + 「成为面板窗口的 owned window」能否同时满足
 *   1) 始终浮在置顶的面板窗口之上（含面板被激活时）
 *   2) 点击后能拿到系统前台与键盘焦点（即键盘真的能用）
 *
 * 这是架构决策的最后一块拼图。
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
const GetWindow = user32.func('GetWindow', 'uint64', ['uint64', 'uint32'])
const SetWindowPos = user32.func('SetWindowPos', 'int', ['uint64', 'uint64', 'int', 'int', 'int', 'int', 'uint32'])
const SetWindowLongPtrW = user32.func('SetWindowLongPtrW', 'int64', ['uint64', 'int', 'int64'])
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uint64', 'int'])
const CreateRectRgn = gdi32.func('CreateRectRgn', 'uint64', ['int', 'int', 'int', 'int'])
const SetWindowRgn = user32.func('SetWindowRgn', 'int', ['uint64', 'uint64', 'int'])

const GWL_EXSTYLE = -20
const GWLP_HWNDPARENT = -8
const WS_EX_TOOLWINDOW = 0x80
const WS_EX_APPWINDOW = 0x40000
const GW_HWNDPREV = 3
const HWND_TOPMOST = 0xFFFFFFFFFFFFFFFFn
const SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_NOACTIVATE = 0x0010

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
  SetCursorPos(x, y); await sleep(150)
  mouse_event(0x0002, 0, 0, 0, 0n); await sleep(80)
  mouse_event(0x0004, 0, 0, 0, 0n); await sleep(350)
}

async function main() {
  const browsers = await detectBrowsers()
  const B = browsers.find((x) => x.channel === 'chrome') || browsers[0]
  console.log('浏览器:', B.name, B.version)

  const testHtml = fs.readFileSync(path.join(__dirname, '..', '.tmp', 'input-test.html'))
  const server = http.createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(testHtml) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const page = `http://127.0.0.1:${server.address().port}/`

  // 面板窗口（置顶，贴右，全高）
  const np = spawn('notepad.exe', [], { stdio: 'ignore' })
  await sleep(2500)
  let host = 0
  for (const h of w32.findWindowsByPid(np.pid)) { const r = rectOf(h); if (r && r.w > 300 && r.h > 300) { host = h; break } }
  w32.moveWindow(host, 1280, 0, 640, 1040)
  SetWindowPos(host, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
  await sleep(400)
  console.log('面板窗口(置顶):', JSON.stringify(rectOf(host)))

  // 浏览器：顶级窗口，启动在屏幕外
  const dir = path.join(os.tmpdir(), `aiquad-own-${Date.now()}`)
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
  let port = 0
  const pf = path.join(dir, 'DevToolsActivePort')
  for (let i = 0; i < 120 && !port; i++) { try { if (fs.existsSync(pf)) port = Number(fs.readFileSync(pf, 'utf8').trim().split(/\r?\n/)[0]) } catch {}; if (!port) await sleep(200) }
  const target = await pickPageTarget(port, '127.0.0.1')
  const cdp = new CdpSession(target.webSocketDebuggerUrl)
  await cdp.connect()
  const ev = async (e) => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.value

  // 1) 去掉任务栏标记并认面板为 owner
  w32.showWindow(hwnd, w32.SW_HIDE); await sleep(200)
  let ex = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE))
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, BigInt((ex & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW))
  SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, BigInt(host))
  w32.showWindow(hwnd, w32.SW_SHOW)

  // 2) 可见状态下定位（Chrome 隐藏时会忽略 resize）
  const pane = { x: 30, y: 60, w: 560, h: 900 }
  const hostR = rectOf(host)
  const baseX = hostR.x + pane.x, baseY = hostR.y + pane.y
  let ui = await cdp.measureChromeUiHeight()
  let ins = w32.windowFrameInsets(hwnd)
  let geo = null
  for (let i = 0; i < 3; i++) {
    const topStrip = Math.max(0, ui - ins.bottom)
    geo = { x: Math.round(baseX - ins.left), y: Math.round(baseY - topStrip), w: Math.round(pane.w + ins.left + ins.right), h: Math.round(pane.h + topStrip + ins.bottom), topStrip }
    w32.moveWindow(hwnd, geo.x, geo.y - 4000, geo.w, geo.h)
    await sleep(800)
    const nx = await cdp.measureChromeUiHeight()
    const ni = w32.windowFrameInsets(hwnd)
    if (nx > 0 && Math.abs(nx - ui) <= 1) { ins = ni; break }
    ui = nx > 0 ? nx : ui; ins = ni
  }
  SetWindowRgn(hwnd, CreateRectRgn(ins.left, geo.topStrip, ins.left + pane.w, geo.topStrip + pane.h), 1)
  w32.moveWindow(hwnd, geo.x, geo.y, geo.w, geo.h)
  await sleep(800)

  const r = rectOf(hwnd)
  const iw = await ev('window.innerWidth'), ih = await ev('window.innerHeight')
  console.log(`浏览器窗口 ${JSON.stringify(r)}  viewport ${iw}×${ih}（目标 ${pane.w}×${pane.h}）`)

  // 3) 层级：面板被激活时，浏览器是否仍在面板之上
  SetForegroundWindow(host); await sleep(600)
  const above = Number(GetWindow(host, GW_HWNDPREV))
  console.log(`面板激活后，面板上一层的窗口 = 0x${above.toString(16)}  浏览器 = 0x${hwnd.toString(16)}  ${above === hwnd ? '✅ 浏览器浮在面板之上' : '⚠️ 被面板压住'}`)

  // 4) 点击输入框 -> 是否拿到系统前台
  const box = await ev(`(() => { const b = document.getElementById('box').getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height} })()`)
  const hitX = Math.round(r.x + ins.left + box.x + box.w / 2)
  const hitY = Math.round(r.y + geo.topStrip + box.y + box.h / 2)
  await clickAt(hitX, hitY)
  const fg = Number(GetForegroundWindow())
  console.log(`点击 (${hitX},${hitY}) 后 前台窗口 = 0x${fg.toString(16)}  ${fg === hwnd ? '✅ 浏览器成为前台' : fg === host ? '❌ 仍是面板' : '⚠️ 其它窗口'}`)
  console.log(`  页面 activeElement=${await ev('document.activeElement ? document.activeElement.id : null')}  hasFocus=${await ev('document.hasFocus()')}`)

  // 5) 键盘
  await ev(`document.getElementById('box').value=''`); await sleep(150)
  sendUnicode('aiz'); await sleep(600)
  const v = await ev(`document.getElementById('box').value`)
  console.log(`键盘输入结果 = ${JSON.stringify(v)}  ${v === 'aiz' ? '✅ 键盘可用' : '❌ 键盘不可用'}`)

  // 6) 焦点回到面板后，浏览器是否仍显示在面板之上
  SetForegroundWindow(host); await sleep(600)
  const above2 = Number(GetWindow(host, GW_HWNDPREV))
  console.log(`面板再次激活后，面板上一层 = 0x${above2.toString(16)}  ${above2 === hwnd ? '✅ 仍在面板之上' : '⚠️ 被面板压住'}`)
  const iw2 = await ev('window.innerWidth')
  console.log(`（参考）viewport 仍为 ${iw2}`)

  cdp.close()
  try { server.close() } catch {}
  try { process.kill(proc.pid) } catch {}
  try { process.kill(np.pid) } catch {}
  console.log('\n完成')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
