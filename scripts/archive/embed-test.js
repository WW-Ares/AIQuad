/**
 * 嵌入机制验证（不需要 Electron）：
 * 启动一个真实 Chrome --app 实例，把它的窗口 SetParent 到记事本窗口内，
 * 验证父子关系、子窗口样式与定位是否正确——这正是 AIQuad 把 AI 页面嵌进分格做的事。
 */
const os = require('os')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { pickBrowser } = require('../dist/main/browser-detect')
const w32 = require('../dist/main/win32')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findWindow(cls, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const hit = w32.findWindowByClass(cls)
    if (hit) return hit
    await sleep(200)
  }
  return 0
}

async function main() {
  console.log('=== 准备宿主窗口（记事本）===')
  const notepad = spawn('notepad.exe', [], { stdio: 'ignore' })
  const host = await findWindow('Notepad')
  if (!host) {
    console.error('FAIL: 未找到记事本窗口')
    process.exit(1)
  }
  console.log('宿主 HWND: 0x' + host.toString(16), w32.getWindowRect(host))
  w32.moveWindow(host, 100, 100, 900, 600)
  await sleep(400)
  const hostRect = w32.getWindowRect(host)
  console.log('宿主调整后:', hostRect)

  console.log('\n=== 启动真实 Chrome 实例 ===')
  const browser = await pickBrowser('auto')
  const profile = path.join(os.tmpdir(), 'aiquad-embed')
  fs.rmSync(profile, { recursive: true, force: true })
  fs.mkdirSync(profile, { recursive: true })
  const chrome = spawn(browser.exePath, [
    '--app=https://example.com',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
  ], { stdio: 'ignore' })

  const target = await (async () => {
    const start = Date.now()
    while (Date.now() - start < 40000) {
      const h = w32.findBrowserWindowByPid(chrome.pid)
      if (h) {
        const { width, height } = w32.windowSize(h)
        if (width > 200 && height > 150) return h
      }
      await sleep(300)
    }
    return 0
  })()
  if (!target) {
    console.error('FAIL: 未找到 Chrome 窗口')
    process.exit(2)
  }
  console.log('Chrome HWND: 0x' + target.toString(16), w32.getWindowRect(target))

  console.log('\n=== 执行嵌入 ===')
  w32.makeChildWindow(target)
  const r = w32.setParent(target, host)
  console.log('SetParent 返回值: 0x' + Number(r).toString(16))
  w32.makeChildWindow(target)
  await sleep(600)
  const parent = w32.getParent(target)
  console.log('嵌入后 GetParent(chrome) = 0x' + parent.toString(16), parent === host ? '✅ 父子关系正确' : '❌ 失败')

  w32.moveWindow(target, 0, 0, 880, 520)
  await sleep(600)
  const rect = w32.getWindowRect(target)
  console.log('嵌入后 chrome 屏幕矩形:', rect)
  const insideX = rect.left >= hostRect.left - 2 && rect.right <= hostRect.right + 2
  const insideY = rect.top >= hostRect.top - 2 && rect.bottom <= hostRect.bottom + 2
  console.log(insideX && insideY ? '✅ 子窗口位于宿主客户区内' : '❌ 子窗口越界')

  console.log('\n=== 清理 ===')
  try { process.kill(chrome.pid) } catch {}
  try { process.kill(notepad.pid) } catch {}
  console.log('done')
  process.exit(parent === host && insideX && insideY ? 0 : 3)
}

main().catch((e) => { console.error(e); process.exit(1) })
