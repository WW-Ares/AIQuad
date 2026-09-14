/**
 * 定位「窗口改了尺寸但页面 viewport 不跟随」的触发条件。
 * 对比：不隐藏直接改尺寸 / 隐藏→改扩展样式→显示后改尺寸 / 改尺寸时机与等待时长。
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
const SetWindowPos = user32.func('SetWindowPos', 'int', ['uint64', 'uint64', 'int', 'int', 'int', 'int', 'uint32'])
const SWP_NOZORDER = 0x0004, SWP_NOACTIVATE = 0x0010, SWP_NOSENDCHANGING = 0x0400, SWP_ASYNC = 0x4000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rectOf = (h) => { const r = w32.getWindowRect(h); return r ? { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top } : null }

function move(h, x, y, w, hh, async) {
  SetWindowPos(h, 0, Math.round(x), Math.round(y), Math.round(w), Math.round(hh),
    SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING | (async ? SWP_ASYNC : 0))
}

async function probe(cdp, label, secs = 3) {
  const t0 = Date.now()
  const seen = []
  while (Date.now() - t0 < secs * 1000) {
    const v = await cdp.viewportSize()
    const s = v ? `${v.width}x${v.height}` : 'null'
    if (seen[seen.length - 1] !== s) seen.push(s)
    await sleep(200)
  }
  console.log(`    ${label}: viewport 变化序列 [${seen.join(' -> ')}]`)
  return seen
}

let B = null

async function scenario(label, doHideShow) {
  console.log(`\n=== ${label} ===`)
  const dir = path.join(os.tmpdir(), `aiquad-lag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  const testHtml = fs.readFileSync(path.join(__dirname, '..', '.tmp', 'input-test.html'))
  const server = http.createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(testHtml) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const page = `http://127.0.0.1:${server.address().port}/`

  const proc = spawn(B.exePath, [
    `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
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

  if (doHideShow) {
    w32.showWindow(hwnd, w32.SW_HIDE)
    await sleep(250)
    w32.makeToolWindow(hwnd)
    w32.showWindow(hwnd, w32.SW_SHOW)
    console.log('  已执行 隐藏→设置 TOOLWINDOW→显示')
  }

  console.log(`  初始：窗口 ${JSON.stringify(rectOf(hwnd))} viewport ${JSON.stringify(await cdp.viewportSize())}`)
  move(hwnd, 1200, 40, 552, 1103, true)
  console.log(`  改尺寸 552×1103（异步）→ 窗口 ${JSON.stringify(rectOf(hwnd))}`)
  await probe(cdp, '异步+NOSENDCHANGING')

  move(hwnd, 1200, 40, 552, 1103, false)
  console.log(`  再改同样尺寸（同步）→ 窗口 ${JSON.stringify(rectOf(hwnd))}`)
  await probe(cdp, '同步+NOSENDCHANGING', 2)

  // 用普通 SetWindowPos（不跳过 WM_WINDOWPOSCHANGING）在窄尺寸下看看能否生效
  SetWindowPos(hwnd, 0, 1200, 40, 552, 600, SWP_NOZORDER | SWP_NOACTIVATE)
  await sleep(900)
  console.log(`  普通移动 552×600 → 窗口 ${JSON.stringify(rectOf(hwnd))} viewport ${JSON.stringify(await cdp.viewportSize())}`)
  move(hwnd, 1200, 40, 552, 1103, false)
  await probe(cdp, '普通移动后再用无钳制', 2)

  cdp.close()
  try { server.close() } catch {}
  try { process.kill(proc.pid) } catch {}
  await sleep(600)
}

async function main() {
  const browsers = await detectBrowsers()
  B = browsers.find((x) => x.channel === 'chrome') || browsers[0]
  console.log('浏览器:', B.name, B.version)
  await scenario('A 不隐藏，直接改尺寸', false)
  await scenario('B 隐藏→TOOLWINDOW→显示，再改尺寸', true)
  console.log('\n完成')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
