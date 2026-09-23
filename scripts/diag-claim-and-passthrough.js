/**
 * 只读诊断：两个已知问题的现场取证工具。**不修改任何窗口状态**，可直接跑。
 *
 *   用法：node scripts/diag-claim-and-passthrough.js windows        列出"会被认领"的窗口
 *         node scripts/diag-claim-and-passthrough.js passthrough 20 采样 20 秒穿透状态
 *         node scripts/diag-claim-and-passthrough.js all           先列窗口，再采样 15 秒
 *
 * 为什么要用它：
 *   ① 认领判据（win32.listBrowserWindows）看的是"窗口长得像不像装着网页的浏览器"，
 *      WorkBuddy / VS Code / 任何 Electron、WebView2 应用都满足同一套判据。
 *      第一种用法把**整张桌面**上所有满足判据的窗口连同**进程 exe 路径**列出来，
 *      exe 不是 chrome.exe / msedge.exe 的那几个就是会被误认领的。
 *      （回归脚本 `verify-claim-cmdline.js` 只查自己起的隔离实例的子窗口，扫不了真桌面。）
 *   ② 面板的鼠标穿透是 setIgnoreMouseEvents 的全局开关，不是按区域挖洞。
 *      指针搬进分格却没穿透时点击会被面板吃掉，表现就是"网页点不动"。
 *      第二种用法把穿透位与指针位置一起采样，抓出现场。
 *
 * 坐标空间与缩放（**重要，2026-09-23 实测**）：
 *   本机 node 22 的线程 DPI 感知是 **PER_MONITOR_AWARE**（`GetThreadDpiAwarenessContext()`
 *   取回 2），所以 `GetWindowRect` / `GetCursorPos` / `GetSystemMetrics` 给的都是**物理像素**
 *   ——主屏物理 2560x1440 @106dpi，最大化窗口 rect = `-8,-8 2576x1456`（= 屏宽+16），可自证。
 *   而 `styles.css` 里的 `--header-h` / `--pad` / `--gap` 是**逻辑像素** →
 *   **必须整体乘 DPI/96（本机 1.104）**。
 *   ⚠️ 原版（`bug提交/` 那份）把 scale 写死成 1，算出来的网页区顶边少 3px、左边少不到 1px
 *      —— 正是 HANDOVER §四 记的"只乘一半 → 整体偏移"那个坑的又一次翻版。
 *   现在不写死：`GetDpiForWindow(面板)/96` 现算（非感知进程会拿到被虚拟化的 96、
 *   感知进程拿到真实 DPI，两种情形都对）。
 *   顶栏高度 / 内衬 / 间隙同理不写死，运行时从 `src/renderer/styles.css` 读，改版自动跟上。
 *
 * 用 node 直接跑即可（koffi 有 node 预编译产物，不需要 electron）。
 *
 * 来源：2026-09-23 大王投递的 `bug提交/diag-claim-and-passthrough.js`，
 *       随 `bug提交/` 清理迁入 `scripts/`，并订正了上面这几处（原版 scale 写死 1、
 *       顶栏 26px 写死、把本应用自己的面板也报成"会被误认"、边界抖动会误报）。
 */
const path = require('node:path')
const fs = require('node:fs')

const koffi = require(path.join(__dirname, '..', 'node_modules', 'koffi'))
const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')
const kernel32 = koffi.load('kernel32.dll')

