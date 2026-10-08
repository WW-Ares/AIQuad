/**
 * 只读诊断：AIQuad 面板与分格浏览器窗口**是不是在同一个置顶带里**。
 *
 * 查的是 bug "只有黑框在顶层、网页不在顶层"：
 * 面板（Electron）浮在最顶，而分格的原生 Chrome 窗口被别的程序盖住。
 * 两种可能必须分开看：
 *   ① 带内次序问题   —— 两者都在置顶带，只是 Chrome 排在别人下面（`placeBelow` 能修）；
 *   ② **掉出置顶带** —— Chrome 的 `WS_EX_TOPMOST` 被清掉，掉进普通层，
 *      那么任何普通程序都能盖住它，而面板仍在置顶带 → 正是"黑框浮着、网页没了"。
 *      ⚠️ 这种状况 30ms 看门狗修不了：`windowsAbovePanel()` 从 `getTopWindow()`
 *      往下走到面板就停，面板**之下**的窗口它一眼都不看。
 *
 * ⚠️ **本脚本只读，一个进程都不杀、一个样式都不改**。
 *    大王正在复现现场，绝不能碰杀进程那条红线（见 MEMORY「回归脚本收尾」）。
 *
 * 用法：node scripts/diag-topmost-band.js
 */
const w32 = require('../dist/main/win32')

/** WS_EX_TOPMOST = 0x00000008（GWL_EXSTYLE 里的一位） */
const WS_EX_TOPMOST = 0x8
const GWL_EXSTYLE = -20

/** GW_ 枚举 */
const GW_HWNDNEXT = 2

function topmostBit(hwnd) {
  const ex = w32.getWindowLong(hwnd, GWL_EXSTYLE)
  return { ex, isTopmost: (ex & WS_EX_TOPMOST) !== 0 }
}

function fmtRect(r) {
  if (!r) return '无矩形'
  // BrowserWindowInfo.rect 是 { x, y, width, height }，不是 left/top/right/bottom
  const { x, y, width, height } = r
  if ([x, y, width, height].some(v => typeof v !== 'number')) return `矩形字段异常 ${JSON.stringify(r)}`
  return `${x},${y} ${width}x${height}`
}

/** 走一遍完整 Z 序（从最顶往下），标出每个窗口的带归属 */
function walkZOrder() {
  const rows = []
  let h = w32.getTopWindow()
  let guard = 0
  while (h && guard++ < 300) {
    const cls = w32.getClassName(h)
    const title = w32.getWindowText(h)
    const vis = w32.isWindowVisible(h)
    if (!vis) {
      // 不可见窗口只占位，不展开，避免刷屏
      rows.push({ hwnd: h, cls, title, visible: false })
      h = w32.getWindow(h, GW_HWNDNEXT)
      continue
    }
    const { ex, isTopmost } = topmostBit(h)
    rows.push({ hwnd: h, cls, title, visible: true, ex, isTopmost })
    h = w32.getWindow(h, GW_HWNDNEXT)
  }
  return rows
}

