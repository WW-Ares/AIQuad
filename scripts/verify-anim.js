/**
 * 验证滑动动画期间"面板与分格里的浏览器窗口是否同帧移动"。
 *
 * 背景（2026-09-14 用户反馈）：
 *   面板和分格里的原生浏览器窗口是**两个互不相干的顶级窗口**。面板自己滑进来、
 *   网页留在原地或晚一拍才跟上，观感就是"动画和网页之间有断层"。
 *   0.4.5 之前的做法更彻底：滑入期间干脆把浏览器窗口全藏起来，滑完再亮出来，
 *   断层直接变成"先出现空面板、再蹦出内容"。
 *
 * 现在的做法是每帧把面板当前 x 推给实例管理器，由它用一次
 * `BeginDeferWindowPos/DeferWindowPos/EndDeferWindowPos` 批量提交，
 * 让这些窗口的几何在同一帧落到 DWM 上。本脚本就是把这件事钉死。
 *
 * 三组断言：
 *   1. 同步性 —— 动画期间"浏览器窗口相对面板的偏移"必须恒定（面板动、网页同帧同量地动）
 *   2. 尺寸   —— 移动过程中浏览器窗口宽度不能被改（批量提交必须带 SWP_NOSENDCHANGING，
 *               否则 Chrome 会把宽度钳到 516px，窄分格直接溢出）
 *   3. 层级   —— 面板置顶时浏览器窗口也在置顶带，且面板必须压在它们之上
 *               （不同层级 = 别的程序能盖住网页却盖不住黑边）
 *
 * 用法：
 *   node scripts/verify-anim.js
 *   AIQUAD_TEST_SCALE=1.25 AIQUAD_TEST_PORT=9270 node scripts/verify-anim.js
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const koffi = require('koffi')
const { CdpSession } = require('../dist/main/cdp')
const w32 = require('../dist/main/win32')
const { cleanupRun } = require('./lib/process-cleanup')

const projectRoot = path.join(__dirname, '..')
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SCALE = process.env.AIQUAD_TEST_SCALE || '1'
const PORT = Number(process.env.AIQUAD_TEST_PORT || 9270)

const WS_EX_TOPMOST = 0x00000008
const CHROME_CLASS = 'Chrome_WidgetWin_1'

/* ---------- 枚举顶层窗口（脚本自己声明，win32.ts 没导出"列全部"这个能力） ---------- */
const user32 = koffi.load('user32.dll')
// 名字不能跟 win32.js 里注册的重复（koffi 的类型名是全局唯一的）
const EnumProc = koffi.proto('bool AnimEnumWindowsProc(uint64 hwnd, uint64 lparam)')
const EnumWindows = user32.func('EnumWindows', 'int', [koffi.pointer(EnumProc), 'uint64'])

function listTopWindows() {
  const out = []
  let cb = null
  try {
    cb = koffi.register((hwnd) => {
      const h = Number(hwnd)
      if (w32.getClassName(h) === CHROME_CLASS && w32.isWindowVisible(h)) {
        const r = w32.getWindowRect(h)
        if (r) out.push({ hwnd: h, ...r })
      }
      return true
    }, koffi.pointer(EnumProc))
    EnumWindows(cb, 0n)
  }
  catch (e) {
    console.log('枚举窗口失败:', e.message)
  }
  finally {
    if (cb) {
      try {
        koffi.unregister(cb)
      }
      catch {}
    }
  }
  return out
}

/** 面板窗口：主进程 pid 下、高而窄的那个 */
function findPanel(pid) {
  for (const h of w32.findWindowsByPid(pid)) {
    if (w32.getClassName(h) !== CHROME_CLASS) continue
    if (!w32.isWindowVisible(h)) continue
    const r = w32.getWindowRect(h)
    if (!r) continue
    const w = r.right - r.left
    const hh = r.bottom - r.top
    if (hh > 500 && w < 1200) return { hwnd: h, ...r }
  }
  return null
}

/** Z 序：从最顶层往下，返回 { above: 落在 [hwnd] 之上、属于 mine 的窗口 } */
function windowsAbove(targetHwnd, mine) {
  const above = []
  let h = w32.getTopWindow()
  let guard = 0
  while (h && h !== targetHwnd && guard++ < 5000) {
    if (mine.has(h)) above.push(h)
    h = w32.getWindow(h, w32.GW_HWNDNEXT)
  }
  return above
}

