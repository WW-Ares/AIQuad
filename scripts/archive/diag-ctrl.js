/**
 * 对照实验（最简）：一个完全普通的 Chrome 窗口，摆在屏幕中间，不嵌入、不裁剪、不改样式。
 * 点击输入框后注入按键，看能否输入 —— 用于确认"注入方式本身"是否可靠。
 * 若这个都失败，说明问题在注入而非架构。
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
const GetFocus = user32.func('GetFocus', 'uint64', [])

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
function sendVk(vk, up) {
  const buf = Buffer.alloc(INPUT_SIZE)
  buf.writeUInt32LE(1, 0)
  buf.writeUInt16LE(vk, 8)
  buf.writeUInt32LE(up ? 0x0002 : 0, 12)
  return SendInput(1, buf, INPUT_SIZE)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rectOf = (h) => { const r = w32.getWindowRect(h); return r ? { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top } : null }

async function clickAt(x, y) {
  SetCursorPos(x, y); await sleep(200)
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

  const dir = path.join(os.tmpdir(), `aiquad-ctrl-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  const proc = spawn(B.exePath, [
    `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--hide-crash-restore-bubble', '--disable-blink-features=AutomationControlled', '--window-size=900,700', page,
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

  w32.moveWindow(hwnd, 300, 200, 900, 700)
  await sleep(900)
  const r = rectOf(hwnd)
  const ins = w32.windowFrameInsets(hwnd)
  const ui = await cdp.measureChromeUiHeight()
  console.log(`普通窗口 ${JSON.stringify(r)}  uiHeight=${ui} insets=${JSON.stringify(ins)}  viewport=${await ev('window.innerWidth')}×${await ev('window.innerHeight')}`)

  const box = await ev(`(() => { const b = document.getElementById('box').getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height} })()`)
  const hitX = Math.round(r.x + ins.left + box.x + box.w / 2)
  const hitY = Math.round(r.y + ui - (ins.bottom || 0) + box.y + box.h / 2)
  console.log(`输入框中心(屏幕) = (${hitX}, ${hitY})`)
  await clickAt(hitX, hitY)
  const fg = Number(GetForegroundWindow())
  console.log(`点击后 前台窗口 = 0x${fg.toString(16)}  浏览器 = 0x${hwnd.toString(16)}  ${fg === hwnd ? '✅ 浏览器成为前台' : '❌ 未激活'}`)
  console.log(`系统 GetFocus() = 0x${Number(GetFocus()).toString(16)}   activeElement=${await ev('document.activeElement ? document.activeElement.id : null')}  hasFocus=${await ev('document.hasFocus()')}`)

  await ev(`document.getElementById('box').value=''`); await sleep(200)
  const nUni = sendUnicode('aiz')
  await sleep(600)
  const v1 = await ev(`document.getElementById('box').value`)
  console.log(`[SendInput Unicode] 发出 ${nUni} 个事件 -> 输入框 = ${JSON.stringify(v1)}  ${v1 === 'aiz' ? '✅ 可用' : '❌ 不可用'}`)

  await ev(`document.getElementById('box').value=''`); await sleep(200)
  sendVk(0x41, false); await sleep(60); sendVk(0x41, true); await sleep(80)
  sendVk(0x49, false); await sleep(60); sendVk(0x49, true); await sleep(80)
  sendVk(0x5a, false); await sleep(60); sendVk(0x5a, true)
  await sleep(600)
  const v2 = await ev(`document.getElementById('box').value`)
  console.log(`[SendInput 虚拟键]  发出 6 个事件 -> 输入框 = ${JSON.stringify(v2)}  ${v2 === 'aiz' ? '✅ 可用' : '❌ 不可用'}`)

  cdp.close()
  try { server.close() } catch {}
  try { process.kill(proc.pid) } catch {}
  console.log('\n完成')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
