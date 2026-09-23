/**
 * 验证「甲方案」= 命令行判据：
 *   `--user-data-dir` 落在本应用档案根下 → 是我们启动的浏览器；
 *   命令行里没有这个目录（哪怕 exe 一模一样）→ 不是我们的，必须拒绝认领。
 *
 * 做法：起一个**隔离 userData** 的 AIQuad 实例（跑真实的 spawn + 认领流程，它会自己去起
 * 浏览器），拿到真实进程后做下列断言。两条独立通道交叉验证 PEB 读法没读歪：
 *   通道 A：browserPidsUnder()        —— 项目工具，走 WMI 读命令行
 *   通道 B：w32.processCommandLine()  —— 产品代码，走 PEB + ReadProcessMemory
 *
 * ⚠️ 「大王自己开的 Chrome」在沙箱里没法直接构造（直接 spawn chrome.exe 会被沙箱吞掉），
 * 但判据只关心"udd 是否落在给定根下"，所以用**假档案根**做逻辑等价的模拟。
 */
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const CHROME_GUESS = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const UDD = path.join(os.tmpdir(), `aiquad-claim-${Date.now()}`)
const PROFILES = path.join(UDD, 'profiles')
const LOG_FILE = path.join(__dirname, 'claim-cmdline-app.log')

const w32 = require(path.join(ROOT, 'dist', 'main', 'win32'))
const { InstanceManager } = require(path.join(ROOT, 'dist', 'main', 'instance-manager'))
const { browserPidsUnder, killBrowsersUnder } = require(path.join(ROOT, 'scripts', 'lib', 'process-cleanup'))

const sleep = ms => new Promise(r => setTimeout(r, ms))
let failures = 0
function check(name, actual, expected, note) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  console.log(`     期望=${expected}  实际=${actual}${note ? '   ' + note : ''}`)
}

/** 假实例：只借产品代码的方法，不跑构造函数（免得挂上 30ms 巡检定时器） */
function fakeRoot(profilesRoot) {
  const f = Object.create(InstanceManager.prototype)
  f.opts = { profilesRoot, browser: { exePath: '' } }
  return f
}

const uddOf = cl => {
  const m = /--user-data-dir=(?:"([^"]*)"|([^\s"]*))/i.exec(cl || '')
  return m ? (m[1] ?? m[2] ?? '') : ''
}

