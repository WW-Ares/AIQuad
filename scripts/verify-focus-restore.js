/**
 * 验证两件事（0.4.9）：
 *
 * ① 点击收敛的分格窗口后，面板**立刻**回到浏览器窗口之上（背景见 win32.watchForeground
 *    的长注释：不补这一下的话，被抬到面板上的浏览器会露出一截自己的工具栏——
 *    第一行分格表现为顶栏闪白，第二行分格表现为在上一格底部留一块透明区域）。
 *    以前只有 200ms 轮询兜底，这里测的就是实际恢复耗时。
 *
 * ② AI 列表展开期间面板必须收回鼠标（`WS_EX_TRANSPARENT` 位清零），
 *    否则点在列表外面（其它分格的网页、面板空白处）的 click 会直接穿透到浏览器窗口，
 *    渲染层收不到事件，"点外面收起列表"就做不到。
 *
 * 用法：
 *   AIQUAD_TEST_PORT=9251 node scripts/verify-focus-restore.js
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { CdpSession } = require('../dist/main/cdp')
const w32 = require('../dist/main/win32')
const { cleanupRun } = require('./lib/process-cleanup')

const projectRoot = path.join(__dirname, '..')
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PORT = Number(process.env.AIQUAD_TEST_PORT || 9251)
const WS_EX_TRANSPARENT = 0x20

/** 从置顶往下走，返回排在 panel 之上的那些窗口 */
function windowsAbove(panelHwnd, mine) {
  const above = []
  let h = w32.getTopWindow()
  let guard = 0
  while (h && h !== panelHwnd && guard++ < 5000) {
    if (mine.has(h)) above.push(h)
    h = w32.getWindow(h, w32.GW_HWNDNEXT)
  }
  return above
}

