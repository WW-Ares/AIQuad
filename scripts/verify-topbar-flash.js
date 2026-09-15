/**
 * 验证「点第一行分格的那一瞬间，顶栏底下不会闪出一条网页」。
 *
 * 背景（0.4.10 修，跟 `verify-clip-pixels.js` 那条"外壳入侵"是**两回事**）：
 *   顶栏那一排的网页是**故意**往上出血、压在顶栏底下的（`styles.css` 的 `--bleed-top`，
 *   否则顶栏与网页之间会露缝）。点分格时系统会把那个浏览器窗口临时抬到面板之上
 *   （见 `instance-manager.ts` 的 `onForeground`，这是系统按激活重排，压不掉，只能抢时间），
 *   被顶栏压住的那一截就露出来 1~2 帧 —— 用户看到的是"点一下，顶栏底下闪一下白线"。
 *
 *   所以：**出血量就是那条白线的高度**。8px 时量到 120×9 个像素、持续 12~25ms；
 *   压到 1px 并把窗口顶边改成 `Math.floor` 之后只剩 2 行（几何下限：窗口顶边只能是
 *   整数像素，而面板不透明区的下沿不是）。本脚本就是钉住这个高度。
 *
 * 为什么不能像 `verify-clip-pixels.js` 那样用 PowerShell 截图 + 取点：
 *   那种路子一帧要 50ms 上下（≈19Hz），而这条白线只存在 1~2 帧 —— **会得出假绿**。
 *   这里改成：一次 `BitBlt` 把顶栏一条 ROI 拷进自己建的 DIB 段，再用 `koffi.view()`
 *   零拷贝成 `Uint32Array` 整块扫，实测 ~165Hz。
 *
 * 为什么点击不能"点完再采样"：`SetCursorPos` / `mouse_event` 之间要留时间（否则按键
 * 可能按老位置路由），采样必须**在点击同时**进行 —— 所以挪光标之后先空采几帧当延时。
 *
 * 用法：
 *   node scripts/verify-topbar-flash.js                       # 4 格，按真实显示器缩放
 *   AIQUAD_TEST_LAYOUT=2 node scripts/verify-topbar-flash.js  # 2 格
 *   AIQUAD_TEST_SCALE=1.1 node scripts/verify-topbar-flash.js # 强制缩放（100% 机器上复现）
 *
 * 环境变量：
 *   AIQUAD_TEST_PORT    调试端口（默认 9360；每档换一个，别和别的脚本撞）
 *   AIQUAD_TEST_LAYOUT  1 / 2 / 4（默认 4）
 *   AIQUAD_TEST_SCALE   强制 deviceScaleFactor（不设 = 用真实显示器缩放）
 *   AIQUAD_TEST_KEEP_FRAME / KEEP_BACKDROP  负向对照：应用侧故意不修，
 *                        此时闪的那一条应当是**整条**（≥5 行）。脚本必须量到它，
 *                        量不到就说明脚本瞎了，直接判失败。
 *
 * 退出码：0 = 符合预期；1 = 不符合（含负向对照量不到入侵）。
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const koffi = require('koffi')
const { CdpSession } = require('../dist/main/cdp')
const w32 = require('../dist/main/win32')
const { cleanupRun, killBrowsersUnder, browserPidsUnder } = require('./lib/process-cleanup')

const PROJECT = path.join(__dirname, '..')
const PORT = Number(process.env.AIQUAD_TEST_PORT || 9360)
const LAYOUT = Number(process.env.AIQUAD_TEST_LAYOUT || 4)
const SCALE = process.env.AIQUAD_TEST_SCALE || ''
const KEEP = !!(process.env.AIQUAD_TEST_KEEP_FRAME || process.env.AIQUAD_TEST_KEEP_BACKDROP)
const TMP = path.join(PROJECT, '.tmp')

/* ---------------- GDI：一次 BitBlt 到自建 DIB 段 ---------------- */

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')
const HDC = 'uint64'
const GetDC = user32.func('GetDC', HDC, ['uint64'])
const ReleaseDC = user32.func('ReleaseDC', 'int', [HDC, HDC])
const SetCursorPos = user32.func('SetCursorPos', 'int', ['int', 'int'])
const MouseEvent = user32.func('mouse_event', 'void', ['uint32', 'uint32', 'uint32', 'uint32', 'uint64'])
const GetForegroundWindow = user32.func('GetForegroundWindow', 'uint64', [])
const CreateCompatibleDC = gdi32.func('CreateCompatibleDC', HDC, [HDC])
const CreateDIBSection = gdi32.func('CreateDIBSection', HDC, [HDC, 'uint8 *', 'uint32', 'uint64 *', 'uint64', 'uint32'])
const SelectObject = gdi32.func('SelectObject', 'uint64', [HDC, 'uint64'])
const BitBlt = gdi32.func('BitBlt', 'int', [HDC, 'int', 'int', 'int', 'int', HDC, 'int', 'int', 'uint32'])
const DeleteDC = gdi32.func('DeleteDC', 'int', [HDC])
const DeleteObject = gdi32.func('DeleteObject', 'int', ['uint64'])