const EnumWindowsProc = koffi.proto('bool EnumWindowsProc(uint64 hwnd, uint64 lparam)')
const EnumChildWindowsProc = koffi.proto('bool EnumChildWindowsProc(uint64 hwnd, uint64 lparam)')
const EnumWindows = user32.func('EnumWindows', 'int', [koffi.pointer(EnumWindowsProc), 'uint64'])
const EnumChildWindows = user32.func('EnumChildWindows', 'int', ['uint64', koffi.pointer(EnumChildWindowsProc), 'uint64'])
const GetClassNameW = user32.func('GetClassNameW', 'int', ['uint64', 'char16 *', 'int'])
const GetWindowTextW = user32.func('GetWindowTextW', 'int', ['uint64', 'char16 *', 'int'])
const IsWindowVisible = user32.func('IsWindowVisible', 'int', ['uint64'])
const GetWindowRect = user32.func('GetWindowRect', 'int', ['uint64', 'uint8 *'])
const GetWindowRgn = user32.func('GetWindowRgn', 'int', ['uint64', 'uint64'])
const GetRgnBox = gdi32.func('GetRgnBox', 'int', ['uint64', 'uint8 *'])
const CreateRectRgn = gdi32.func('CreateRectRgn', 'uint64', ['int', 'int', 'int', 'int'])
const DeleteObject = gdi32.func('DeleteObject', 'int', ['uint64'])
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uint64', 'int'])
const GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'uint32', ['uint64', 'uint32 *'])
const GetCursorPos = user32.func('GetCursorPos', 'int', ['uint8 *'])
const OpenProcess = kernel32.func('OpenProcess', 'uint64', ['uint32', 'int', 'uint32'])
const QueryFullProcessImageNameW = kernel32.func('QueryFullProcessImageNameW', 'int', ['uint64', 'uint32', 'char16 *', 'uint32 *'])
const CloseHandle = kernel32.func('CloseHandle', 'int', ['uint64'])

// Win10 1607+；取不到就按 96（＝非感知进程被虚拟化后的值）处理
let GetDpiForWindow = null
try { GetDpiForWindow = user32.func('GetDpiForWindow', 'uint32', ['uint64']) } catch { /* 老系统 */ }

const GWL_EXSTYLE = -20
const WS_EX_TRANSPARENT = 0x20
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const CHROME_RENDER_WIDGET_CLASS = 'Chrome_RenderWidgetHostHWND'
const PANEL_TITLE = 'AIQuad'
/** 与 win32.listBrowserWindows 完全一致的阈值 */
const MIN_W = 200
const MIN_H = 150
/** 判定"指针在/不在网页区"时留的死区（CSS 逻辑像素）：边界上几像素的抖动不算失配 */
const DEADBAND_CSS = 8

const cls = (h) => { const b = Buffer.alloc(512); const n = GetClassNameW(h, b, 256); return n ? b.toString('utf16le', 0, n * 2) : '' }
const title = (h) => { const b = Buffer.alloc(2048); const n = GetWindowTextW(h, b, 1024); return n ? b.toString('utf16le', 0, n * 2) : '' }
const rect = (h) => { const b = Buffer.alloc(16); if (!GetWindowRect(h, b)) return null; return { x: b.readInt32LE(0), y: b.readInt32LE(4), w: b.readInt32LE(8) - b.readInt32LE(0), h: b.readInt32LE(12) - b.readInt32LE(4) } }
const pidOf = (h) => { const o = new Uint32Array(1); GetWindowThreadProcessId(h, o); return Number(o[0]) }
const cursor = () => { const b = Buffer.alloc(8); GetCursorPos(b); return { x: b.readInt32LE(0), y: b.readInt32LE(4) } }
const passthrough = (h) => ((Number(GetWindowLongPtrW(h, GWL_EXSTYLE)) >>> 0) & WS_EX_TRANSPARENT) !== 0

function rgnBox(h) {
  const r = CreateRectRgn(0, 0, 0, 0)
  const kind = GetWindowRgn(h, r)
  if (!kind) { DeleteObject(r); return null }
  const b = Buffer.alloc(16)
  GetRgnBox(r, b)
  DeleteObject(r)
  return `${b.readInt32LE(0)},${b.readInt32LE(4)},${b.readInt32LE(8)},${b.readInt32LE(12)}`
}

function hasRenderWidget(h) {
  let hit = false
  const cb = koffi.register((c) => { if (cls(c) === CHROME_RENDER_WIDGET_CLASS) hit = true; return true }, koffi.pointer(EnumChildWindowsProc))
  EnumChildWindows(h, cb, 0n)
  koffi.unregister(cb)
  return hit
}

