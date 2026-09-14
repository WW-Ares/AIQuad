/**
 * 聚焦诊断：--app 模式 vs 普通窗口，站点侧可观测的「应用/嵌入」特征。
 * 重点：display-mode（PWA 独立窗口特征）、Chrome UI 像素高度、窗口最小尺寸。
 */
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { detectBrowsers } = require('../dist/main/browser-detect')
const w32 = require('../dist/main/win32')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body>
<script>
const d = {
  displayBrowser: matchMedia('(display-mode: browser)').matches,
  displayStandalone: matchMedia('(display-mode: standalone)').matches,
  displayMinimalUi: matchMedia('(display-mode: minimal-ui)').matches,
  displayFullscreen: matchMedia('(display-mode: fullscreen)').matches,
  navigatorStandalone: navigator.standalone,
  chromeUIPx: outerHeight - innerHeight,
  relatedApps: !!(navigator.getInstalledRelatedApps),
  permissions: typeof navigator.permissions,
  credentials: typeof navigator.credentials,
  isSecure: isSecureContext,
};
fetch('/r',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)});
</script></body></html>`

function startServer() {
  return new Promise((resolve) => {
    let resolveReport = null
    const server = http.createServer((req, res) => {
      if (req.url === '/r' && req.method === 'POST') {
        let b = ''
        req.on('data', (c) => (b += c))
        req.on('end', () => {
          res.writeHead(200); res.end('ok')
          try { resolveReport?.(JSON.parse(b)) } catch {}
        })
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        server,
        wait: (ms) => new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('timeout')), ms)
          resolveReport = (v) => { clearTimeout(t); resolveReport = null; res(v) }
        }),
      })
    })
  })
}

async function run(label, exe, { appMode, url, extra = [] }) {
  const profileDir = path.join(os.tmpdir(), 'aiquad-dm-' + label + '-' + Date.now())
  fs.mkdirSync(profileDir, { recursive: true })
  const args = [
    ...extra,
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
  ]
  if (appMode) args.push(`--app=${url}`)
  else args.push(url)

  const proc = spawn(exe, args, { stdio: 'ignore' })
  let js = {}
  try { js = await srv.wait(25000) } catch (e) { js = { error: String(e.message) } }
  console.log(`\n===== ${label} =====`)
  console.log(`  display-mode browser   : ${js.displayBrowser}`)
  console.log(`  display-mode standalone: ${js.displayStandalone}`)
  console.log(`  display-mode minimal-ui: ${js.displayMinimalUi}`)
  console.log(`  navigator.standalone   : ${js.navigatorStandalone}`)
  console.log(`  chromeUIPx             : ${js.chromeUIPx}`)

  // 测窗口最小尺寸（强行设很小，看实际能到多少）
  await sleep(1500)
  const hwnd = w32.findBrowserWindowByPid(proc.pid)
  if (hwnd) {
    w32.moveWindow(hwnd, 100, 100, 320, 200)
    await sleep(600)
    const s = w32.windowSize(hwnd)
    console.log(`  minSize probe (req 320x200 -> actual ${s.width}x${s.height})`)
  }
  else {
    console.log('  (no hwnd)')
  }
  try { process.kill(proc.pid) } catch {}
  await sleep(400)
}

let srv
;(async () => {
  const browsers = await detectBrowsers()
  const b = browsers.find((x) => x.channel === 'chrome') || browsers[0]
  console.log('browser:', b.name, b.version)
  srv = await startServer()
  const url = `http://127.0.0.1:${srv.port}/`
  await run('A_app_mode', b.exePath, { appMode: true, url })
  await run('B_normal', b.exePath, { appMode: false, url })
  srv.server.close()
  process.exit(0)
})()
