/**
 * 实测「呼出面板后，鼠标穿透判定是否**立刻**是对的」。
 *
 * 为什么需要它：这个 bug 的全部证据都在**主进程**里（`setIgnoreMouseEvents` 的调用值），
 * CDP 截图、页面 DOM 都看不见。所以这里在 dist 上临时插探针（不改源码），
 * 把每次 `applyPassthrough` 的判定值、鼠标位置、面板原点、各格 shown 状态写进日志文件，
 * 再让真实鼠标停在**分格正中**做「收起 → 呼出」，看呼出后**第一次**判定对不对。
 *
 * 复现的前提（缺一不可）：
 *   ① 面板先显示过、再收起（否则 setSuppressed(true) 没跑过，所有格 shown 仍是 true）；
 *   ② 鼠标在呼出前就已经停在分格区域内（用户就是这么操作的：瞄准 → 按快捷键 → 点）。
 *      呼出后再去移动鼠标会触发渲染层 mousemove，把错误状态顺手纠正掉 —— 那样就测不出来了。
 *
 * 用法：
 *   node scripts/verify-passthrough-show.js            # 测当前 dist
 *   node scripts/verify-passthrough-show.js legacy     # 负向对照：把顺序改回旧代码
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const Q = path.join(ROOT, '.tmp', 'appdata', 'q-pt')
const DIST = path.join(ROOT, 'dist', 'main', 'index.js')
const BAK = path.join(ROOT, '.tmp', 'dist-main-index.pt.bak')
const PTLOG = path.join(ROOT, '.tmp', 'pt-log.txt')
const PORT = Number(process.env.AIQUAD_TEST_PORT || 9796)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PY = 'C:\\Users\\Administrator\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe'
const MODE = process.argv[2] === 'legacy' ? 'legacy' : 'fixed'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- dist 探针 ---------------- */

/** 探针统一用这个函数写日志：console（管道）+ 文件（绝对可靠） */
const LOGFN = `const __ptlog = (s) => { try { console.log(s) } catch {} try { require('fs').appendFileSync(${JSON.stringify(PTLOG)}, s + '\\n') } catch {} };`

const ANCHOR_APPLY = 'function applyPassthrough(win, origin) {'

const APPLY_BODY_OLD = `    setThrough(win, !!manager?.cursorOverPane(origin));`

const APPLY_BODY_NEW = `    const __pt = !!manager?.cursorOverPane(origin);
    try {
        const __el = require('electron');
        const __m = __el.screen.getCursorScreenPoint();
        const __d = __el.screen.getPrimaryDisplay();
        const __og = manager ? manager.panel.x + ',' + manager.panel.y : '?';
        const __sh = manager ? [...manager.instances.entries()].map(([k, v]) => k + (v.shown ? '+' : '-')).join(',') : '';
        const __rs = manager ? [...manager.rects.entries()].map(([k, v]) => k + ':' + v.x + ',' + v.y + ',' + v.width + 'x' + v.height).join('|') : '';
        __ptlog('[PT] apply t=' + Date.now() + ' through=' + __pt + ' at=' + (origin ? origin.x + ',' + origin.y : 'live') + ' mouse=' + __m.x + ',' + __m.y + ' liveOrigin=' + __og + ' shown=' + __sh + ' rects=' + __rs + ' scale=' + __d.scaleFactor);
    } catch (__e) {
        __ptlog('[PT] apply t=' + Date.now() + ' through=' + __pt + ' geomfail=' + __e.message);
    }
    setThrough(win, __pt);`

const EVENT_OLD = `function showPanel() {
    // 可能是收起后 180ms 内又呼出：先取消那个"把面板挪回停靠位"的延迟任务
    cancelHideSettle();`

const EVENT_NEW = `function showPanel() {
    __ptlog('[PT] event t=' + Date.now() + ' showPanel');
    // 可能是收起后 180ms 内又呼出：先取消那个"把面板挪回停靠位"的延迟任务
    cancelHideSettle();`

const HIDE_OLD = `function hidePanel() {
    if (!panelWindow || panelWindow.isDestroyed() || !panelWindow.isVisible())`

const HIDE_NEW = `function hidePanel() {
    __ptlog('[PT] event t=' + Date.now() + ' hidePanel');
    if (!panelWindow || panelWindow.isDestroyed() || !panelWindow.isVisible())`

const IPC_OLD = `    electron_1.ipcMain.on('mouse-passthrough', (_e, through) => {
        if (!panelWindow || panelWindow.isDestroyed())`

const IPC_NEW = `    electron_1.ipcMain.on('mouse-passthrough', (_e, through) => {
        __ptlog('[PT] fromRenderer t=' + Date.now() + ' through=' + !!through);
        if (!panelWindow || panelWindow.isDestroyed())`

/** 旧代码的顺序：穿透判定排在 syncPanelToManager / setSuppressed 之前 */
const ORDER_NEW = `    syncPanelToManager();
    manager?.setSuppressed(false);`
const ORDER_LEGACY = `    applyPassthrough(win);
    syncPanelToManager();
    manager?.setSuppressed(false);`

