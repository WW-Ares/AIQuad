/**
 * 设置窗口的标题栏下沿分割线，是否一直贯通到右上角三个系统按钮下面。
 *
 * 为什么需要它：标题栏是自绘的（`titleBarStyle:'hidden'` + `titleBarOverlay`），
 * 那三个按钮由 Electron 在原生层画成一块**不透明矩形**、盖在页面**之上**。
 * 它的高度只要不小于 `.st-head` 的高度，底边就会压住分割线所在的那一行像素 ——
 * 于是线从左画到按钮下面突然断掉（2026-09-15 的真实反馈）。而 CDP 的
 * `Page.captureScreenshot` 里**根本没有叠加层**，截图看上去永远是好的：
 * 这件事只有屏幕像素能判。
 *
 * 判据：全屏实拍后逐行统计"线色像素"（`--line` #2e333e）在
 *   左段 x ∈ [窗口左+20, 窗口左+250)  与  右段 x ∈ [窗口右-140, 窗口右-5)
 * 的命中数。右段正下方就是那三个按钮，**两侧都要 ≥90%** 才算贯通。
 * 另有负向对照：临时把 `.st-head` 压矮 2px，让线重新落回叠加层的覆盖范围里，
 * 此时右段必须报断 —— 否则说明这套测量看不见问题，结论不可信。
 *
 * 用法：AIQUAD_TEST_PORT=9797 node scripts/verify-titlebar-line.js
 * 退出码：0 通过；3 判据不成立。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const TMP = path.join(ROOT, '.tmp')
const PORT = Number(process.env.AIQUAD_TEST_PORT || 9797)
const Q = path.join(TMP, 'appdata', 'q2')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const { CdpSession, listTargets } = require(path.join(ROOT, 'dist', 'main', 'cdp'))
const { cleanupRun } = require('./lib/process-cleanup')
const w32 = require(path.join(ROOT, 'dist', 'main', 'win32'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** ⚠️ 必须纯 ASCII：PowerShell 5.1 按 ANSI 读 .ps1，中文注释会让它解析错乱（$bmp 变 null） */
function writeAscii(file, text) {
  fs.mkdirSync(TMP, { recursive: true })
  const p = path.join(TMP, file)
  fs.writeFileSync(p, text.replace(/\r?\n/g, '\r\n'), 'ascii')
  return p
}

const SHOT_PS1 = writeAscii('headline-shot.ps1', `
param([string]$Out, [string]$Meta)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
[System.IO.File]::WriteAllText($Meta, "$($vs.Left),$($vs.Top),$($vs.Width),$($vs.Height)")
`)

const SCAN_PS1 = writeAscii('headline-scan.ps1', `
param([string]$Png, [int]$L, [int]$R, [int]$Y0, [int]$Y1, [string]$Out, [int]$Tol = 10)
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Image]::FromFile($Png)
$lines = New-Object System.Collections.Generic.List[string]
for ($y = $Y0; $y -le $Y1; $y++) {
  $hl = 0; $tl = 0; $hr = 0; $tr = 0
  for ($x = $L + 20; $x -lt $L + 250; $x += 2) {
    $tl++
    $c = $bmp.GetPixel($x, $y)
    if ([Math]::Abs($c.R - 46) -le $Tol -and [Math]::Abs($c.G - 51) -le $Tol -and [Math]::Abs($c.B - 62) -le $Tol) { $hl++ }
  }
  for ($x = $R - 140; $x -lt $R - 5; $x += 2) {
    $tr++
    $c = $bmp.GetPixel($x, $y)
    if ([Math]::Abs($c.R - 46) -le $Tol -and [Math]::Abs($c.G - 51) -le $Tol -and [Math]::Abs($c.B - 62) -le $Tol) { $hr++ }
  }
  $lines.Add("$y,$hl,$tl,$hr,$tr")
}
$bmp.Dispose()
[System.IO.File]::WriteAllLines($Out, $lines)
`)

const ps = (args) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ...args], { encoding: 'utf8' })

