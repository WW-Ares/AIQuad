/**
 * 验证「被裁掉的浏览器外壳不会露在相邻分格上」—— 覆盖两层，都是 DWM 画的、
 * **都不受 `SetWindowRgn` 约束**：
 *
 *   A. 系统背板（Mica）→ 表现为一整条**死板纯色**。
 *   B. 原生窗口框架 → 表现为**一条 1px 外框线 + 右上角一个 ✕ 按钮**。
 *
 * 背景（2026-09-15 查实，在别的机器上多次没修好的 bug）：
 *   分格里的浏览器是**标准窗口**，自带约 96px 的标题栏+标签栏+地址栏；
 *   我们靠 `SetWindowRgn` 把这一截从可视区裁掉。Chrome 自己的内容确实被裁掉了，
 *   但上面那两层照旧画满窗口矩形。2 格 / 4 格布局里，**下面那格窗口"被裁掉的那一截"
 *   正好落在上面那格的底部**，于是"选中下面的格子，上面那格底部被入侵"。
 *
 *   修法：A 用 `DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_NONE)`
 *   （`win32.disableWindowBackdrop` / `instance-manager.fixBackdrop`）；
 *   B 用摘掉窗口样式里的 `WS_CAPTION | WS_THICKFRAME`
 *   （`win32.stripWindowFrame` / `instance-manager.fixFrame`，逐项实测见那里的注释）。
 *
 * 为什么以前的自检全绿却漏掉了它：
 *   · A：`GetWindowRgn` / `PtInRegion` 读回来完全正常（区域确实设上了，命中测试也确实生效），
 *     所有"基于区域"的断言都判通过 —— **只有采屏幕像素才看得见**。
 *   · B：即便采了像素也照样漏 —— 原来只在被裁带里横向取 0.2 / 0.5 / 0.8 三行，
 *     而框线只有 1~2px 高，采样行正好从它两行中间穿过去，量到的是干干净净的棋盘格。
 *   所以本脚本：断言全部落在屏幕像素上（不看区域），并且**竖着逐像素扫一列**（见 scanPoints）。
 *
 * 本脚本怎么保证"真的看得见"：
 *   ① 先把每个分格页面的底色刷成**洋红/亮绿棋盘格**（通过 CDP）。棋盘格是极高对比的
 *      确定性图案，于是"这一片是不是被一块死板纯色盖住了"用一行像素的极差就能判死；
 *      而框线/✕ 是接近灰阶的**中性色**，用"中性色像素占比"判死 —— 两个判据互不干扰。
 *   ② 再对着屏幕实拍，取"下面那格窗口的被裁区"与"上面那格可视区"的交集，
 *      横着取三行（抓纯色块）+ 竖着扫三列（抓框线与 ✕）。
 *   ③ 真点一下下面那格（前台激活，用户的实际操作路径），再测一次。
 *   ④ 直接把背板**注入回来**（脚本自己调 DwmSetWindowAttribute 设成 AUTO），
 *      验证 30ms 看门狗会把它关回去（这一项就是为"几何没变、背板却回来了"加的）。
 *   ⑤ 再把窗口样式里的 `WS_CAPTION | WS_THICKFRAME` **注回去**，验证看门狗同样会摘掉它
 *      （对应 `verifyGeometry` 的 ⓪ 项）。
 *
 * 自证：带 `AIQUAD_TEST_KEEP_BACKDROP=1` 跑（应用侧故意两处都不修），本脚本**必须报失败**；
 *   若那时仍报绿，说明脚本瞎了，脚本自己会 exit 1。这条负向对照是本脚本存在的前提。
 *
 * 用法：
 *   node scripts/verify-clip-pixels.js
 *   AIQUAD_TEST_SCALE=1.1 AIQUAD_TEST_PORT=9331 node scripts/verify-clip-pixels.js
 *   AIQUAD_TEST_KEEP_BACKDROP=1 node scripts/verify-clip-pixels.js     # 负向对照，应当失败
 *
 * ⚠️ 每档都要换 AIQUAD_TEST_PORT；别用 951$RANDOM（会超 65535）。
 * ⚠️ 必须至少跑一档 ≠ 100% 缩放：几何那类 bug 只在非 100% 下复现。
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const koffi = require('koffi')
const { CdpSession, listPageTargets } = require('../dist/main/cdp')
const w32 = require('../dist/main/win32')
const { cleanupRun, browserPidsUnder } = require('./lib/process-cleanup')

const projectRoot = path.join(__dirname, '..')
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const tmp = path.join(projectRoot, '.tmp')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SCALE = process.env.AIQUAD_TEST_SCALE || '1'
const PORT = Number(process.env.AIQUAD_TEST_PORT || 9330)
/** 负向对照：应用侧故意两处都不修（背板 + 原生窗框），本脚本必须能看出来 */
const KEEP_BACKDROP = !!process.env.AIQUAD_TEST_KEEP_BACKDROP
/** 只关"原生窗框"那一半的修复（背板照常修），用来单独校窗框判据 */
const KEEP_FRAME = !!process.env.AIQUAD_TEST_KEEP_FRAME
const LAYOUTS = (process.env.AIQUAD_TEST_LAYOUTS || '2,4')
  .split(',').map((s) => s.trim()).filter(Boolean)