async function main() {
  fs.mkdirSync(PROFILES, { recursive: true })
  fs.writeFileSync(path.join(UDD, 'config.json'), JSON.stringify({
    version: 6,
    layout: '1',
    panes: [{ id: 'p1', aiId: 'probe' }],
    aiList: [{
      id: 'probe', name: 'Probe', url: 'about:blank', category: 'cn',
      logo: 'qwen.png', proxyMode: 'direct', builtin: true,
    }],
    cacheCleanup: 'off',
    // 强制指定浏览器，排除"探测不到浏览器"这个混淆因素
    browserPreference: 'chrome',
    customBrowserPath: CHROME_GUESS,
    shortcuts: { toggleFloat: 'Alt+Space', layout1: '', layout2: '', layout4: '' },
  }))
  console.log('隔离 userData :', UDD)
  console.log('档案根        :', PROFILES)
  console.log('强制浏览器    :', CHROME_GUESS, fs.existsSync(CHROME_GUESS) ? '(存在)' : '(不存在!)')
  console.log('')

  const env = { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' }
  delete env.ELECTRON_RUN_AS_NODE // 沙箱注入这个会让 electron 跑成纯 node

  const child = spawn(ELECTRON, [ROOT, `--user-data-dir=${UDD}`, '--in-process-gpu', '--disable-gpu'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let appLog = ''
  child.stdout.on('data', d => { appLog += d.toString() })
  child.stderr.on('data', d => { appLog += d.toString() })
  console.log('隔离实例 pid  :', child.pid)

  console.log('--- 等隔离实例 spawn 浏览器 ---')
  let pids = []
  for (let i = 0; i < 40; i++) {
    await sleep(1000)
    pids = browserPidsUnder(PROFILES)
    if (pids.length) break
    if (child.exitCode !== null) { console.log('  ⚠️ 实例提前退出 exitCode=', child.exitCode); break }
  }
  console.log('  浏览器进程 pid :', pids.join(', ') || '(没起来)')
  console.log('')

  /* ---------- 被测样本 1：真实浏览器窗口进程（理想样本） ---------- */
  const bp = pids[0]
  if (bp) {
    const cl = w32.processCommandLine(bp)
    const got = uddOf(cl)
    const same = path.normalize(got).toLowerCase().startsWith(path.normalize(PROFILES).toLowerCase())
    console.log('===== 通道交叉验证 =====')
    console.log('  通道B（PEB + ReadProcessMemory）读出的 udd :', got)
    console.log('  通道A（WMI）据以找到它的判据目录          :', PROFILES)
    console.log(`  ${same ? '✅ 两条通道一致（PEB 读法没读歪）' : '❌ 两条通道不一致'}`)
    if (!same) failures++
    console.log('  通道B 读到的完整命令行 :', JSON.stringify(cl.slice(0, 300)))
    console.log('')

    console.log('===== 判据测试（样本：真实浏览器窗口进程）=====')
    const exe = w32.processImagePath(bp)
    console.log('  被测对象 exe :', exe)
    check('① 真档案根 → true（自家窗口认得出来，不能误伤）',
      fakeRoot(PROFILES).commandLineIsOurs(bp), true)
    check('② 假档案根（模拟"用户自己开的同 exe 浏览器"）→ false',
      fakeRoot(path.join(UDD, 'other-profiles')).commandLineIsOurs(bp), false, '← 甲方案的核心断言')
    check('③ 前缀陷阱：档案根比 udd 更深一层 → false',
      fakeRoot(path.join(PROFILES, 'shared', 'Default')).commandLineIsOurs(bp), false)
    check('④ 负向对照：修复前只看 exe → 会把它当自家窗口（证明这条缝真实存在）',
      fakeRoot(PROFILES).isBrowserExe(exe), true)
    console.log('')
  }
  else {
    console.log('⚠️ 真实浏览器没能起来，①②③④ 改由下面的 Electron 样本代偿')
    console.log('')
  }

  /* ---------- 被测样本 2：AIQuad 自己的 Electron 进程（它也带 --user-data-dir） ---------- */
  if (child.exitCode === null) {
    const aqCl = w32.processCommandLine(child.pid)
    console.log('===== 判据测试（样本：AIQuad 主进程，Electron 也带 udd）=====')
    console.log('  它的 exe        :', w32.processImagePath(child.pid))
    console.log('  它的 udd        :', JSON.stringify(uddOf(aqCl)))
    check('⑤ 以隔离 userData 为档案根 → true（认得出"udd 落在这个根下"）',
      fakeRoot(UDD).commandLineIsOurs(child.pid), true)
    check('⑥ Electron 排他性：udd 比档案根少一层 → false',
      fakeRoot(PROFILES).commandLineIsOurs(child.pid), false)
    check('⑦ 外来模拟：档案根是另一个目录 → false',
      fakeRoot(path.join(UDD, 'elsewhere')).commandLineIsOurs(child.pid), false)
    console.log('')
  }

  /* ---------- 判据边界测试：直接喂"大王自己开的 Chrome"的真实命令行形态 ----------
   * 沙箱里起不来真实 chrome.exe（直接被吞），但判据只比对字符串，所以把
   * w32.processCommandLine 换掉、塞进**真实抓到的命令行形态**（2026-09-23 进程快照），
   * 让产品代码本身跑一遍 —— 这比起真进程还能覆盖边界。
   * ⚠️ CommonJS 模块缓存共享，改 win32 模块的导出属性，instance-manager 里看到的是同一个。
   */
  console.log('===== 判据边界测试（喂真实形态的命令行）=====')
  const win32mod = require(path.join(ROOT, 'dist', 'main', 'win32'))
  const REAL_ROOT = path.join(process.env.APPDATA, 'aiquad', 'profiles')
  const realPCL = win32mod.processCommandLine
  const withCmdLine = (cmd, fn) => {
    win32mod.processCommandLine = () => cmd
    try { return fn() } finally { win32mod.processCommandLine = realPCL }
  }
  const EXE = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'
  const SW = '--profile-directory=Default --remote-debugging-port=0 --no-first-run'
  const clOwn = `${EXE} --user-data-dir=C:\\Users\\Administrator\\AppData\\Roaming\\aiquad\\profiles\\shared ${SW}`
  const clUser = `${EXE} ${SW} https://www.google.com/` // 用户自己开的：没有 --user-data-dir
  const clQuote = `${EXE} --user-data-dir="C:\\Users\\Administrator\\AppData\\Roaming\\aiquad\\profiles\\p1_deepseek" ${SW}`
  const clSibling = `${EXE} --user-data-dir=C:\\Users\\Administrator\\AppData\\Roaming\\aiquad\\profiles2\\shared ${SW}`
  const fReal = fakeRoot(REAL_ROOT)
  console.log('  档案根:', REAL_ROOT)
  check('⑧ 自家浏览器（udd 落在档案根下）→ true',
    withCmdLine(clOwn, () => fReal.commandLineIsOurs(1)), true)
  check('⑨ ★ 大王自己开的 Chrome（命令行没有 --user-data-dir）→ false',
    withCmdLine(clUser, () => fReal.commandLineIsOurs(1)), false, '← 正是大王问的那个场景')
  check('⑩ 带引号的 udd 也要能解析 → true',
    withCmdLine(clQuote, () => fReal.commandLineIsOurs(1)), true)
  check('⑪ 兄弟目录 profiles2（前缀相似）→ false',
    withCmdLine(clSibling, () => fReal.commandLineIsOurs(1)), false)
  check('⑫ 读不到命令行 → null（不表态，退回旧判据，不能误伤自家）',
    withCmdLine('', () => fReal.commandLineIsOurs(1)), null)
  check('⑬ 负向对照：修复前只看 exe，上面那个外来窗口会被判成"自家的"',
    withCmdLine(clUser, () => fReal.isBrowserExe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')), true)
  console.log('')

  /* ---------- 回归：新判据不能把自家窗口挡在门外 ---------- */
  console.log('===== 回归检查 =====')
  console.log('  应用日志（末尾 40 行）:')
  const lines = appLog.split(/\r?\n/).filter(Boolean)
  console.log(lines.slice(-40).map(l => '    ' + l).join('\n') || '    (无输出)')
  try { fs.writeFileSync(LOG_FILE, appLog) ; console.log('    （完整日志 -> ' + LOG_FILE + '）') } catch {}

  /* ---------- 清理 ---------- */
  console.log('')
  console.log('===== 清理 =====')
  try { execFileSync('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) }
  catch {}
  await sleep(1200)
  const n = killBrowsersUnder(PROFILES)
  await sleep(800)
  const left = browserPidsUnder(PROFILES)
  console.log(`  killTree 后按档案目录补清 ${n} 个；残留: ${left.join(', ') || '(无)'}`)
  console.log('  隔离实例 :', child.exitCode === null ? '仍活着 ❌' : '已退出 ✅')

  console.log('')
  console.log(failures === 0 ? '【判定】✅ 全部通过' : `【判定】❌ ${failures} 项不符`)
  try { fs.rmSync(UDD, { recursive: true, force: true }) } catch {}
  process.exit(failures === 0 ? 0 : 3)
}

main().catch(e => { console.log('失败：', String((e && e.stack) || e)); process.exit(1) })
