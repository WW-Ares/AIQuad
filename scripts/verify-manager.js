/**
 * 端到端验证**真实代码路径**：直接驱动 dist 里的 InstanceManager。
 *
 * 之前的 verify-final.js 把几何算法抄了一份在脚本里，所以完全测不到
 * instance-manager 的实际改动（比如校准闭环雪崩、异步丢包）。
 * 这里改用真身：
 *   notepad 充当"面板窗口" → manager.setPanel / setRects → manager.launch
 *   → 读页面 viewport 与分格矩形的误差
 *   → 真实鼠标点击 + Unicode SendInput 键盘注入，验证"能不能打字"
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const koffi = require('koffi')
const { detectBrowsers } = require('../dist/main/browser-detect')
const { InstanceManager } = require('../dist/main/instance-manager')
const w32 = require('../dist/main/win32')

const user32 = koffi.load('user32.dll')
const SetCursorPos = user32.func('SetCursorPos', 'int', ['int', 'int'])
const mouse_event = user32.func('mouse_event', 'void', ['uint32', 'uint32', 'uint32', 'uint32', 'uint64'])
const SendInput = user32.func('SendInput', 'uint32', ['uint32', 'uint8 *', 'int'])
const GetForegroundWindow = user32.func('GetForegroundWindow', 'uint64', [])

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
  SetCursorPos(x, y)
  await sleep(200)
  mouse_event(0x0002, 0, 0, 0, 0n)
  await sleep(100)
  mouse_event(0x0004, 0, 0, 0, 0n)
  await sleep(450)
}

async function numOf(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
  return r?.result?.value
}

/** 用一批分格矩形跑一轮，返回对齐误差与键盘可用性 */
async function runLayout(manager, B, page, hostHwnd, hostR, rects, label) {
  console.log(`\n=== ${label} ===`)
  manager.setRects(rects)

  // 只测第一个分格的键盘，其余分格只看对齐
  const results = []
  for (const r of rects) {
    const t0 = Date.now()
    const inst = await manager.launch(r.paneId, {
      id: 'test_ai',
      name: 'Test AI',
      url: page,
      category: 'cn',
      proxyMode: 'global',
    })
    if (!inst.cdp) { console.log(`  [${r.paneId}] ❌ 未建立 CDP，无法测量`); results.push(null); continue }
    await sleep(700)
    const vp = await inst.cdp.viewportSize()
    const wr = rectOf(inst.hwnd)
    const ew = vp ? vp.width - r.width : NaN
    const eh = vp ? vp.height - r.height : NaN
    const aligned = Math.abs(ew) <= 3 && Math.abs(eh) <= 3
    console.log(`  [${r.paneId}] 目标内容区 ${r.width}×${r.height}  viewport ${vp ? `${vp.width}×${vp.height}` : 'null'}  误差 ${ew},${eh} ${aligned ? '✅' : '❌'}`)
    console.log(`  [${r.paneId}] 窗口 ${wr.w}×${wr.h} @(${wr.x},${wr.y})  期望 @(${hostR.x + r.x},${hostR.y + r.y})  用时 ${Date.now() - t0}ms`)
    const rgn = w32.windowRegionBox(inst.hwnd)
    console.log(`  [${r.paneId}] 窗口区域 ${rgn ? `${rgn.right - rgn.left}×${rgn.bottom - rgn.top} @(${rgn.left},${rgn.top})` : 'null（未裁剪 ❌）'}`)
    results.push({ inst, vp, wr, aligned, r })
  }

  // ---- 键盘验证（只在第一个分格上做）----
  const first = results.find((x) => x)
  let typed = null
  let fgOk = false
  if (first) {
    const box = await numOf(first.inst.cdp, `(() => { const b = document.getElementById('box').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })()`)
    if (box) {
      // 窗口屏幕坐标 + 裁剪区域偏移 + 页面坐标 = 点击点
      const rgn = w32.windowRegionBox(first.inst.hwnd)
      const hitX = Math.round(first.wr.x + (rgn ? rgn.left : 0) + box.x + box.w / 2)
      const hitY = Math.round(first.wr.y + (rgn ? rgn.top : 0) + box.y + box.h / 2)
      await clickAt(hitX, hitY)
      const fg = Number(GetForegroundWindow())
      fgOk = fg === first.inst.hwnd
      await numOf(first.inst.cdp, `document.getElementById('box').value=''`)
      await sleep(150)
      sendUnicode('aiz')
      await sleep(700)
      typed = await numOf(first.inst.cdp, `document.getElementById('box').value`)
      console.log(`  [键盘] 点击(${hitX},${hitY}) 前台=0x${fg.toString(16)}${fgOk ? '(浏览器✅)' : '(非浏览器❌)'} activeElement=${await numOf(first.inst.cdp, 'document.activeElement ? document.activeElement.id : null')}`)
      console.log(`  [键盘] 注入 'aiz' → 实际值 ${JSON.stringify(typed)} ${typed === 'aiz' ? '✅ 可打字' : '❌ 打不进字'}`)
    }
  }

  for (const r of results) {
    if (r) manager.kill(r.inst.paneId)
  }
  await sleep(700)
  return { results, alignedAll: results.every((x) => x && x.aligned), typed, fgOk }
}

