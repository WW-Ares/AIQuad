/**
 * 对比实验：同样用「窗口区域裁剪 + 精确对齐」，比较
 *   A. 顶级窗口（不嵌入）
 *   B. 子窗口（SetParent 嵌入）
 * 两种形态下的真实鼠标点击 / 键盘输入可用性，并验证 owner 关系能否保证
 * 浏览器窗口始终浮在面板窗口之上（面板是 alwaysOnTop）。
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
const kernel32 = koffi.load('kernel32.dll')
const SetCursorPos = user32.func('SetCursorPos', 'int', ['int', 'int'])
const mouse_event = user32.func('mouse_event', 'void', ['uint32', 'uint32', 'uint32', 'uint32', 'uint64'])
const keybd_event = user32.func('keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uint64'])
const SetForegroundWindow = user32.func('SetForegroundWindow', 'int', ['uint64'])
const GetForegroundWindow = user32.func('GetForegroundWindow', 'uint64', [])
const GetWindow = user32.func('GetWindow', 'uint64', ['uint64', 'uint32'])
const SetWindowLongPtrW = user32.func('SetWindowLongPtrW', 'int64', ['uint64', 'int', 'int64'])
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uint64', 'int'])
const CreateRectRgn = gdi32.func('CreateRectRgn', 'uint64', ['int', 'int', 'int', 'int'])
const SetWindowRgn = user32.func('SetWindowRgn', 'int', ['uint64', 'uint64', 'int'])

const GWL_EXSTYLE = -20
const GWLP_HWNDPARENT = -8
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_APPWINDOW = 0x00040000
const GW_HWNDPREV = 3

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
  mouse_event(0x0002, 0, 0, 0, 0n)
  await sleep(70)
  mouse_event(0x0004, 0, 0, 0, 0n)
  await sleep(250)
}

async function startBrowser(page, extra = []) {
  const dir = path.join(os.tmpdir(), `aiquad-top-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
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
    ...extra,
    page,
  ], { stdio: 'ignore' })
  let hwnd = 0
  const t0 = Date.now()
  while (Date.now() - t0 < 40000) {
    const h = w32.findBrowserWindowByPid(proc.pid)
    if (h) {
      const r = rectOf(h)
      if (r && r.w > 200 && r.h > 150) { hwnd = h; break }
    }
    await sleep(300)
  }
  let port = 0
  const pf = path.join(dir, 'DevToolsActivePort')
  for (let i = 0; i < 120 && !port; i++) {
    try {
      if (fs.existsSync(pf)) port = Number(fs.readFileSync(pf, 'utf8').trim().split(/\r?\n/)[0])
    }
    catch {}
    if (!port) await sleep(200)
  }
  return { proc, hwnd, port }
}

let B = null

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

  // 宿主（模拟 Electron 面板窗口，置顶 + 窄条贴右边）
  const np = spawn('notepad.exe', [], { stdio: 'ignore' })
  await sleep(2500)
  let host = 0
  for (const h of w32.findWindowsByPid(np.pid)) {
    const r = rectOf(h)
    if (r && r.w > 300 && r.h > 300) { host = h; break }
  }
  w32.moveWindow(host, 1280, 0, 640, 1040)
  await sleep(500)
  // 模拟 alwaysOnTop
  user32.func('SetWindowPos', 'int', ['uint64', 'uint64', 'int', 'int', 'int', 'int', 'uint32'])(host, 0xFFFFFFFFFFFFFFFEn, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010)
  await sleep(400)
  console.log('宿主(面板模拟) 屏幕矩形:', JSON.stringify(rectOf(host)))

  const pane = { x: 30, y: 60, w: 560, h: 900 }   // 相对面板客户区

  /* ================= A. 顶级窗口（不嵌入） ================= */
  console.log('\n=== A. 顶级窗口 + 区域裁剪（不 SetParent） ===')
  {
    const s = await startBrowser(page)
    if (!s.hwnd) console.log('  FAIL 无窗口')
    else {
      const target = await pickPageTarget(s.port, '127.0.0.1')
      const cdp = new CdpSession(target.webSocketDebuggerUrl)
      await cdp.connect()
      const ev = async (e) => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.value

      // 隐藏 -> 去掉任务栏/Alt+Tab 标记 -> 设 owner 为宿主
      w32.showWindow(s.hwnd, w32.SW_HIDE)
      await sleep(200)
      let ex = Number(GetWindowLongPtrW(s.hwnd, GWL_EXSTYLE))
      ex = (ex & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW
      SetWindowLongPtrW(s.hwnd, GWL_EXSTYLE, BigInt(ex))
      const prevOwner = Number(SetWindowLongPtrW(s.hwnd, GWLP_HWNDPARENT, BigInt(host)))
      console.log(`  ex-style 设为 TOOLWINDOW, SetWindowLongPtr(GWLP_HWNDPARENT)=${prevOwner} 前值`)

      const ui = await cdp.measureChromeUiHeight()
      const ins = w32.windowFrameInsets(s.hwnd)
      const topStrip = Math.max(0, ui - ins.bottom)
      const hostR = rectOf(host)
      const X = hostR.x + pane.x - ins.left
      const Y = hostR.y + pane.y - topStrip
      w32.moveWindow(s.hwnd, X, Y, pane.w + ins.left + ins.right, pane.h + topStrip + ins.bottom)
      await sleep(600)
      SetWindowRgn(s.hwnd, CreateRectRgn(ins.left, topStrip, ins.left + pane.w, topStrip + pane.h), 1)
      w32.showWindow(s.hwnd, w32.SW_SHOW)
      await sleep(700)

      const r = rectOf(s.hwnd)
      const iw = await ev('window.innerWidth')
      const ih = await ev('window.innerHeight')
      const dmB = await ev(`matchMedia('(display-mode: browser)').matches`)
      console.log(`  窗口矩形 ${JSON.stringify(r)}  期望尺寸 ${pane.w + ins.left + ins.right}×${pane.h + topStrip + ins.bottom}`)
      console.log(`  viewport ${iw}×${ih}（目标 ${pane.w}×${pane.h}）  display-mode browser=${dmB}`)
      console.log(`  任务栏标记检查：ex-style 含 TOOLWINDOW=${(Number(GetWindowLongPtrW(s.hwnd, GWL_EXSTYLE)) & WS_EX_TOOLWINDOW) !== 0}`)

      // z-order：浏览器窗口是否在宿主之上（GetWindow(host, GW_HWNDPREV) 应为浏览器）
      const above = Number(GetWindow(host, GW_HWNDPREV))
      console.log(`  宿主上一层的窗口 = 0x${above.toString(16)}  浏览器 = 0x${s.hwnd.toString(16)}  ${above === s.hwnd ? '✅ 浏览器浮在面板之上' : '⚠️ 层级需手动维护'}`)

      // 真实点击 + 按键
      SetForegroundWindow(host)
      await sleep(500)
      const boxRect = await ev(`(() => { const r = document.getElementById('box').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height} })()`)
      const hit = { x: Math.round(X + ins.left + boxRect.x + boxRect.w / 2), y: Math.round(Y + topStrip + boxRect.y + boxRect.h / 2) }
      await clickAt(hit.x, hit.y)
      const fg = Number(GetForegroundWindow())
      console.log(`  点击后前台窗口 = 0x${fg.toString(16)} ${fg === s.hwnd ? '(浏览器)' : fg === host ? '(面板)' : '(其它)'}`)
      await typeText('aiz')
      await sleep(400)
      const v = await ev(`document.getElementById('box').value`)
      console.log(`  >> 顶级窗口输入结果 = ${JSON.stringify(v)}  ${v === 'aiz' ? '✅ 键盘可用' : '❌ 键盘不可用'}`)

      // 焦点回到面板后，浏览器窗口是否仍在面板之上
      SetForegroundWindow(host)
      await sleep(500)
      const above2 = Number(GetWindow(host, GW_HWNDPREV))
      console.log(`  面板重新激活后：宿主上层 = 0x${above2.toString(16)}  ${above2 === s.hwnd ? '✅ 仍在面板之上' : '⚠️ 被面板压住'}`)

      cdp.close()
      try { process.kill(s.proc.pid) } catch {}
    }
  }

  try { server.close() } catch {}
  try { process.kill(np.pid) } catch {}
  console.log('\n完成')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
