/**
 * M1 冒烟测试（不依赖 Electron）：
 * 1. 探测本机 Chrome / Edge
 * 2. 以 --app 模式启动一个真实浏览器实例（独立用户档案）
 * 3. 读取 DevToolsActivePort 得到调试端口，列出 CDP 页面
 * 4. 通过 EnumWindows 按 PID 找到浏览器窗口句柄
 * 5. 清理进程
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { detectBrowsers, pickBrowser } = require('../dist/main/browser-detect')
const w32 = require('../dist/main/win32')
const { InstanceManager } = require('../dist/main/instance-manager')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('=== 1. 浏览器探测 ===')
  const browsers = await detectBrowsers()
  console.log(browsers.length ? browsers.map((b) => `${b.name} ${b.version || ''} -> ${b.exePath}`).join('\n') : '未检测到浏览器')
  const browser = await pickBrowser('auto')
  if (!browser) {
    console.error('FAIL: 未检测到 Chrome / Edge')
    process.exit(1)
  }
  console.log('使用浏览器:', browser.name, browser.exePath)

  console.log('\n=== 2. 启动真实浏览器实例 ===')
  const smokeRoot = path.join(os.tmpdir(), 'aiquad-smoke')
  fs.rmSync(smokeRoot, { recursive: true, force: true })
  fs.mkdirSync(smokeRoot, { recursive: true })

  const manager = new InstanceManager({
    browser,
    profilesRoot: smokeRoot,
    config: () => ({
      proxy: { mode: 'none', type: 'http', host: '', port: '', bypassList: '' },
    }),
  })

  const ai = { id: 'smoke', name: 'smoke', url: 'https://example.com', proxyMode: 'direct' }
  const inst = await manager.launch('p1', ai)
  console.log('实例状态:', inst.status, 'PID:', inst.pid, '端口:', inst.port, '错误:', inst.error || '无')
  if (inst.status !== 'ready' || !inst.hwnd) {
    console.error('FAIL: 实例未就绪')
    process.exit(2)
  }
  console.log('浏览器窗口句柄 HWND: 0x' + inst.hwnd.toString(16))
  const rect = w32.getWindowRect(inst.hwnd)
  console.log('窗口矩形:', rect)

  console.log('\n=== 3. CDP 连通性 ===')
  try {
    const targets = await (async () => {
      const res = await fetch(`http://127.0.0.1:${inst.port}/json/list`)
      return res.json()
    })()
    console.log('页面目标数:', targets.filter((t) => t.type === 'page').length)
    console.log('首个页面:', targets[0]?.url)
    if (inst.cdp) {
      const r = await inst.cdp.send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })
      console.log('UA:', r?.result?.value)
      const isAutomation = await inst.cdp.send('Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true })
      console.log('navigator.webdriver =', isAutomation?.result?.value, '（false 表示无自动化指纹）')
    }
    else {
      console.log('CDP 未附加（功能降级，不影响使用）')
    }
  }
  catch (e) {
    console.log('CDP 查询失败:', e.message)
  }

  console.log('\n=== 4. 窗口操作 ===')
  w32.moveWindow(inst.hwnd, 0, 0, 800, 600)
  await sleep(300)
  console.log('moveWindow 后矩形:', w32.getWindowRect(inst.hwnd))

  console.log('\n=== 5. 清理 ===')
  manager.killAll()
  await sleep(800)
  console.log('已清理，进程存在:', w32.isWindow(inst.hwnd))
  console.log('\nSMOKE OK')
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e)
  process.exit(1)
})
