/**
 * 排查：为什么 Electron 面板渲染进程的 Runtime.evaluate 没有响应。
 * 打印 target 列表、握手过程与收到的原始消息。
 */
const path = require('node:path')
const { spawn } = require('node:child_process')

const projectRoot = path.join(__dirname, '..')
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1', AIQUAD_DISABLE_GPU: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronExe, ['--remote-debugging-port=9222', '--in-process-gpu', '--disable-gpu', projectRoot], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write(`[app] ${d}`))
  child.stderr.on('data', (d) => process.stdout.write(`[app!] ${d}`))

  await sleep(6000)
  const res = await fetch('http://127.0.0.1:9222/json/list')
  const list = await res.json()
  console.log('\n=== targets ===')
  for (const t of list) console.log(` ${t.type}  ${t.title}  ${t.url}\n   ws=${t.webSocketDebuggerUrl}`)

  const target = list.find((t) => /main\.html/.test(t.url))
  if (!target) { console.log('no main.html target'); try { process.kill(child.pid) } catch {}; process.exit(0) }

  // 直连 DevTools，打印原始消息
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.onopen = () => {
    console.log('\n=== socket open，发送 Runtime.evaluate ===')
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } }))
    ws.send(JSON.stringify({ id: 2, method: 'Page.enable', params: {} }))
    setTimeout(() => {
      console.log('=== 超时，仍未收到 id=1 的结果 ===')
      try { process.kill(child.pid) } catch {}
      process.exit(0)
    }, 6000)
  }
  ws.onmessage = (ev) => {
    const s = typeof ev.data === 'string' ? ev.data : String(ev.data)
    console.log('[cdp]', s.slice(0, 400))
    if (/"id":1/.test(s)) {
      try { process.kill(child.pid) } catch {}
      setTimeout(() => process.exit(0), 300)
    }
  }
  ws.onerror = (e) => console.log('[ws error]', e?.message || e)
  ws.onclose = (e) => console.log('[ws close]', e?.code, e?.reason)
}

main().catch((e) => { console.error(e); process.exit(1) })
