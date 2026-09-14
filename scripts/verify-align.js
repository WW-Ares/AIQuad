/**
 * 对齐自检（DPI 感知）：在**指定显示缩放**下启动真实应用，验证
 * "原生浏览器窗口的可见区域 == 面板客户区原点 + 分格内容区（物理像素）"。
 *
 * 为什么必须单独有这个脚本：ui-check.js 只看面板自己的 DOM（CSS 像素），
 * 查不出"浏览器窗口贴错位置"这类**跨坐标系**问题。本脚本同时读三条来源：
 *   ① 渲染层：devicePixelRatio + 分格矩形（CSS 像素）
 *   ② Win32  ：面板窗口的**物理**客户区原点（GetWindowRect + 边框内衬）
 *   ③ Win32  ：浏览器窗口的物理矩形 + SetWindowRgn 设上去的可见区域
 * 只有 ①×dpr + ② == ③ 才算对齐。
 *
 * 用法：
 *   node scripts/verify-align.js                     # 默认按 125% 缩放跑
 *   AIQUAD_TEST_SCALE=1     node scripts/verify-align.js   # 100% 对照
 *   AIQUAD_TEST_SCALE=1.1   AIQUAD_TEST_LAYOUT=2 node scripts/verify-align.js
 *
 * 环境变量：
 *   AIQUAD_TEST_SCALE   强制的 deviceScaleFactor（默认 1.25）
 *   AIQUAD_TEST_LAYOUT  1 / 2 / 4（默认 4）
 *   AIQUAD_TEST_WAIT    等待浏览器实例就位的秒数（默认 60）
 *
 * 注意：本机若已开着 AIQuad，它会占住 %APPDATA%\aiquad 的单实例锁。
 * 脚本用独立的 --user-data-dir 启动，两边互不干扰。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { CdpSession, listTargets } = require('../dist/main/cdp')
const { cleanupRun } = require('./lib/process-cleanup')

const projectRoot = path.join(__dirname, '..')
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SCALE = process.env.AIQUAD_TEST_SCALE || '1.25'
const LAYOUT = process.env.AIQUAD_TEST_LAYOUT || '4'
const WAIT_SEC = Number(process.env.AIQUAD_TEST_WAIT || 60)
// 端口可覆盖：连着跑多档缩放时，固定端口会撞上上一个实例残留的 CDP，
// 结果是把上一轮的窗口当成这一轮的来量（假通过/假失败都出现过）。
const PORT = Number(process.env.AIQUAD_TEST_PORT || 9223)

/** 与 app.js 的 reportRects() 保持一致：宽取满，高减去底部条 */
const REPORT = `(() => {
  const F = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pane-footer')) || 0
  const panes = [...document.querySelectorAll('#panes .pane')].map((p) => {
    const r = p.getBoundingClientRect()
    return {
      id: p.dataset.paneId,
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height) - F,
    }
  })
  return { dpr: devicePixelRatio, panes }
})()`