function fullShot(tag) {
  const png = path.join(TMP, `headline-${tag}.png`)
  const meta = path.join(TMP, `headline-${tag}.meta.txt`)
  ps([SHOT_PS1, '-Out', png, '-Meta', meta])
  const [left, top] = fs.readFileSync(meta, 'utf8').trim().split(',').map(Number)
  return { png, vsLeft: left, vsTop: top }
}

function rowScan(png, L, R, Y0, Y1, tag) {
  const out = path.join(TMP, `headline-${tag}.txt`)
  ps([SCAN_PS1, '-Png', png, '-L', String(L), '-R', String(R), '-Y0', String(Y0), '-Y1', String(Y1), '-Out', out])
  return fs.readFileSync(out, 'utf8').trim().split(/\r?\n/).map((ln) => {
    const [y, hl, tl, hr, tr] = ln.split(',').map(Number)
    return { y, hitL: hl, totL: tl, hitR: hr, totR: tr }
  })
}

/** 找出最完整的一行（左段命中 ≥90%），并判定它右段是否也 ≥90% */
function judge(rows, winTopPng) {
  let best = null
  for (const r of rows) {
    if (r.hitL >= r.totL * 0.9 && (!best || r.hitR > best.hitR)) best = r
  }
  const ok = !!best && best.hitR >= best.totR * 0.9
  return { ok, best, rel: best ? best.y - winTopPng : null }
}

function report(title, rows, winTopPng) {
  const { ok, best, rel } = judge(rows, winTopPng)
  for (const r of rows) {
    if (r.hitL === 0 && r.hitR < 5) continue
    console.log(`  相对窗口 +${String(r.y - winTopPng).padStart(3)} 行  左段 ${String(r.hitL).padStart(3)}/${r.totL}   右段 ${String(r.hitR).padStart(3)}/${r.totR}`)
  }
  console.log(`  ${title}：${ok ? '✅ 分割线在右段（按钮下方）连续' : '❌ 右段断开'}`
    + `（最完整的一行 相对窗口 +${rel}，右段命中 ${best ? best.hitR : '?'}/${best ? best.totR : '?'}）`)
  return ok
}

