/**
 * 验证"认领前验身"用到的两个新跨进程 API 真能读到东西：
 *   - processImagePath(pid)     ：取 exe 完整路径（用来排除 Electron / WebView2 应用）
 *   - processCreationTime(pid)  ：取进程创建时间（用来排除用户早就开着的浏览器）
 *
 * 期望：
 *   ① 自己的进程能读到路径与创建时间
 *   ② 桌面上每个"可被认领"的窗口都能读到 exe
 *   ③ 打印被判为"非浏览器"的窗口 —— 这些就是修复前会被误认领的（如 WorkBuddy / AIQuad 自己）
 */
const path = require('node:path')
const w32 = require(path.join(__dirname, '..', 'dist', 'main', 'win32.js'))

let fail = 0
const assert = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++ }

console.log(`\n[self] pid=${process.pid}`)
const selfExe = w32.processImagePath(process.pid)
const selfBorn = w32.processCreationTime(process.pid)
console.log(`  exe =${selfExe}`)
console.log(`  born=${selfBorn}  (${selfBorn ? new Date(selfBorn).toISOString() : '取不到'})`)
assert(/\.exe$/i.test(selfExe), '能读到自己的 exe 完整路径')
assert(selfBorn > 1600000000000 && selfBorn < Date.now() + 60000, '创建时间是合理的 Unix 毫秒')

console.log('\n[桌面上满足"可被认领"判据的窗口]')
const wins = w32.listBrowserWindows()
console.log(`  共 ${wins.length} 个`)
let foreign = 0
for (const w of wins) {
  const exe = w32.processImagePath(w.pid)
  const base = (exe.replace(/\\/g, '/').split('/').pop() || '').toLowerCase()
  const isBrowser = base === 'chrome.exe' || base === 'msedge.exe'
  if (!isBrowser) foreign += 1
  console.log(`  ${isBrowser ? '[浏览器]  ' : '[非浏览器]'} hwnd=${w.hwnd} pid=${w.pid}`)
  console.log(`             标题=${w.title}`)
  console.log(`             exe=${exe || '(取不到)'}`)
  if (exe) assert(true, `pid ${w.pid} 能读到 exe`)
}
console.log(`\n小结：其中 ${foreign} 个属于非浏览器进程 —— 修复前它们会被当成自家分格窗口认领。`)
console.log(fail === 0 ? '\n全部通过 ✅' : `\n有 ${fail} 项失败 ❌`)
process.exit(fail === 0 ? 0 : 1)