async function main() {
  const browsers = await detectBrowsers()
  const B = browsers.find((x) => x.channel === 'chrome') || browsers[0]
  console.log('浏览器:', B.name, B.version)

  const testHtml = fs.readFileSync(path.join(__dirname, '..', '.tmp', 'input-test.html'))
  const server = http.createServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(testHtml) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const page = `http://127.0.0.1:${server.address().port}/`

  // notepad 当"面板窗口"：贴右侧、全高
  const np = spawn('notepad.exe', [], { stdio: 'ignore' })
  await sleep(2500)
  let hostHwnd = 0
  for (const h of w32.findWindowsByPid(np.pid)) { const r = rectOf(h); if (r && r.w > 300 && r.h > 300) { hostHwnd = h; break } }
  w32.moveWindow(hostHwnd, 1180, 0, 740, 1040)
  await sleep(600)
  const hostR = rectOf(hostHwnd)
  console.log('面板模拟窗口:', JSON.stringify(hostR))

  const profileDir = path.join(os.tmpdir(), `aiquad-mgr-${Date.now()}`)
  const cfg = {
    windowMode: 'standard',
    proxy: { mode: 'none', type: 'http', host: '', port: '', bypassList: '' },
  }
  const manager = new InstanceManager({ browser: B, profilesRoot: profileDir, config: () => cfg })
  manager.setStatusSink((paneId, status, error) => {
    if (status === 'failed') console.log(`  [status] ${paneId} → failed: ${error}`)
  })
  manager.setPanel({ x: hostR.x, y: hostR.y }, 1, hostHwnd, true)

  // 1920×1080 屏幕、面板宽 576px（30%）时的真实分格内容区
  const one = await runLayout(manager, B, page, hostHwnd, hostR, [
    { paneId: 'pane-1', x: 20, y: 54, width: 536, height: 960 },
  ], '单格（536×960）')

  const four = await runLayout(manager, B, page, hostHwnd, hostR, [
    { paneId: 'pane-1', x: 20, y: 54, width: 271, height: 450 },
    { paneId: 'pane-2', x: 305, y: 54, width: 271, height: 450 },
    { paneId: 'pane-3', x: 20, y: 550, width: 271, height: 450 },
    { paneId: 'pane-4', x: 305, y: 550, width: 271, height: 450 },
  ], '2×2 四格（271×450，原方案会被钳制到 516px）')

  console.log('\n================ 结论 ================')
  console.log(`单格对齐 ${one.alignedAll ? '✅' : '❌'}   四格对齐 ${four.alignedAll ? '✅' : '❌'}`)
  console.log(`键盘可输入 ${one.typed === 'aiz' || four.typed === 'aiz' ? '✅' : '❌'}（单格=${JSON.stringify(one.typed)} 四格=${JSON.stringify(four.typed)}）`)
  console.log(`点击后浏览器成为前台窗口：单格=${one.fgOk} 四格=${four.fgOk}`)

  manager.killAll()
  try { server.close() } catch {}
  try { process.kill(np.pid) } catch {}
  await sleep(500)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
