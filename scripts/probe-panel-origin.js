/**
 * 探针：找出"面板客户区原点"到底该怎么取。
 *
 * 背景：验证脚本里用 renderer 的 screenX/screenY + windowFrameInsets 反推客户区原点，
 * 结果 y 方向差了 31px（浏览器窗口落在 54，而推算出的期望值是 85）。
 * 应用内部用的是 panelWindow.getBounds()（Electron 无边框窗口下 = 客户区原点），
 * 所以这里把所有属于 Electron 主进程的顶层窗口都摊开，看谁才是面板窗口、它的三个矩形各是多少。
 *
 * 用法：node scripts/probe-panel-origin.js [等待秒数]
 */
const path = require('node:path')
const { spawn } = require('node:child_process')

const projectRoot = path.join(__dirname, '..')
const packagedExe = path.join(projectRoot, 'build', 'win-unpacked', 'AIQuad.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const waitSec = Number(process.argv[2] || 14)

async function main() {
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1', AIQUAD_DISABLE_GPU: '1', AIQUAD_NO_SANDBOX: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(packagedExe, ['--remote-debugging-port=9229'], {
    cwd: path.dirname(packagedExe), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  console.log(`启动打包版，等 ${waitSec}s …`)
  await sleep(waitSec * 1000)

  const w32 = require('../dist/main/win32')

  // 渲染层视角
  let r = null
  try {
    const list = await (await fetch('http://127.0.0.1:9229/json/list')).json()
    const t = list.find((x) => /main\.html/.test(x.url))
    if (t) {
      const { CdpSession } = require('../dist/main/cdp')
      const cdp = new CdpSession(t.webSocketDebuggerUrl)
      await cdp.connect()
      const res = await cdp.send('Runtime.evaluate', {
        expression: `({
          screenX, screenY,
          innerWidth, innerHeight,
          outerWidth, outerHeight,
          dpr: devicePixelRatio,
          docEl: [document.documentElement.clientWidth, document.documentElement.clientHeight],
          body: [document.body.clientWidth, document.body.clientHeight],
          devicePixelRatio,
        })`,
        returnByValue: true,
      })
      r = res?.result?.value
      cdp.close()
    }
  }
  catch (e) { console.log('CDP 读取失败:', e.message) }

  console.log('\n渲染层:', JSON.stringify(r))

  console.log('\nElectron 主进程 (pid=' + child.pid + ') 的顶层窗口：')
  const hwnds = w32.findWindowsByPid(child.pid)
  console.log('  共', hwnds.length, '个')
  for (const h of hwnds) {
    const rect = w32.getWindowRect(h)
    const f = w32.windowFrameInsets(h)
    const vis = w32.isWindowVisible(h)
    const cls = w32.getClassName(h)
    const title = w32.getWindowText ? w32.getWindowText(h) : ''
    const box = w32.windowRegionBox(h)
    console.log(`  hwnd=${h} cls=${cls} visible=${vis} title="${title}"`)
    console.log(`    GetWindowRect=${JSON.stringify(rect)}`)
    console.log(`    client=${f ? `${f.clientWidth}x${f.clientHeight} insets(l=${f.left},t=${f.top},r=${f.right},b=${f.bottom})` : 'null'}`)
    console.log(`    推算客户区原点=(${rect ? rect.left + (f ? f.left : 0) : '?'},${rect ? rect.top + (f ? f.top : 0) : '?'})  region=${JSON.stringify(box)}`)
    console.log(`    hasRenderWidget=${!!w32.findChildByClass(h, 'Chrome_RenderWidgetHostHWND')}`)
  }

  try { process.kill(child.pid) } catch {}
  await sleep(800)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