/* ---------------- DWM 背板读写（和 src/main/win32.ts 里那份同源，这里独立一份，
   好让脚本既能"制造 bug"又能"观察应用有没有修好"） ---------------- */
const DWMWA_SYSTEMBACKDROP_TYPE = 38
const DWMSBT_AUTO = 0
const DWMSBT_NONE = 1
const dwmapi = (() => {
  try {
    return koffi.load('dwmapi.dll')
  }
  catch {
    return null
  }
})()
const DwmSetWindowAttribute = dwmapi
  ? dwmapi.func('DwmSetWindowAttribute', 'int32', ['uint64', 'uint32', 'uint8 *', 'uint32'])
  : null
function setBackdrop(hwnd, type) {
  if (!DwmSetWindowAttribute) return false
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(type, 0)
  return DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, buf, 4) === 0
}

/* ---------------- 系统级点击（真点，不是往渲染层注入事件） ---------------- */
const user32 = koffi.load('user32.dll')
const SetCursorPos = user32.func('SetCursorPos', 'int', ['int', 'int'])
const mouse_event = user32.func('mouse_event', 'void', ['uint32', 'uint32', 'uint32', 'uint32', 'uint64'])
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004

/* ---------------- 窗口样式：观察 / 注入"原生窗口框架"（外框线 + ✕） ----------------
   这一层和系统背板一样是 DWM 画的、不受 SetWindowRgn 约束，所以也由屏幕像素判定；
   这里只是给脚本一副"能制造它、也能看穿它"的手脚。 */
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uint64', 'int'])
const SetWindowLongPtrW = user32.func('SetWindowLongPtrW', 'int64', ['uint64', 'int', 'int64'])
const SetWindowPosRaw = user32.func('SetWindowPos', 'int', ['uint64', 'uint64', 'int', 'int', 'int', 'int', 'uint32'])
const GWL_STYLE = -16
const WS_CAPTION = 0x00c00000
const WS_THICKFRAME = 0x00040000
const SWP_STYLE_ONLY = 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020 // NOSIZE|NOMOVE|NOZORDER|NOACTIVATE|FRAMECHANGED
/** 窗口样式里还留着会被 DWM 画成框架的位吗 */
function windowHasFrame(hwnd) {
  try { return (Number(GetWindowLongPtrW(hwnd, GWL_STYLE)) & (WS_CAPTION | WS_THICKFRAME)) !== 0 } catch { return false }
}
/** 故意把框架注回去（模拟 Chrome 重排时把样式带回来），验证看门狗认不认得出 */
function restoreWindowFrame(hwnd) {
  try {
    const st = Number(GetWindowLongPtrW(hwnd, GWL_STYLE))
    SetWindowLongPtrW(hwnd, GWL_STYLE, BigInt((st | WS_CAPTION | WS_THICKFRAME) >>> 0))
    SetWindowPosRaw(hwnd, 0n, 0, 0, 0, 0, SWP_STYLE_ONLY)
    return true
  }
  catch { return false }
}

/**
 * 采样点里允许出现的"非洋红"像素上限。
 * 纯色底 + 无入侵的正常情况下应该是 **0**，留几个余量给缩放/合成的轻微漂移。
 * 实测参考：完全干净时 0；只露出原生窗框（外框线 + ✕）时同一个 zone 上有 25 个以上。
 */
const OFF_COLOR_MAX = 6

async function clickAt(x, y) {
  SetCursorPos(Math.round(x), Math.round(y))
  await sleep(120)
  mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0n)
  await sleep(40)
  mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0n)
}

/* ---------------- 截图 / 采像素：走 PowerShell + System.Drawing（无需第三方库） ---------------- */
fs.mkdirSync(tmp, { recursive: true })

/**
 * ⚠️ 这两个 .ps1 必须是**纯 ASCII**：PowerShell 5.1 按 ANSI 读脚本，
 * 混进中文会直接 ParserError 且看不出原因。中文只写在本文件的注释里。
 */
function writeAscii(file, text) {
  const p = path.join(tmp, file)
  fs.writeFileSync(p, text.replace(/\r?\n/g, '\r\n'), 'ascii')
  return p
}

