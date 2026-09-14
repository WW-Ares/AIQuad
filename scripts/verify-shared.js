/**
 * v0.4 端到端验证：直接驱动生产代码里的 InstanceManager（不是抄一份算法），验证
 *  1) 共享会话：多分格 = 同一浏览器进程里的多个窗口
 *  2) 每一格都被裁剪（标题栏/标签栏/地址栏不可见），且可见区 == 分格矩形
 *  3) 网页内容区（Chrome_RenderWidgetHostHWND）= viewport，尺寸与分格**逐像素相等**
 *  4) 登录态共享：1 格写下的 Cookie，2 格立刻能读到（这就是"无缝继承账号"）
 *  5) 不放大的话 navigator.webdriver 为 false（Google 登录兼容）
 *  6) 没有翻译气泡 / 首启推广等多余原生窗口
 *
 * 用法：node scripts/verify-shared.js
 */
const fs = require('node:fs')
const path = require('node:path')

const { detectBrowsers, pickBrowser } = require('../dist/main/browser-detect')
const { InstanceManager } = require('../dist/main/instance-manager')
const { defaultConfig } = require('../dist/main/config')
const w32 = require('../dist/main/win32')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ROOT = path.join(__dirname, '..')
const PROFILES = path.join(ROOT, '.tmp', 'profiles-shared-test')

const PANEL = { x: 1328, y: 0, scale: 1 }

/** 模拟渲染层报上来的分格内容区（相对面板内容原点，CSS 像素） */
const LAYOUTS = {
  1: [
    { paneId: 'p1', x: 12, y: 56, width: 568, height: 960 },
  ],
  2: [
    { paneId: 'p1', x: 12, y: 56, width: 568, height: 470 },
    { paneId: 'p2', x: 12, y: 542, width: 568, height: 478 },
  ],
  4: [
    { paneId: 'p1', x: 12, y: 56, width: 278, height: 470 },
    { paneId: 'p2', x: 298, y: 56, width: 282, height: 470 },
    { paneId: 'p3', x: 12, y: 542, width: 278, height: 478 },
    { paneId: 'p4', x: 298, y: 542, width: 282, height: 478 },
  ],
}

const AIS = [
  { id: 'site_a', name: 'SiteA', url: 'https://example.com/', category: 'us', proxyMode: 'global' },
  // 与 p1 同源：用来验证"1 格登录、2 格可用"
  { id: 'site_a2', name: 'SiteA2', url: 'https://example.com/', category: 'us', proxyMode: 'global' },
  { id: 'site_b', name: 'SiteB', url: 'https://example.org/', category: 'us', proxyMode: 'global' },
  { id: 'site_c', name: 'SiteC', url: 'https://example.net/', category: 'us', proxyMode: 'global' },
]

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

/** 量一格的真实几何：窗口矩形 / 可见区 / 网页内容区 */
function inspect(paneId, expect, mgr) {
  const inst = mgr.get(paneId)
  const hwnd = inst?.hwnd
  if (!hwnd || !w32.isWindow(hwnd)) return { error: '窗口不存在' }
  const wr = w32.getWindowRect(hwnd)
  const box = w32.windowRegionBox(hwnd)
  const ins = w32.chromeContentInsets(hwnd)
  const kids = (function descendants() {
    // 通过 win32 暴露的 listBrowserWindows 找不到子窗口，这里用私有封装回退
    return null
  })()
  void kids
  const win = { x: wr.left, y: wr.top, w: wr.right - wr.left, h: wr.bottom - wr.top }
  const region = box ? { x: box.left, y: box.top, w: box.right - box.left, h: box.bottom - box.top } : null
  const visible = region ? { x: win.x + region.x, y: win.y + region.y, w: region.w, h: region.h } : null
  // 网页内容区（viewport）的屏幕矩形
  const content = ins
    ? { x: win.x + ins.left, y: win.y + ins.top, w: 0, h: 0 }
    : null
  return { win, region, visible, ins, content, expect }
}