/**
 * 取进程的 exe 完整路径。这正是"认领前应该做的校验"：
 * 只有路径等于我们启动的那个浏览器 exe，才可能是自己的窗口。
 */
function exePath(pid) {
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (!h) return ''
  const size = new Uint32Array(1)
  size[0] = 1024
  const buf = Buffer.alloc(2048)
  const ok = QueryFullProcessImageNameW(h, 0, buf, size)
  CloseHandle(h)
  return ok ? buf.toString('utf16le', 0, size[0] * 2) : ''
}

/** 枚举桌面上所有顶层窗口，返回 {hwnd, cls, title, vis, rect, pid} */
function allTopWindows() {
  const out = []
  const cb = koffi.register((h) => {
    h = Number(h)
    out.push({ hwnd: h, cls: cls(h), title: title(h), vis: !!IsWindowVisible(h), rect: rect(h), pid: pidOf(h) })
    return true
  }, koffi.pointer(EnumWindowsProc))
  EnumWindows(cb, 0n)
  koffi.unregister(cb)
  return out
}

/** 与 win32.listBrowserWindows 逐条对齐的判据 */
function claimCandidates() {
  return allTopWindows()
    .filter((w) => w.cls === 'Chrome_WidgetWin_1' && w.vis && w.rect && w.rect.w >= MIN_W && w.rect.h >= MIN_H && hasRenderWidget(w.hwnd))
}

const base = (p) => path.basename(p || '?').toLowerCase()
const isBrowserExe = (b) => b === 'chrome.exe' || b === 'msedge.exe'
/** 本应用自己的窗口（面板 / 设置窗）：它们不该算"会被误认"，属预期 */
const isSelfExe = (b) => b === 'aiquad.exe' || b === 'electron.exe'

/** 面板在窗口坐标系里的缩放：非感知进程被虚拟化成 96 → 1；感知进程拿真实 DPI */
function coordScale(hwnd) {
  if (!GetDpiForWindow) return { scale: 1, dpi: 96, note: '无 GetDpiForWindow，按 96 处理' }
  let dpi = 0
  try { dpi = Number(GetDpiForWindow(hwnd)) } catch { dpi = 0 }
  if (!dpi) dpi = 96
  return { scale: dpi / 96, dpi, note: dpi === 96 ? '本进程坐标即逻辑像素' : '本进程坐标是物理像素，已按 DPI 换算' }
}

/** 从 styles.css 读顶栏高度 / 内衬 / 间隙（改版自动跟上，不再写死 26） */
function layoutCss() {
  const p = path.join(__dirname, '..', 'src', 'renderer', 'styles.css')
  const get = (name, dflt) => {
    try {
      const m = fs.readFileSync(p, 'utf8').match(new RegExp('--' + name + ':\\s*([0-9.]+)px'))
      return m ? Number(m[1]) : dflt
    } catch { return dflt }
  }
  return { pad: get('pad', 4), gap: get('gap', 4), headerH: get('header-h', 26) }
}

/** 找面板窗口：优先标题严格等于 AIQuad 的本应用窗口 */
function findPanel() {
  const cands = claimCandidates().filter((w) => isSelfExe(base(exePath(w.pid))))
  const exact = cands.filter((w) => w.title === PANEL_TITLE)
  const pool = exact.length ? exact : cands
  if (!pool.length) return null
  return pool.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)[0]
}