const SRCCOPY = 0x00cc0020
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004

/** 建一个 ROI 大小的 32bpp 自顶向下 DIB 段，返回 { view, read, dispose } */
function openCapture(rx, ry, rw, rh) {
  const screen = GetDC(0)
  const mem = CreateCompatibleDC(screen)
  if (!screen || !mem) throw new Error('拿不到屏幕 DC')
  // BITMAPINFOHEADER（40 字节，32bpp BI_RGB 不需要调色板）：
  // ⚠️ 单位是**主显示器原点**的坐标 —— `BitBlt(GetDC(0))` 与 `GetWindowRect` 同一套；
  //    而"整屏截图"（PowerShell / PIL ImageGrab）用的是**虚拟桌面原点**，本机差 1080px。
  const bi = Buffer.alloc(40)
  bi.writeUInt32LE(40, 0)          // biSize
  bi.writeInt32LE(rw, 4)           // biWidth
  bi.writeInt32LE(-rh, 8)          // biHeight（负数 = 自上而下，行序与屏幕一致）
  bi.writeUInt16LE(1, 12)          // biPlanes
  bi.writeUInt16LE(32, 14)         // biBitCount
  bi.writeUInt32LE(0, 16)          // biCompression = BI_RGB
  const ppv = Buffer.alloc(8)
  const hbmp = CreateDIBSection(mem, bi, 0, ppv, 0, 0)
  if (!hbmp) throw new Error('CreateDIBSection 失败')
  SelectObject(mem, hbmp)
  const bits = Number(ppv.readBigUInt64LE(0))
  // koffi.view 返回 ArrayBuffer，零拷贝：每帧直接扫这块内存，不再分配
  const cur = new Uint32Array(koffi.view(bits, rw * rh * 4))
  const base = new Uint32Array(rw * rh)
  const read = () => { BitBlt(mem, 0, 0, rw, rh, screen, rx, ry, SRCCOPY); return cur }
  const snap = () => base.set(read())
  return {
    read, snap, base, cur, rw, rh,
    dispose() { ReleaseDC(0, screen); DeleteDC(mem); DeleteObject(hbmp) },
  }
}

