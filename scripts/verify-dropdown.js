/**
 * 验证"下拉挖洞"：展开 AI 切换器时，只把菜单那一块从原生浏览器窗口上裁掉，
 * 页面其余部分必须依然可见（而不是整窗消失）。
 *
 * 判定方法：GetWindowRgn 拿到的复合区域用 PtInRegion 逐点探测——
 *   · 菜单中心点 → 应在区域之外（false）＝ 洞挖对了
 *   · 页面中心点 → 应在区域之内（true） ＝ 页面还在
 * 并附一张桌面实拍图供人眼复核。
 *
 * 用法：
 *   node scripts/verify-dropdown.js                        # 100% 缩放
 *   AIQUAD_TEST_SCALE=1.25 node scripts/verify-dropdown.js # 125% 缩放（查 DPI 单位坑）
 *
 * 注意：菜单矩形来自渲染层（DIP），窗口区域是物理像素，所以探针坐标必须乘 dpr——
 * 这正是被测代码里最容易搞错的地方，脚本自己也要按同一套单位算。
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
const PORT = Number(process.env.AIQUAD_TEST_PORT || 9222)

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

/** 找出发给某个分格的原生浏览器窗口：尺寸与分格内容区一致、且已裁剪 */
function findWindowFor(contentW, contentH) {
  let out = null
  try {
    const ids = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      'Get-Process chrome -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id'], { encoding: 'utf8' })
    for (const line of ids.split(/\r?\n/)) {
      const pid = Number(line.trim())
      if (!pid) continue
      for (const h of w32.findWindowsByPid(pid)) {
        const r = w32.getWindowRect(h)
        if (!r) continue
        const rgn = w32.windowRegionBox(h)
        if (!rgn) continue
        const dw = Math.abs((rgn.right - rgn.left) - contentW)
        const dh = Math.abs((rgn.bottom - rgn.top) - contentH)
        if (dw <= 2 && dh <= 2) {
          out = { hwnd: h, pid, rect: r, region: rgn }
        }
      }
    }
  }
  catch {}
  return out
}

