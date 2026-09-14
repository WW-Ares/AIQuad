/**
 * 验证"顶栏拖动面板"，以及顶栏不再依赖系统标题栏。
 *
 * 背景：顶栏原来用 CSS `-webkit-app-region: drag`。那等于把这一条声明成
 * **标题栏**，最终由系统按自己的标题栏配色重画——Win11 上就变成一条 #F1F1F1
 * 的浅色带，把面板自绘的深色顶栏整个盖掉（顶栏文字随之消失，按钮却还能点）。
 * 现在改成自己算位移：顶栏上按下 → 记起点 → pointermove 把相对位移交给主进程
 * 挪窗口。本脚本就盯着这条路：真按下、真移动，看窗口有没有跟着走。
 *
 * 用法：
 *   node scripts/verify-drag.js
 *   AIQUAD_TEST_SCALE=1.25 node scripts/verify-drag.js
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { CdpSession } = require('../dist/main/cdp')
const w32 = require('../dist/main/win32')
const { cleanupRun } = require('./lib/process-cleanup')

const projectRoot = path.join(__dirname, '..')
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SCALE = process.env.AIQUAD_TEST_SCALE || '1'
const PORT = Number(process.env.AIQUAD_TEST_PORT || 9226)

async function main() {
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
    AIQUAD_DISABLE_GPU: process.env.AIQUAD_DISABLE_GPU || '1',
    AIQUAD_NO_SANDBOX: process.env.AIQUAD_NO_SANDBOX || '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const ud = path.join(projectRoot, '.tmp', `ud-drag-${SCALE}`)
  fs.rmSync(ud, { recursive: true, force: true })
  fs.mkdirSync(ud, { recursive: true })
  const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`]
  if (Number(SCALE) !== 1) args.push(`--force-device-scale-factor=${SCALE}`)
  args.push(projectRoot)
  console.log(`启动应用：deviceScaleFactor=${SCALE}`)
  const child = spawn(electronExe, args, { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d.toString() })
  child.stderr.on('data', (d) => { log += d.toString() })

  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(700)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => /main\.html/.test(t.url)) || null
    }
    catch {}
  }
  if (!target) {
    console.log('❌ 面板渲染进程未启动')
    console.log(log.slice(-2000))
    cleanupRun(child.pid)
    process.exit(1)
  }

  const cdp = new CdpSession(target.webSocketDebuggerUrl)
  await cdp.connect()
  const val = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value

  await sleep(2500)

  // ① 顶栏必须自己是不透明的深色，且不再声明 drag（drag 会被系统当标题栏重画）
  const style = await val(`(() => {
    const h = document.querySelector('.setting-header')
    const cs = getComputedStyle(h)
    return {
      appRegion: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region') || '(未声明)',
      bg: cs.backgroundColor,
      height: Math.round(h.getBoundingClientRect().height),
      ratio: devicePixelRatio,
    }
  })()`)
  console.log('顶栏样式:', JSON.stringify(style))
  const regionClean = !String(style.appRegion).includes('drag')
  console.log(`  未使用 -webkit-app-region: drag = ${regionClean}（应 true）`)
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(style.bg || '')
  const opaque = !!m && (m[4] === undefined || Number(m[4]) >= 0.99)
  const dark = !!m && Number(m[1]) < 80 && Number(m[2]) < 80 && Number(m[3]) < 80
  console.log(`  顶栏底色不透明 = ${opaque}（应 true，半透明一旦掉底就会露出浅色）`)
  console.log(`  顶栏底色是深色 = ${dark}（应 true｜实测 ${style.bg}）`)

  // ② 真按下 + 真移动，窗口要跟着位移走
  const before = await val(`({ x: window.screenX, y: window.screenY })`)
  console.log(`拖动前窗口位置 DIP: ${before.x},${before.y}`)

  const DX = 137
  const DY = 91
  const moved = await val(`(() => {
    const h = document.querySelector('.setting-header')
    const b = h.getBoundingClientRect()
    const sx = window.screenX + b.left + b.width / 2
    const sy = window.screenY + b.top + b.height / 2
    const mk = (type, x, y) => new PointerEvent(type, {
      pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
      clientX: b.left + b.width / 2, clientY: b.top + b.height / 2,
      screenX: x, screenY: y, bubbles: true, cancelable: true,
    })
    h.dispatchEvent(mk('pointerdown', sx, sy))
    h.dispatchEvent(mk('pointermove', sx + 40, sy + 30))
    h.dispatchEvent(mk('pointermove', sx + ${DX}, sy + ${DY}))
    h.dispatchEvent(mk('pointerup', sx + ${DX}, sy + ${DY}))
    return true
  })()`)
  console.log(`已派发 pointerdown → pointermove(+${DX},+${DY}) → pointerup = ${moved}`)
  await sleep(600)

  const after = await val(`({ x: window.screenX, y: window.screenY })`)
  console.log(`拖动后窗口位置 DIP: ${after.x},${after.y}`)
  const adx = after.x - before.x
  const ady = after.y - before.y
  console.log(`实际位移: Δ(${adx},${ady})｜期望 Δ(${DX},${DY})`)
  const dragOk = Math.abs(adx - DX) <= 2 && Math.abs(ady - DY) <= 2
  console.log(`  位移相符 = ${dragOk}（容差 ±2）`)

  // ③ 顶栏按钮不能被拖动逻辑吃掉（按在按钮上应走按钮自己的点击）
  //    注意：事件必须派发在**按钮**上（靠冒泡到顶栏）。派发在顶栏上的话
  //    e.target 是顶栏本身，closest('button') 自然是空——那是测试写错，不是程序错。
  const btnState = await val(`(() => {
    const btn = document.querySelector('[data-layout="1"]')
    const b = btn.getBoundingClientRect()
    const cx = b.left + b.width / 2
    const cy = b.top + b.height / 2
    const sx = window.screenX + cx
    const sy = window.screenY + cy
    const mk = (type, x, y) => new PointerEvent(type, {
      pointerId: 9, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
      clientX: cx, clientY: cy, screenX: x, screenY: y, bubbles: true, cancelable: true,
    })
    btn.dispatchEvent(mk('pointerdown', sx, sy))
    btn.dispatchEvent(mk('pointermove', sx + 80, sy + 60))
    return { x: window.screenX, y: window.screenY, tag: btn.tagName }
  })()`)
  await sleep(400)
  const afterBtn = await val(`({ x: window.screenX, y: window.screenY })`)
  const buttonSafe = afterBtn.x === btnState.x && afterBtn.y === btnState.y
  console.log(`按在顶栏按钮（<${btnState.tag}>）上不会拖动窗口 = ${buttonSafe}（应 true）`)

  /**
   * ④ 面板窗口的命名与"无痕"。
   *
   * 硬断言只有两条：标题必须是 AIQuad；不能带 WS_EX_APPWINDOW（否则必然进任务栏）。
   * `WS_EX_TOOLWINDOW` 只作提示——面板改成 transparent 之后，Electron 会在 show() 时
   * 补 WS_EX_LAYERED 并把 TOOLWINDOW 冲掉，而窗口可见后 SetWindowLongPtr 又改不回来
   * （Chromium 会把不认识的样式改动退回，先藏后改也一样）。任务栏那一条现在靠
   * Electron 的 setSkipTaskbar 保住，代价是 Alt+Tab 里可能仍列出面板。
   */
  const panelWin = (() => {
    for (const h of w32.findWindowsByPid(child.pid)) {
      const t = w32.getWindowText(h)
      if (/AIQuad/.test(t)) {
        const ex = w32.getWindowLong(h, w32.GWL_EXSTYLE)
        return { hwnd: h, title: t, toolWindow: (ex & w32.WS_EX_TOOLWINDOW) !== 0, appWindow: (ex & w32.WS_EX_APPWINDOW) !== 0 }
      }
    }
    return null
  })()
  let chromeOk = false
  if (!panelWin) {
    console.log('❌ 找不到标题含 AIQuad 的面板窗口（改名没生效？）')
  }
  else {
    console.log(`面板窗口: "${panelWin.title}"  WS_EX_TOOLWINDOW=${panelWin.toolWindow}  WS_EX_APPWINDOW=${panelWin.appWindow}`)
    console.log(`  标题为 AIQuad = ${panelWin.title === 'AIQuad'}（应 true）`)
    console.log(`  没有 WS_EX_APPWINDOW = ${!panelWin.appWindow}（应 true）`)
    if (!panelWin.toolWindow) {
      console.log('  ⚠️ 透明窗口拿不到 WS_EX_TOOLWINDOW（Electron 在 Win 上的限制）：任务栏已摘，Alt+Tab 可能仍列出面板')
    }
    chromeOk = panelWin.title === 'AIQuad' && !panelWin.appWindow
  }

  const ok = regionClean && opaque && dark && dragOk && buttonSafe && chromeOk
  console.log(`\n================ 结论 ================\n顶栏/窗口（scale=${SCALE}）：${ok ? '✅ 无标题栏语义、底色不透明、拖动正常、按钮不受影响、标题为 AIQuad' : '❌ 不符合预期'}`)

  cdp.close()
  cleanupRun(child.pid)
  await sleep(800)
  process.exit(ok ? 0 : 3)
}

main().catch((e) => { console.error(e); process.exit(9) })
