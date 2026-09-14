/**
 * 输入可用性实测：把真实 Chrome 窗口嵌入宿主窗口后，
 * 用**真实鼠标点击 + 真实键盘按键**（SendInput/keybd_event）打到网页输入框，
 * 再用 CDP 读回输入框内容，判断「嵌入后能否正常点击与输入」。
 *
 * 这是决定架构的关键实验：
 *   - 若点击+键盘都通 ⇒ 保持 SetParent 子窗口方案
 *   - 若键盘不通 ⇒ 需要 AttachThreadInput 接管输入队列
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const koffi = require('koffi')
const { detectBrowsers } = require('../dist/main/browser-detect')
const { CdpSession, pickPageTarget } = require('../dist/main/cdp')
const w32 = require('../dist/main/win32')

const user32 = koffi.load('user32.dll')
const SetCursorPos = user32.func('SetCursorPos', 'int', ['int', 'int'])
const mouse_event = user32.func('mouse_event', 'void', ['uint32', 'uint32', 'uint32', 'uint32', 'uint64'])
const keybd_event = user32.func('keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uint64'])
const SetForegroundWindow = user32.func('SetForegroundWindow', 'int', ['uint64'])
const GetForegroundWindow = user32.func('GetForegroundWindow', 'uint64', [])
const AttachThreadInput = user32.func('AttachThreadInput', 'int', ['uint32', 'uint32', 'int'])
const GetCurrentThreadId = koffi.load('kernel32.dll').func('GetCurrentThreadId', 'uint32', [])
const GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'uint32', ['uint64', 'void *'])
const SetFocus = user32.func('SetFocus', 'uint64', ['uint64'])
const gdi32 = koffi.load('gdi32.dll')
const CreateRectRgn = gdi32.func('CreateRectRgn', 'uint64', ['int', 'int', 'int', 'int'])
const SetWindowRgn = user32.func('SetWindowRgn', 'int', ['uint64', 'uint64', 'int'])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rectOf = (h) => {
  const r = w32.getWindowRect(h)
  return r ? { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top } : null
}

const VK = { a: 0x41, i: 0x49, z: 0x5a }

async function typeText(text) {
  for (const ch of text) {
    const vk = VK[ch]
    if (!vk) continue
    keybd_event(vk, 0, 0, 0n)
    await sleep(40)
    keybd_event(vk, 0, 2, 0n)
    await sleep(60)
  }
}

async function clickAt(x, y) {
  SetCursorPos(x, y)
  await sleep(120)
  mouse_event(0x0002, 0, 0, 0, 0n) // LEFTDOWN
  await sleep(70)
  mouse_event(0x0004, 0, 0, 0, 0n) // LEFTUP
  await sleep(250)
}

async function main() {
  const browsers = await detectBrowsers()
  const B = browsers.find((x) => x.channel === 'chrome') || browsers[0]
  console.log('浏览器:', B.name, B.version)

  // 宿主窗口：记事本（模拟 Electron 面板窗口）
  const np = spawn('notepad.exe', [], { stdio: 'ignore' })
  await sleep(2500)
  let host = 0
  for (const h of w32.findWindowsByPid(np.pid)) {
    const r = rectOf(h)
    if (r && r.w > 300 && r.h > 300) { host = h; break }
  }
  if (!host) { console.log('FAIL: 无宿主窗口'); process.exit(1) }
  w32.moveWindow(host, 260, 140, 1000, 760)
  await sleep(500)
  const hostRect = rectOf(host)
  console.log('宿主窗口(屏幕):', JSON.stringify(hostRect))

  // 浏览器：打开本地输入测试页（用本机 HTTP 服务，CDP 只认 http(s) 页面）
  const http = require('node:http')
  const testHtml = fs.readFileSync(path.join(__dirname, '..', '.tmp', 'input-test.html'))
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(testHtml)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const page = `http://127.0.0.1:${server.address().port}/`
  console.log('测试页:', page)
  const dir = path.join(os.tmpdir(), `aiquad-input-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  const proc = spawn(B.exePath, [
    `--user-data-dir=${dir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-networking',
    '--window-size=1000,760',
    page,
  ], { stdio: 'ignore' })

  // 等待窗口
  let hwnd = 0
  const t0 = Date.now()
  while (Date.now() - t0 < 40000) {
    const h = w32.findBrowserWindowByPid(proc.pid)
    if (h) { const r = rectOf(h); if (r && r.w > 200 && r.h > 150) { hwnd = h; break } }
    await sleep(300)
  }
  if (!hwnd) { console.log('FAIL: 无浏览器窗口'); process.exit(2) }
  await sleep(1200)
  console.log('浏览器 HWND 0x' + hwnd.toString(16))

  // 端口
  let port = 0
  const portFile = path.join(dir, 'DevToolsActivePort')
  for (let i = 0; i < 100 && !port; i++) {
    try {
      if (fs.existsSync(portFile)) port = Number(fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/)[0])
    }
    catch {}
    if (!port) await sleep(200)
  }
  const target = await pickPageTarget(port, 'input-test')
  if (!target) { console.log('FAIL: 无 CDP 页面'); process.exit(3) }
  const cdp = new CdpSession(target.webSocketDebuggerUrl)
  await cdp.connect()
  const ev = async (e) => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.value

  /* ---------- 嵌入 + 定位 ---------- */
  w32.makeChildWindow(hwnd)
  w32.setParent(hwnd, host)
  w32.makeChildWindow(hwnd)

  const pane = { x: 60, y: 120, w: 520, h: 560 }   // 相对宿主客户区
  const ui = await cdp.measureChromeUiHeight()
  let ins = w32.windowFrameInsets(hwnd)
  const topStrip = Math.max(0, ui - ins.bottom)
  w32.moveWindow(hwnd, pane.x - ins.left, pane.y - topStrip, pane.w + ins.left + ins.right, pane.h + topStrip + ins.bottom)
  await sleep(700)
  SetWindowRgn(hwnd, CreateRectRgn(ins.left, topStrip, ins.left + pane.w, topStrip + pane.h), 1)
  w32.showWindow(hwnd, w32.SW_SHOW)
  await sleep(700)

  const r1 = rectOf(hwnd)
  const iw = await ev('window.innerWidth')
  const ih = await ev('window.innerHeight')
  console.log(`嵌入后：窗口屏幕矩形 ${JSON.stringify(r1)}  网页 viewport ${iw}×${ih}  (目标 ${pane.w}×${pane.h})`)
  const contentOrigin = { x: r1.x + ins.left, y: r1.y + topStrip }
  console.log(`网页内容区左上角(屏幕): (${contentOrigin.x}, ${contentOrigin.y})`)

  /* ---------- 输入框位置 ---------- */
  const boxRect = await ev(`(() => { const r = document.getElementById('box').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height} })()`)
  const hit = {
    x: Math.round(contentOrigin.x + boxRect.x + boxRect.w / 2),
    y: Math.round(contentOrigin.y + boxRect.y + boxRect.h / 2),
  }
  console.log(`输入框中心(屏幕): (${hit.x}, ${hit.y})`)

  /* ---------- 方案一：直接点击 + 按键（不接管输入队列） ---------- */
  w32.showWindow(host, w32.SW_SHOW)
  SetForegroundWindow(host)
  await sleep(600)
  console.log('\n--- 方案一：直接真实点击 + 按键 ---')
  console.log('  点击前前台窗口 = 0x' + Number(GetForegroundWindow()).toString(16) + (Number(GetForegroundWindow()) === host ? ' (宿主)' : ''))
  await clickAt(hit.x, hit.y)
  const fgAfter = Number(GetForegroundWindow())
  console.log('  点击后前台窗口 = 0x' + fgAfter.toString(16) + (fgAfter === host ? ' (宿主)' : fgAfter === hwnd ? ' (浏览器)' : ' (其它)'))
  console.log('  document.activeElement =', await ev('document.activeElement && document.activeElement.id'))
  await typeText('aiz')
  await sleep(400)
  const v1 = await ev(`document.getElementById('box').value`)
  console.log(`  键入 "aiz" 后输入框内容 = ${JSON.stringify(v1)}  ${v1 === 'aiz' ? '✅ 可输入' : '❌ 无法输入'}`)

  /* ---------- 方案二：AttachThreadInput 接管输入队列后再点击按键 ---------- */
  console.log('\n--- 方案二：AttachThreadInput + SetFocus 后点击 + 按键 ---')
  await ev(`document.getElementById('box').value = ''`)
  await ev(`document.getElementById('box').blur()`)
  await sleep(200)
  const myTid = GetCurrentThreadId()
  const targetTid = GetWindowThreadProcessId(hwnd, null)
  const attached = AttachThreadInput(myTid, targetTid, 1)
  console.log(`  当前线程=${myTid} 浏览器线程=${targetTid} AttachThreadInput=${attached}`)
  SetForegroundWindow(host)
  SetFocus(hwnd)
  await sleep(200)
  await clickAt(hit.x, hit.y)
  console.log('  document.activeElement =', await ev('document.activeElement && document.activeElement.id'))
  await typeText('aiz')
  await sleep(400)
  const v2 = await ev(`document.getElementById('box').value`)
  if (attached) AttachThreadInput(myTid, targetTid, 0)
  console.log(`  键入 "aiz" 后输入框内容 = ${JSON.stringify(v2)}  ${v2 === 'aiz' ? '✅ 可输入' : '❌ 无法输入'}`)

  console.log('\n================ 结论 ================')
  console.log(`方案一（纯 SetParent 子窗口）: ${v1 === 'aiz' ? '可用 ✅' : '不可用 ❌'}`)
  console.log(`方案二（AttachThreadInput）: ${v2 === 'aiz' ? '可用 ✅' : '不可用 ❌'}`)

  cdp.close()
  try { server.close() } catch {}
  try { process.kill(proc.pid) } catch {}
  try { process.kill(np.pid) } catch {}
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