/** 逐像素比基线（只比 24 位：DIB 的 alpha 字节 GDI 不保证有意义）。返回变化的行号数组 */
function diffRows(cap) {
  const { cur, base, rw, rh } = cap
  const rows = new Set()
  for (let i = 0; i < cur.length; i++) {
    if ((cur[i] & 0xffffff) !== (base[i] & 0xffffff)) rows.add((i / rw) | 0)
  }
  return [...rows].sort((a, b) => a - b)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const ud = path.join(TMP, `ud-flash-${Date.now().toString(36)}`)
  fs.mkdirSync(ud, { recursive: true })
  const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`]
  if (SCALE) args.push(`--force-device-scale-factor=${SCALE}`)
  args.push(PROJECT)
  const child = spawn(path.join(PROJECT, 'node_modules', 'electron', 'dist', 'electron.exe'), args,
    { cwd: PROJECT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d.toString() })
  child.stderr.on('data', (d) => { log += d.toString() })
  const done = (code) => {
    try { killBrowsersUnder(path.join(ud, 'profiles')) } catch {}
    try { cleanupRun(child.pid) }
    catch { try { child.kill() } catch {} }
    setTimeout(() => process.exit(code), 800)
  }

  console.log(`启动应用：布局 ${LAYOUT}${SCALE ? `，强制缩放 ${SCALE}` : '，真实缩放'}，端口 ${PORT}`)
  let target = null
  for (let i = 0; i < 45 && !target; i++) {
    await sleep(700)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => /main\.html/.test(t.url)) || null
    }
    catch { /* 还没起来 */ }
  }
  if (!target) { console.log('面板没起来'); console.log(log.slice(-1500)); return done(1) }
  const cdp = new CdpSession(target.webSocketDebuggerUrl)
  await cdp.connect()
  const num = async (e) => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.value
  const click = (sel) => num(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true })()`)

  await sleep(2500)
  for (let i = 0; i < 20; i++) {
    await click(`[data-layout="${LAYOUT}"]`)
    await sleep(1200)
    if (await num(`document.querySelectorAll('#panes > .pane').length`) === LAYOUT) break
  }
  for (let i = 0; i < 60; i++) {
    if (await num(`document.querySelectorAll('#panes > .pane.ready').length`) >= LAYOUT) break
    await sleep(800)
  }
  await sleep(3000)

  // 面板底色：用来做"取样位置对不对"的自检（取错了区域就不可能撞上这个颜色）
  const panelBg = await num(`(() => {
    const c = getComputedStyle(document.documentElement).getPropertyValue('--panel-bg').trim()
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c)
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null
  })()`)
  const dpr = await num('window.devicePixelRatio')

  const pids = new Set(browserPidsUnder(path.join(ud, 'profiles')))
  const wins = w32.listBrowserWindows().filter((w) => pids.has(w.pid)).map((w) => {
    const rb = w32.windowRegionBox(w.hwnd)
    if (!rb) return null
    return {
      hwnd: w.hwnd,
      vis: { left: w.rect.x + rb.left, top: w.rect.y + rb.top, right: w.rect.x + rb.right, bottom: w.rect.y + rb.bottom },
    }
  }).filter(Boolean)
  if (wins.length < 2) { console.log(`只找到 ${wins.length} 个分格窗口，没法测`); return done(1) }

  // 可视区顶最小的那几个 = 第一行；最大的 = 最后一行
  const sorted = wins.slice().sort((a, b) => a.vis.top - b.vis.top)
  const up = sorted[0]
  const down = sorted[sorted.length - 1]
  if (up === down) { console.log('分不出上下排'); return done(1) }

  const cx = Math.round((up.vis.left + up.vis.right) / 2)
  const ROI = { x: cx - 60, y: 0, w: 120, h: 44 }
  console.log(`devicePixelRatio=${dpr}｜分格窗口 ${wins.length} 个`)
  console.log(`第一行 0x${up.hwnd.toString(16)} 可视区 top=${up.vis.top}；ROI x=${ROI.x}..${ROI.x + ROI.w} y=0..${ROI.h}`)

  const cap = openCapture(ROI.x, ROI.y, ROI.w, ROI.h)
  // 预热：先点一次最后一行，让第一行处于"未激活"（基线取的就是这个状态）
  SetCursorPos(Math.round((down.vis.left + down.vis.right) / 2), down.vis.top + 300)
  await sleep(150)
  MouseEvent(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
  MouseEvent(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
  await sleep(900)

  cap.snap()
  /**
   * 取样位置自检：ROI 里应当有相当一部分是顶栏底色。
   *
   * 为什么要这道检查：这条白线只闪 1~2 帧，**量不到**既可能是"真的修好了"，也可能是
   * "取样区域取错了 / 点击没落到分格里"——两者在输出上长得一模一样，都会给出假绿。
   * 顶栏占这个 44px 高 ROI 的多半（26px 顶栏 + 4px 尾巴），所以只要 ROI 里 ≥20%
   * 的像素是面板底色，就说明取的确实是顶栏那一条。
   * ⚠️ DIB 里是 BGRA（低位是蓝），别把 B 当 R 比 —— 写这段时踩过，明明对上也报"对不上"。
   */
  const px01 = cap.base[0] & 0xffffff
  const got = [px01 & 0xff, (px01 >> 8) & 0xff, (px01 >> 16) & 0xff]      // B,G,R
  const want = [panelBg[2], panelBg[1], panelBg[0]]
  let bgCount = 0
  for (let i = 0; i < cap.base.length; i++) {
    const v = cap.base[i]
    if (Math.abs((v & 0xff) - want[0]) <= 6
      && Math.abs(((v >> 8) & 0xff) - want[1]) <= 6
      && Math.abs(((v >> 16) & 0xff) - want[2]) <= 6) bgCount++
  }
  const bgRatio = bgCount / cap.base.length
  const bgHit = bgRatio >= 0.2
  console.log(`取样位置自检：ROI 里顶栏底色占 ${(bgRatio * 100).toFixed(0)}%（${JSON.stringify(got)} vs ${JSON.stringify(want)}）`
    + ` → ${bgHit ? '✅ 取的是顶栏那一条' : '❌ 对不上，取样区域取错了'}`)
  if (!bgHit) {
    console.log('取样区域不对，这次的结果不可信（量不到白线也可能只是没测对地方）')
    cap.dispose()
    console.log(log.slice(-1200))
    return done(1)
  }

  // 采样循环：中途点第一行那格，看有没有帧偏离基线
  const runs = []
  let cur = null
  let frames = 0
  const t0 = Date.now()
  const clickAt = []
  for (let cycle = 0; cycle < 4; cycle++) {
    // 预热（回到"最后一行激活"）——只采样不点击，顺便当延时
    SetCursorPos(Math.round((down.vis.left + down.vis.right) / 2), down.vis.top + 300)
    for (let i = 0; i < 8; i++) { cap.read(); frames++ }
    MouseEvent(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    MouseEvent(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    for (let i = 0; i < 40; i++) { cap.read(); frames++ }
    // 目标点击
    SetCursorPos(cx, up.vis.top + 300)
    for (let i = 0; i < 8; i++) { cap.read(); frames++ }
    clickAt.push(Date.now() - t0)
    MouseEvent(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    MouseEvent(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    for (let i = 0; i < 90; i++) {                    // ~0.55s
      cap.read(); frames++
      const rows = diffRows(cap)
      if (rows.length) {
        if (!cur) { cur = { rows: new Set(rows), frames: 1, first: Date.now() - t0 } }
        else { rows.forEach((r) => cur.rows.add(r)); cur.frames++ }
      }
      else if (cur) { runs.push(cur); cur = null }
    }
    if (cur) { runs.push(cur); cur = null }
  }
  const hz = Math.round(frames / ((Date.now() - t0) / 1000))
  cap.dispose()

  // 点击是否真的生效：点完第一行那格之后，前台窗口应该是它
  const fg = Number(GetForegroundWindow())
  const clicked = fg === Number(up.hwnd) || fg === Number(down.hwnd)
  console.log(`\n采样 ${frames} 帧 / ${hz}Hz｜点击 ${clickAt.length} 次｜前台窗口=${fg === Number(up.hwnd) ? '第一行那格 ✅' : clicked ? '分格里（不是最上面那格）' : `0x${fg.toString(16)} ⚠️`}`)

  if (!runs.length) {
    console.log('没有量到任何偏离基线的帧。')
    if (KEEP) {
      console.log(`❌ 负向对照（KEEP_FRAME=${process.env.AIQUAD_TEST_KEEP_FRAME || '-'} KEEP_BACKDROP=${process.env.AIQUAD_TEST_KEEP_BACKDROP || '-'}）应当量到一整条，却什么都没量到 —— 脚本没有判定力`)
      console.log(log.slice(-1200))
      return done(1)
    }
    console.log('（也可能只是这几次点击没落到分格里 —— 看上面那行"前台窗口"）')
    console.log(`\n================ 结论 ================\n顶栏闪一下（布局 ${LAYOUT}）：✅ 没量到白线`)
    return done(0)
  }

  const worst = runs.reduce((a, b) => (b.rows.size > a.rows.size ? b : a))
  const worstRows = [...worst.rows].sort((a, b) => a - b)
  console.log(`\n量到 ${runs.length} 段偏离：`)
  for (const run of runs) {
    console.log(`  持续约 ${run.frames} 帧｜变化行 y=${[...run.rows].sort((a, b) => a - b).map((r) => ROI.y + r).join(',')}`)
  }
  console.log(`\n最高的一段：${worst.rows.size} 行（y=${worstRows.map((r) => ROI.y + r).join(',')}）`)

  if (KEEP) {
    if (worst.rows.size >= 5) {
      console.log(`\n================ 结论 ================\n负向对照（布局 ${LAYOUT}）：✅ 如预期地量到整条入侵（${worst.rows.size} 行），说明本脚本确实看得见`)
      return done(0)
    }
    console.log(`\n================ 结论 ================\n负向对照（布局 ${LAYOUT}）：❌ 只量到 ${worst.rows.size} 行，太小，脚本判定力可疑`)
    return done(1)
  }

  const LIMIT = 2
  if (worst.rows.size <= LIMIT) {
    console.log(`\n================ 结论 ================\n顶栏闪一下（布局 ${LAYOUT}）：✅ 最多 ${worst.rows.size} 行（上限 ${LIMIT}）—— 出血被压在 1px 的几何下限内`)
    return done(0)
  }
  console.log(`\n================ 结论 ================\n顶栏闪一下（布局 ${LAYOUT}）：❌ 闪了 ${worst.rows.size} 行（上限 ${LIMIT}）`)
  console.log(`多半是 --bleed-top 又被调大了（出血量 = 这条白线的高度），或 geometry() 的顶边取整被改回 Math.round`)
  console.log(log.slice(-1200))
  return done(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