function cmdWindows() {
  const cands = claimCandidates()
  console.log(`\n符合"可被认领"判据的窗口：${cands.length} 个`)
  console.log(`判据 = 类名 Chrome_WidgetWin_1 + 可见 + ≥${MIN_W}x${MIN_H} + 内含 ${CHROME_RENDER_WIDGET_CLASS}\n`)
  let bad = 0
  let self = 0
  for (const w of cands) {
    const exe = exePath(w.pid)
    const b = base(exe)
    const kind = isBrowserExe(b) ? '浏览器' : (isSelfExe(b) ? '本应用' : '非浏览器，会被误认')
    if (kind.startsWith('非浏览器')) bad += 1
    if (kind === '本应用') self += 1
    const rgn = rgnBox(w.hwnd)
    console.log(`  [${kind}] hwnd=${w.hwnd} pid=${w.pid}`)
    console.log(`     标题: ${w.title}`)
    console.log(`     进程: ${exe || '(取不到)'}`)
    console.log(`     位置: ${w.rect.x},${w.rect.y}  ${w.rect.w}x${w.rect.h}`)
    console.log(`     窗口区域: ${rgn ? rgn + '  ← 已被 AIQuad 裁过' : '无'}`)
  }
  console.log(`\n小结：${bad} 个第三方非浏览器进程的窗口满足判据（本应用自己的 ${self} 个不算）——`)
  console.log('程序退出 / 切格时它们会被当作分格窗口处理；0.4.12 起已用「exe + 命令行 --user-data-dir」拦掉。')
}

function cmdPassthrough(seconds) {
  const panel = findPanel()
  if (!panel) {
    console.log(`\n没找到 AIQuad 面板窗口（标题 "${PANEL_TITLE}"）。请先让面板显示出来再跑。`)
    return
  }
  const { scale, dpi, note } = coordScale(panel.hwnd)
  const { pad, gap, headerH } = layoutCss()
  // 网页区 = 面板矩形，顶边再让出「顶栏 + 间隙」
  const top = Math.round((headerH + gap) * scale)
  const side = Math.round(pad * scale)
  const pane = {
    x: panel.rect.x + side,
    y: panel.rect.y + top,
    w: panel.rect.w - side * 2,
    h: panel.rect.y + panel.rect.h - top - side - panel.rect.y,
  }
  const db = Math.round(DEADBAND_CSS * scale) // 死区：边界抖动不算失配

  console.log(`\n面板 hwnd=${panel.hwnd}  "${panel.title}"  位置 ${panel.rect.x},${panel.rect.y} ${panel.rect.w}x${panel.rect.h}`)
  console.log(`坐标空间：DPI=${dpi} → scale=${scale}（${note}）；顶栏 ${headerH} / 内衬 ${pad} / 间隙 ${gap}（读自 styles.css）`)
  console.log(`推算网页区：${pane.x},${pane.y} ${pane.w}x${pane.h}（另有 ${DEADBAND_CSS}px 死区）`)
  console.log(`采样 ${seconds} 秒（每 100ms 一次），只报"指针确实在网页区却没穿透"和"指针确实在网页区外却穿透"两种失配\n`)

  let bad = 0
  let n = 0
  const t = setInterval(() => {
    n += 1
    const p = cursor()
    const inside = p.x >= pane.x + db && p.x < pane.x + pane.w - db && p.y >= pane.y + db && p.y < pane.y + pane.h - db
    const outside = p.x < pane.x - db || p.x >= pane.x + pane.w + db || p.y < pane.y - db || p.y >= pane.y + pane.h + db
    const through = passthrough(panel.hwnd)
    if (inside && !through) {
      bad += 1
      console.log(`  [${new Date().toLocaleTimeString()}] 失配：指针在网页区，面板却收着鼠标（点击会被吃掉 → 网页点不动）   指针=${p.x},${p.y}`)
    } else if (outside && through) {
      bad += 1
      console.log(`  [${new Date().toLocaleTimeString()}] 失配：指针不在网页区，面板却穿透了（面板自己的 UI 点不到）   指针=${p.x},${p.y}`)
    }
  }, 100)
  setTimeout(() => {
    clearInterval(t)
    console.log(`\n采样结束：${n} 次里失配 ${bad} 次。`)
    console.log('复现要点：先收起面板，再呼出，然后在指针不动的情况下直接点网页。')
  }, seconds * 1000)
}

const mode = process.argv[2] || 'all'
if (mode === 'windows') cmdWindows()
else if (mode === 'passthrough') cmdPassthrough(Number(process.argv[3]) || 20)
else { cmdWindows(); cmdPassthrough(15) }
