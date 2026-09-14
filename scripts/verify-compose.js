/**
 * 验证"分层合成"架构（0.4.5 起）。
 *
 * 背景（2026-09-14 用户 Win11 机器上的真实事故）：
 *   Win11 上 Chromium 的窗口带 `WS_EX_NOREDIRECTIONBITMAP`，内容由 DirectComposition
 *   交换链直接合成，**DWM 合成时会忽略 GDI 的 SetWindowRgn 区域**。于是"把浏览器自带的
 *   标题栏/工具栏从可视区裁掉"只在**命中测试**上生效（点是点得到的），画面上照旧显示——
 *   浏览器那 96px 高的浅色标题栏整条压在面板顶栏上，顶栏和下拉菜单都成了
 *   "看得见位置、点得着、但读不出内容"的白块。
 *
 * 新架构（两条路各自绕开对方的短处）：
 *   视觉 —— 面板整窗 transparent，分格处渲染层输出 alpha=0，这是**合成器通道**，
 *          不受 GDI 区域限制；面板置顶，顶栏/悬浮胶囊/下拉菜单都画在它上面，天然压住浏览器。
 *   输入 —— 面板平时整体忽略鼠标（Electron 的 `setIgnoreMouseEvents`），点击落到下面那层
 *          浏览器窗口上；指针压到面板 UI 上时渲染层再把它收回来。
 *
 *   ⚠️ 别改回 `SetWindowRgn` 给面板挖洞（0.4.5 的失败尝试）：
 *   在**屏幕缩放 ≠ 100%** 的机器上，给 Electron 窗口设 GDI 区域会直接把主进程打崩
 *   （退出码 0xC0000409）。100% 时物理像素与 DIP 恰好相等才侥幸没事。
 *   本脚本的三个缩放档位就是用来钉死这件事的。
 *
 * 本脚本把这些断言钉死，改几何/窗口层级相关代码后必跑。
 *
 * 用法：
 *   node scripts/verify-compose.js
 *   AIQUAD_TEST_SCALE=1.25 AIQUAD_TEST_PORT=9242 node scripts/verify-compose.js
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { CdpSession } = require('../dist/main/cdp')
const w32 = require('../dist/main/win32')
const { cleanupRun } = require('./lib/process-cleanup')

const projectRoot = path.join(__dirname, '..')
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SCALE = process.env.AIQUAD_TEST_SCALE || '1'
const PORT = Number(process.env.AIQUAD_TEST_PORT || 9240)

/** 面板底色（styles.css 的 --panel-bg），分格处不该是它 */
const PANEL_BG = [21, 24, 31]
/** 分格"没就位"时的底色（--pane-empty），分格已就位时也不该是它 */
const PANE_EMPTY = [27, 31, 39]

