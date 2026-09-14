/**
 * 找出在这台（无 GPU / 虚拟化受限）机器上能真正跑起来的 Electron 启动参数。
 * 逐组合尝试：能否打开调试端口 + 面板渲染进程能否响应 Runtime.evaluate。
 */
const path = require('node:path')
const { spawn } = require('node:child_process')

const projectRoot = path.join(__dirname, '..')
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const COMBOS = [
  ['--disable-gpu', []],
  ['--disable-gpu --disable-gpu-compositing', []],
  ['--use-angle=swiftshader', []],
  ['--use-gl=swiftshader', []],
  ['--disable-gpu-sandbox', []],
  ['--no-sandbox', []],
  ['--disable-gpu --no-sandbox', []],
  ['--in-process-gpu', []],
  ['--disable-gpu --disable-software-rasterizer --in-process-gpu', []],
  ['--use-angle=swiftshader --disable-gpu-sandbox', []],
  ['--disable-gpu --disable-gpu-compositing --no-sandbox', []],
]

async function tryCombo(label, extra) {
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.AIQUAD_DISABLE_GPU
  const child = spawn(electronExe, ['--remote-debugging-port=9222', ...extra, projectRoot], {
    cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  await sleep(6500)

  let list = []
  try { list = await (await fetch('http://127.0.0.1:9222/json/list')).json() } catch {}
  const t = list.find((x) => /main\.html/.test(x.url))
  let verdict = 'no-target'
  if (t) {
    verdict = await new Promise((resolve) => {
      const ws = new WebSocket(t.webSocketDebuggerUrl)
      const timer = setTimeout(() => resolve('TIMEOUT'), 5000)
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.querySelectorAll(".icon-btn").length + "/" + document.querySelectorAll(".ai-selector").length', returnByValue: true } }))
      ws.onmessage = (ev) => { const s = String(ev.data); if (/"id":1/.test(s)) { clearTimeout(timer); resolve(s.replace(/\s+/g, ' ').slice(0, 160)) } }
      ws.onerror = () => { clearTimeout(timer); resolve('WS-ERROR') }
    })
  }
  const good = /"value":"\d+\/\d+"/.test(verdict)
  console.log(`${good ? '✅' : '❌'} ${label.padEnd(52)} → ${verdict}`)
  if (!good) console.log(`     ${log.replace(/\s*\n\s*/g, ' | ').slice(-260)}`)
  try { process.kill(child.pid) } catch {}
  await sleep(900)
}

async function main() {
  for (const [label, extra] of COMBOS) await tryCombo(label, extra)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
