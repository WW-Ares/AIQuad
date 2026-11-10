/**
 * 验证「顶栏带永远不穿透」—— 顶栏按钮的点击绝不会落到下面那个程序上。
 *
 * 事故现象（0.4.16 修）：点顶栏的「收起 / 置顶 / 设置」，下面那个正在编辑的程序
 * 被关掉或者最小化了。原因是面板贴着屏幕右侧、用户自己的窗口多半是最大化的，
 * 面板顶栏那一排图标**正好压在它的 ✕ / 最大化 / 最小化按钮上**；只要面板那一刻
 * 处在"穿透"状态，这一下点击就交给它了。
 *
 * 面板的穿透状态由渲染层用 `elementFromPoint` 算出来（见 app.js 的 syncPassthrough），
 * 而它对 `setIgnoreMouseEvents(true, {forward:true})` 转发过来的鼠标坐标没有把握。
 * 一旦那个坐标算偏 —— 指针明明停在顶栏上、判定却是"压在网页上" —— 面板就一直穿透，
 * 于是"点一下收起，把人家的窗口关了"。
 *
 * 修法（主进程侧，几何事实说了算）：指针在「面板顶边 → 第一行分格上沿」这条带子里时，
 * `setThrough()` 一律拒绝置为穿透；另有 25ms 的巡逻把已经卡在穿透态的面板收回来。
 *
 * 本脚本怎么测（关键是**先把渲染层的自愈能力摘掉**，否则量到的可能只是它自己修好了）：
 *   ① 起一个隔离实例（布局 1 格；沙箱里浏览器起不来也没关系，分格矩形照样会上报）；
 *   ② 在页面里把 `setPassthrough` 换成空函数 —— 渲染层从此只会算、不会上报，
 *      等价于"转发消息丢了 / 坐标算偏"那种现场；
 *   ③ 强制把面板置为穿透（`window.aiquad.mousePassthrough(true)`）；
 *   ④ 把指针移到「收起」按钮正中，等 300ms，点一下；
 *   ⑤ 判据：面板必须**收起**（窗口被挪到屏幕外）。穿透着的面板收不到这一下点击，
 *      只会原地不动。
 *
 * 负向对照（自证脚本不瞎）：
 *   AIQUAD_TEST_NO_CHROME_GUARD=1 node scripts/verify-chrome-guard.js
 *   应用侧故意不做这道保险，同样的步骤必须**收不起来**；收起来了就说明这个脚本
 *   量到的不是保险本身（比如渲染层自己把状态改回来了），当场判失败。
 *
 * 用法（每档换一个端口，别和别的脚本撞）：
 *   node scripts/verify-chrome-guard.js
 *   AIQUAD_TEST_PORT=9796 node scripts/verify-chrome-guard.js
 *
 * 退出码：0 = 符合预期；1 = 不符合；3 = 负向对照没复现（脚本瞎了）。
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const koffi = require('koffi')
const { CdpSession } = require('../dist/main/cdp')
const w32 = require('../dist/main/win32')
const { cleanupRun, killBrowsersUnder } = require('./lib/process-cleanup')

const PROJECT = path.join(__dirname, '..')
const PORT = Number(process.env.AIQUAD_TEST_PORT || 9795)
/** 负向对照：应用侧关掉顶栏带的硬保险 */
const NEG = process.env.AIQUAD_TEST_NO_CHROME_GUARD === '1'
const TMP = path.join(PROJECT, '.tmp')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const user32 = koffi.load('user32.dll')
const SetCursorPos = user32.func('SetCursorPos', 'int', ['int', 'int'])
const GetCursorPos = user32.func('GetCursorPos', 'int', ['void *'])
const MouseEvent = user32.func('mouse_event', 'void', ['uint32', 'uint32', 'uint32', 'uint32', 'uint64'])
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004