async function main() {
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
    AIQUAD_DISABLE_GPU: process.env.AIQUAD_DISABLE_GPU || '1',
    AIQUAD_NO_SANDBOX: process.env.AIQUAD_NO_SANDBOX || '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const ud = path.join(projectRoot, '.tmp', 'ud-focus')
  fs.rmSync(ud, { recursive: true, force: true })
  fs.mkdirSync(ud, { recursive: true })

  const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`, projectRoot]
  console.log('启动应用…')
  const child = spawn(electronExe, args, { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d.toString() })
  child.stderr.on('data', (d) => { log += d.toString() })

  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(700)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => /main\.html/.test(t.url)) || null
    }
    catch {}
  }
  if (!target) {
    console.log('❌ 面板渲染进程未启动')
    console.log(log.slice(-1500))
    cleanupRun(child.pid)
    process.exit(1)
  }

  const cdp = new CdpSession(target.webSocketDebuggerUrl)
  await cdp.connect()
  const run = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value
  const move = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  const clickAt = async (x, y) => {
    await move(x, y)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }

  let pass = 0
  let fail = 0
  const check = (ok, label, extra = '') => {
    console.log(`${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`)
    ok ? pass++ : fail++
  }

  // 面板窗口：属于主进程、可见的 Chrome_WidgetWin_1。
  // 要轮询等一会儿：这套脚本跑在没有交互桌面的会话里，窗口有时候要过几秒才被系统认成可见
  let panelHwnd = 0
  for (let i = 0; i < 40 && !panelHwnd; i++) {
    for (const h of w32.findWindowsByPid(child.pid)) {
      if (w32.getClassName(h) !== 'Chrome_WidgetWin_1') continue
      if (w32.isWindowVisible(h)) panelHwnd = h
    }
    if (!panelHwnd) await sleep(700)
  }
  if (!panelHwnd) {
    console.log('❌ 找不到面板窗口')
    console.log(log.slice(-1500))
    cleanupRun(child.pid)
    process.exit(1)
  }

  /* ---------- ② AI 列表展开期间必须收回鼠标 ---------- */
  console.log('\n── AI 列表：展开期间收回鼠标 ──')
  await run(`document.querySelector('[data-layout="1"]').click(), true`)
  console.log('已切到单格，等待浏览器窗口就位…')
  await sleep(14000)

  const geo = await run(`(() => {
    const pane = document.querySelector('.pane')
    if (!pane) return null
    const r = pane.getBoundingClientRect()
    return { ready: pane.classList.contains('ready'), x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  if (!geo || !geo.ready) {
    console.log('⚠️ 分格没就位，跳过这一段（环境里没有可用的浏览器）')
  }
  else {
    const exIs = () => (w32.getWindowLong(panelHwnd, w32.GWL_EXSTYLE) >>> 0) & WS_EX_TRANSPARENT
    await move(geo.x, geo.y)
    await sleep(300)
    check(exIs() !== 0, '平时：指针在分格上 → 面板穿透（点击落到网页）')

    await run(`document.querySelector('[data-role="aitrigger"]').click(), true`)
    await sleep(400)
    await move(geo.x, geo.y)
    await sleep(300)
    const openTransparent = exIs()
    check(openTransparent === 0, '列表展开中：同一位置 → 面板收回鼠标（点外面收得起来）')
    const menuOpen = await run(`!!document.querySelector('.pane.menu-open')`)
    check(!!menuOpen, '列表确实处于展开状态')

    // 点在列表之外、面板之内（分格中部）：应当收起来
    await clickAt(geo.x, geo.y)
    await sleep(500)
    const closed = await run(`!document.querySelector('.pane.menu-open')`)
    check(!!closed, '点列表外面 → 列表收起')
    await move(geo.x + 1, geo.y + 1)
    await sleep(300)
    check(exIs() !== 0, '收起之后：穿透恢复（网页重新可点）')
  }

  /* ---------- ① 激活分格窗口后的层级恢复速度 ---------- */
  console.log('\n── 激活分格窗口 → 面板回到最上一层 ──')
  await run(`document.querySelector('[data-layout="4"]').click(), true`)
  console.log('已切到四格，等待窗口都起来…')
  await sleep(22000)

  const wins = w32.listBrowserWindows().filter((w) => w32.isWindowVisible(w.hwnd))
  const mine = new Set(wins.map((w) => w.hwnd))
  console.log(`可见浏览器窗口 ${mine.size} 个`)
  if (!mine.size) {
    console.log('⚠️ 没有可见的浏览器窗口，这一段跳过')
  }
  else {
    // 先确认初始状态是干净的
    const baseline = windowsAbove(panelHwnd, mine)
    check(baseline.length === 0, '初始状态：没有浏览器窗口压在面板之上', `（${baseline.length} 个）`)

    let worst = 0
    for (const hwnd of Array.from(mine).slice(0, 4)) {
      // 模拟用户真的点了那一格：把它变成前台窗口。
      // 系统随之把它提到置顶带顶端，也就是浮到面板之上——这正是要被纠正的那一瞬间。
      w32.showWindow(hwnd, w32.SW_SHOWNORMAL)
      w32.focusWindow(hwnd)
      const t0 = Date.now()
      let restored = -1
      for (let i = 0; i < 400; i++) {
        await sleep(5)
        if (!windowsAbove(panelHwnd, mine).length) {
          restored = Date.now() - t0
          break
        }
      }
      const region = w32.windowRegionBox(hwnd)
      if (restored > worst) worst = restored
      check(restored >= 0 && restored <= 120, `窗口 ${hwnd}：面板恢复在最上层`, `${restored}ms`)
      check(!!region, `窗口 ${hwnd}：可见区仍在（没被浏览器自己抹掉）`, region ? `${region.left},${region.top},${region.right},${region.bottom}` : '无区域')
    }
    console.log(`最长恢复耗时 ${worst}ms（轮询看门狗是 200ms 一跳）`)

    // 关掉置顶再验一遍：这时大家都在普通层里，面板与浏览器窗口的相对次序
    // 依旧得由看门狗维持（否则面板会被浏览器盖掉，顶栏又白回来）
    await run(`document.getElementById('btn-pin').click(), true`)
    await sleep(1500)
    const unpinned = await run(`document.querySelector('.icon-btn#btn-pin').classList.contains('active')`)
    check(unpinned === false, '点顶栏图钉 → 置顶已关掉')
    for (const hwnd of Array.from(mine).slice(0, 2)) {
      w32.focusWindow(hwnd)
      const t0 = Date.now()
      let restored = -1
      for (let i = 0; i < 400; i++) {
        await sleep(5)
        if (!windowsAbove(panelHwnd, mine).length) {
          restored = Date.now() - t0
          break
        }
      }
      check(restored >= 0 && restored <= 120, `未置顶状态：窗口 ${hwnd} 仍在面板之下`, `${restored}ms`)
    }
    // 还原，免得影响后面的场景
    await run(`document.getElementById('btn-pin').click(), true`)
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  cdp.close()
  cleanupRun(child.pid)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('脚本自身出错：', e)
  process.exit(2)
})
