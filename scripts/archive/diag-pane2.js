/**
 * 窄分格可行性验证：
 *   T1  标准窗口能否"启动即小尺寸"（--window-size 绕过 WM_GETMINMAXINFO 钳制）
 *   T2  嵌入成子窗口（WS_CHILD + SetParent）后，最小宽度钳制是否消失
 *   T3  SetWindowRgn 裁掉工具栏后，网页内容区是否精确等于分格矩形
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
const gdi32 = koffi.load('gdi32.dll')
const CreateRectRgn = gdi32.func('CreateRectRgn', 'uint64', ['int', 'int', 'int', 'int'])
const SetWindowRgn = user32.func('SetWindowRgn', 'int', ['uint64', 'uint64', 'int'])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rectOf = (h) => {
  const r = w32.getWindowRect(h)
  return r ? { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top } : null
}

async function waitDevToolsPort(dir, ms = 40000) {
  const f = path.join(dir, 'DevToolsActivePort')
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (fs.existsSync(f)) {
        const p = Number(fs.readFileSync(f, 'utf8').trim().split(/\r?\n/)[0])
        if (p > 0) return p
      }
    }
    catch {}
    await sleep(200)
  }
  return 0
}

async function waitWindow(pid, ms = 40000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const h = w32.findBrowserWindowByPid(pid)
    if (h) {
      const r = rectOf(h)
      if (r && r.w > 120 && r.h > 120) return h
    }
    await sleep(300)
  }
  return 0
}

async function findNotepadHost() {
  const np = spawn('notepad.exe', [], { stdio: 'ignore' })
  await sleep(2500)
  for (const h of w32.findWindowsByPid(np.pid)) {
    const r = rectOf(h)
    if (r && r.w > 300 && r.h > 300) return { hwnd: h, pid: np.pid }
  }
  try { process.kill(np.pid) } catch {}
  return null
}

let B = null

async function launch(label, extra) {
  const dir = path.join(os.tmpdir(), `aiquad-p2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  const proc = spawn(B.exePath, [
    `--user-data-dir=${dir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-blink-features=AutomationControlled',
    ...extra,
  ], { stdio: 'ignore' })
  const port = await waitDevToolsPort(dir)
  const hwnd = await waitWindow(proc.pid)
  return { proc, port, hwnd, label }
}

async function main() {
  const browsers = await detectBrowsers()
  B = browsers.find((x) => x.channel === 'chrome') || browsers[0]
  console.log('浏览器:', B.name, B.version)

  /* ---------- T1: 启动即小尺寸 ---------- */
  console.log('\n=== T1  标准窗口用 --window-size 直接启动为窄窗口 ===')
  for (const [w, h] of [[270, 340], [300, 400], [420, 500]]) {
    const s = await launch('t1', [`--window-size=${w},${h}`, 'https://example.com'])
    if (!s.hwnd) { console.log(`  请求 ${w}×${h} → 未找到窗口`); try { process.kill(s.proc.pid) } catch {}; continue }
    await sleep(1200)
    const r = rectOf(s.hwnd)
    console.log(`  请求 ${w}×${h}  →  启动实际 ${r.w}×${r.h}   ${r.w <= w + 4 ? '✅ 未被钳制' : '⚠️ 仍被放大到 ' + r.w}`)
    try { process.kill(s.proc.pid) } catch {}
    await sleep(700)
  }

  /* ---------- T2: 嵌入后是否仍被钳制 ---------- */
  console.log('\n=== T2  嵌入为子窗口后，宽度钳制是否消失 ===')
  const host = await findNotepadHost()
  if (!host) {
    console.log('  跳过：未找到记事本宿主窗口')
  }
  else {
    w32.moveWindow(host.hwnd, 80, 80, 1000, 760)
    await sleep(400)
    console.log(`  宿主 HWND 0x${host.hwnd.toString(16)} ${JSON.stringify(rectOf(host.hwnd))}`)
    const s = await launch('t2', ['--window-size=1000,760', 'https://example.com'])
    if (!s.hwnd) console.log('  未找到浏览器窗口')
    else {
      w32.makeChildWindow(s.hwnd)
      w32.setParent(s.hwnd, host.hwnd)
      w32.makeChildWindow(s.hwnd)
      await sleep(700)
      for (const [w, h] of [[270, 340], [300, 400], [420, 500], [516, 500]]) {
        w32.moveWindow(s.hwnd, 20, 60, w, h)
        await sleep(600)
        const r = rectOf(s.hwnd)
        console.log(`  嵌入后请求 ${w}×${h}  →  实际 ${r.w}×${r.h}   ${r.w <= w + 4 ? '✅ 未被钳制（嵌入后限制消失）' : '⚠️ 仍被钳制到 ' + r.w}`)
      }

      /* ---------- T3: region 裁剪后 viewport 对齐 ---------- */
      console.log('\n=== T3  SetWindowRgn 裁剪后内容区是否精确等于目标分格 ===')
      const pane = { x: 20, y: 60, w: 300, h: 420 }
      const target = await pickPageTarget(s.port, 'example.com')
      const cdp = new CdpSession(target.webSocketDebuggerUrl)
      await cdp.connect()
      const ui = await cdp.measureChromeUiHeight()
      const ins = w32.windowFrameInsets(s.hwnd)
      const topStrip = Math.max(0, ui - (ins?.bottom ?? 0))
      console.log(`  uiHeight=${ui} insets=${JSON.stringify(ins)} topStrip=${topStrip}`)

      const il = ins?.left ?? 0
      const ir = ins?.right ?? 0
      const ib = ins?.bottom ?? 0
      const X = pane.x - il
      const Y = pane.y - topStrip
      const W = pane.w + il + ir
      const H = pane.h + topStrip + ib
      w32.moveWindow(s.hwnd, X, Y, W, H)
      await sleep(900)
      // region：只保留网页内容区（裁掉工具栏与边框）
      SetWindowRgn(s.hwnd, CreateRectRgn(il, topStrip, W - ir, H - ib), 1)
      await sleep(900)
      const r = rectOf(s.hwnd)
      const evalNum = async (e) => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.value
      const iw = await evalNum('window.innerWidth')
      const ih = await evalNum('window.innerHeight')
      const dmBrowser = await evalNum(`matchMedia('(display-mode: browser)').matches`)
      const dmStandalone = await evalNum(`matchMedia('(display-mode: standalone)').matches`)
      console.log(`  窗口请求 (${X},${Y}) ${W}×${H}  →  实际 (${r.x},${r.y}) ${r.w}×${r.h}`)
      console.log(`  网页 viewport = ${iw}×${ih}   目标分格 = ${pane.w}×${pane.h}`)
      console.log(`  ${Math.abs(ih - pane.h) <= 3 ? '✅ 纵向精确' : '⚠️ 纵向偏差 ' + (ih - pane.h)}   ${Math.abs(iw - pane.w) <= 25 ? '✅ 横向吻合' : '⚠️ 横向偏差 ' + (iw - pane.w)}`)
      console.log(`  display-mode browser=${dmBrowser} standalone=${dmStandalone}`)
      cdp.close()
      try { process.kill(s.proc.pid) } catch {}
    }
    try { process.kill(host.pid) } catch {}
  }

  console.log('\n完成')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