const SHOT_PS1 = writeAscii('clip-shot.ps1', `
param([string]$Out, [string]$Meta)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
[System.IO.File]::WriteAllText($Meta, "$($vs.Left),$($vs.Top),$($vs.Width),$($vs.Height)")
`)

const PIX_PS1 = writeAscii('clip-pix.ps1', `
param([string]$Png, [string]$Points, [string]$Out)
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Image]::FromFile($Png)
$lines = New-Object System.Collections.Generic.List[string]
foreach ($ln in [System.IO.File]::ReadAllLines($Points)) {
  if ($ln.Trim().Length -eq 0) { continue }
  $p = $ln.Split(',')
  $x = [int]$p[0]
  $y = [int]$p[1]
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $bmp.Width -or $y -ge $bmp.Height) {
    $lines.Add("$x,$y,-1,-1,-1")
    continue
  }
  $c = $bmp.GetPixel($x, $y)
  $lines.Add("$x,$y,$($c.R),$($c.G),$($c.B)")
}
$bmp.Dispose()
[System.IO.File]::WriteAllLines($Out, $lines)
`)

let shotSeq = 0
function shot(tag) {
  shotSeq += 1
  const out = path.join(tmp, `clip-${tag}-${shotSeq}.png`)
  const meta = path.join(tmp, `clip-${tag}-${shotSeq}.meta`)
  execFileSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SHOT_PS1, '-Out', out, '-Meta', meta],
    { encoding: 'utf8' })
  const [left, top, width, height] = fs.readFileSync(meta, 'utf8').trim().split(',').map(Number)
  return { png: out, vs: { left, top, width, height } }
}

/** 采一批**屏幕物理坐标**的点，返回 [{x,y,r,g,b}] */
function sample(screen, points) {
  const pf = path.join(tmp, 'clip-points.txt')
  const of = path.join(tmp, 'clip-points-out.txt')
  fs.writeFileSync(pf, points.map((p) => `${Math.round(p[0] - screen.vs.left)},${Math.round(p[1] - screen.vs.top)}`).join('\n'))
  execFileSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PIX_PS1, '-Png', screen.png, '-Points', pf, '-Out', of],
    { encoding: 'utf8' })
  const lines = fs.readFileSync(of, 'utf8').trim().split(/\r?\n/).filter(Boolean)
  return lines.map((l) => {
    const [x, y, r, g, b] = l.split(',').map(Number)
    return { x: x + screen.vs.left, y: y + screen.vs.top, r, g, b }
  })
}

/* ---------------- 页面刷成纯洋红底 ---------------- */
/**
 * 页面底色刷成**纯洋红**（不是棋盘格）。
 *
 * 为什么不用棋盘格（0.4.10 试过、不行）：棋盘格两色（洋红 / 亮绿）之间的水平边界
 * 在**所有 x 上是共线的**，那条边界上的过渡灰点会被"中性色像素"判据当成一条窗框线
 * ——实测每列固定 2 个共线灰点，跟窗口框架长得一模一样，没法区分。
 * 换成纯色之后，图案内部没有任何边界：**凡是"不是洋红"的像素，就一定是别的东西画上来的**，
 * 判据塌缩成"数非洋红像素"，既简单又没有误报源，还能顺带看出入侵物是什么颜色。
 *
 * 仍然用 `position:fixed` 的浮层而不是改 html/body 背景：这些站点的根容器自带不透明底色，
 * 会把 body 背景整个盖住（0.4.9 因此白测过一轮）。
 */
const MAGENTA = [255, 0, 255]
const CHECKER_CSS = 'position:fixed!important;inset:0!important;left:0!important;top:0!important;'
  + 'width:100vw!important;height:100vh!important;'
  + 'z-index:2147483647!important;pointer-events:none!important;'
  + 'background:rgb(255,0,255)!important'
const CHECKER_JS = `(() => {
  let d = document.getElementById('__aiquad_checker')
  if (!d) {
    d = document.createElement('div')
    d.id = '__aiquad_checker'
    document.documentElement.appendChild(d)
  }
  d.setAttribute('style', ${JSON.stringify(CHECKER_CSS)})
  return true
})()`

/**
 * 采样点是不是"该有的纯洋红"。
 * 容差 50 是留给 DPI 缩放/合成时通道值的轻微漂移；这个范围足以把常见入侵物全部排除：
 * 奶白背板 (249,241,235) → g 超标；窗框灰 (206,206,206) → g 超标；面板深色 (42,47,58) → r/b 不足。
 */