async function main() {
  const real = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'aiquad', 'config.json'), 'utf8'))
  real.panes = []
  real.cacheCleanup = 'off'
  real.autoStart = false
  fs.mkdirSync(Q, { recursive: true })
  fs.writeFileSync(path.join(Q, 'config.json'), JSON.stringify(real, null, 2))

  const env = { ...process.env, AIQUAD_DISABLE_GPU: '1', AIQUAD_NO_SANDBOX: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(ELECTRON, [
    '--in-process-gpu', '--disable-gpu',
    `--user-data-dir=${Q}`,
    `--remote-debugging-port=${PORT}`,
    ROOT,
  ], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.on('data', (d) => { err += d.toString() })

  try {
    let panel = null
    for (let i = 0; i < 60 && !panel; i++) {
      await sleep(700)
      try { panel = (await listTargets(PORT, 1)).find((t) => /main\.html/.test(t.url)) } catch {}
    }
    if (!panel) throw new Error('面板没起来\n' + err.slice(-800))
    const p = new CdpSession(panel.webSocketDebuggerUrl)
    await p.connect()
    await p.send('Runtime.evaluate', { expression: 'window.aiquad.openSettings()', returnByValue: true, awaitPromise: true })

    let set = null
    for (let i = 0; i < 40 && !set; i++) {
      await sleep(500)
      try { set = (await listTargets(PORT, 1)).find((t) => /settings\.html/.test(t.url)) } catch {}
    }
    if (!set) throw new Error('设置窗口没起来')
    await sleep(2000)

    const s = new CdpSession(set.webSocketDebuggerUrl)
    await s.connect()
    await s.send('Page.bringToFront')
    const ev = async (expr) => {
      const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '页面内异常')
      return r?.result?.value
    }

    const page = await ev(`(() => {
      const cs = getComputedStyle(document.querySelector('.st-head'))
      const r = document.querySelector('.st-head').getBoundingClientRect()
      return { dpr: devicePixelRatio, headH: Math.round(r.height), headBottom: r.bottom,
               borderBottom: cs.borderBottomWidth + ' ' + cs.borderBottomColor }
    })()`)
    console.log('[页面]', JSON.stringify(page))

    const all = w32.listBrowserWindows()
    const setWin = all.find((w) => /设置/.test(w.title) && w.pid === child.pid) || all.find((w) => /设置/.test(w.title))
    if (!setWin) throw new Error('没找到设置窗口 hwnd')
    const W = { left: setWin.rect.x, top: setWin.rect.y, width: setWin.rect.width, height: setWin.rect.height }
    console.log(`[设置窗口] hwnd=${setWin.hwnd} ${W.width}x${W.height}@(${W.left},${W.top})`)

    // 顺带核对两个定位函数：findWindowsByPid 走的是回调内部 GetWindowThreadProcessId，
    // 历史上出现过对本进程返回空数组的情况（不影响生产，只影响脚本）。
    const byPid = w32.findWindowsByPid(child.pid).length
    console.log(`[定位函数] findWindowsByPid(${child.pid}) → ${byPid} 个；listBrowserWindows 里同 pid 的 → ${all.filter((w) => w.pid === child.pid).length} 个`)

    const shot = fullShot('after')
    const L = W.left - shot.vsLeft
    const R = W.left + W.width - shot.vsLeft
    const Y0 = W.top - shot.vsTop + 25
    const Y1 = W.top - shot.vsTop + 62
    const winTopPng = W.top - shot.vsTop
    const rowsA = rowScan(shot.png, L, R, Y0, Y1, 'after')
    console.log('\n=== 正常状态（titleBarOverlay.height 应比 .st-head 矮 2）===')
    const okNow = report('分割线', rowsA, winTopPng)

    // 负向对照：把标题栏压矮 2px，让线重新落进叠加层的覆盖范围里
    await ev(`(() => { const st = document.createElement('style'); st.id = 'neg';
      st.textContent = '.st-head{height:38px !important}'; document.head.appendChild(st); return true })()`)
    await sleep(600)
    const shotB = fullShot('before')
    const rowsB = rowScan(shotB.png, L, R, Y0, Y1, 'before')
    console.log('\n=== 负向对照（把标题栏压矮 2px，预期右段断）===')
    const okNeg = report('分割线', rowsB, winTopPng)
    await ev(`(() => { const e = document.getElementById('neg'); if (e) e.remove(); return true })()`)

    // 人眼对照图（放大 2.4 倍，只看窗口右上角）
    const cropPs = writeAscii('headline-crop.ps1', `
param([string]$Png, [string]$Out, [int]$X, [int]$Y, [int]$W, [int]$H, [double]$Scale = 1.0)
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($Png)
$rect = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
$dw = [int]($W * $Scale)
$dh = [int]($H * $Scale)
$bmp = New-Object System.Drawing.Bitmap($dw, $dh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $dw, $dh)), $rect, [System.Drawing.GraphicsUnit]::Pixel)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $src.Dispose()
`)
    for (const [png, tag] of [[shot.png, 'after'], [shotB.png, 'before']]) {
      ps([cropPs, '-Png', png, '-Out', path.join(TMP, `headline-${tag}-zoom.png`),
        '-X', String(R - 420), '-Y', String(winTopPng), '-W', '420', '-H', '70', '-Scale', '2.4'])
    }
    console.log(`\n[放大对照图] .tmp/headline-after-zoom.png（连续） vs .tmp/headline-before-zoom.png（断开）`)

    const pass = okNow && !okNeg
    console.log(`\n=== 结果：${pass ? '✅ 通过' : '❌ 失败'}（正向 ${okNow ? 'PASS' : 'FAIL'}；`
      + `负向对照 ${okNeg ? '未复现（测量可能失效）' : '已复现'}）===`)
    s.close(); p.close()
    process.exitCode = pass ? 0 : 3
  }
  finally {
    cleanupRun(child.pid)
    await sleep(500)
  }
}

main().catch((e) => { console.log('失败：', String(e?.message || e)); process.exitCode = 1; setTimeout(() => process.exit(1), 300) })
