const os = require('os')
const path = require('path')
const fs = require('fs')
const { pickBrowser } = require('../dist/main/browser-detect')
const w32 = require('../dist/main/win32')
const { CdpSession } = require('../dist/main/cdp')

const koffi = require('koffi')
const user32 = koffi.load('user32.dll')
const GetClassNameW = user32.func('GetClassNameW', 'int', ['uint64', 'char16 *', 'int'])

function className(hwnd) {
  const buf = Buffer.alloc(512)
  const n = GetClassNameW(hwnd, buf, 256)
  if (!n) return ''
  return buf.toString('utf16le', 0, n * 2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function run(extraArgs, label, mode) {
  const browser = await pickBrowser('auto')
  const profile = path.join(os.tmpdir(), `aiquad-diag-${label}`)
  fs.rmSync(profile, { recursive: true, force: true })
  fs.mkdirSync(profile, { recursive: true })

  const { spawn } = require('child_process')
  const proc = spawn(browser.exePath, [
    '--app=https://example.com',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    ...extraArgs,
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
  await sleep(1500)

  const wins = w32.findWindowsByPid(proc.pid).map((h) => {
    const r = w32.getWindowRect(h)
    return {
      hwnd: '0x' + h.toString(16),
      cls: className(h),
      size: r ? `${r.right - r.left}x${r.bottom - r.top}` : 'null',
    }
  }).filter((w) => w.size !== '0x0' || w.cls.toLowerCase().includes('chrome'))

  let webdriverImmediate = null
  let webdriverAfter = null
  if (mode !== 'nocdp' && port) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (page) {
      const s = new CdpSession(page.webSocketDebuggerUrl)
      await s.connect()
      const a = await s.send('Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true })
      webdriverImmediate = a?.result?.value
      await sleep(2000)
      const b = await s.send('Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true })
      webdriverAfter = b?.result?.value
      if (mode === 'detach') s.close()
    }
  }

  console.log(`\n[${label}] args="${extraArgs.join(' ') || 'none'}" mode=${mode}`)
  console.log('  port:', port)
  console.log('  windows:', JSON.stringify(wins))
  console.log('  webdriver 立即:', webdriverImmediate, '/ 2秒后:', webdriverAfter)

  try { process.kill(proc.pid) } catch {}
  await sleep(400)
}

async function main() {
  await run([], 'A-attach', 'attach')
  await run(['--disable-blink-features=AutomationControlled'], 'B-flag', 'attach')
}

main().catch((e) => { console.error(e); process.exit(1) })
