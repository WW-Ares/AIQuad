/**
 * 验证：Chrome 普通窗口的最小尺寸限制，以及去掉窗口边框后能否缩得更小。
 * 这决定了「标准窗口模式」（避开 --app 应用窗口特征）在窄分格下是否可行。
 */
const koffi = require('koffi')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { detectBrowsers } = require('../dist/main/browser-detect')
const w32 = require('../dist/main/win32')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const user32 = koffi.load('user32.dll')

const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' })
const EnumProcProto = koffi.proto('bool EnumProc(uint64 hwnd, uint64 lparam)')
const EnumProcPtr = koffi.pointer(EnumProcProto)
const GetWindowRect = user32.func('GetWindowRect', 'int', ['uint64', 'uint8 *'])
const GetClassNameW = user32.func('GetClassNameW', 'int', ['uint64', 'char16 *', 'int'])
const EnumWindows = user32.func('EnumWindows', 'int', [EnumProcPtr, 'uint64'])
const MoveWindow = user32.func('MoveWindow', 'int', ['uint64', 'int', 'int', 'int', 'int', 'int'])
const GetWindowLongPtrW = user32.func('GetWindowLongPtrW', 'int64', ['uint64', 'int'])
const SetWindowLongPtrW = user32.func('SetWindowLongPtrW', 'int64', ['uint64', 'int', 'int64'])
const SetWindowPos = user32.func('SetWindowPos', 'int', ['uint64', 'uint64', 'int', 'int', 'int', 'int', 'uint'])
const GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'uint32', ['uint64', koffi.pointer('uint32')])

const GWL_STYLE = -16
const WS_CAPTION = 0x00C00000
const WS_THICKFRAME = 0x00040000
const WS_SYSMENU = 0x00080000
const WS_MINIMIZEBOX = 0x00020000
const WS_MAXIMIZEBOX = 0x00010000
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOZORDER = 0x0004
const SWP_FRAMECHANGED = 0x0020

function rect(hwnd) {
  // 注意：koffi 的结构体出参不会写回，必须用 Buffer 接收
  const buf = Buffer.alloc(16)
  if (!GetWindowRect(hwnd, buf)) return null
  return { w: buf.readInt32LE(8) - buf.readInt32LE(0), h: buf.readInt32LE(12) - buf.readInt32LE(4) }
}

function className(hwnd) {
  const b = Buffer.alloc(512)
  const n = GetClassNameW(hwnd, b, 256)
  return n ? b.toString('utf16le', 0, n * 2) : ''
}

function findBrowserWindow(pid) {
  const p = EnumProcPtr
  let hit = 0
  const cb = koffi.register((h) => {
    const out = Buffer.alloc(4)
    GetWindowThreadProcessId(Number(h), out)
    if (out.readUInt32LE(0) === pid && className(Number(h)) === 'Chrome_WidgetWin_1') {
      const r = rect(Number(h))
      if (r && r.w > 100) {
        hit = Number(h)
        return false
      }
    }
    return true
  }, p)
  EnumWindows(cb, 0n)
  koffi.unregister(cb)
  return hit
}

function ptr(v) {
  return BigInt(Math.trunc(v))
}

;(async () => {
  const browsers = await detectBrowsers()
  const b = browsers.find((x) => x.channel === 'chrome') || browsers[0]
  console.log('浏览器:', b.name, b.version)

  for (const mode of ['app', 'normal']) {
    const profileDir = path.join(os.tmpdir(), `aiquad-min-${mode}-${Date.now()}`)
    fs.mkdirSync(profileDir, { recursive: true })
    const args = [
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      '--disable-blink-features=AutomationControlled',
    ]
    const url = 'about:blank'
    if (mode === 'app') args.push(`--app=${url}`)
    else args.push(url)

    const proc = spawn(b.exePath, args, { stdio: 'ignore' })
    let hwnd = 0
    for (let i = 0; i < 100 && !hwnd; i++) {
      await sleep(400)
      const h = w32.findBrowserWindowByPid(proc.pid)
      if (h) {
        const r = w32.getWindowRect(h)
        if (r && r.right - r.left > 100) hwnd = h
      }
    }
    if (!hwnd) {
      console.log(`\n[${mode}] 未找到窗口`)
      try { process.kill(proc.pid) } catch {}
      continue
    }

    const style0 = Number(GetWindowLongPtrW(hwnd, GWL_STYLE))
    const nat = rect(hwnd)
    console.log(`\n===== ${mode === 'app' ? '应用窗口 (--app)' : '标准窗口'} =====`)
    console.log(`  原始尺寸        : ${nat.w}×${nat.h}`)
    console.log(`  窗口样式         : 0x${(style0 >>> 0).toString(16)}`)

    // 1) 尝试缩到 300×220
    MoveWindow(hwnd, 60, 60, 300, 220, 1)
    await sleep(500)
    const r1 = rect(hwnd)
    console.log(`  MoveWindow(300×220) → 实际 ${r1.w}×${r1.h}${r1.w > 320 ? '  ← 被最小尺寸限制' : ''}`)

    // 2) 去掉标题栏/可调整边框后再试
    const stripped = (style0 & ~WS_CAPTION & ~WS_THICKFRAME & ~WS_SYSMENU & ~WS_MINIMIZEBOX & ~WS_MAXIMIZEBOX) >>> 0
    SetWindowLongPtrW(hwnd, GWL_STYLE, ptr(stripped))
    SetWindowPos(hwnd, 0n, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED)
    await sleep(400)
    MoveWindow(hwnd, 60, 60, 300, 220, 1)
    await sleep(500)
    const r2 = rect(hwnd)
    console.log(`  去边框后(300×220) → 实际 ${r2.w}×${r2.h}${r2.w > 320 ? '  ← 仍受限' : '  ✅ 可缩小'}`)

    try { process.kill(proc.pid) } catch {}
    await sleep(600)
  }
  process.exit(0)
})()