async function main() {
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
    // 沙箱/无显示环境下 GPU 进程会连续崩溃（exit_code=1）并拖死主进程，
    // 必须和 verify-align.js 一样显式关掉。
    AIQUAD_DISABLE_GPU: process.env.AIQUAD_DISABLE_GPU || '1',
    AIQUAD_NO_SANDBOX: process.env.AIQUAD_NO_SANDBOX || '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const ud = path.join(projectRoot, '.tmp', `ud-dropdown-${SCALE}`)
  fs.rmSync(ud, { recursive: true, force: true })
  fs.mkdirSync(ud, { recursive: true })
  const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`]
  if (Number(SCALE) !== 1) args.push(`--force-device-scale-factor=${SCALE}`)
  args.push(projectRoot)
  console.log(`启动应用：deviceScaleFactor=${SCALE}`)
  const child = spawn(electronExe, args, {
    cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
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
    console.log(log.slice(-2000))   // 多半是 GPU 进程崩溃，日志能直接看出来
    cleanupRun(child.pid)
    process.exit(1)
  }

  const cdp = new CdpSession(target.webSocketDebuggerUrl)
  await cdp.connect()
  const num = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value
  const click = (sel) => num(`document.querySelector(${JSON.stringify(sel)}).click(), true`)

  // 单格布局，保证只有一个原生浏览器窗口，避免认错
  await click('[data-layout="1"]')
  console.log('已切到单格布局，等待实例就位…')
  await sleep(12000)

  const info = await num(`(() => {
    const F = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pane-footer')) || 0
    const p = document.querySelector('#panes .pane')
    const b = p.getBoundingClientRect()
    return { id: p.dataset.paneId, x: Math.round(b.x), y: Math.round(b.y),
             w: Math.round(b.width), h: Math.round(b.height) - F, dpr: devicePixelRatio }
  })()`)
  console.log('渲染层:', JSON.stringify(info))
  const dpr = info.dpr || Number(SCALE) || 1

  const win = findWindowFor(Math.round(info.w * dpr), Math.round(info.h * dpr))
  if (!win) { console.log('❌ 找不到匹配的原生浏览器窗口'); cleanupRun(child.pid); process.exit(2) }
  const vr = { x: win.rect.left + win.region.left, y: win.rect.top + win.region.top, w: win.region.right - win.region.left, h: win.region.bottom - win.region.top }
  console.log(`原生浏览器窗口: hwnd=${win.hwnd} 窗口 ${win.rect.right - win.rect.left}×${win.rect.bottom - win.rect.top} 可视区 ${vr.w}×${vr.h} @屏幕(${vr.x},${vr.y})`)

  // 展开前的基线
  const before = w32.pointInWindowRegion(win.hwnd, win.region.left + Math.round(info.w * dpr / 2), win.region.top + Math.round(info.h * dpr / 2))
  console.log(`展开前：页面中心点在可视区内 = ${before}（应 true）`)

  /**
   * 悬浮切换器（"灵动岛"）：底部不再预留条带之后，它是靠"挖洞"露出来的。
   * 这一小块既不绘制也不收鼠标，所以：
   *   · 胶囊中心必须在可视区**之外**（洞挖对了），否则网页会把它整块盖住；
   *   · 胶囊旁边必须还在可视区**之内**（没挖过头把网页切掉）。
   */
  const pill = await num(`(() => {
    const p = document.querySelector('#panes .pane')
    const pr = p.getBoundingClientRect()
    const b = p.querySelector('.ai-select').getBoundingClientRect()
    return { x: Math.round(b.left - pr.left), y: Math.round(b.top - pr.top),
             w: Math.round(b.width), h: Math.round(b.height) }
  })()`)
  const probePill = (dx, dy) => w32.pointInWindowRegion(
    win.hwnd,
    win.region.left + Math.round((pill.x + dx) * dpr),
    win.region.top + Math.round((pill.y + dy) * dpr),
  )
  const inPill = probePill(pill.w / 2, pill.h / 2)
  const leftOfPill = probePill(-14, pill.h / 2)
  const abovePill = probePill(pill.w / 2, -14)
  console.log(`悬浮切换器 胶囊 ${pill.w}×${pill.h}（分格内容区 DIP 坐标 ${pill.x},${pill.y}）`)
  console.log(`  胶囊中心   在可视区内 = ${inPill}（应 false：洞挖对了，网页盖不住它）`)
  console.log(`  胶囊左侧14 在可视区内 = ${leftOfPill}（应 true：没挖过头）`)
  console.log(`  胶囊上方14 在可视区内 = ${abovePill}（应 true）`)

  await click('.pane .ai-select')
  await sleep(1600)

  const menu = await num(`(() => {
    const p = document.querySelector('#panes .pane')
    const pr = p.getBoundingClientRect()
    const m = p.querySelector('.ai-menu')
    const mr = m.getBoundingClientRect()
    return { visible: getComputedStyle(m).display !== 'none',
             x: Math.round(mr.left - pr.left), y: Math.round(mr.top - pr.top),
             w: Math.round(mr.width), h: Math.round(mr.height) }
  })()`)
  console.log('下拉菜单（分格内容区 DIP 坐标）:', JSON.stringify(menu))

  // 菜单矩形 → 物理像素（相对原生窗口）
  const hole = {
    x: win.region.left + Math.round(menu.x * dpr),
    y: win.region.top + Math.round(menu.y * dpr),
    w: Math.round(menu.w * dpr),
    h: Math.round(menu.h * dpr),
  }
  const pageCx = win.region.left + Math.round(info.w * dpr / 2)
  const pageCy = win.region.top + Math.round(Math.max(40, info.h * 0.35) * dpr)

  /**
   * 直接**量出洞的实际范围**，而不是只探几个点。
   *
   * 为什么不探四角：洞和内容区都是圆角矩形（半径 = PANE_RADIUS × dpr ≈ 13px），
   * 四角 3px 内的点**本来就在圆角之外**，拿它判定会得到假失败。
   * 沿菜单中心线横扫/纵扫，读到的就是洞的真实 left/right 与 top/bottom。
   *
   * 注意：现在屏幕上**有两个洞**——下拉菜单，和底部常驻的悬浮胶囊（灵动岛）。
   * 两者纵向只隔几个像素，所以要扫成**若干段连通段**再按坐标取回菜单那一段；
   * 早先版本量的是"最外接范围"，会把菜单+胶囊桥接成一条，得到假失败。
   */
  const inRgn = (x, y) => w32.pointInWindowRegion(win.hwnd, x, y)
  const scanRuns = (fixed, from, to, horizontal) => {
    const runs = []
    let cur = null
    for (let v = from; v <= to; v++) {
      const inside = horizontal ? inRgn(v, fixed) : inRgn(fixed, v)
      if (inside === false) {
        if (!cur) { cur = { start: v, end: v }; runs.push(cur) }
        else cur.end = v
      }
      else cur = null
    }
    return runs
  }
  const runAt = (runs, p) => runs.find((r) => p >= r.start && p <= r.end) || null
  const fmtRuns = (runs) => runs.length ? runs.map((r) => `${r.start}..${r.end}(高${r.end - r.start + 1})`).join(' | ') : '没有'

  const cx = Math.round(hole.x + hole.w / 2)
  const cy = Math.round(hole.y + hole.h / 2)
  const hxRuns = scanRuns(cy, win.region.left + 1, win.region.left + Math.round(info.w * dpr) - 1, true)
  const vyRuns = scanRuns(cx, win.region.top + 1, win.region.top + Math.round(info.h * dpr) - 1, false)
  const hx = runAt(hxRuns, cx)
  const vy = runAt(vyRuns, cy)

  console.log(`洞实测 横段（过菜单中心线的横扫）: ${fmtRuns(hxRuns)}`)
  console.log(`洞实测 纵段（过菜单中心线的纵扫）: ${fmtRuns(vyRuns)}`)
  console.log(`洞实测（取菜单所在段）: 横向 ${hx ? `${hx.start}..${hx.end}（宽 ${hx.end - hx.start + 1}）` : '没扫到'}；纵向 ${vy ? `${vy.start}..${vy.end}（高 ${vy.end - vy.start + 1}）` : '没扫到'}`)
  console.log(`洞期望（窗口内）: 横向 ${hole.x}..${hole.x + hole.w - 1}（宽 ${hole.w}）；纵向 ${hole.y}..${hole.y + hole.h - 1}（高 ${hole.h}）`)

  let holeBad = 0
  const pillTop = win.region.top + Math.round(pill.y * dpr)
  const pillBottom = pillTop + Math.round(pill.h * dpr)
  const menuBottom = hole.y + hole.h - 1
  if (!hx || !vy) {
    console.log('  ❌ 菜单这块根本没挖开（原生窗口把它盖住了）')
    holeBad = 9
  }
  else {
    // 横向上菜单是这条线上唯一的洞，可以严格比
    const dx = { l: hx.start - hole.x, r: hx.end - (hole.x + hole.w - 1) }
    console.log(`  横向偏差：左 ${dx.l} 右 ${dx.r}（容差 ±2px，圆角处取整会差 1px）`)
    if (Math.max(...Object.values(dx).map(Math.abs)) > 2) {
      console.log('  ❌ 洞的横向位置/宽度与菜单不符（常见原因：忘了把 DIP 乘 dpr）')
      holeBad++
    }
    /**
     * 纵向上菜单洞下面紧挨着胶囊洞。两者相差几个像素时，扫描会把它们连成
     * 一段连通段——这是**正常**的（区域本质是并集），所以断言这样写：
     *   · 段的上边界 = 菜单顶（严格）；
     *   · 段的下边界 ∈ [菜单底, 胶囊底]（既不能不到菜单底，也不能挖过胶囊底）。
     * 菜单与胶囊之间若未来又拉开间隙，则退化成两段，用上面同样的规则取菜单段。
     */
    const dt = vy.start - hole.y
    const dbLow = vy.end - menuBottom
    const dbHigh = vy.end - Math.max(menuBottom, pillBottom)
    console.log(`  纵向偏差：上 ${dt}；下相对菜单底 ${dbLow}、相对并集底 ${dbHigh}`)
    if (Math.abs(dt) > 2) { console.log('  ❌ 菜单洞上边界不符'); holeBad++ }
    if (dbLow < -2 || dbHigh > 2) { console.log('  ❌ 菜单洞下边界不符（挖少了或挖过头）'); holeBad++ }
    console.log(`  连通段数 ${vyRuns.length}：${vyRuns.length > 1 ? '菜单与胶囊是分开的两段' : '菜单与胶囊连成一段（并集，正常）'}`)

    // 胶囊洞：那一段必须完整盖住胶囊的纵向范围（中心点已单独探过）
    const pillRun = runAt(vyRuns, pillTop + Math.round(pill.h * dpr / 2))
    if (!pillRun) {
      console.log('  ❌ 胶囊那一块没挖开')
      holeBad++
    }
    else if (pillRun.start > pillTop + 2 || pillRun.end < pillBottom - 2) {
      console.log(`  ❌ 胶囊洞没盖全：实测 ${pillRun.start}..${pillRun.end}，胶囊 ${pillTop}..${pillBottom}`)
      holeBad++
    }
    else {
      console.log(`  胶囊洞覆盖 OK（实测 ${pillRun.start}..${pillRun.end}，胶囊 ${pillTop}..${pillBottom}）`)
    }

    // 胶囊下方还要能看见网页（没挖过胶囊底）
    const belowPillY = pillBottom + Math.round(4 * dpr)
    if (belowPillY < win.region.top + Math.round(info.h * dpr) - 2) {
      const belowOk = inRgn(cx, belowPillY)
      console.log(`  胶囊下方(${cx},${belowPillY}) 在可视区内 = ${belowOk}（应 true，说明没挖过胶囊底）`)
      if (belowOk !== true) holeBad++
    }
  }

  // 反向：菜单右侧 6px 处应该**还在**可视区里（防止"洞挖过头"把网页切掉）
  const sideX = hole.x + hole.w + 6
  const sideY = cy
  const inSide = sideX < win.region.left + Math.round(info.w * dpr) - 2 ? inRgn(sideX, sideY) : null
  if (inSide !== null) {
    console.log(`  菜单右侧外(${sideX},${sideY}) 在可视区内 = ${inSide}（应 true，说明没有挖过头）`)
    if (inSide !== true) holeBad++
  }

  const inPage = inRgn(pageCx, pageCy)
  console.log(`页面中间点(窗口内 ${pageCx},${pageCy}) 在可视区内 = ${inPage}（应 true）`)
  const rgnNow = w32.windowRegionBox(win.hwnd)
  console.log(`窗口可视区外接矩形 = ${rgnNow.right - rgnNow.left}×${rgnNow.bottom - rgnNow.top} @(${rgnNow.left},${rgnNow.top})`)

  const png = shot(`dropdown-open-${SCALE}.png`)
  console.log('桌面实拍 →', path.relative(projectRoot, png))

  await click('.pane .ai-select')
  await sleep(1200)
  const after = inRgn(cx, cy)
  console.log(`收起后：原菜单位置(cx,cy)=(${cx},${cy}) 在可视区内 = ${after}（应 true，说明洞已补回）`)
  const vyAfter = scanRuns(cx, win.region.top + 1, win.region.top + Math.round(info.h * dpr) - 1, false)
  console.log(`  收起后 纵段: ${fmtRuns(vyAfter)}（预期只剩胶囊那一段）`)
  const rgnAfter = w32.windowRegionBox(win.hwnd)
  console.log(`  收起后 可视区外接矩形 = ${rgnAfter.right - rgnAfter.left}×${rgnAfter.bottom - rgnAfter.top} @(${rgnAfter.left},${rgnAfter.top})`)
  shot(`dropdown-closed-${SCALE}.png`)

  const ok = before === true && holeBad === 0 && inPage === true && after === true
    && inPill === false && leftOfPill === true
  console.log(`\n================ 结论 ================\n下拉挖洞（scale=${SCALE}）：${ok ? '✅ 页面保持可见、菜单区域正确挖开、收起后恢复' : '❌ 不符合预期'}`)

  fs.writeFileSync(path.join(projectRoot, '.tmp', `dropdown-check-${SCALE}.json`), JSON.stringify({ info, vr, menu, hole, pill, inPill, leftOfPill, abovePill, scanned: { hx, vy, hxRuns, vyRuns }, holeBad, inSide, inPage, after, ok }, null, 2))
  cdp.close()
  cleanupRun(child.pid)
  await sleep(800)
  fs.rmSync(ud, { recursive: true, force: true })
  process.exit(ok ? 0 : 3)
}

main().catch((e) => { console.error(e); process.exit(1) })
