const os = require('os')
const path = require('path')
const fs = require('fs')
const { pickBrowser } = require('../dist/main/browser-detect')
const w32 = require('../dist/main/win32')
const { CdpSession } = require('../dist/main/cdp')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const koffi = require('koffi')
const user32 = koffi.load('user32.dll')
const SetWindowPos = user32.func('SetWindowPos', 'int', ['uint64', 'uint64', 'int', 'int', 'int', 'int', 'uint32'])
const MoveWindow = user32.func('MoveWindow', 'int', ['uint64', 'int', 'int', 'int', 'int', 'int'])

async function main() {
  const browser = await pickBrowser('auto')
  const profile = path.join(os.tmpdir(), 'aiquad-diag2')
  fs.rmSync(profile, { recursive: true, force: true })
  fs.mkdirSync(profile, { recursive: true })

  const { spawn } = require('child_process')
  const proc = spawn(browser.exePath, [
    '--app=https://example.com',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
  ], { stdio: 'ignore' })

  let port = 0
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const f = path.join(profile, 'DevToolsActivePort')
    if (fs.existsSync(f)) {
      port = Number(fs.readFileSync(f, 'utf8').trim().split(/\r?\n/)[0])
      if (port) break
    }
    await sleep(200)
  }
  console.log('port =', port)

  console.log('\n--- DevTools HTTP 探测（重试 8 次）---')
  for (let i = 0; i < 8; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      console.log(`  尝试 ${i + 1}: ${res.status}`, (await res.text()).slice(0, 120))
      break
    }
    catch (e) {
      console.log(`  尝试 ${i + 1}: 失败 ${e.message} / cause=${e.cause?.code || ''}`)
      await sleep(800)
    }
  }

  const hwnd = w32.findBrowserWindowByPid(proc.pid)
  console.log('\n--- 窗口操作 ---')
  console.log('找到窗口: 0x' + (hwnd || 0).toString(16), w32.getWindowRect(hwnd))

  console.log('MoveWindow(10,10,900,700):', MoveWindow(hwnd, 10, 10, 900, 700, 1))
  await sleep(600)
  console.log('  ->', w32.getWindowRect(hwnd))

  console.log('SetWindowPos(50,50,800,600):', SetWindowPos(hwnd, 0, 50, 50, 800, 600, 0x0004 | 0x0010))
  await sleep(600)
  console.log('  ->', w32.getWindowRect(hwnd))

  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (page) {
      const s = new CdpSession(page.webSocketDebuggerUrl)
      await s.connect()
      const r = await s.send('Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true })
      console.log('\nnavigator.webdriver =', r?.result?.value)
      s.close()
    }
  }
  catch (e) {
    console.log('\nCDP 失败:', e.message)
  }

  try { process.kill(proc.pid) } catch {}
}

main().catch((e) => { console.error(e); process.exit(1) })
