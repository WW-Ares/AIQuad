/**
 * 诊断：对比两种启动模式下，站点侧看到的真实 HTTP 请求头与 JS 指纹。
 * 目的：找出 Google 判定「此浏览器或应用可能不安全」的依据。
 */
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { detectBrowsers } = require('../dist/main/browser-detect')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head>
<body><h1>probe</h1>
<script>
const data = {
  ua: navigator.userAgent,
  webdriver: navigator.webdriver,
  hasWindowChrome: typeof window.chrome,
  uad: navigator.userAgentData ? JSON.parse(JSON.stringify(navigator.userAgentData)) : null,
  brands: navigator.userAgentData ? navigator.userAgentData.brands.map(b=>b.brand+'/'+b.version) : null,
  mobile: navigator.userAgentData ? navigator.userAgentData.mobile : null,
  platform: navigator.userAgentData ? navigator.userAgentData.platform : null,
  formFactors: navigator.userAgentData ? (navigator.userAgentData.formFactors || null) : null,
  outerH: window.outerHeight, innerH: window.innerHeight,
  chromeUIPx: window.outerHeight - window.innerHeight,
  screenAvailTop: window.screen.availTop,
  isSecureContext: window.isSecureContext,
  deviceMemory: navigator.deviceMemory,
  hwc: navigator.hardwareConcurrency,
  languages: navigator.languages,
  pluginsLen: navigator.plugins.length,
  webauthn: typeof window.PublicKeyCredential,
};
fetch('/report', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(data)});
</script>
</body></html>`

function startServer() {
  return new Promise((resolve) => {
    const headersSeen = {}
    let reportPromise = null
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url.startsWith('/probe')) {
        headersSeen[req.url] = { ...req.headers }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(PAGE)
        return
      }
      if (req.url === '/report' && req.method === 'POST') {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          res.writeHead(200)
          res.end('ok')
          try {
            const js = JSON.parse(body)
            if (reportPromise) reportPromise({ headers: headersSeen['/'] || {}, js })
          }
          catch (e) {
            console.error('parse err', e)
          }
        })
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
    })
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        port,
        server,
        waitReport: (ms) =>
          new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('report timeout')), ms)
            reportPromise = (v) => {
              clearTimeout(t)
              reportPromise = null
              resolve(v)
            }
          }),
      })
    })
  })
}

function markHeaders(h) {
  const interesting = Object.keys(h).filter((k) =>
    /^(sec-ch-ua|user-agent|accept-language|upgrade-insecure|sec-fetch|origin|referer)/i.test(k),
  )
  return interesting.sort().map((k) => `  ${k}: ${h[k]}`).join('\n')
}

async function runMode(label, exe, extraArgs, srv, profilesRoot) {
  const profileDir = path.join(profilesRoot, label)
  fs.rmSync(profileDir, { recursive: true, force: true })
  fs.mkdirSync(profileDir, { recursive: true })
  const url = extraArgs.url
  const args = [
    ...extraArgs.args,
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
  ]
  if (extraArgs.appMode) args.push(`--app=${url}`)
  else args.push(url)

  const proc = spawn(exe, args, { stdio: 'ignore' })
  let out
  try {
    out = await srv.waitReport(30000)
  }
  catch (e) {
    out = { headers: {}, js: { error: String(e) } }
  }
  console.log(`\n===== ${label} =====`)
  console.log('-- HTTP headers --')
  console.log(markHeaders(out.headers))
  console.log('-- JS fingerprint --')
  const js = out.js
  for (const k of ['ua', 'webdriver', 'hasWindowChrome', 'mobile', 'platform', 'formFactors', 'chromeUIPx', 'outerH', 'innerH', 'isSecureContext', 'webauthn', 'hwc']) {
    console.log(`  ${k}: ${JSON.stringify(js[k])}`)
  }
  console.log(`  brands: ${JSON.stringify(js.brands)}`)
  try {
    process.kill(proc.pid)
  }
  catch {}
  await sleep(500)
  return out
}

;(async () => {
  const browsers = await detectBrowsers()
  const b = browsers.find((x) => x.channel === 'chrome') || browsers[0]
  console.log('browser:', b.name, b.exePath, 'version', b.version)
  const srv = await startServer()
  const url = `http://127.0.0.1:${srv.port}/`
  const root = path.join(os.tmpdir(), 'aiquad-diag-' + Date.now())
  fs.mkdirSync(root, { recursive: true })

  await runMode('A_app_mode', b.exePath, { appMode: true, url, args: [] }, srv, root)
  await runMode('B_normal_window', b.exePath, { appMode: false, url, args: [] }, srv, root)
  await runMode('C_normal_windowed_dup', b.exePath, { appMode: false, url, args: ['--new-window'] }, srv, root)

  srv.server.close()
  process.exit(0)
})()