function cursorPos() {
  const buf = Buffer.alloc(8)
  try {
    if (!GetCursorPos(buf)) return null
    return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) }
  }
  catch {
    return null
  }
}

async function main() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  // 沙箱里 GPU 进程会崩、进程沙箱会让浏览器起不来，跟别的脚本一样降级跑
  env.AIQUAD_DISABLE_GPU = '1'
  env.AIQUAD_NO_SANDBOX = '1'
  if (NEG) env.AIQUAD_TEST_NO_CHROME_GUARD = '1'
  else delete env.AIQUAD_TEST_NO_CHROME_GUARD

  const ud = path.join(TMP, `ud-guard-${Date.now().toString(36)}`)
  fs.mkdirSync(ud, { recursive: true })
  // 只留 1 格，且关掉缓存扫描：本脚本只关心"点一下顶栏按钮会不会穿透"
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({
    layout: '1',
    position: 'right',
    windowWidthRatio: 0.3,
    panes: [{ id: 'p1', aiId: 'deepseek' }],
    cacheCleanup: 'off',
    autoStart: false,
    alwaysOnTop: true,
  }, null, 2))

  const child = spawn(
    path.join(PROJECT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [`--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`, '--in-process-gpu', '--disable-gpu', PROJECT],
    { cwd: PROJECT, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let appLog = ''
  child.stdout.on('data', (d) => { appLog += d.toString() })
  child.stderr.on('data', (d) => { appLog += d.toString() })

  const before = cursorPos()
  const done = (code) => {
    if (before) { try { SetCursorPos(before.x, before.y) } catch {} }
    try { killBrowsersUnder(path.join(ud, 'profiles')) } catch {}
    try { cleanupRun(child.pid) } catch { try { child.kill() } catch {} }
    setTimeout(() => process.exit(code), 900)
  }

  console.log(`启动应用：端口 ${PORT}${NEG ? '（负向对照：应用侧不做保险）' : ''}`)
  let target = null
  for (let i = 0; i < 45 && !target; i++) {
    await sleep(700)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => /main\.html/.test(t.url)) || null
    }
    catch { /* 还没起来 */ }
  }
  if (!target) {
    console.log('面板没起来')
    console.log(appLog.slice(-1200))
    return done(1)
  }

  const cdp = new CdpSession(target.webSocketDebuggerUrl)
  await cdp.connect()
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '页面内异常')
    return r?.result?.value
  }

  // 等呼出动画落定（240ms 滑动 + 收尾）
  await sleep(3500)

  const geo = await ev(`(() => {
    const b = document.getElementById('btn-hide')
    const pane = document.querySelector('#panes > .pane')
    if (!b || !pane) return null
    const br = b.getBoundingClientRect()
    const pr = pane.getBoundingClientRect()
    return {
      bx: br.left + br.width / 2,
      by: br.top + br.height / 2,
      band: pr.top,
      dpr: window.devicePixelRatio,
      outerW: window.outerWidth,
    }
  })()`)
  if (!geo) { console.log('页面里找不到顶栏按钮 / 分格，测不了'); return done(1) }

  // 面板窗口（物理像素）。⚠️ 不能用 `listBrowserWindows()` —— 它要求窗口里有
  // `Chrome_RenderWidgetHostHWND` 子窗口，而面板是 transparent 窗口，实测那条判据挑不到它
  // （2026-11-11 试过，返回空）。按 pid + 类名 + 尺寸 + 可见性挑就够了：隔离实例里
  // 只有它一个。
  let panel = null
  for (let i = 0; i < 20 && !panel; i++) {
    const cands = w32.findWindowsByPid(child.pid)
      .filter((h) => w32.getClassName(h) === 'Chrome_WidgetWin_1' && w32.isWindowVisible(h))
      .map((h) => {
        const r = w32.getWindowRect(h)
        return r ? { hwnd: h, rect: { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } } : null
      })
      .filter((w) => w && w.rect.width >= 200 && w.rect.height >= 300)
    panel = cands[0] || null
    if (!panel) await sleep(600)
  }
  if (!panel) { console.log('找不到面板窗口'); return done(1) }

  console.log(`面板窗口 ${panel.hwnd} @ ${panel.rect.x},${panel.rect.y} ${panel.rect.width}x${panel.rect.height}｜`
    + `缩放 ${geo.dpr}｜顶栏带下沿 ${geo.band.toFixed(1)}px（CSS）｜收起按钮 ${geo.bx.toFixed(1)},${geo.by.toFixed(1)}`)

  /**
   * ① 摘掉渲染层的自愈能力。
   * `setPassthrough` 是顶层函数声明（挂在全局），换掉之后 `syncPassthrough` 只会算、
   * 不会往主进程发 —— 这正是"转发鼠标消息丢了 / 坐标算偏"那一刻的现状。
   */
  await ev('setPassthrough = () => {}')

  /** ② 强制停在穿透态（模拟已经卡在"以为指针在网页上"） */
  await ev('window.aiquad.mousePassthrough(true)')
  await sleep(80)

  /** ③ 指针移到「收起」按钮正中 */
  const px = Math.round(panel.rect.x + geo.bx * geo.dpr)
  const py = Math.round(panel.rect.y + geo.by * geo.dpr)
  SetCursorPos(px, py)
  // 留够一个巡逻周期（25ms）+ 余量：保险该在这一下之前把穿透收回
  await sleep(320)

  /** ④ 点一下 */
  const sxBefore = await ev('window.screenX')
  MouseEvent(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0n)
  await sleep(50)
  MouseEvent(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0n)
  /**
   * ⚠️ 不能"点完等 1 秒再看 screenX"：收起动画跑完（200ms）之后 `hidePanel` 还会把窗口
   * **挪回停靠位**（+180ms 那个 hideSettleTimer），screenX 于是又变回原值，看上去像"没动"。
   * 真正的证据是**中途那一下位移**——所以这里每 30ms 采一次，抓的是过程不是终态。
   */
  let peak = 0
  for (let i = 0; i < 22; i++) {
    const x = await ev('window.screenX')
    if (typeof x === 'number') peak = Math.max(peak, Math.abs(x - sxBefore))
    await sleep(30)
  }
  const state = await ev(`({ screenX: window.screenX, vis: document.visibilityState })`)
  const movedOut = peak > 100

  // 主进程日志里应该有保险动手的痕迹（负向对照里必须没有）
  let guardHits = 0
  try {
    const logFile = path.join(ud, 'logs', 'main.log')
    if (fs.existsSync(logFile)) {
      guardHits = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('[passthrough] 指针在顶栏带上')).length
    }
  }
  catch {}

  console.log(`点击前 screenX=${sxBefore}｜点击后 ${state ? state.screenX : '页面不可用'}（${state ? state.vis : '-'}）｜中途最大位移 ${peak}px`)
  console.log(`面板${movedOut ? '已收起（点击被面板收下）' : '没动（点击穿透到下面去了）'}｜保险动手 ${guardHits} 次`)

  let code = 0
  if (NEG) {
    if (movedOut) {
      console.log('\n【负向对照】把保险关掉之后面板照样收起了 —— 说明这个脚本量到的不是保险本身，判失败')
      code = 3
    }
    else {
      console.log('\n【负向对照】✅ 关掉保险就穿透了（面板没动），脚本有区分力')
    }
  }
  else if (movedOut) {
    console.log('\n【自检】✅ 顶栏按钮的点击被面板收下了，没有落到下面的窗口')
  }
  else {
    console.log('\n【自检】❌ 点击还是穿透了：保险没起作用')
    code = 1
  }

  cdp.close()
  done(code)
}

main().catch((e) => { console.log('失败：', String(e?.message || e)); process.exitCode = 1; setTimeout(() => process.exit(1), 300) })
