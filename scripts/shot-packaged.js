/**
 * 打包产物实拍验证：直接启动 build/win-unpacked/AIQuad.exe（安装包内的同一份代码），
 * 等各分格浏览器实例就位后，抓整个桌面 + 逐格核对"原生窗口可见区 == 面板客户区 + 分格矩形"。
 *
 * 与 shot-desktop.js 的区别：那个跑的是 node_modules/electron + 源码，
 * 这个跑的是真正交付给用户的二进制，用来确认"打包之后行为一致"。
 *
 * 用法：node scripts/shot-packaged.js [等待秒数] [输出文件名]
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { cleanupRun, killBrowsersUnder, browserPidsUnder } = require('./lib/process-cleanup')

const projectRoot = path.join(__dirname, '..')
const packagedExe = path.join(projectRoot, 'build', 'win-unpacked', 'AIQuad.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 本应用的浏览器档案根目录：用来精确结束"自己拉起来的"Chrome/Edge，
// 而不是无差别 taskkill 掉用户自己开着的浏览器。
const appProfilesRoot = path.join(process.env.APPDATA || '', 'aiquad', 'profiles')

/** 收尾：杀应用进程树 + 只清本应用名下的浏览器（不碰用户自己的 Chrome） */
function cleanup(pid) {
  cleanupRun(pid, ['AIQuad.exe'])
  const n = killBrowsersUnder(appProfilesRoot)
  console.log(`收尾：结束 ${n} 个本应用名下的浏览器进程（未触碰其它 Chrome 窗口）`)
}

const waitSec = Number(process.argv[2] || 35)
const outName = process.argv[3] || 'packaged-4panes.png'
const outPath = path.join(projectRoot, '.tmp', outName)

// AIQUAD_TEST_SCALE：用 --force-device-scale-factor 在 100% 的机器上复现缩放环境。
// 不设就走系统真实缩放（用户路径）。
const SCALE = process.env.AIQUAD_TEST_SCALE || ''
const scaleArgs = SCALE ? [`--force-device-scale-factor=${SCALE}`] : []

