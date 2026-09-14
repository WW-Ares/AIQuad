/**
 * 端到端"实拍"：启动真实应用 → 等各分格浏览器实例就位 → 截取整个桌面 + 逐格核对对齐。
 *
 * 为什么需要它：Electron 的 Page.captureScreenshot 只能看到面板自身的内容，
 * 真实浏览器窗口是**独立的原生窗口**，不会出现在里面。
 * 只有抓整个桌面，才能看到"原生浏览器窗口是否精确落在分格内容区里"。
 *
 * ⚠️ 坐标系坑（本项目踩过两次）：
 *   ① 面板窗口必须用 findBrowserWindowByPid 定位（Chrome_WidgetWin_1 + 可见）。
 *      按"面积最大"挑会命中隐藏的 Chrome_WidgetWin_0 消息窗口（1424×720，内衬 top=31），
 *      客户区原点凭空多 31px，整列期望值集体下移 —— 表现为"4 个窗口全都没对齐"。
 *   ② Electron 无边框窗口的 `getBounds()` 给的是**客户区**矩形，
 *      而渲染层里的 `window.screenX/screenY` 是 **OS 窗口矩形**原点，
 *      两者相差 DWM 那条不可见的 8px 缩放边框。
 *      分格坐标（getBoundingClientRect）是客户区相对的，
 *      所以换算屏幕坐标要用**客户区原点** = 窗口矩形原点 + windowFrameInsets()。
 *
 * 用法：node scripts/shot-desktop.js [等待秒数] [输出文件名]
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { cleanupRun } = require('./lib/process-cleanup')

const projectRoot = path.join(__dirname, '..')
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const waitSec = Number(process.argv[2] || 30)
const outName = process.argv[3] || 'desktop.png'
const outPath = path.join(projectRoot, '.tmp', outName)

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
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronExe, ['--remote-debugging-port=9222', projectRoot], {
    cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })

  console.log(`启动应用，等待 ${waitSec}s 让各分格实例就位…`)
  await sleep(waitSec * 1000)

  const script = PS.replace('OUTPATH', outPath.replace(/\\/g, '\\\\'))
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
    console.log('桌面截图:', out.trim())
  }
  catch (e) {
    console.log('截图失败:', e.message)
  }

  // 渲染层报上来的分格矩形（相对面板客户区）+ 面板的 OS 窗口原点
  let rendered = null
  try {
    const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
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
          return { osOrigin: { x: screenX, y: screenY }, panes }
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

  const w32 = require('../dist/main/win32')

  // 面板客户区原点：必须用 findBrowserWindowByPid（Chrome_WidgetWin_1 + 可见）定位面板窗口。
  // 按"面积最大"挑会命中隐藏的 Chrome_WidgetWin_0 消息窗口（内衬 top=31），
  // 客户区原点凭空多 31px → 所有期望值集体下移。win32.ts 里已记录过这个坑。
  let clientOrigin = null
  if (rendered) {
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

  // 原生浏览器窗口 → 与分格矩形逐格比对
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
  let bad = 0
  for (const w of uniq) {
    const rgn = w32.windowRegionBox(w.hwnd)
    if (!rgn || !clientOrigin || !rendered) {
      console.log(`  hwnd=${w.hwnd} ${w.rect.width}×${w.rect.height}@(${w.rect.x},${w.rect.y}) 未裁剪/无法比对`)
      continue
    }
    const vis = { x: w.rect.x + rgn.left, y: w.rect.y + rgn.top, w: rgn.right - rgn.left, h: rgn.bottom - rgn.top }
    const pane = rendered.panes.find((p) => clientOrigin.x + p.x === vis.x && clientOrigin.y + p.y === vis.y)
    if (pane) {
      const dw = vis.w - pane.w
      const dh = vis.h - pane.h
      if (dw || dh) bad++
      console.log(`  ✅ ${pane.id} 可见 ${vis.w}×${vis.h}@(${vis.x},${vis.y})  vs 分格 ${pane.w}×${pane.h}  误差 ${dw},${dh}`)
    }
    else {
      bad++
      console.log(`  ❌ hwnd=${w.hwnd} 可见 ${vis.w}×${vis.h}@(${vis.x},${vis.y}) 不对应任何分格`)
    }
  }
  console.log(bad ? `\n⚠️ ${bad} 个窗口未对齐` : '\n全部对齐（误差 0px）')

  // ⚠️ 杀进程树：留一个宿主进程活着，它会占着单实例锁，之后应用再也起不来
  cleanupRun(child.pid)
  await sleep(800)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
