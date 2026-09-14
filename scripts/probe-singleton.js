/**
 * 找出"谁占着单实例锁"。
 *
 * 症状：应用启动后 `app.requestSingleInstanceLock()` 返回 false → 立刻 `app.quit()`，
 * 用户视角就是"双击没反应"，连窗口都没有、也没有任何报错。
 * 换成别的 userData 目录启动就正常，说明锁被**某个残留进程**占着。
 *
 * Chromium 的 ProcessSingleton（Electron 复用）在 Windows 上会创建一个**隐藏的顶层窗口**
 * 来占位，类名带 userData 路径的哈希。所以直接枚举桌面上所有顶层窗口
 * （含不可见的），按类名/标题找出可疑的占位窗口，并报出它的 PID。
 *
 * 用法：node scripts/probe-singleton.js
 */
const koffi = require('koffi')
const w32 = require('../dist/main/win32')

const user32 = koffi.load('user32.dll')
const EnumWindowsProc = koffi.proto('bool AIQuadProbeEnumProc(intptr hwnd, intptr lparam)')
const EnumWindowsProcPtr = koffi.pointer(EnumWindowsProc)
const EnumWindows = user32.func('bool EnumWindows(AIQuadProbeEnumProc *lpEnumFunc, intptr lParam)')

const rows = []
const cb = koffi.register((hwnd) => {
  const h = Number(hwnd)
  const cls = w32.getClassName(h)
  const title = w32.getWindowText(h)
  const r = w32.getWindowRect(h)
  rows.push({
    hwnd: h,
    pid: w32.getWindowPid(h),
    cls,
    title,
    visible: w32.isWindowVisible(h),
    rect: r ? `${r.right - r.left}x${r.bottom - r.top}@${r.left},${r.top}` : '?',
  })
  return true
}, EnumWindowsProcPtr)
EnumWindows(cb, 0n)
koffi.unregister(cb)

console.log(`顶层窗口共 ${rows.length} 个\n`)
console.log('【不可见窗口】——隐藏的占位窗口通常藏在这里')
for (const r of rows.filter((x) => !x.visible)) {
  console.log(`  hwnd=${String(r.hwnd).padEnd(10)} pid=${String(r.pid).padEnd(7)} ${r.cls.padEnd(34)} ${r.rect.padEnd(22)} "${r.title}"`)
}
console.log('\n【可见窗口】')
for (const r of rows.filter((x) => x.visible)) {
  console.log(`  hwnd=${String(r.hwnd).padEnd(10)} pid=${String(r.pid).padEnd(7)} ${r.cls.padEnd(34)} ${r.rect.padEnd(22)} "${r.title}"`)
}

const pids = [...new Set(rows.map((r) => r.pid))]
console.log(`\n涉及 PID：${pids.join(', ')}`)