const PS = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
$bmp.Save('OUTPATH', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved $($vs.Width)x$($vs.Height) -> OUTPATH"
`

async function main() {
  if (!fs.existsSync(packagedExe)) {
    console.error('找不到打包产物:', packagedExe)
    process.exit(1)
  }
  fs.mkdirSync(path.join(projectRoot, '.tmp'), { recursive: true })

  // 故意不设任何 AIQUAD_* 降级开关：走用户真实路径。
  // 本机 GPU 进程不可用，靠应用自身的"启动自愈"（startup-state.json）自动降级。
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(packagedExe, ['--remote-debugging-port=9229', ...scaleArgs], {
    cwd: path.dirname(packagedExe), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })

  console.log(`启动打包版，等待 ${waitSec}s 让各分格实例就位…`)
  await sleep(waitSec * 1000)

  const script = PS.replace('OUTPATH', outPath.replace(/\\/g, '\\\\'))
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
    console.log('桌面截图:', out.trim())
  }
  catch (e) {
    console.log('截图失败:', e.message)
  }

  let rendered = null
  try {
    const list = await (await fetch('http://127.0.0.1:9229/json/list')).json()
    const t = list.find((x) => /main\.html/.test(x.url))
    if (t) {
      const { CdpSession } = require('../dist/main/cdp')
      const cdp = new CdpSession(t.webSocketDebuggerUrl)
      await cdp.connect()
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const F = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pane-footer')) || 0
          const panes = [...document.querySelectorAll('#panes .pane')].map(p => {
            const b = p.getBoundingClientRect()
            return { id: p.dataset.paneId, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) - F }
          })
          return { osOrigin: { x: screenX, y: screenY }, dpr: window.devicePixelRatio, titleBar: !!document.querySelector('.titlebar,header'), panes }
        })()`,
        returnByValue: true,
      })
      rendered = r?.result?.value
      console.log('渲染层分格内容区（相对面板客户区）:', JSON.stringify(rendered))
      cdp.close()
    }
  }
  catch (e) {
    console.log('读取分格信息失败:', e.message)
  }

  // 拿不到渲染层信息 = 面板根本没在线（多半是上一轮残留进程占着单实例锁，
  // 本次启动静默退出）。这种情况下必须**直接判失败**：
  // 后面「找不到匹配窗口就跳过」的逻辑会让它一路空跑到"全部对齐（0px）"，
  // 假装通过——正是这个假通过把真 bug 放过去过一次。
  if (!rendered) {
    console.log('\n❌ 面板渲染进程未就绪，无法比对（不是"通过"）。打包版自身输出如下：')
    console.log(log.split('\n').filter(Boolean).slice(-40).join('\n'))
    cleanup(child.pid)
    await sleep(800)
    process.exit(1)
  }

  const w32 = require('../dist/main/win32')

  let clientOrigin = null
  if (rendered) {
    // 面板窗口必须用 findBrowserWindowByPid（Chrome_WidgetWin_1 + 可见）来定位：
    // 按"面积最大"挑会命中隐藏的 Chrome_WidgetWin_0 消息窗口（1424×720，内衬 top=31），
    // 于是客户区原点凭空多出 31px，整列期望值集体下移。这个坑在 win32.ts 里已经记录过一次。
    const hwnd = w32.findBrowserWindowByPid(child.pid)
    const f = hwnd ? w32.windowFrameInsets(hwnd) : null
    const rect = hwnd ? w32.getWindowRect(hwnd) : null
    if (rect && f) {
      const insetX = f.left >= 0 && f.left < 40 ? f.left : 0
      const insetY = f.top >= 0 && f.top < 40 ? f.top : 0
      clientOrigin = { x: rect.left + insetX, y: rect.top + insetY }
      console.log(`面板 hwnd=${hwnd} cls=${w32.getClassName(hwnd)}：窗口矩形 (${rect.left},${rect.top})，内衬 (${insetX},${insetY}) → 客户区原点 (${clientOrigin.x},${clientOrigin.y})`)
      console.log(`（渲染层自报 screenX/Y = ${rendered.osOrigin.x},${rendered.osOrigin.y}，仅作交叉校验）`)
    }
  }

  const uniq = []
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      'Get-Process chrome -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id'], { encoding: 'utf8' })
    const pids = out.split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean)
    const seen = new Set()
    for (const w of w32.listBrowserWindows()) {
      if (!pids.includes(w.pid) || seen.has(w.hwnd)) continue
      seen.add(w.hwnd)
      uniq.push(w)
    }
  }
  catch {}

  console.log(`\n原生浏览器窗口 ${uniq.length} 个（可见区 == 面板客户区原点 + 分格矩形 才算对齐）：`)

  // 单位必须统一：分格矩形来自渲染层 = **DIP**（CSS px），客户区原点是 **物理像素**。
  // 应用侧算的是 `round((面板客户区原点DIP + 分格x) × s)`，所以这里要先把物理原点
  // 折回 DIP 再加分格偏移，整体乘 dpr —— 直接把 DIP 的 p.x 加到物理原点上，
  // 在 s≠1 的机器上会凭空差出 `原点×(s−1)`，把**已经对齐**的窗口判成失败。
  const dpr = rendered.dpr || 1
  console.log(`渲染层 devicePixelRatio=${dpr}（本机缩放）`)
  const expectXY = (p) => ({
    x: Math.round((clientOrigin.x / dpr + p.x) * dpr),
    y: Math.round((clientOrigin.y / dpr + p.y) * dpr),
    w: Math.round(p.w * dpr),
    h: Math.round(p.h * dpr),
  })

  let bad = 0
  for (const w of uniq) {
    const rgn = w32.windowRegionBox(w.hwnd)
    if (!rgn || !clientOrigin) {
      console.log(`  hwnd=${w.hwnd} ${w.rect.width}×${w.rect.height}@(${w.rect.x},${w.rect.y}) 未裁剪/无法比对`)
      bad++
      continue
    }
    const vis = { x: w.rect.x + rgn.left, y: w.rect.y + rgn.top, w: rgn.right - rgn.left, h: rgn.bottom - rgn.top }
    // 分格左上角对齐 + 尺寸一致，各容 1px（渲染层是取整后的 CSS px，缩放后会有半像素差）
    const pane = rendered.panes
      .map((p) => ({ p, e: expectXY(p) }))
      .find(({ e }) => Math.abs(e.x - vis.x) <= 1 && Math.abs(e.y - vis.y) <= 1)
    if (pane) {
      const dw = vis.w - pane.e.w
      const dh = vis.h - pane.e.h
      const off = Math.abs(dw) > 1 || Math.abs(dh) > 1
      if (off) bad++
      console.log(`  ${off ? '❌' : '✅'} ${pane.p.id} 可见 ${vis.w}×${vis.h}@(${vis.x},${vis.y})  vs 期望 ${pane.e.w}×${pane.e.h}@(${pane.e.x},${pane.e.y})  误差 ${dw},${dh}`)
    }
    else {
      bad++
      console.log(`  ❌ hwnd=${w.hwnd} 可见 ${vis.w}×${vis.h}@(${vis.x},${vis.y}) 不对应任何分格（期望 ${rendered.panes.map((p) => { const e = expectXY(p); return `${p.id}@(${e.x},${e.y})` }).join(' / ')}）`)
    }
  }

  // 窗口数少于分格数同样是失败：全都没起来时会「零窗口比对零" → 假通过
  const missing = rendered.panes.length - uniq.length
  if (missing > 0) {
    console.log(`\n❌ 只找到 ${uniq.length} 个原生浏览器窗口，面板有 ${rendered.panes.length} 个分格 —— 有 ${missing} 格没起来，本次不算通过`)
    cleanup(child.pid)
    await sleep(800)
    process.exit(2)
  }
  console.log(bad ? `\n⚠️ ${bad} 个窗口未对齐` : '\n全部对齐（误差 0px）')
  const exitCode = bad ? 3 : 0

  // ⚠️ 收尾必须杀进程树：只 `process.kill(child.pid)` 会留下打包版的 AIQuad.exe，
  // 它占着 %APPDATA%\aiquad 的单实例锁，之后所有启动都会静默退出（连窗口都没有）。
  //
  // ⚠️ 关窗口同样要限定"自己名下的进程"：`listBrowserWindows()` 返回的是
  // 系统里**所有** Chrome_WidgetWin_1，无过滤地 postClose 会把用户自己开着的
  // 浏览器一起关掉（连着未保存的表单）。先温和关闭自己的，再强杀残留。
  const ours = new Set(browserPidsUnder(appProfilesRoot))
  console.log(`收尾：本应用名下的浏览器进程 ${ours.size} 个`)
  try {
    for (const w of w32.listBrowserWindows()) {
      if (ours.has(w.pid) && w.rect.width > 150) w32.postClose(w.hwnd)
    }
  } catch {}
  await sleep(800)
  cleanup(child.pid)
  await sleep(400)
  process.exit(exitCode)
}

main().catch((e) => { console.error(e); process.exit(1) })
