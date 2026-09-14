/**
 * 验证"下拉挖洞"：展开 AI 切换器时，只把菜单那一块从原生浏览器窗口上裁掉，
 * 页面其余部分必须依然可见（而不是整窗消失）。
 *
 * 判定方法：GetWindowRgn 拿到的复合区域用 PtInRegion 逐点探测——
 *   · 菜单中心点 → 应在区域之外（false）＝ 洞挖对了
 *   · 页面中心点 → 应在区域之内（true） ＝ 页面还在
 * 并附一张桌面实拍图供人眼复核。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { CdpSession } = require('../dist/main/cdp')
const w32 = require('../dist/main/win32')

const projectRoot = path.join(__dirname, '..')
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
        if (rgn.right - rgn.left === contentW && rgn.bottom - rgn.top === contentH) {
          out = { hwnd: h, pid, rect: r, region: rgn }
        }
      }
    }
  }
  catch {}
  return out
}

async function main() {
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronExe, ['--remote-debugging-port=9222', projectRoot], {
    cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})

  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(700)
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
      target = list.find((t) => /main\.html/.test(t.url)) || null
    }
    catch {}
  }
  if (!target) { console.log('❌ 面板渲染进程未启动'); try { process.kill(child.pid) } catch {}; process.exit(1) }

  const cdp = new CdpSession(target.webSocketDebuggerUrl)
  await cdp.connect()
  const num = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value
  const click = (sel) => num(`document.querySelector(${JSON.stringify(sel)}).click(), true`)

  // 单格布局，保证只有一个原生浏览器窗口，避免认错
  await click('[data-layout="1"]')
  console.log('已切到单格布局，等待实例就位…')
  await sleep(12000)

  let info = await num(`(() => {
    const p = document.querySelector('#panes .pane')
    const b = p.getBoundingClientRect()
    return { id: p.dataset.paneId, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) - 46 }
  })()`)
  console.log('分格内容区:', JSON.stringify(info))

  const win = findWindowFor(info.w, info.h)
  if (!win) { console.log('❌ 找不到匹配的原生浏览器窗口'); try { process.kill(child.pid) } catch {}; process.exit(2) }
  const vr = { x: win.rect.left + win.region.left, y: win.rect.top + win.region.top, w: win.region.right - win.region.left, h: win.region.bottom - win.region.top }
  console.log(`原生浏览器窗口: hwnd=${win.hwnd} 窗口 ${win.rect.right - win.rect.left}×${win.rect.bottom - win.rect.top} 可视区 ${vr.w}×${vr.h} @屏幕(${vr.x},${vr.y})`)

  // 展开前的基线
  const before = w32.pointInWindowRegion(win.hwnd, win.region.left + info.w / 2, win.region.top + info.h / 2)
  console.log(`展开前：页面中心点在可视区内 = ${before}（应 true）`)

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
  console.log('下拉菜单（分格内容区坐标）:', JSON.stringify(menu))

  const rgnNow = w32.windowRegionBox(win.hwnd)
  const holeCx = rgnNow.left + menu.x + menu.w / 2
  const holeCy = rgnNow.top + menu.y + menu.h / 2
  const pageCx = rgnNow.left + info.w / 2
  const pageCy = rgnNow.top + Math.max(40, info.h * 0.35)

  const inHole = w32.pointInWindowRegion(win.hwnd, holeCx, holeCy)
  const inPage = w32.pointInWindowRegion(win.hwnd, pageCx, pageCy)
  console.log(`展开后：菜单中心点(${Math.round(holeCx)},${Math.round(holeCy)}) 在可视区内 = ${inHole}（应 false）`)
  console.log(`展开后：页面中间点(${Math.round(pageCx)},${Math.round(pageCy)}) 在可视区内 = ${inPage}（应 true）`)
  console.log(`窗口可视区外接矩形 = ${rgnNow.right - rgnNow.left}×${rgnNow.bottom - rgnNow.top} @(${rgnNow.left},${rgnNow.top})`)

  const png = shot('dropdown-open.png')
  console.log('桌面实拍 →', path.relative(projectRoot, png))

  await click('.pane .ai-select')
  await sleep(1200)
  const after = w32.pointInWindowRegion(win.hwnd, rgnNow.left + menu.x + menu.w / 2, rgnNow.top + menu.y + menu.h / 2)
  console.log(`收起后：原菜单位置在可视区内 = ${after}（应 true，说明洞已补回）`)
  shot('dropdown-closed.png')

  const ok = before === true && inHole === false && inPage === true && after === true
  console.log(`\n================ 结论 ================\n下拉挖洞：${ok ? '✅ 页面保持可见、菜单区域正确挖开、收起后恢复' : '❌ 不符合预期'}`)

  fs.writeFileSync(path.join(projectRoot, '.tmp', 'dropdown-check.json'), JSON.stringify({ info, vr, menu, inHole, inPage, after, ok }, null, 2))
  cdp.close()
  try { process.kill(child.pid) } catch {}
  await sleep(800)
  process.exit(ok ? 0 : 3)
}

main().catch((e) => { console.error(e); process.exit(1) })