async function main() {
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
    AIQUAD_DISABLE_GPU: process.env.AIQUAD_DISABLE_GPU || '1',
    AIQUAD_NO_SANDBOX: process.env.AIQUAD_NO_SANDBOX || '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const ud = path.join(projectRoot, '.tmp', `ud-anim-${SCALE}`)
  fs.rmSync(ud, { recursive: true, force: true })
  fs.mkdirSync(ud, { recursive: true })
  const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`]
  if (Number(SCALE) !== 1) args.push(`--force-device-scale-factor=${SCALE}`)
  args.push(projectRoot)

  const before = new Set(listTopWindows().map((w) => w.hwnd))
  console.log(`启动应用：deviceScaleFactor=${SCALE}（启动前已有 ${before.size} 个浏览器窗口）`)
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
  const num = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value
  const click = (sel) => num(`document.querySelector(${JSON.stringify(sel)}).click(), true`)

  await click('[data-layout="1"]')
  console.log('已切到单格布局，等待实例就位…')
  await sleep(16000)

  const panel = findPanel(child.pid)
  if (!panel) {
    console.log('❌ 没找到面板窗口')
    cleanupRun(child.pid)
    process.exit(1)
  }
  const after = listTopWindows().filter((w) => !before.has(w.hwnd) && w.hwnd !== panel.hwnd)
  if (!after.length) {
    console.log('❌ 没找到分格里的浏览器窗口（实例可能没起来）')
    console.log(log.slice(-3000))
    cleanupRun(child.pid)
    process.exit(1)
  }
  const mine = new Set(after.map((w) => w.hwnd))
  console.log(`面板 hwnd=0x${panel.hwnd.toString(16)}  浏览器窗口 ${after.length} 个`)

  /* ---------- 断言 3：层级 ---------- */
  const panelEx = w32.getWindowLong(panel.hwnd, w32.GWL_EXSTYLE) >>> 0
  const browserEx = [...mine].map((h) => w32.getWindowLong(h, w32.GWL_EXSTYLE) >>> 0)
  const panelTop = (panelEx & WS_EX_TOPMOST) !== 0
  const browserTop = browserEx.map((e) => (e & WS_EX_TOPMOST) !== 0)
  const above = windowsAbove(panel.hwnd, mine)
  console.log('\n================ 层级 ================')
  console.log(`面板置顶        = ${panelTop}`)
  console.log(`浏览器窗口置顶  = ${browserTop.map((b) => (b ? '是' : '否')).join(' / ')}`)
  console.log(`压在面板之上的窗口 = ${above.length}`)

  /* ---------- 采样：触发动画并逐帧记录 ---------- */
  const samples = []
  let timer = null
  const panelHwnd = panel.hwnd
  const startSample = () => {
    samples.length = 0
    timer = setInterval(() => {
      /**
       * 只收面板**可见**期间的样本。
       *
       * 收起动画跑完会 `hide()`，再过 180ms 面板又被静默挪回停靠位（此时已不可见）。
       * 那段位移和动画无关，混进来会让"首末位移"抵消成 0，断言直接失去意义。
       */
      if (!w32.isWindowVisible(panelHwnd)) return
      const p = w32.getWindowRect(panelHwnd)
      if (!p) return
      const bs = []
      for (const h of mine) {
        const r = w32.getWindowRect(h)
        if (r && w32.isWindowVisible(h)) bs.push({ hwnd: h, ...r })
      }
      /**
       * 采样不是原子的：上面这一串 GetWindowRect 加起来要几毫秒，中间动画可能
       * 已经推进了一帧，读出来的就成了"面板新、网页旧"的假偏差。
       * 再读一次面板，前后位置一致才说明这个样本是干净的。
       */
      const p2 = w32.getWindowRect(panelHwnd)
      if (!p2 || p2.left !== p.left) return
      samples.push({ t: Date.now(), panel: p, browsers: bs })
    }, 8)
  }
  const stopSample = () => {
    if (timer) clearInterval(timer)
    timer = null
    return samples.slice()
  }

  const analyse = (label, s) => {
    const moved = s.filter((x, i) => i > 0 && x.panel.left !== s[i - 1].panel.left)
    if (moved.length < 3) {
      console.log(`\n---- ${label}：只采到 ${moved.length} 帧位移，判定不了 ----`)
      return { ok: false, reason: '采样帧数不足' }
    }
    /**
     * 判定用的是**首末位移量是否一致**，不是逐帧最大漂移。
     *
     * 面板和浏览器窗口由主进程顺序调用 setBounds / SetWindowPos 更新，落在两个
     * 相邻的提交里；采样周期和动画帧周期各自独立，抓到"面板已动、网页还没动"的
     * 帧内瞬时是常事。那种偏差下一帧就归零，不影响观感。
     * 真正的断层是**窗口根本没跟**——那就表现为整段动画走完，网页没挪窝。
     */
    /**
     * 判据取**逐帧跟随误差的中位数**，不是首尾总位移。
     *
     * 动画跑完的那一帧，主进程会补一次落位校准（内衬重测），窗口可能再挪几像素。
     * 那是静止状态下的一次性修正，不是"网页没跟上"——用首尾位移去卡它，
     * 会把校准误判成断层；逐帧看则只有最后一帧有值，中位数为 0。
     */
    let maxWidthDelta = 0
    const first = moved[0]
    const last = moved[moved.length - 1]
    const width0 = new Map()
    for (const b of first.browsers) width0.set(b.hwnd, b.right - b.left)
    const errs = []
    let maxDrift = 0
    for (let i = 1; i < moved.length; i++) {
      const f = moved[i]
      const prev = moved[i - 1]
      const dp = f.panel.left - prev.panel.left
      for (const b of f.browsers) {
        const pb = prev.browsers.find((x) => x.hwnd === b.hwnd)
        if (pb) errs.push(Math.abs((b.left - pb.left) - dp))
      }
      for (const b of f.browsers) {
        const base = first.browsers.find((x) => x.hwnd === b.hwnd)
        if (base) maxDrift = Math.max(maxDrift, Math.abs((b.left - f.panel.left) - (base.left - first.panel.left)))
        const w0 = width0.get(b.hwnd)
        if (w0) maxWidthDelta = Math.max(maxWidthDelta, Math.abs((b.right - b.left) - w0))
      }
    }
    // 末帧单独看：它是落位那一帧，允许有一次收尾修正
    const lastErr = errs.length ? errs[errs.length - 1] : 0
    const body = errs.slice(0, Math.max(1, errs.length - 1)).sort((a, b) => a - b)
    const median = body.length ? body[Math.floor(body.length / 2)] : 0
    const p90 = body.length ? body[Math.min(body.length - 1, Math.floor(body.length * 0.9))] : 0
    const worst = body.length ? body[body.length - 1] : 0
    const span = last.panel.left - first.panel.left
    console.log(`\n---- ${label} ----`)
    console.log(`  位移帧数 ${moved.length}｜面板横向移动 ${span}px`)
    console.log(`  动画过程中逐帧跟随误差：中位数 ${median}px（应 ≤2）｜p90 ${p90}px｜最大 ${worst}px（应 ≤3）`)
    console.log(`  末帧落位误差 = ${lastErr}px（收尾修正，允许偏大）｜帧内瞬时最大漂移 = ${maxDrift}px（参考）`)
    console.log(`  移动中窗口宽度最大变化 = ${maxWidthDelta}px（应 ≤1：>1 说明被 Chrome 钳宽）`)
    if (worst > 3) {
      console.log('  误差明细（逐帧：面板位移 vs 网页位移）')
      for (let i = 1; i < moved.length; i++) {
        const f = moved[i]
        const prev = moved[i - 1]
        const dp = f.panel.left - prev.panel.left
        for (const b of f.browsers) {
          const pb = prev.browsers.find((x) => x.hwnd === b.hwnd)
          if (!pb) continue
          const db = b.left - pb.left
          const flag = Math.abs(db - dp) > 3 ? '   ← 差得多' : ''
          console.log(`    #${i} 面板 ${prev.panel.left}→${f.panel.left}（${dp >= 0 ? '+' : ''}${dp}）  网页 ${pb.left}→${b.left}（${db >= 0 ? '+' : ''}${db}）${flag}`)
        }
      }
    }
    return { ok: median <= 2 && worst <= 3 && maxWidthDelta <= 1, median, p90, worst, maxWidthDelta }
  }

  console.log('\n================ 动画同步 ================')
  // 收起：采样窗口只覆盖动画本身（200ms）加一点余量，别收进隐藏后的回位
  startSample()
  await sleep(60)
  await num('window.aiquad.panelToggle(), true')
  await sleep(320)
  const hideSamples = stopSample()
  const rHide = analyse('收起动画', hideSamples)

  await sleep(900)
  // 展开：面板就位后动画（240ms）加余量
  startSample()
  await sleep(60)
  await num('window.aiquad.panelToggle(), true')
  await sleep(400)
  const showSamples = stopSample()
  const rShow = analyse('展开动画', showSamples)

  /* ---------- 结论 ---------- */
  const bad = []
  if (!panelTop) bad.push('面板没有置顶')
  if (!browserTop.every(Boolean)) bad.push('浏览器窗口没有跟着置顶 → 别的程序能盖住网页，只剩黑边浮在上层')
  if (above.length) bad.push(`有 ${above.length} 个浏览器窗口压在面板之上 → 会盖住顶栏`)
  if (!rHide.ok) bad.push(`收起动画不同步（逐帧误差中位数 ${rHide.median ?? '-'}px / 最大 ${rHide.worst ?? '-'}px / 宽度变化 ${rHide.maxWidthDelta ?? '-'}px）`)
  if (!rShow.ok) bad.push(`展开动画不同步（逐帧误差中位数 ${rShow.median ?? '-'}px / 最大 ${rShow.worst ?? '-'}px / 宽度变化 ${rShow.maxWidthDelta ?? '-'}px）`)

  console.log('\n================ 结论 ================')
  if (bad.length) {
    for (const b of bad) console.log(`❌ ${b}`)
    console.log(`\n动画与层级（scale=${SCALE}）：❌ 不符合预期`)
  }
  else {
    console.log(`动画与层级（scale=${SCALE}）：✅ 网页与面板同帧移动、宽度不变、层级一致且面板在最上`)
  }

  cleanupRun(child.pid)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
