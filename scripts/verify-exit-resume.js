/**
 * 验证「退出前先解冻」（0.4.9）。
 *
 * 现场：`suspend()` 是拿 `NtSuspendProcess` 把浏览器进程的所有线程停住的。
 * 这种进程连消息泵都停了，发给它窗口的 `WM_CLOSE` 会一直排在队列里没人处理，
 * 于是 `killAll()` 只能等兜底超时再强杀，退出时该落盘的 Cookie / Local Storage 就有丢的风险。
 *
 * 这里不碰"退出"这条链路本身（托盘菜单里的退出没法从自动化里点），直接验证它依赖的
 * 那个事实：**挂起的进程收不到 WM_CLOSE，解冻后就能正常退出**。
 *
 * 用法：
 *   AIQUAD_TEST_PORT=9259 node scripts/verify-exit-resume.js
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const w32 = require('../dist/main/win32')
const { cleanupRun } = require('./lib/process-cleanup')

const projectRoot = path.join(__dirname, '..')
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT = Number(process.env.AIQUAD_TEST_PORT || 9259)

/** 进程是否还活着（0 信号只是探活，不会杀掉它） */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function main() {
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
    AIQUAD_DISABLE_GPU: process.env.AIQUAD_DISABLE_GPU || '1',
    AIQUAD_NO_SANDBOX: process.env.AIQUAD_NO_SANDBOX || '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const ud = path.join(projectRoot, '.tmp', 'ud-exit-resume')
  fs.rmSync(ud, { recursive: true, force: true })
  fs.mkdirSync(ud, { recursive: true })
  // 独立档案（每条一个进程）+ 开启休眠，才能真的挂起某个分格的进程
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({
    version: 5,
    layout: '4',
    sharedSession: false,
    hibernateBackground: true,
    paneCleanup: false,
  }, null, 2))

  const child = spawn(electronExe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`, projectRoot], {
    cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d.toString() })
  child.stderr.on('data', (d) => { log += d.toString() })

  let pass = 0
  let fail = 0
  const check = (ok, label, extra = '') => {
    console.log(`${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`)
    ok ? pass++ : fail++
  }

  console.log('等待四个分格都起来…')
  let wins = []
  for (let i = 0; i < 60; i++) {
    await sleep(1500)
    wins = w32.listBrowserWindows().filter((w) => w32.isWindowVisible(w.hwnd))
    if (wins.length >= 4) break
  }
  check(wins.length >= 4, '四格布局：4 个分格窗口都在', `可见 ${wins.length} 个`)
  if (wins.length < 4) {
    console.log(log.slice(-1500))
    cleanupRun(child.pid)
    process.exit(1)
  }

  // 取一个"进程独立"的分格：同一 pid 只留一个，避免拿到的其实是共享进程
  const pids = [...new Set(wins.map((w) => w.pid))].filter((p) => p && p !== child.pid)
  check(pids.length >= 2, '独立档案模式下每个分格各有一个浏览器进程', `pid=${pids.join(',')}`)

  const victimPid = pids[0]
  const victim = wins.find((w) => w.pid === victimPid)
  console.log(`\n拿 pid=${victimPid}（hwnd=${victim.hwnd}）做实验\n`)

  /* ---------- 1. 挂起后发 WM_CLOSE：应该收不到 ---------- */
  check(w32.suspendProcess(victimPid), '进程已被挂起（休眠）')
  await sleep(300)
  w32.postClose(victim.hwnd)
  await sleep(2500)
  check(alive(victimPid), '挂起状态下 WM_CLOSE 无人处理，进程还活着 ← 这正是原来的 bug')

  /* ---------- 2. 解冻后：应该正常退出 ---------- */
  check(w32.resumeProcess(victimPid), '进程已解冻（退出前 resumeAll 做的就是这个）')
  let exited = false
  for (let i = 0; i < 30; i++) {
    await sleep(200)
    if (!alive(victimPid)) { exited = true; break }
  }
  check(exited, '解冻之后浏览器走完自己的退出流程，进程正常结束')

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  cleanupRun(child.pid)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