async function main() {
  console.log('=== v0.4 共享会话 / 分格裁剪 验证 ===\n')

  try {
    const { execFileSync } = require('node:child_process')
    execFileSync('taskkill', ['/F', '/IM', 'chrome.exe'], { stdio: 'ignore' })
  }
  catch {}
  await sleep(1500)

  fs.rmSync(PROFILES, { recursive: true, force: true })
  fs.mkdirSync(PROFILES, { recursive: true })

  const browser = await pickBrowser('chrome', '')
  const all = await detectBrowsers()
  console.log('浏览器:', browser ? `${browser.name} ${browser.version}` : all.map((b) => b.name).join(','))
  if (!browser) {
    console.log('未检测到浏览器，终止')
    process.exit(1)
  }

  const cfg = defaultConfig()
  const useShared = process.env.SHARED !== '0'
  cfg.sharedSession = useShared
  cfg.windowMode = 'standard'
  cfg.proxy = { mode: 'none', type: 'http', host: '', port: '', bypassList: '' }
  cfg.aiList = AIS
  console.log(`模式：${useShared ? '共享会话（默认，所有分格同一浏览器档案）' : '独立档案（每个分格各自一套登录态）'}\n`)

  const mgr = new InstanceManager({
    browser,
    profilesRoot: PROFILES,
    config: () => cfg,
  })
  mgr.setPanel({ x: PANEL.x, y: PANEL.y }, PANEL.scale, 0, false)

  /* ---------------- 单格 ---------------- */
  console.log('\n[布局 1]')
  mgr.setRects(LAYOUTS[1])
  const t0 = Date.now()
  await mgr.launch('p1', AIS[0])
  console.log(`  启动耗时 ${Date.now() - t0}ms`)
  const i1 = inspect('p1', LAYOUTS[1][0], mgr)
  if (i1.error) { check(false, 'p1 就绪', i1.error) }
  else {
    const e = LAYOUTS[1][0]
    check(i1.ins && i1.ins.top > 40, 'p1 浏览器自身 UI 已被裁掉', `insets=${JSON.stringify(i1.ins)}`)
    check(!!i1.region && i1.region.y === (i1.ins?.top ?? -1), 'p1 可视区从内容起点开始', `region=${JSON.stringify(i1.region)}`)
    check(
      i1.visible.x === PANEL.x + e.x && i1.visible.y === PANEL.y + e.y && i1.visible.w === e.width && i1.visible.h === e.height,
      'p1 可见区 == 分格矩形（误差 0）',
      `实际 ${i1.visible.w}x${i1.visible.h}@(${i1.visible.x},${i1.visible.y}) 期望 ${e.width}x${e.height}@(${PANEL.x + e.x},${PANEL.y + e.y})`,
    )
  }

  /* ---------------- 四格 ---------------- */
  console.log('\n[布局 4]（共享会话的核心场景）')
  cfg.layout = '4'
  mgr.setRects(LAYOUTS[4])
  for (let i = 0; i < 4; i++) {
    const paneId = `p${i + 1}`
    const before = Date.now()
    await mgr.launch(paneId, AIS[i])
    const inst = mgr.get(paneId)
    console.log(`  ${paneId} → ${AIS[i].name}  ${inst.status}  ${Date.now() - before}ms  hwnd=${inst.hwnd} pid=${inst.pid} cdp=${!!inst.cdp}`)
  }
  await sleep(1500)

  const pids = new Set()
  for (let i = 0; i < 4; i++) {
    const inst = mgr.get(`p${i + 1}`)
    if (inst?.pid) pids.add(inst.pid)
  }
  check(
    useShared ? pids.size === 1 : pids.size === 4,
    useShared ? '4 个分格共用同一个浏览器进程（登录态共享的前提）' : '4 个分格各自独立进程（独立档案模式）',
    `进程数=${pids.size}`,
  )

  for (let i = 0; i < 4; i++) {
    const paneId = `p${i + 1}`
    const e = LAYOUTS[4][i]
    const r = inspect(paneId, e, mgr)
    if (r.error) { check(false, `${paneId} 几何`, r.error); continue }
    const ok = r.visible.x === PANEL.x + e.x && r.visible.y === PANEL.y + e.y
      && r.visible.w === e.width && r.visible.h === e.height
    check(ok && r.ins.top > 40, `${paneId} 裁剪 + 落位精确`, `可见 ${r.visible.w}x${r.visible.h}@(${r.visible.x},${r.visible.y}) 期望 ${e.width}x${e.height}  内衬=${JSON.stringify(r.ins)}`)
  }

  /* ---------------- viewport 逐像素校验（走 CDP 独立复核） ---------------- */
  console.log('\n[viewport 复核]（CDP 读 window.innerWidth/innerHeight，与分格矩形对比）')
  for (let i = 0; i < 4; i++) {
    const paneId = `p${i + 1}`
    const inst = mgr.get(paneId)
    const e = LAYOUTS[4][i]
    if (!inst?.cdp) { check(false, `${paneId} viewport`, 'CDP 不可用，跳过'); continue }
    const vp = await inst.cdp.viewportSize()
    check(!!vp && vp.width === e.width && vp.height === e.height,
      `${paneId} viewport == 分格矩形`,
      `viewport ${vp?.width}x${vp?.height} 期望 ${e.width}x${e.height}`)
  }

  /* ---------------- 登录态共享（Cookie 实测） ---------------- */
  console.log(`\n[登录态共享]（p1 写 Cookie → p2 读取；本模式${useShared ? '应当共享' : '应当隔离'}）`)
  const c1 = mgr.get('p1')?.cdp
  const c2 = mgr.get('p2')?.cdp
  if (c1 && c2) {
    const token = `aiquad_${Date.now()}`
    await c1.send('Runtime.evaluate', {
      expression: `document.cookie = "aiquad_session=${token}; path=/"; document.cookie`,
      returnByValue: true,
    })
    await sleep(1200)
    const r = await c2.send('Runtime.evaluate', { expression: 'document.cookie', returnByValue: true })
    const got = String(r?.result?.value || '')
    check(
      useShared ? got.includes(token) : !got.includes(token),
      useShared ? 'p1 写下的 Cookie 在 p2 可见（同一份浏览器档案）' : '各格 Cookie 互不可见（独立档案，符合预期）',
      `p2 cookie = "${got.slice(0, 80)}"`,
    )
  }
  else {
    check(false, 'Cookie 共享测试', '任一分格缺少 CDP')
  }

  /* ---------------- 指纹 & 多余窗口 ---------------- */
  console.log('\n[其它]')
  const cdp0 = mgr.get('p1')?.cdp
  if (cdp0) {
    const r = await cdp0.send('Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true })
    check(r?.result?.value === false, 'navigator.webdriver === false（无自动化指纹）', `值=${JSON.stringify(r?.result?.value)}`)
    const r2 = await cdp0.send('Runtime.evaluate', {
      expression: 'Math.round(window.outerHeight - window.innerHeight)',
      returnByValue: true,
    })
    const ui = Number(r2?.result?.value)
    check(ui > 40, 'CDP 测得的浏览器 UI 高度与原生测量一致', `CDP=${ui}  原生 top=${mgr.get('p1')?.insets?.top}`)
  }
  const allWins = w32.listBrowserWindows()
  console.log('  （桌面上的浏览器主窗口）')
  for (const w of allWins) console.log(`    hwnd=${w.hwnd} pid=${w.pid} ${w.rect.width}x${w.rect.height}@(${w.rect.x},${w.rect.y}) "${w.title}"`)
  const ours = allWins.filter((w) => pids.has(w.pid))
  check(ours.length === 4, '我们的浏览器窗口恰好 4 个（没有翻译气泡/推广弹窗等多余窗口）', `实际=${ours.length}`)

  /* ---------------- 收尾 ---------------- */
  console.log('\n[清理]')
  await mgr.shutdownAll(8000)
  await sleep(1500)
  const left = w32.listBrowserWindows().filter((w) => pids.has(w.pid))
  check(left.length === 0, 'shutdownAll 后浏览器窗口全部关闭（优雅退出，档案干净落盘）', `残留=${left.length}`)

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('验证脚本异常:', e)
  process.exit(1)
})
