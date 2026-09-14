/**
 * 验证"浏览器升级把安装目录搬走"之后的应用行为。
 *
 * 真实事故：Chrome 从用户级（%LOCALAPPDATA%\Google\Chrome\Application）迁到
 * 系统级（%ProgramFiles%\Google\Chrome\Application），原路径被删掉。
 * 应用启动时缓存的 exePath 就此失效，`spawn` 抛 ENOENT —— 因为没人监听
 * ChildProcess 的 'error' 事件，它变成**未捕获异常**，主进程直接弹
 * "A JavaScript error occurred in the main process" 并结束。
 *
 * 本脚本就用**那个已经失效的真实路径**当输入，断言：
 *   1) 不再抛未捕获异常（挂 uncaughtException 计数器）
 *   2) 自动重新探测并重试后，分格能正常起来
 *   3) 重试出来的窗口照样被裁剪、落位准确
 *   4) 探测不到浏览器时给出的是清晰错误，而不是崩溃
 *
 * 用法：node scripts/verify-recovery.js
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { pickBrowser } = require('../dist/main/browser-detect')
const { InstanceManager } = require('../dist/main/instance-manager')
const { defaultConfig } = require('../dist/main/config')
const w32 = require('../dist/main/win32')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ROOT = path.join(__dirname, '..')
const PROFILES = path.join(ROOT, '.tmp', 'profiles-recovery-test')
const PANEL = { x: 1328, y: 0, scale: 1 }
const PANE = { paneId: 'p1', x: 12, y: 56, width: 568, height: 700 }
const AI = { id: 'site_a', name: 'SiteA', url: 'https://example.com/', category: 'us', proxyMode: 'global' }

/**
 * 模拟"浏览器升级后安装目录被搬走"的那条失效路径。
 * 用当前用户的 LocalAppData 拼出来，避免写死某个账号名。
 */
const STALE_PATH = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Google',
  'Chrome',
  'Application',
  'chrome.exe',
)

let pass = 0
let fail = 0
function check(ok, label, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✅ ${label}${detail ? `  ${detail}` : ''}`)
  }
  else {
    fail++
    console.log(`  ❌ ${label}${detail ? `  ${detail}` : ''}`)
  }
}

let uncaught = 0
process.on('uncaughtException', (e) => {
  uncaught++
  console.log('  ⚠️ 未捕获异常:', e && e.message)
})

function makeMgr(browser, resolveBrowser) {
  const cfg = defaultConfig()
  cfg.sharedSession = true
  cfg.windowMode = 'standard'
  cfg.proxy = { mode: 'none', type: 'http', host: '', port: '', bypassList: '' }
  cfg.aiList = [AI]
  const mgr = new InstanceManager({ browser, profilesRoot: PROFILES, config: () => cfg, resolveBrowser })
  mgr.setPanel({ x: PANEL.x, y: PANEL.y }, 1, 0, false)
  mgr.setRects([PANE])
  return mgr
}

async function main() {
  console.log('=== 浏览器路径漂移 / 启动自愈 验证 ===\n')

  try {
    require('node:child_process').execFileSync('taskkill', ['/F', '/IM', 'chrome.exe'], { stdio: 'ignore' })
  }
  catch {}
  await sleep(1500)

  fs.rmSync(PROFILES, { recursive: true, force: true })
  fs.mkdirSync(PROFILES, { recursive: true })

  const real = await pickBrowser('chrome', '')
  if (!real) {
    console.log('未检测到浏览器，无法进行本项验证')
    process.exit(1)
  }
  console.log(`真实浏览器：${real.name} ${real.version}`)
  console.log(`             ${real.exePath}`)
  console.log(`模拟的失效路径：${STALE_PATH}`)
  console.log(`该路径当前是否存在：${fs.existsSync(STALE_PATH)}\n`)

  /* ---------- 场景 1：路径失效，但能重新探测到 ---------- */
  console.log('[场景 1] 缓存路径失效 → 应自愈')
  {
    const mgr = makeMgr({ ...real, exePath: STALE_PATH }, async () => real)
    const t0 = Date.now()
    const inst = await mgr.launch('p1', AI)
    const ms = Date.now() - t0
    check(inst?.status === 'ready', '分格最终就绪', `status=${inst?.status} 耗时 ${ms}ms`)
    if (inst?.status === 'ready') {
      const ins = w32.chromeContentInsets(inst.hwnd)
      const rect = w32.getWindowRect(inst.hwnd)
      const box = w32.windowRegionBox(inst.hwnd)
      const vis = box ? { x: rect.left + box.left, y: rect.top + box.top, w: box.right - box.left, h: box.bottom - box.top } : null
      check(!!ins && ins.top > 40, '窗口照样被裁剪（工具栏不可见）', `insets=${JSON.stringify(ins)}`)
      check(
        !!vis && vis.x === PANEL.x + PANE.x && vis.y === PANEL.y + PANE.y && vis.w === PANE.width && vis.h === PANE.height,
        '可见区 == 分格矩形（误差 0）',
        vis ? `实际 ${vis.w}x${vis.h}@(${vis.x},${vis.y}) 期望 ${PANE.width}x${PANE.height}@(${PANEL.x + PANE.x},${PANEL.y + PANE.y})` : '无',
      )
    }
    await mgr.shutdownAll()
    await sleep(800)
  }

  /* ---------- 场景 2：彻底探测不到 → 清晰报错，不能崩 ---------- */
  console.log('\n[场景 2] 重新探测也失败 → 应报清晰错误而不是崩溃')
  {
    const cfg = defaultConfig()
    cfg.sharedSession = true
    cfg.windowMode = 'standard'
    cfg.proxy = { mode: 'none', type: 'http', host: '', port: '', bypassList: '' }
    cfg.aiList = [AI]
    // resolveBrowser 返回 null：假装机器上已经没有 Chrome / Edge
    const mgr = new InstanceManager({
      browser: { id: 'chrome', name: 'Google Chrome', exePath: STALE_PATH },
      profilesRoot: PROFILES,
      config: () => cfg,
      resolveBrowser: async () => null,
    })
    mgr.setPanel({ x: PANEL.x, y: PANEL.y }, 1, 0, false)
    mgr.setRects([PANE])
    const inst = await mgr.launch('p1', AI)
    check(inst?.status === 'failed', '状态是 failed（不是崩溃）', `status=${inst?.status}`)
    check(/浏览器/.test(String(inst?.error || '')), '错误信息可读', `error="${inst?.error}"`)
    await mgr.shutdownAll()
    await sleep(400)
  }

  check(uncaught === 0, '整个过程 0 次未捕获异常（不再弹主进程错误框）', `uncaught=${uncaught}`)

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('脚本异常:', e)
  process.exit(1)
})