const MAGENTA_TOL = 50
function isExpected(s) {
  return Math.abs(s.r - MAGENTA[0]) <= MAGENTA_TOL
    && s.g <= MAGENTA_TOL
    && Math.abs(s.b - MAGENTA[2]) <= MAGENTA_TOL
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
    AIQUAD_DISABLE_GPU: process.env.AIQUAD_DISABLE_GPU || '1',
    AIQUAD_NO_SANDBOX: process.env.AIQUAD_NO_SANDBOX || '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  /**
   * 档案目录不能"用完就删"地想当然：Chrome 刚被 kill 时还握着 BrowserMetrics 里的文件，
   * `rmSync` 会以 EBUSY 直接抛出去（实测连着跑第二轮必崩）。删不掉就换一个新目录，
   * 别让一次清理失败毁掉整轮测试。
   */
  const udBase = path.join(tmp, `ud-clip-${SCALE}`)
  let ud = udBase
  try {
    fs.rmSync(udBase, { recursive: true, force: true })
  }
  catch {
    ud = `${udBase}-${Date.now().toString(36)}`
    console.log('  （上一轮的档案目录被占用，本轮换用新目录）')
  }
  fs.mkdirSync(ud, { recursive: true })
  const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`]
  if (Number(SCALE) !== 1) args.push(`--force-device-scale-factor=${SCALE}`)
  args.push(projectRoot)

  const modeNote = KEEP_BACKDROP
    ? '  【负向对照：背板与原生窗框都不修】'
    : (KEEP_FRAME ? '  【只挂原生窗框：背板照常修】' : '')
  console.log(`启动应用：deviceScaleFactor=${SCALE}${modeNote}`)
  const child = spawn(electronExe, args, { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d.toString() })
  child.stderr.on('data', (d) => { log += d.toString() })

  const finish = (code) => {
    try { cleanupRun(child.pid, ['electron.exe', 'AIQuad.exe']) } catch {}
    process.exit(code)
  }

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
    finish(1)
  }

  const cdp = new CdpSession(target.webSocketDebuggerUrl)
  await cdp.connect()
  const num = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value
  const click = (sel) => num(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true })()`)

  const dpr = await num('window.devicePixelRatio')
  console.log(`devicePixelRatio = ${dpr}`)

  // 分格的浏览器档案在 <userData>/profiles/*/，每个档案一个 DevToolsActivePort
  const browserPorts = []
  const scanPorts = () => {
    const root = path.join(ud, 'profiles')
    if (!fs.existsSync(root)) return
    for (const name of fs.readdirSync(root)) {
      const f = path.join(root, name, 'DevToolsActivePort')
      if (!fs.existsSync(f)) continue
      const port = Number(fs.readFileSync(f, 'utf8').trim().split(/\r?\n/)[0])
      if (port > 0 && !browserPorts.includes(port)) browserPorts.push(port)
    }
  }

  /** 把当前所有分格页面刷成棋盘格；返回刷成功的页面数 */
  async function paintChecker() {
    scanPorts()
    let painted = 0
    for (const port of browserPorts) {
      let targets = []
      try { targets = await listPageTargets(port) }
      catch { continue }
      for (const t of targets) {
        try {
          const s = new CdpSession(t.webSocketDebuggerUrl)
          await s.connect()
          const r = await s.send('Runtime.evaluate', { expression: CHECKER_JS, returnByValue: true })
          if (r?.result?.value === true) painted += 1
          await s.close()
        }
        catch {}
      }
    }
    return painted
  }

  /** 等 n 个分格 ready */
  async function waitPanes(n, timeoutMs = 90000) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const k = await num(`document.querySelectorAll('#panes > .pane.ready').length`)
      if (k >= n) return true
      await sleep(800)
    }
    return false
  }

  /**
   * 切布局：**要点到"分格数真的变了"为止**。
   * 踩过：应用刚起来时渲染层还没接上点击处理器，这一下 `click()` 直接丢了，
   * 于是后面干等 90s 判"分格没就位"——把竞态当成功能坏了。
   */
  async function clickLayout(n) {
    for (let i = 0; i < 20; i++) {
      await click(`[data-layout="${n}"]`)
      await sleep(1200)
      const k = await num(`document.querySelectorAll('#panes > .pane').length`)
      if (k === n) return true
      if (i === 0) console.log(`  （分格数还是 ${k}，重试点击 [data-layout="${n}"]）`)
    }
    return false
  }

  /**
   * 采一轮：返回每个"被裁区压在别的分格上"的窗口的像素极差。
   *
   * 全部用**屏幕物理坐标**：窗口矩形与窗口区域（GetRgnBox）都是物理像素，
   * 所以整条链路不需要 DIP→物理换算，也就不会踩"少乘一次 scale"那个坑。
   *
   * ⚠️ 只认**本实例**的浏览器窗口：按"命令行里带着本次测试档案根目录"筛 pid
   * （见 lib/process-cleanup 的 browserPidsUnder）。不筛的话，用户自己开着的
   * 浏览器、甚至另一个 AIQuad 实例的窗口都会被当成被测量——它们背板没关掉、
   * 或者压在测试窗口上面，会把判定搅成一团假失败/假通过。
   */
  function probe() {
    const ourPids = new Set(browserPidsUnder(path.join(ud, 'profiles')))
    const all = w32.listBrowserWindows()
    const describe = (w) => {
      const rb = w32.windowRegionBox(w.hwnd)
      if (!rb) return null
      return {
        hwnd: w.hwnd,
        title: w.title,
        win: w.rect,
        rb,
        /** 该窗口"真正可见"的那块（屏幕物理坐标） */
        vis: {
          left: w.rect.x + rb.left,
          top: w.rect.y + rb.top,
          right: w.rect.x + rb.right,
          bottom: w.rect.y + rb.bottom,
        },
        backdrop: w32.windowBackdropType(w.hwnd),
      }
    }
    const windows = all
      .filter((w) => w.pid !== child.pid && ourPids.has(w.pid))
      .map(describe)
      .filter(Boolean)
    const foreign = all
      .filter((w) => w.pid !== child.pid && !ourPids.has(w.pid))
      .map(describe)
      .filter(Boolean)

    const screen = shot('probe')
    if (!windows.length) return { screen, windows, foreign, zones: [] }

    const zones = []
    for (const w of windows) {
      if (w.rb.top < 8) continue // 没有可裁的带（比如这一格在上排，被裁的那截落在顶栏上）
      const y0 = w.win.y
      const y1 = w.vis.top
      const x0 = w.vis.left
      const x1 = w.vis.right
      // 只取它真正压在**另一个分格可视区**上的部分
      for (const o of windows) {
        if (o === w) continue
        const iy0 = Math.max(y0, o.vis.top)
        const iy1 = Math.min(y1, o.vis.bottom)
        const ix0 = Math.max(x0, o.vis.left)
        const ix1 = Math.min(x1, o.vis.right)
        if (iy1 - iy0 < 20 || ix1 - ix0 < 60) continue
        const zone = { x0: ix0, y0: iy0, x1: ix1, y1: iy1 }
        zones.push({
          hwnd: w.hwnd,
          backdrop: w.backdrop,
          over: o.hwnd,
          overWin: o,
          band: { x0, y0, x1, y1 },
          zone,
          /** 有没有"别人的窗口"压在这块上——有的话这一块的像素说明不了问题 */
          polluted: foreign.filter((f) => f.win.x < zone.x1 && f.win.x + f.win.width > zone.x0
            && f.win.y < zone.y1 && f.win.y + f.win.height > zone.y0).map((f) => f.hwnd),
        })
      }
    }

    // 采样：每个 zone 取 3 行，每行 24 个点（左右各 12，避开中间那截可能是胶囊的地方）
    const points = []
    const meta = []
    for (const z of zones) {
      const h = z.zone.y1 - z.zone.y0
      z.rows = [0.2, 0.5, 0.8].map((f) => Math.round(z.zone.y0 + h * f))
      z.cols = []
      const w = z.zone.x1 - z.zone.x0
      for (let i = 0; i < 12; i++) z.cols.push(Math.round(z.zone.x0 + w * (0.04 + 0.26 * (i / 11))))
      for (let i = 0; i < 12; i++) z.cols.push(Math.round(z.zone.x0 + w * (0.70 + 0.26 * (i / 11))))
      for (const y of z.rows) for (const x of z.cols) { points.push([x, y]); meta.push(z) }
    }

    /**
     * 竖向扫描线：**逐像素**从上到下走一列。
     *
     * 为什么必须要它：窗口的外框线只有 1~2px 高，而那三条横向采样（0.2/0.5/0.8）
     * 正好从它两行之间穿过去 —— 这就是 0.4.10 明明露出"一条横线 + 一个 ✕"、
     * 本脚本却判绿的原因。竖着扫一列，水平方向的框线必然被扫到。
     *
     * 三条线的位置：左 1/4、右 3/4、以及**最右边内缩 12px**（✕ 按钮就在那儿）。
     * 避开正中间的 0.5 —— 那一带常被面板自己的悬浮胶囊占着，量到的不算入侵。
     */
    const scanPoints = []
    const scanMeta = []
    for (const z of zones) {
      const w = z.zone.x1 - z.zone.x0
      z.scanCols = [
        Math.round(z.zone.x0 + w * 0.2),
        Math.round(z.zone.x0 + w * 0.8),
        Math.round(z.zone.x1 - 12),
      ].filter((x, i, arr) => arr.indexOf(x) === i && x > z.zone.x0 + 1 && x < z.zone.x1 - 1)
      for (const x of z.scanCols) {
        for (let y = Math.round(z.zone.y0); y < Math.round(z.zone.y1); y++) {
          scanPoints.push([x, y])
          scanMeta.push(z)
        }
      }
    }

    /**
     * 「图案自检」：在分格可视区的中段戳一片 5×5 的点。
     * 这里显示的是该分格**自己的网页内容**，所以必须看到棋盘格（极差 ≈ 255）。
     * 看不到就说明图案没刷上 —— 那一格的像素判定必须作废，否则就是在拿
     * "这段有没有文字"当"有没有被背板盖住"用（0.4.9 那次翻车就是这么来的）。
     */
    const sanGrid = []
    for (const w of windows) {
      w.patternOk = null
      // 避开顶部 60px（外壳/圆角）与底部 60px（面板的悬浮胶囊压在上面）
      const y0 = w.vis.top + 60
      const y1 = w.vis.bottom - 60
      if (y1 - y0 < 40) continue
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
          sanGrid.push({ w, pt: [Math.round(w.vis.left + (w.vis.right - w.vis.left) * (0.2 + 0.15 * i)), Math.round(y0 + (y1 - y0) * (j / 4))] })
        }
      }
    }

    if (sanGrid.length) {
      const px = sample(screen, sanGrid.map((s) => s.pt))
      const byWindow = new Map()
      for (let i = 0; i < sanGrid.length; i++) {
        const { w } = sanGrid[i]
        if (!byWindow.has(w)) byWindow.set(w, [])
        byWindow.get(w).push(px[i])
      }
      for (const [w, list] of byWindow) {
        const hit = list.filter(isExpected).length
        w.patternOk = list.length ? hit / list.length : 0
      }
    }

    if (points.length) {
      const px = sample(screen, points)
      for (const z of zones) z.samples = []
      for (let i = 0; i < px.length; i++) meta[i].samples.push(px[i])
      /** 横向三行采样里的"非洋红"像素 —— 有别的东西盖在这一带上就是它 */
      for (const z of zones) z.offH = z.samples.filter((s) => !isExpected(s)).length
    }
    else {
      for (const z of zones) { z.rows = []; z.cols = []; z.samples = []; z.offH = 0 }
    }

    if (scanPoints.length) {
      const px = sample(screen, scanPoints)
      for (const z of zones) z.scan = []
      for (let i = 0; i < px.length; i++) scanMeta[i].scan.push(px[i])
      for (const z of zones) {
        const off = z.scan.filter((s) => !isExpected(s))
        z.offV = off.length
        z.scanTotal = z.scan.length
        z.offColors = {}
        for (const s of off) {
          const key = `${s.r},${s.g},${s.b}`
          z.offColors[key] = (z.offColors[key] || 0) + 1
        }
        /** 每条竖向扫描线上"入侵"像素的 y（按 x 分组）—— 一眼能看出是不是一条横线/一个按钮 */
        z.offByCol = new Map()
        for (const s of off) {
          const arr = z.offByCol.get(s.x) || []
          arr.push(s.y)
          z.offByCol.set(s.x, arr)
        }
      }
    }
    else {
      for (const z of zones) { z.scan = []; z.offV = 0; z.scanTotal = 0; z.offColors = {}; z.offByCol = new Map() }
    }

    return { screen, windows, foreign, zones }
  }

  const failures = []
  const results = []

  /**
   * 判定一处"被裁区压在邻居上"的像素。
   *
   * 三种情况不下结论（宁可说"没测到"，也不能拿不相干的东西当证据）：
   *   · 被不属于本次测试的窗口压着（用户自己开的浏览器 / 另一个 AIQuad 实例）
   *   · 邻居那一格没刷上纯洋红底（没有参照，量到的像素说明不了问题）
   *   · 没采到有效点（带子太窄）
   *
   * 判据只有一条：**这一带上应该全是洋红**。任何"不是洋红"的像素都是别的东西画上来的，
   * 报告里连颜色带位置一起打出来，一眼就知道是谁：
   *   · 一整片奶白/浅灰 → 系统背板（Mica）
   *   · 细细的一条线或一小块 → 原生窗框（那圈外框线 / 右上角的 ✕）
   */
  function judgeZone(layout, z, afterClick) {
    const tag = afterClick ? '点击后 ' : ''
    if (z.polluted.length) {
      console.log(`    ${tag}压在 0x${z.over.toString(16)} 上的被裁区 → ⏭ 被外部窗口 ${z.polluted.map((h) => '0x' + h.toString(16)).join('/')} 压着，跳过`)
      return
    }
    if (!(z.overWin.patternOk >= 0.9)) {
      const p = z.overWin.patternOk === null ? '未测' : `${(z.overWin.patternOk * 100).toFixed(0)}%`
      console.log(`    ${tag}压在 0x${z.over.toString(16)} 上的被裁区 → ⏭ 邻居那格没刷上洋红底（命中 ${p}），没有参照，跳过`)
      return
    }
    if (!z.scanTotal) {
      console.log(`    ${tag}压在 0x${z.over.toString(16)} 上的被裁区 → ⏭ 没采到有效点（带子太窄？），跳过`)
      return
    }
    const off = z.offH + z.offV
    const total = z.samples.length + z.scanTotal
    const ok = off <= OFF_COLOR_MAX
    const colors = Object.entries(z.offColors).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([c, n]) => `${c}×${n}`).join('  ')
    const shape = [...z.offByCol.entries()].map(([x, ys]) => `x${x}:${ys.length}`).join(' ')
    console.log(`    ${tag}压在 0x${z.over.toString(16)} 上的被裁区 ${JSON.stringify(z.zone)}：`
      + `非洋红 ${off}/${total}（横向 ${z.offH}/${z.samples.length} ＋ 竖向 ${z.offV}/${z.scanTotal}）`
      + `${off ? `｜颜色 ${colors || '—'}｜竖向命中分布 ${shape || '—'}` : ''}`
      + ` → ${ok ? '✅ 全是邻格自己的内容' : '❌ 有别的东西画在邻格上了'}`)
    if (!ok) failures.push(`布局 ${layout}：${tag}0x${z.hwnd.toString(16)} 的被裁区压在邻居上有 ${off} 个非洋红像素（${colors || '颜色未知'}）`)
    else results.push(`布局 ${layout}：${tag}被裁区像素`)
  }

  for (const layout of LAYOUTS) {
    const n = Number(layout)
    console.log(`\n================ 布局 ${layout} 格 ================`)
    await clickLayout(n)
    if (!await waitPanes(n)) {
      console.log(`❌ ${layout} 格布局在 90s 内没全部就位`)
      failures.push(`布局 ${layout}：分格没就位`)
      continue
    }
    await sleep(1500)

    const painted = await paintChecker()
    if (!painted) console.log('  ⚠️ 没能通过 CDP 给分格页面刷上棋盘格（下面只看"是否死板纯色"）')
    else console.log(`  已给 ${painted} 个分格页面刷上洋红/亮绿棋盘格`)
    await sleep(900)

    const before = probe()
    console.log(`  本实例分格窗口 ${before.windows.length} 个；被裁区压在别的分格上的有 ${before.zones.length} 处`)
    for (const w of before.windows) {
      console.log(`    hwnd 0x${w.hwnd.toString(16)} 窗口(${w.win.x},${w.win.y},${w.win.width}x${w.win.height}) 区域top=${w.rb.top} 背板=${w.backdrop === null ? '读不到' : w.backdrop} 洋红命中=${w.patternOk === null ? '未测' : (w.patternOk * 100).toFixed(0) + '%'}`)
    }
    if (before.foreign.length) {
      console.log(`  ⚠️ 桌面上还有 ${before.foreign.length} 个**不属于本次测试**的浏览器窗口，压在测试区域上的像素判定会被隔离（不参与对错）：`)
      for (const f of before.foreign) console.log(`     0x${f.hwnd.toString(16)} (${f.win.x},${f.win.y},${f.win.width}x${f.win.height}) ${JSON.stringify(f.title)}`)
      console.log('     想让判定完整，请先关掉这些窗口（常见来源：自己开着的旧版 AIQuad、正在用的浏览器）再跑')
    }
    if (!before.windows.length) {
      failures.push(`布局 ${layout}：没找到本实例的分格浏览器窗口`)
      console.log('  ❌ 没找到本实例的分格浏览器窗口（档案根目录匹配不上？）')
      continue
    }

    // ① 属性断言：每个分格窗口都不该挂着会铺满整窗的背板
    const paintedBackdrops = before.windows.filter((w) => w.backdrop !== null && w.backdrop !== DWMSBT_NONE)
    if (paintedBackdrops.length) {
      failures.push(`布局 ${layout}：${paintedBackdrops.length} 个分格窗口仍挂着系统背板（${paintedBackdrops.map((w) => `0x${w.hwnd.toString(16)}=${w.backdrop}`).join(', ')}）`)
      console.log(`  ❌ 有 ${paintedBackdrops.length} 个分格窗口的背板没关掉`)
    }
    else {
      const read = before.windows.filter((w) => w.backdrop !== null).length
      console.log(`  ✅ 背板已关闭（${read}/${before.windows.length} 个窗口读得到属性${read < before.windows.length ? '，其余读不到，按 Win10/老版本处理' : ''}）`)
      results.push(`布局 ${layout}：背板属性`)
    }

    // ② 像素断言：被裁区压在邻居上的地方，必须是邻居的内容，不能是一块死板纯色
    if (!before.zones.length) {
      console.log('  ⚠️ 没有"被裁区压在邻居上"的位置可测（布局或几何与预期不符），本布局只做了属性断言')
    }
    for (const z of before.zones) judgeZone(layout, z, false)

    // ③ 真点下面那格（用户的实际操作路径），再测一次
    const lowest = before.windows.slice().sort((a, b) => b.vis.top - a.vis.top)[0]
    if (lowest) {
      const cx = (lowest.vis.left + lowest.vis.right) / 2
      const cy = (lowest.vis.top + lowest.vis.bottom) / 2
      console.log(`  点一下最下面那格 (${Math.round(cx)},${Math.round(cy)}) …`)
      await clickAt(cx, cy)
      await sleep(900)
      const after = probe()
      for (const z of after.zones) judgeZone(layout, z, true)
    }

    // ④ 把背板注入回来，看看 30ms 看门狗认不认得出（对应 verifyGeometry 的第 ④ 项）
    const victim = before.windows.slice().sort((a, b) => b.vis.top - a.vis.top)[0]
    if (victim) {
      const injected = setBackdrop(victim.hwnd, DWMSBT_AUTO)
      if (!injected) {
        console.log('  ⚠️ 注入背板失败（本机 DWM 不接受），跳过愈合检查')
      }
      else {
        const afterInject = w32.windowBackdropType(victim.hwnd)
        if (afterInject === DWMSBT_NONE || afterInject === null) {
          console.log('  ⚠️ 注入后属性立刻不是 AUTO —— Chrome/DWM 没接受这次注入，愈合检查不具判定力，跳过')
        }
        else {
          await sleep(900) // 30ms 看门狗，30 跳足够
          const healed = w32.windowBackdropType(victim.hwnd)
          const ok = healed === DWMSBT_NONE
          console.log(`  注入背板后 0.9s：背板 = ${healed === null ? '读不到' : healed} → ${ok ? '✅ 看门狗已关回去' : '❌ 没人管，背板留着'}`)
          if (!ok) failures.push(`布局 ${layout}：注入的背板没人关回去（当前 ${healed}）—— 看门狗第 ③ 项没生效`)
          else results.push(`布局 ${layout}：看门狗愈合`)
        }
      }
    }

    /**
     * ⑤ 把原生窗口框架（WS_CAPTION / WS_THICKFRAME）注回去，看 30ms 看门狗认不认得出
     *    （对应 verifyGeometry 的 ⓪ 项）。和背板一样，Chrome 重排自己的窗口时会把
     *    窗口样式一并带回来，而那一刻几何往往纹丝不动，只能靠主动问。
     */
    if (victim && !windowHasFrame(victim.hwnd)) {
      if (!restoreWindowFrame(victim.hwnd)) {
        console.log('  ⚠️ 注入窗口框架失败，跳过愈合检查')
      }
      else {
        await sleep(900)
        const healed = !windowHasFrame(victim.hwnd)
        console.log(`  注入窗口框架后 0.9s：样式里还留着框架位 = ${!healed} → ${healed ? '✅ 看门狗已摘掉' : '❌ 没人管，框线会留着'}`)
        if (!healed) failures.push(`布局 ${layout}：注入的原生窗口框架没人摘掉（外框线/✕ 会露在邻格上）—— 看门狗第 ⓪ 项没生效`)
        else results.push(`布局 ${layout}：窗框看门狗愈合`)
      }
    }
  }

  try { await cdp.close() } catch {}

  fs.writeFileSync(path.join(tmp, `clip-pixels-${SCALE}.json`), JSON.stringify({
    scale: SCALE, layouts: LAYOUTS, keepBackdrop: KEEP_BACKDROP, passed: results, failures,
  }, null, 2))

  console.log('\n================ 结论 ================')
  if (KEEP_BACKDROP) {
    // 负向对照：应用故意不修。脚本必须报出失败，否则脚本是瞎的。
    if (failures.length) {
      console.log(`负向对照（scale=${SCALE}）：✅ 如预期地检测到入侵 ${failures.length} 处，说明本脚本确实看得见这个 bug`)
      for (const f of failures.slice(0, 6)) console.log(`   · ${f}`)
      finish(0)
    }
    console.log(`负向对照（scale=${SCALE}）：❌ 关掉修复之后仍然全绿 —— 本脚本没有判定力，等于白测`)
    finish(1)
  }

  if (failures.length) {
    for (const f of failures) console.log(`❌ ${f}`)
    console.log(`\n被裁区像素检查（scale=${SCALE}）：❌ 不符合预期`)
    finish(3)
  }
  console.log(`被裁区像素检查（scale=${SCALE}）：✅ 被裁掉的浏览器外壳没有以任何形式露在相邻分格上 —— 不含"死板纯色"（背板）、不含"外框线 / ✕"（原生窗框），含"选中下面那格"与"被注入后看门狗自愈"`)
  finish(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
