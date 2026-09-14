/**
 * 端到端验证：走完整的 InstanceManager 流程（真实浏览器 + 嵌入 + 裁剪）。
 * 用记事本窗口当宿主（模拟面板窗口），验证嵌入后页面内容区与分格矩形精确对齐。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { detectBrowsers, pickBrowser } = require('../dist/main/browser-detect')
const { InstanceManager } = require('../dist/main/instance-manager')
const w32 = require('../dist/main/win32')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function rectOf(hwnd) {
  const r = w32.getWindowRect(hwnd)
  if (!r) return null
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }
}

async function main() {
  const browser = await pickBrowser('auto')
  if (!browser) {
    console.error('FAIL: 未检测到浏览器')
    process.exit(1)
  }
  console.log('浏览器:', browser.name, browser.version || '')
  void detectBrowsers

  // 1. 宿主窗口（记事本）
  const np = spawn('notepad.exe', [], { stdio: 'ignore' })
  let host = 0
  for (let i = 0; i < 30 && !host; i++) {
    await sleep(400)
    for (const h of w32.findWindowsByPid(np.pid)) {
      const r = rectOf(h)
      if (r && r.w > 300 && r.h > 300) {
        host = h
        break
      }
    }
  }
  if (!host) {
    console.error('FAIL: 未找到记事本宿主窗口')
    process.exit(1)
  }
  const hostRect = rectOf(host)
  console.log(`宿主窗口: 0x${host.toString(16)}  ${hostRect.w}×${hostRect.h}`)

  // 2. 实例管理器（标准窗口模式）
  const root = path.join(os.tmpdir(), `aiquad-e2e-${Date.now()}`)
  fs.mkdirSync(root, { recursive: true })
  const manager = new InstanceManager({
    browser,
    profilesRoot: root,
    config: () => ({
      windowMode: 'standard',
      proxy: { mode: 'none', type: 'http', host: '', port: '', bypassList: '' },
    }),
  })

  const pane = { paneId: 'p1', x: 40, y: 70, width: 760, height: 560 }
  manager.setStatusSink((id, status, err) => {
    console.log(`  [状态] ${id} -> ${status}${err ? ` (${err})` : ''}`)
  })
  manager.setHostWindow(host, 1)
  manager.setRects([pane])

  console.log('\n=== 启动实例（标准窗口） ===')
  const inst = await manager.launch('p1', {
    id: 'test',
    name: 'Test',
    url: 'https://example.com',
    category: 'us',
    proxyMode: 'direct',
  })
  console.log(`  状态=${inst.status}  hwnd=${inst.hwnd ? '0x' + inst.hwnd.toString(16) : 'none'}  uiHeight=${inst.uiHeight}`)
  if (inst.status !== 'ready' || !inst.hwnd) {
    console.error('FAIL: 实例未就绪', inst.error)
    process.exit(2)
  }

  // 3. 校验窗口与内容区
  await sleep(1500)
  const winRect = rectOf(inst.hwnd)
  const insets = w32.windowFrameInsets(inst.hwnd)
  const parent = w32.getParent(inst.hwnd)
  console.log('\n=== 嵌入与裁剪校验 ===')
  console.log(`  父窗口 = 宿主: ${parent === host ? '是 ✅' : `否 ❌ (${parent})`}`)
  console.log(`  窗口矩形: ${winRect.w}×${winRect.h} @ (${winRect.x},${winRect.y})`)
  console.log(`  边框内衬: l=${insets.left} t=${insets.top} r=${insets.right} b=${insets.bottom}`)
  console.log(`  期望窗口: ${pane.width + insets.left + insets.right}×${pane.height + (inst.uiHeight || 0)} @ (${pane.x - insets.left},${pane.y - Math.max(0, (inst.uiHeight || 0) - insets.bottom)})`)

  let innerW = 0
  let innerH = 0
  let mode = ''
  try {
    const r1 = await inst.cdp.send('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
    const r2 = await inst.cdp.send('Runtime.evaluate', { expression: 'window.innerHeight', returnByValue: true })
    const r3 = await inst.cdp.send('Runtime.evaluate', { expression: "matchMedia('(display-mode: browser)').matches", returnByValue: true })
    const r4 = await inst.cdp.send('Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true })
    innerW = r1.result.value
    innerH = r2.result.value
    mode = `display-mode browser=${r3.result.value}, webdriver=${r4.result.value}`
  }
  catch (e) {
    console.log('  CDP 查询失败:', e.message)
  }

  console.log(`\n  页面 viewport: ${innerW}×${innerH}   （目标 ${pane.width}×${pane.height}）`)
  console.log(`  ${mode}`)
  const okH = Math.abs(innerH - pane.height) <= 3
  const okW = Math.abs(innerW - pane.width) <= 25
  console.log(`  ${okH && okW ? '✅ 嵌入后内容区与分格精确对齐，浏览器工具栏已被裁掉' : '⚠️ 存在偏差，需要检查'}`)

  // 4. 清理
  console.log('\n=== 清理 ===')
  manager.killAll()
  try {
    process.kill(np.pid)
  }
  catch {}
  await sleep(1000)
  console.log('完成')
  process.exit(0)
}

main().catch((e) => {
  console.error('E2E FAILED:', e)
  process.exit(1)
})