async function main() {
  const w32 = require('../dist/main/win32')
  const ud = path.join(projectRoot, '.tmp', 'ud-align')
  fs.rmSync(ud, { recursive: true, force: true })
  fs.mkdirSync(ud, { recursive: true })

  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
    AIQUAD_DISABLE_GPU: process.env.AIQUAD_DISABLE_GPU || '1',
    AIQUAD_NO_SANDBOX: process.env.AIQUAD_NO_SANDBOX || '1',
  }
  delete env.ELECTRON_RUN_AS_NODE

  console.log(`启动应用：强制 deviceScaleFactor=${SCALE}，布局 ${LAYOUT}，等待上限 ${WAIT_SEC}s`)
  const child = spawn(electronExe, [
    `--remote-debugging-port=${PORT}`,
    `--force-device-scale-factor=${SCALE}`,
    `--user-data-dir=${ud}`,
    projectRoot,
  ], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d.toString() })
  child.stderr.on('data', (d) => { log += d.toString() })

  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(700)
    const list = await listTargets(PORT, 1)
    target = list.find((t) => t.type === 'page' && /main\.html/.test(t.url)) || null
  }
  if (!target) {
    console.log('❌ 面板渲染进程没起来')
    console.log(log.slice(-2000))
    cleanupRun(child.pid)
    process.exit(1)
  }

  const cdp = new CdpSession(target.webSocketDebuggerUrl)
  await cdp.connect()
  await sleep(2000)
  await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector('[data-layout="${LAYOUT}"]')?.click()`,
    returnByValue: true,
  })

  // 面板窗口（Chrome_WidgetWin_1 + 可见）——按 PID 定位，别按面积挑。
  // 注意：渲染进程刚就绪时窗口可能还没 show 出来，必须轮询等它可见。
  let panelHwnd = null
  for (let i = 0; i < 20 && !panelHwnd; i++) {
    panelHwnd = w32.findBrowserWindowByPid(child.pid)
    if (!panelHwnd) await sleep(1000)
  }
  if (!panelHwnd) {
    console.log('❌ 找不到面板窗口（等 20s 仍未出现）')
    cleanupRun(child.pid)
    process.exit(1)
  }
  const pRect = w32.getWindowRect(panelHwnd)
  const pFrame = w32.windowFrameInsets(panelHwnd)
  const insetX = pFrame && pFrame.left >= 0 && pFrame.left < 40 ? pFrame.left : 0
  const insetY = pFrame && pFrame.top >= 0 && pFrame.top < 40 ? pFrame.top : 0
  const origin = { x: pRect.left + insetX, y: pRect.top + insetY }
  console.log(`面板 hwnd=${panelHwnd} 窗口矩形 (${pRect.left},${pRect.top},${pRect.right - pRect.left}×${pRect.bottom - pRect.top}) 内衬 (${insetX},${insetY}) → 客户区原点 (${origin.x},${origin.y})`)

  // 等浏览器实例就位。
  //
  // 怎么认出"自己的"浏览器窗口？**不能只靠属主关系**：实测 GWLP_HWNDPARENT 设上去后
  // 用 GetParent 读回来是 0（详见 win32.setOwner 注释），照属主过滤会一个都找不到，
  // 自检就会"0 个可比对 → 空跑通过"。
  // 可靠判据是 **SetWindowRgn**：只有本应用会往 Chrome 窗口上设区域裁剪，
  // 用户自己开的普通 Chrome 窗口没有区域（GetWindowRgn 返回 0）。属主关系只当补充。
  //
  // ⚠️ 必须把面板窗口自己排除掉：面板从 0.4.5 起也是 transparent + 带区域裁剪的
  //    （挖掉分格做输入穿透），不排除的话它会被当成第 5 个"浏览器窗口"，
  //    尺寸当然对不上任何分格，于是稳定报一个假失败。
  const ours = (w) => w.hwnd !== panelHwnd
    && (Number(w32.getParent(w.hwnd)) === panelHwnd || !!w32.windowRegionBox(w.hwnd))
  let cands = []
  let ownedCount = 0
  for (let i = 0; i < Math.ceil(WAIT_SEC / 2); i++) {
    const all = w32.listBrowserWindows()
    ownedCount = all.filter((w) => Number(w32.getParent(w.hwnd)) === panelHwnd).length
    cands = all.filter(ours)
    if (cands.length >= Number(LAYOUT)) break
    await sleep(2000)
  }
  console.log(`属主是本面板的浏览器窗口：${ownedCount} 个；带区域裁剪（判定为"本应用的"）：${cands.length} 个（期望 ${LAYOUT} 个）`)

  const rep = (await cdp.send('Runtime.evaluate', { expression: REPORT, returnByValue: true }))?.result?.value
  console.log(`渲染层：devicePixelRatio=${rep.dpr}，分格 ${rep.panes.length} 个`)
  for (const p of rep.panes) console.log(`  分格 ${p.id}  CSS ${p.width}×${p.height}@(${p.x},${p.y})`)

  if (!cands.length) {
    console.log('  当前可见的 Chrome_WidgetWin_1（含其它程序）：')
    for (const w of w32.listBrowserWindows()) {
      console.log(`    hwnd=${w.hwnd} pid=${w.pid} owner=${Number(w32.getParent(w.hwnd))} ${w.rect.width}×${w.rect.height}@(${w.rect.x},${w.rect.y}) 「${String(w.title).slice(0, 40)}」`)
    }
  }

  const owned = cands

  console.log('\n期望 = 面板客户区原点 + 分格内容区 × devicePixelRatio；实测 = 窗口矩形 + SetWindowRgn 可见区')
  let bad = 0
  for (const w of owned) {
    const rgn = w32.windowRegionBox(w.hwnd)
    const ins = w32.chromeContentInsets(w.hwnd)
    if (!rgn) {
      console.log(`  ❌ hwnd=${w.hwnd} ${w.rect.width}×${w.rect.height}@(${w.rect.x},${w.rect.y}) 没有区域裁剪`)
      bad++
      continue
    }
    const vis = {
      x: w.rect.x + rgn.left, y: w.rect.y + rgn.top,
      w: rgn.right - rgn.left, h: rgn.bottom - rgn.top,
    }
    const hit = rep.panes
      .map((p) => ({
        p, ex: origin.x + Math.round(p.x * rep.dpr), ey: origin.y + Math.round(p.y * rep.dpr),
        ew: Math.round(p.width * rep.dpr), eh: Math.round(p.height * rep.dpr),
      }))
      .find((c) => Math.abs(c.ex - vis.x) <= 40 && Math.abs(c.ey - vis.y) <= 40)
    if (!hit) {
      console.log(`  ❌ hwnd=${w.hwnd} 可见 ${vis.w}×${vis.h}@(${vis.x},${vis.y}) 不对应任何分格`)
      bad++
      continue
    }
    const dx = vis.x - hit.ex
    const dy = vis.y - hit.ey
    const dw = vis.w - hit.ew
    const dh = vis.h - hit.eh
    const ok = Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && Math.abs(dw) <= 1 && Math.abs(dh) <= 1
    if (!ok) bad++
    console.log(`  ${ok ? '✅' : '❌'} ${hit.p.id}  可见 ${vis.w}×${vis.h}@(${vis.x},${vis.y})  期望 ${hit.ew}×${hit.eh}@(${hit.ex},${hit.ey})  偏差 Δ(${dx},${dy}) Δ尺寸(${dw},${dh})`)
    console.log(`       内衬 left=${ins ? ins.left : '?'} top=${ins ? ins.top : '?'} right=${ins ? ins.right : '?'} bottom=${ins ? ins.bottom : '?'}｜分格 CSS ${hit.p.width}×${hit.p.height}@(${hit.p.x},${hit.p.y})`)
  }

  console.log(`\n================ 结论 ================`)
  if (!owned.length) {
    console.log(`⚠️ 没有可比对的浏览器窗口（实例没起来或还没就位）——本次不算通过`)
    bad = Math.max(bad, 1)
  }
  else {
    console.log(bad ? `❌ ${bad} 个窗口未对齐（scale=${SCALE}）` : `✅ 全部对齐 0px（scale=${SCALE}）`)
  }

  if (process.env.AIQUAD_TEST_SHOT === '1') {
    const shotPath = path.join(projectRoot, '.tmp', `align-${SCALE}.png`)
    const PS = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
$bmp.Save('OUTPATH', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "$($vs.Width)x$($vs.Height)"
`.replace('OUTPATH', shotPath.replace(/\\/g, '\\\\'))
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { encoding: 'utf8' })
      console.log(`桌面实拍 → ${shotPath}（${out.trim()}）`)
    }
    catch (e) {
      console.log('桌面实拍失败:', e.message)
    }
  }

  cdp.close()
  cleanupRun(child.pid)
  await sleep(800)
  fs.rmSync(ud, { recursive: true, force: true })
  process.exit(bad ? 2 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