function sub(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`探针插入失败（${label}）：锚点没找到`)
  return text.split(from).join(to)
}

function patchDist() {
  fs.copyFileSync(DIST, BAK)
  let src = fs.readFileSync(DIST, 'utf8')
  // __ptlog 必须定义在模块顶层作用域，插在 'use strict' 之后的第一个函数声明前
  const anchor = ANCHOR_APPLY
  src = sub(src, anchor, LOGFN + '\n' + anchor, 'LOGFN')
  src = sub(src, APPLY_BODY_OLD, APPLY_BODY_NEW, 'apply')
  src = sub(src, EVENT_OLD, EVENT_NEW, 'showPanel')
  src = sub(src, HIDE_OLD, HIDE_NEW, 'hidePanel')
  src = sub(src, IPC_OLD, IPC_NEW, 'ipc')
  if (MODE === 'legacy') {
    src = sub(src, '    applyPassthrough(win);\n    slideTo(offX, b.x, b, 240', '    slideTo(offX, b.x, b, 240', 'legacy-del')
    src = sub(src, ORDER_NEW, ORDER_LEGACY, 'legacy-ins')
  }
  fs.writeFileSync(DIST, src)
}

function restoreDist() {
  try { if (fs.existsSync(BAK)) { fs.copyFileSync(BAK, DIST); fs.unlinkSync(BAK) } } catch {}
}

/* ---------------- 运行环境 ---------------- */

function prepareUserData() {
  const realPath = path.join(process.env.APPDATA, 'aiquad', 'config.json')
  const real = JSON.parse(fs.readFileSync(realPath, 'utf8'))
  real.panes = [{ id: 'p1', aiId: 'deepseek' }]
  real.layout = '1'
  real.cacheCleanup = 'off'
  real.autoStart = false
  real.shortcuts = {}
  delete real.hidden
  if (Array.isArray(real.aiList)) for (const a of real.aiList) delete a.hidden
  fs.mkdirSync(Q, { recursive: true })
  fs.writeFileSync(path.join(Q, 'config.json'), JSON.stringify(real, null, 2))
}

function setCursor(dipX, dipY, scale) {
  const px = Math.round(dipX * scale)
  const py = Math.round(dipY * scale)
  execFileSync(PY, ['-c', `import ctypes;ctypes.windll.user32.SetCursorPos(${px},${py})`])
  return { px, py }
}

/* ---------------- 主流程 ---------------- */

let CHILD = null
let CLEANUP = null

