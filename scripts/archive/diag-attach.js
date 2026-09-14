/**
 * 子窗口（SetParent 嵌入）键盘可用性 —— 修正注入方式后的复测。
 *
 * 已知：跨进程 reparent 后，Windows 的系统焦点仍在宿主线程上，
 * 因此需要在「宿主线程」与「浏览器线程」之间接管输入队列（AttachThreadInput），
 * 才能让按键真正路由到嵌入的浏览器窗口。
 *
 * 三组对照：
 *   S1 直接点击 + Unicode 注入
 *   S2 点击后 AttachThreadInput(前台线程, 浏览器线程) + SetFocus + Unicode 注入
 *   S3 连接后保持不放开，再点击 + 注入（模拟长期连接）
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
const GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'uint32', ['uint64', 'void *'])
const AttachThreadInput = user32.func('AttachThreadInput', 'int', ['uint32', 'uint32', 'int'])
const SetFocus = user32.func('SetFocus', 'uint64', ['uint64'])
const GetFocus = user32.func('GetFocus', 'uint64', [])
const SetForegroundWindow = user32.func('SetForegroundWindow', 'int', ['uint64'])
const GetCurrentThreadId = koffi.load('kernel32.dll').func('GetCurrentThreadId', 'uint32', [])

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
  w32.moveWindow(host, 1280, 0, 640, 1040)
  await sleep(600)
  console.log('宿主(面板模拟，非置顶):', JSON.stringify(rectOf(host)))

  const pane = { x: 30, y: 60, w: 560, h: 900 }

  const dir = path.join(os.tmpdir(), `aiquad-att-${Date.now()}`)
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

  // 嵌入
  w32.makeChildWindow(hwnd)
  w32.setParent(hwnd, host)
  w32.makeChildWindow(hwnd)
  await sleep(400)

  // 定位（可见状态下改尺寸；-32000 位置测量 insets 不可靠，所以先移进来再测）
  const hostR = rectOf(host)
  const baseX = pane.x, baseY = pane.y      // 子窗口坐标相对宿主客户区
  let geo = null
  w32.moveWindow(hwnd, baseX, baseY - 4000, pane.w, pane.h)
  await sleep(900)
  let ui = await cdp.measureChromeUiHeight()
  let ins = w32.windowFrameInsets(hwnd)
  console.log(`  初次测量：uiHeight=${ui} insets=${JSON.stringify(ins)}`)
  for (let i = 0; i < 3; i++) {
    const topStrip = Math.max(0, ui - ins.bottom)
    geo = { x: baseX - ins.left, y: baseY - topStrip, w: pane.w + ins.left + ins.right, h: pane.h + topStrip + ins.bottom, topStrip }
    w32.moveWindow(hwnd, geo.x, geo.y, geo.w, geo.h)
    await sleep(800)
    const nx = await cdp.measureChromeUiHeight()
    const ni = w32.windowFrameInsets(hwnd)
    if (nx > 0 && Math.abs(nx - ui) <= 1 && ni.left === ins.left) { break }
    ui = nx > 0 ? nx : ui; ins = ni
  }
  w32.setWindowRegion(hwnd, { x: ins.left, y: geo.topStrip, width: pane.w, height: pane.h }, 0)
  await sleep(500)
  const r = rectOf(hwnd)
  const iw = await ev('window.innerWidth'), ih = await ev('window.innerHeight')
  console.log(`  嵌入定位后 ${JSON.stringify(r)}  viewport ${iw}×${ih}（目标 ${pane.w}×${pane.h}）`)

  const box = await ev(`(() => { const b = document.getElementById('box').getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height} })()`)
  const screenOriginX = r.x - ins.left            // 窗口屏幕 x 对应窗口坐标 0
  const contentScreenX = r.x + ins.left
  const contentScreenY = r.y + geo.topStrip
  const hitX = Math.round(contentScreenX + box.x + box.w / 2)
  const hitY = Math.round(contentScreenY + box.y + box.h / 2)
  void screenOriginX
  console.log(`  输入框中心(屏幕) = (${hitX}, ${hitY})`)

  /* ---------- S1: 直接点击 + Unicode 注入 ---------- */
  console.log('\n--- S1 直接点击 + Unicode 注入（不改输入队列）---')
  SetForegroundWindow(host); await sleep(500)
  await clickAt(hitX, hitY)
  console.log(`  前台=0x${Number(GetForegroundWindow()).toString(16)} (宿主=0x${host.toString(16)})  activeElement=${await ev('document.activeElement ? document.activeElement.id : null')}  hasFocus=${await ev('document.hasFocus()')}`)
  await ev(`document.getElementById('box').value=''`); await sleep(150)
  sendUnicode('aiz'); await sleep(600)
  const s1 = await ev(`document.getElementById('box').value`)
  console.log(`  >> S1 结果 = ${JSON.stringify(s1)}  ${s1 === 'aiz' ? '✅ 可用' : '❌ 不可用'}`)

  /* ---------- S2: AttachThreadInput(前台线程, 浏览器线程) + SetFocus ---------- */
  console.log('\n--- S2 AttachThreadInput(前台线程, 浏览器线程) + SetFocus ---')
  await ev(`document.getElementById('box').value=''; document.getElementById('box').blur()`); await sleep(200)
  const fgTid = GetWindowThreadProcessId(Number(GetForegroundWindow()), null)
  const bTid = GetWindowThreadProcessId(hwnd, null)
  const myTid = GetCurrentThreadId()
  console.log(`  线程：前台=${fgTid} 浏览器=${bTid} 本进程=${myTid}`)
  const a1 = AttachThreadInput(fgTid, bTid, 1)
  console.log(`  AttachThreadInput(前台,浏览器) = ${a1}`)
  SetForegroundWindow(host)
  const f1 = Number(SetFocus(hwnd))
  await sleep(300)
  await clickAt(hitX, hitY)
  console.log(`  SetFocus 前值=0x${f1.toString(16)}  点击后 activeElement=${await ev('document.activeElement ? document.activeElement.id : null')}  hasFocus=${await ev('document.hasFocus()')}`)
  await ev(`document.getElementById('box').value=''`); await sleep(150)
  sendUnicode('aiz'); await sleep(600)
  const s2 = await ev(`document.getElementById('box').value`)
  console.log(`  >> S2 结果 = ${JSON.stringify(s2)}  ${s2 === 'aiz' ? '✅ 可用' : '❌ 不可用'}`)

  /* ---------- S3: 保持连接（不 detach）后再注入 ---------- */
  console.log('\n--- S3 维持 AttachThreadInput 连接后再注入 ---')
  await ev(`document.getElementById('box').value=''`); await sleep(200)
  SetFocus(hwnd)
  await sleep(200)
  await ev(`document.getElementById('box').focus()`)
  await sleep(200)
  sendUnicode('aiz'); await sleep(600)
  const s3 = await ev(`document.getElementById('box').value`)
  console.log(`  >> S3 结果 = ${JSON.stringify(s3)}  ${s3 === 'aiz' ? '✅ 可用' : '❌ 不可用'}`)

  AttachThreadInput(fgTid, bTid, 0)
  console.log('\n================ 结论 ================')
  console.log(`S1 纯嵌入       : ${s1 === 'aiz' ? '可用 ✅' : '不可用 ❌'}`)
  console.log(`S2 attach+点击  : ${s2 === 'aiz' ? '可用 ✅' : '不可用 ❌'}`)
  console.log(`S3 attach 保持  : ${s3 === 'aiz' ? '可用 ✅' : '不可用 ❌'}`)
  console.log(`对照（普通窗口）: 可用 ✅（已验证）`)

  cdp.close()
  try { server.close() } catch {}
  try { process.kill(proc.pid) } catch {}
  try { process.kill(np.pid) } catch {}
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