function shot(name) {
  const out = path.join(projectRoot, '.tmp', name)
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)',
    `$bmp.Save('${out.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose(); $bmp.Dispose()',
  ].join('; ')
  try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }) }
  catch (e) { console.log('  截图失败:', e.message) }
  return out
}

/** 读整屏某一个点的颜色 */
function pixelAt(png, x, y) {
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    `$bmp = [System.Drawing.Image]::FromFile('${png.replace(/\\/g, '\\\\')}')`,
    `$c = $bmp.GetPixel(${Math.round(x)}, ${Math.round(y)})`,
    'Write-Output "$($c.R),$($c.G),$($c.B)"',
    '$bmp.Dispose()',
  ].join('; ')
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })
    return out.trim().split(',').map(Number)
  }
  catch { return null }
}

async function main() {
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
    AIQUAD_DISABLE_GPU: process.env.AIQUAD_DISABLE_GPU || '1',
    AIQUAD_NO_SANDBOX: process.env.AIQUAD_NO_SANDBOX || '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const ud = path.join(projectRoot, '.tmp', `ud-compose-${SCALE}`)
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
  const num = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value
  const click = (sel) => num(`document.querySelector(${JSON.stringify(sel)}).click(), true`)

  await click('[data-layout="1"]')
  console.log('已切到单格布局，等待实例就位…')
  await sleep(14000)

  const dpr = await num('window.devicePixelRatio')

  /** 面板渲染层里的各矩形（DIP，相对客户区左上角） */
  const geo = await num(`(() => {
    const pane = document.querySelector('.pane')
    const r = pane.getBoundingClientRect()
    const pill = pane.querySelector('.ai-selector').getBoundingClientRect()
    const head = document.querySelector('.setting-header').getBoundingClientRect()
    const ready = pane.classList.contains('ready')
    return {
      ready,
      pane: { x: r.left, y: r.top, w: r.width, h: r.height },
      pill: { x: pill.left, y: pill.top, w: pill.width, h: pill.height },
      head: { x: head.left, y: head.top, w: head.width, h: head.height },
    }
  })()`)

  if (!geo) { console.log('❌ 读不到渲染层几何'); cleanupRun(child.pid); process.exit(1) }
  console.log(`分格 ready=${geo.ready}  分格 ${JSON.stringify(geo.pane)}  胶囊 ${JSON.stringify(geo.pill)}`)

  // 找面板窗口：属于主进程、标题 AIQuad 的可见 Chrome_WidgetWin_1
  let panel = null
  for (const h of w32.findWindowsByPid(child.pid)) {
    if (w32.getClassName(h) !== 'Chrome_WidgetWin_1') continue
    if (!w32.isWindowVisible(h)) continue
    const r = w32.getWindowRect(h)
    if (!r) continue
    panel = { hwnd: h, rect: r }
  }
  if (!panel) { console.log('❌ 找不到面板窗口'); cleanupRun(child.pid); process.exit(1) }
  const fi = w32.windowFrameInsets(panel.hwnd)
  console.log(`面板窗口 (${panel.rect.left},${panel.rect.top})-(${panel.rect.right},${panel.rect.bottom})  客户区偏移 (${fi.left},${fi.top})`)

  // 客户区 DIP → 面板窗口内物理坐标
  const toWin = (p) => ({
    x: Math.round(fi.left + p.x * dpr),
    y: Math.round(fi.top + p.y * dpr),
  })

  const paneMid = { x: geo.pane.x + geo.pane.w / 2, y: geo.pane.y + geo.pane.h / 2 }
  const headMid = { x: geo.head.x + geo.head.w / 2, y: geo.head.y + geo.head.h / 2 }
  const pillMid = { x: geo.pill.x + geo.pill.w / 2, y: geo.pill.y + geo.pill.h / 2 }

  /**
   * 输入穿透怎么验（0.4.5 起换了实现，这里跟着换）：
   *
   * 旧实现是给面板窗口设 `SetWindowRgn` 把分格挖掉，于是可以直接用 `PtInRegion` 采样。
   * 那个做法在**屏幕缩放 ≠ 100%** 时会把 Electron 主进程打崩（0xC0000409，Chromium 内部
   * CHECK 失败），已废弃。现在改成 Electron 自己的 `setIgnoreMouseEvents`：
   * 窗口整体忽略鼠标，指针压到面板 UI 上时再取消忽略。
   *
   * 于是可观测的表征变成 **`WS_EX_TRANSPARENT`(0x20) 这一位**：
   *   指针在分格上 → 面板忽略鼠标 → 该位为 1（点击落到下面的浏览器窗口）
   *   指针在顶栏/胶囊上 → 面板接收鼠标 → 该位为 0
   * 判定方法是把鼠标真的挪过去，再读一次扩展样式。
   *
   * 指针怎么"挪过去"：不能用 `Cursor.Position`（SetCursorPos 只挪光标，不合成鼠标事件，
   * 窗口收不到 mousemove，实测计数恒为 0），改用 CDP 的 `Input.dispatchMouseEvent`
   * 直接向渲染层注入 mouseMoved。第三步（顶栏）是在**穿透状态下**注入的——
   * 那一步能翻回来，才说明 `forward: true` 真的把鼠标移动转发回了渲染层；
   * 这一步要是失败了，面板就会永久穿透，顶栏和胶囊全都点不动。
   */
  const WS_EX_TRANSPARENT = 0x20
  const exAt = () => w32.getWindowLong(panel.hwnd, w32.GWL_EXSTYLE) >>> 0
  const throughAt = async (p) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 })
    await sleep(300)
    return (exAt() & WS_EX_TRANSPARENT) !== 0
  }

  const rPane = await throughAt(paneMid)
  const rHead = await throughAt(headMid)
  const rPill = await throughAt(pillMid)
  console.log(`\n鼠标穿透采样（true = 面板忽略鼠标，点击穿到下面的浏览器）`)
  console.log(`  分格中心   = ${rPane}（应 true：点击要落到网页上）`)
  console.log(`  顶栏中心   = ${rHead}（应 false：顶栏自己接点击）`)
  console.log(`  胶囊中心   = ${rPill}（应 false：切换器自己接点击）`)

  // 扩展样式：面板必须置顶（否则浏览器窗口会盖住它），且必须仍是无痕的工具窗口
  const ex = w32.getWindowLong(panel.hwnd, w32.GWL_EXSTYLE) >>> 0
  const topMost = (ex & 0x8) !== 0
  const toolWin = (ex & 0x100) !== 0
  console.log(`\n面板扩展样式 = 0x${ex.toString(16)}  TOPMOST=${topMost}（应 true）  TOOLWINDOW=${toolWin}`)
  if (!toolWin) {
    /**
     * 这不是本脚本要拦的问题，只提示。
     * transparent 窗口在 Windows 上，Electron 是在 show() 之后才补 WS_EX_LAYERED 的，
     * 那一下会把创建时加的 WS_EX_TOOLWINDOW 冲掉；而窗口可见后 SetWindowLongPtr 又改不回去
     * （Chromium 会把不认识的样式改动原样退回，先藏后改也一样，已实测）。
     * 现在靠 Electron 的 setSkipTaskbar 保住任务栏不出现，代价是 Alt+Tab 列表里会有它。
     */
    console.log('  ⚠️ 透明窗口拿不到 WS_EX_TOOLWINDOW（Electron 在 Win 上的限制）：任务栏已摘，Alt+Tab 可能仍列出面板')
  }

  // 屏幕实拍：顶栏那一条必须是面板底色，分格那一片必须不是
  const png = shot(`compose-${SCALE}.png`)
  const panelOrigin = { x: panel.rect.left, y: panel.rect.top }
  const px = (p) => pixelAt(png, panelOrigin.x + (fi.left + p.x * dpr), panelOrigin.y + (fi.top + p.y * dpr))
  /**
   * 采样点必须避开顶栏上的东西：banner 的文字/logo 在左侧，一排按钮在右侧，
   * 中间那段空白才是一整条纯底色。取靠顶上 2px，文字（垂直居中）也碰不到。
   * 换成随便挑一个点会得到文字的抗锯齿灰边，那不是"被盖住"，是采样选错了地方。
   */
  const cHead = px({ x: geo.head.x + 100, y: geo.head.y + 2 })
  const cPane = px(paneMid)
  const near = (c, t, tol = 6) => !!c && Math.abs(c[0] - t[0]) <= tol && Math.abs(c[1] - t[1]) <= tol && Math.abs(c[2] - t[2]) <= tol
  console.log(`\n屏幕实拍（dpr=${dpr}）`)
  console.log(`  顶栏采样点 = ${cHead}（期望面板底色 ${PANEL_BG}）`)
  console.log(`  分格采样点 = ${cPane}（期望是网页内容，既不是面板底色也不是占位底色）`)
  const headOk = near(cHead, PANEL_BG)
  const paneOk = !near(cPane, PANEL_BG) && !near(cPane, PANE_EMPTY)

  const bad = []
  if (!geo.ready) bad.push('分格没有进入 ready（渲染层没把这一格变透明）')
  if (rPane !== true) bad.push('指针在分格上时面板没有忽略鼠标 → 点击穿不到网页')
  if (rHead !== false) bad.push('指针在顶栏上时面板仍在忽略鼠标 → 顶栏点不到')
  if (rPill !== false) bad.push('指针在胶囊上时面板仍在忽略鼠标 → 切换器点不到')
  if (!topMost) bad.push('面板不是置顶窗口 → 浏览器窗口会盖住它')
  if (!headOk) bad.push('屏幕上的顶栏不是面板底色')
  if (!paneOk) bad.push('屏幕上的分格不是网页内容（透明没生效）')

  console.log(`\n================ 结论 ================`)
  if (bad.length) {
    for (const b of bad) console.log(`❌ ${b}`)
    console.log(`\n分层合成（scale=${SCALE}）：❌ 不符合预期`)
  }
  else {
    console.log(`分层合成（scale=${SCALE}）：✅ 面板置顶、分格视觉透出、分格点击穿透、胶囊与顶栏可点`)
  }

  const json = { scale: SCALE, dpr, geo, panel: { rect: panel.rect, frameInsets: fi, exstyle: ex, topMost, toolWin }, probes: { rPane, rHead, rPill }, screen: { cHead, cPane }, bad }
  fs.writeFileSync(path.join(projectRoot, '.tmp', `compose-check-${SCALE}.json`), JSON.stringify(json, null, 2))

  try { await cdp.close() } catch {}
  cleanupRun(child.pid, ['electron.exe', 'AIQuad.exe'])
  process.exit(bad.length ? 3 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