function main() {
  console.log('='.repeat(72))
  console.log('AIQuad 置顶带诊断（只读，不杀进程不改样式）')
  console.log('='.repeat(72))

  /**
   * ⚠️ 这里**不能**用 `listBrowserWindows()` 找面板：它要求窗口里有
   * `Chrome_RenderWidgetHostHWND` 子窗口，而**面板是 Electron 窗口、没有那个子窗口**，
   * 所以它必然被漏掉（第一版探针就栽在这，误报成"面板 0 个"）。
   * 面板的判据只能用标题 —— 它是唯一认得出来的地方。
   */
  const all = w32.listBrowserWindows()
  const panelRow = { hwnd: 0, title: 'AIQuad', isPanel: true }
  const zAll = walkZOrder().filter(r => r.visible)
  const found = zAll.find(r => /^AIQuad$/i.test((r.title || '').trim()))
  if (found) panelRow.hwnd = found.hwnd

  console.log(`\nlistBrowserWindows 枚举到 ${all.length} 个浏览器窗口；`
    + `面板${panelRow.hwnd ? `已定位 hwnd=0x${panelRow.hwnd.toString(16)}` : '**没找到**（面板未呼出？）'}\n`)

  // 逐个报置顶位
  const rows = []
  for (const w of all) {
    const { ex, isTopmost } = topmostBit(w.hwnd)
    const pid = w32.getWindowPid(w.hwnd)
    const exe = w32.processImagePath(pid)
    const cl = w32.processCommandLine(pid)
    const udd = /--user-data-dir=(\S+)/i.exec(cl || '')
    rows.push({
      hwnd: w.hwnd,
      title: w.title,
      ex,
      isTopmost,
      exe: exe ? exe.split(/[\\/]/).pop() : '?',
      rect: fmtRect(w.rect),
      isPanel: false,
      udd: udd ? udd[1] : '(无 udd)',
    })
  }
  if (panelRow.hwnd) {
    const { ex, isTopmost } = topmostBit(panelRow.hwnd)
    rows.unshift({
      hwnd: panelRow.hwnd,
      title: 'AIQuad',
      ex,
      isTopmost,
      exe: 'AIQuad.exe',
      rect: '-',
      isPanel: true,
      udd: '(Electron)',
    })
  }

  for (const r of rows) {
    const kind = r.isPanel ? '面板  ' : '分格? '
    console.log(`${kind} hwnd=0x${r.hwnd.toString(16)}  ex=0x${(r.ex >>> 0).toString(16)}  ${r.isTopmost ? '【置顶】' : '【普通层】'}  ${r.exe}`)
    console.log(`         标题="${r.title}"  ${r.rect}`)
    console.log(`         udd=${r.udd}`)
  }

  // 汇总：面板与分格是否同带
  const panels = rows.filter(r => r.isPanel)
  const panes = rows.filter(r => !r.isPanel)
  console.log('\n' + '-'.repeat(72))
  console.log(`面板 ${panels.length} 个 / 疑似分格 ${panes.length} 个`)
  for (const p of panels) console.log(`  面板置顶位 = ${p.isTopmost}`)
  for (const p of panes) console.log(`  分格置顶位 = ${p.isTopmost}  (udd=${p.udd})`)

  const split = panels.some(p => p.isTopmost) && panes.some(p => !p.isTopmost)
  console.log('\n' + '='.repeat(72))
  if (split) {
    console.log('★ 判定：**置顶带分裂** —— 面板在置顶带，而至少一个分格掉在普通层。')
    console.log('  这就是"黑框浮在最顶、网页被别的程序盖住"的直接成因。')
    console.log('  看门狗修不了它：windowsAbovePanel() 走到面板就停，面板之下不看。')
  }
  else if (panels.length && panes.every(p => p.isTopmost)) {
    console.log('判定：面板与分格**同在置顶带**。')
    console.log('  → 那问题在带内次序（placeBelow 该按没按），不是掉带。')
  }
  else {
    console.log('判定：未检出置顶带分裂（可能面板未呼出，或分格尚未认领）。')
  }
  console.log('='.repeat(72))

  // Z 序快照：面板附近到底压着谁
  console.log('\nZ 序快照（从最顶往下，只列可见窗口，前 25 个）：')
  const z = walkZOrder().filter(r => r.visible).slice(0, 25)
  const panelIdx = z.findIndex(r => /aiquad/i.test(r.title))
  z.forEach((r, i) => {
    const band = r.isTopmost ? '置顶带' : '普通层'
    const mark = /aiquad/i.test(r.title) ? ' ←AIQuad面板' : ''
    console.log(`  ${String(i).padStart(2)}: [${band}] 0x${r.hwnd.toString(16)} ${r.cls.slice(0, 22).padEnd(22)} "${(r.title || '').slice(0, 34)}"${mark}`)
  })
  if (panelIdx >= 0) {
    console.log(`\n  面板在可见 Z 序里排第 ${panelIdx} 位；它下面的窗口就是"黑框之下"看到的东西。`)
  }
}

main()