async function main() {
  const { CdpSession, listTargets } = require(path.join(ROOT, 'dist', 'main', 'cdp'))
  CLEANUP = require(path.join(ROOT, 'scripts', 'lib', 'process-cleanup')).cleanupRun

  if (fs.existsSync(PTLOG)) fs.unlinkSync(PTLOG)
  patchDist()
  console.log(`【模式】${MODE}（探针已注入 dist，收尾自动还原）`)

  prepareUserData()
  const env = { ...process.env, AIQUAD_DISABLE_GPU: '1', AIQUAD_NO_SANDBOX: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(ELECTRON, ['--in-process-gpu', '--disable-gpu', `--user-data-dir=${Q}`,
    `--remote-debugging-port=${PORT}`, ROOT], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  CHILD = child
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d.toString() })

  let panel = null
  for (let i = 0; i < 60 && !panel; i++) {
    await sleep(700)
    try { panel = (await listTargets(PORT, 1)).find((t) => /main\.html/.test(t.url)) } catch {}
  }
  if (!panel) throw new Error('面板没起来\n' + stderr.slice(-600))
  const p = new CdpSession(panel.webSocketDebuggerUrl)
  await p.connect()
  const ev = async (expr) => {
    const r = await p.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '页面内异常')
    return r?.result?.value
  }

  // 等分格就绪（ready 类由渲染层在实例可用后加上）
  let ready = false
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(1000)
    ready = await ev(`document.querySelectorAll('.pane.ready').length > 0`)
  }
  if (!ready) throw new Error('分格没就绪（浏览器窗口没起来？）')

  const geom = await ev(`(() => {
    const el = document.querySelector('.pane.ready')
    const r = el.getBoundingClientRect()
    return { screenX: window.screenX, screenY: window.screenY, dpr: devicePixelRatio,
             x: r.x, y: r.y, w: r.width, h: r.height, hidden: document.hidden }
  })()`)
  const dipX = geom.screenX + geom.x + geom.w / 2
  const dipY = geom.screenY + geom.y + geom.h / 2

  // 面板必须处于「显示过」的状态；启动就是显示的，这里只兜底
  if (geom.hidden) { await ev('window.aiquad.panelToggle()'); await sleep(1800) }

  // ① 先把鼠标停在分格正中（关键：呼出后不再移动鼠标）
  const seen = (fs.existsSync(PTLOG) ? fs.readFileSync(PTLOG, 'utf8') : '').split('\n').filter((l) => l.includes('scale='))
  const scale = Number((/scale=([\d.]+)/.exec(seen[seen.length - 1] || '') || [])[1] || 1.104)
  const pos = setCursor(dipX, dipY, scale)
  console.log(`【几何】面板 screen=${geom.screenX},${geom.screenY} 分格=${geom.x.toFixed(0)},${geom.y.toFixed(0)} ${geom.w.toFixed(0)}x${geom.h.toFixed(0)} → 鼠标 DIP=${dipX.toFixed(0)},${dipY.toFixed(0)} 物理=${pos.px},${pos.py} scale=${scale}`)
  await sleep(400)

  // ② 收起（触发 setSuppressed(true) + 隐藏）
  await ev('window.aiquad.panelToggle()')
  await sleep(1800)
  const hiddenNow = await ev('document.hidden')
  console.log(`【收起】面板隐藏 = ${hiddenNow}`)

  // ③ 呼出，采集 3 秒
  const mark = Date.now()
  await ev('window.aiquad.panelToggle()')
  await sleep(3000)

  const lines = fs.readFileSync(PTLOG, 'utf8').split('\n').filter((l) => l.startsWith('[PT]'))
  const evt = lines.find((l) => l.includes('showPanel') && Number(/t=(\d+)/.exec(l)[1]) >= mark - 50)
  const t0 = evt ? Number(/t=(\d+)/.exec(evt)[1]) : mark
  const after = lines.map((l) => {
    const t = Number((/t=(\d+)/.exec(l) || [])[1])
    return { t, l, dt: t - t0 }
  }).filter((x) => x.t >= t0 - 20)
  const applies = after.filter((x) => x.l.includes('] apply '))
  const reports = after.filter((x) => x.l.includes('fromRenderer'))

  console.log('\n===== 呼出后主进程判定时间线 =====')
  for (const x of after) console.log(`  +${String(x.dt).padStart(5)}ms  ${x.l.replace('[PT] ', '')}`)

  const first = applies[0]
  const firstThrough = first ? /through=(\w+)/.exec(first.l)[1] : '?'
  const flip = applies.find((x) => /through=true/.test(x.l))
  const lastThrough = applies.length ? /through=(\w+)/.exec(applies[applies.length - 1].l)[1] : '?'
  const mouseSeen = first ? (/mouse=([\d,]+)/.exec(first.l) || [])[1] : '?'
  const originSeen = first ? (/origin=([\d,]+)/.exec(first.l) || [])[1] : '?'
  const shownSeen = first ? (/shown=([\w,+-]*)/.exec(first.l) || [])[1] : '?'

  console.log('\n===== 结论 =====')
  console.log(`  呼出后第一次判定：through=${firstThrough}  (+${first ? first.dt : '?'}ms)  ← 面板此时还在屏幕外，不穿透是对的`)
  console.log(`  首次变「穿透」：${flip ? '+' + flip.dt + 'ms' : '❌ 整段都没变过'}`)
  console.log(`  最终值：through=${lastThrough}`)
  console.log(`  那一刻：鼠标=${mouseSeen} 面板原点=${originSeen} 各格 shown=${shownSeen}`)
  console.log(`  渲染层上报次数：${reports.length}`)

  // 核心指标：**什么时候**变穿透。面板落位是 +240ms，超过 ~260ms 就说明
  // 靠的是落位后的补救，而不是滑动过程中就算对了 —— 用户手指快的那一下会落在错窗里。
  const flipMs = flip ? flip.dt : Infinity
  const pass = lastThrough === 'true' && flipMs <= 260
  console.log(`\n【判定】${pass ? '✅ 滑动过程中就算对了（≤260ms 变穿透）' : lastThrough !== 'true' ? '❌ 最终都没变成穿透' : `❌ 要等 +${flipMs}ms 才变穿透 —— 落位前那一段点击会被面板吃掉`}`)
  const mouseOk = mouseSeen !== '?'
  if (mouseOk) {
    const [mx, my] = mouseSeen.split(',').map(Number)
    if (Math.abs(mx - dipX) > 6 || Math.abs(my - dipY) > 6) {
      console.log(`  ⚠️ 鼠标落点与预期分格中心差得较多（预期 ${dipX.toFixed(0)},${dipY.toFixed(0)}）→ 本结论只能当「鼠标不在分格上」参考`)
    }
  }

  p.close()
  await sleep(500)
  process.exitCode = pass ? 0 : 3
}

main()
  .catch((e) => { console.log('失败：', String(e?.message || e)); process.exitCode = 1 })
  .finally(() => {
    /**
     * ⚠️ 必须把 `profilesRoot` 一起交给 cleanupRun。
     *
     * 只杀进程树是不够的：Chrome 的**顶层窗口属于另一个进程**（实测 spawn 的是 12320，
     * 窗口却挂在 10436 上——Chrome 自己又起了一层，launcher 退出后真正的 browser process
     * 就成了孤儿），`killTree` 够不到它，桌面上会留一个"置顶的无框网页"。
     * 传了 profilesRoot 才会走 killBrowsersUnder（判据＝命令行带本应用档案目录）。
     */
    if (CHILD && CLEANUP) { try { CLEANUP(CHILD.pid, [], path.join(Q, 'profiles')) } catch {} }
    restoreDist()
    setTimeout(() => process.exit(process.exitCode || 0), 800)
  })
