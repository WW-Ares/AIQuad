/**
 * 验证「闲置分格清理」（0.4.9）。
 *
 * 切到 1 格之后，多出来的分格窗口只是先藏起来：页面照跑、内存照占。
 * 打开设置里的开关并等到时限，这些窗口必须被真正关掉（不是隐藏）。
 *
 * 判定方法很直接：数屏幕上还能看见几个浏览器窗口。切换之后立刻数一次
 * （应该还是原来的数量 + 面板自己），等到时限之后再数一次（应该只剩 1 个分格 + 面板）。
 *
 * 用法：
 *   AIQUAD_TEST_PORT=9256 node scripts/verify-cleanup.js
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

const PORT = Number(process.env.AIQUAD_TEST_PORT || 9256)

async function main() {
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: '1',
    AIQUAD_DISABLE_GPU: process.env.AIQUAD_DISABLE_GPU || '1',
    AIQUAD_NO_SANDBOX: process.env.AIQUAD_NO_SANDBOX || '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const ud = path.join(projectRoot, '.tmp', 'ud-cleanup')
  fs.rmSync(ud, { recursive: true, force: true })
  fs.mkdirSync(ud, { recursive: true })
  // 直接把配置铺好：闲置 1 分钟就清理（下限就是这个值）
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({
    version: 5,
    layout: '4',
    paneCleanup: true,
    paneCleanupDelayMin: 1,
  }, null, 2))

  const child = spawn(electronExe, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${ud}`, projectRoot], {
    cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
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

  let pass = 0
  let fail = 0
  const check = (ok, label, extra = '') => {
    console.log(`${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`)
    ok ? pass++ : fail++
  }
  const count = () => w32.listBrowserWindows().filter((w) => w32.isWindowVisible(w.hwnd))
  /** 还活着的句柄数：区分"藏起来了"和"真的关掉了"只能看句柄还在不在 */
  const alive = (list) => list.filter((h) => w32.isWindow(h)).length

  console.log('等待四个分格都起来…')
  let peak = 0
  let all = []
  for (let i = 0; i < 60; i++) {
    await sleep(1500)
    const cur = count()
    if (cur.length > peak) all = cur.map((w) => w.hwnd)
    peak = Math.max(peak, cur.length)
    if (peak >= 5) break
  }
  check(peak >= 5, '四格布局：面板 + 4 个分格窗口都在', `可见 ${peak} 个`)
  console.log(`记下 ${all.length} 个窗口句柄，后面看它们还在不在`)

  console.log('切到单格…')
  await run(`document.querySelector('[data-layout="1"]').click(), true`)
  await sleep(6000)
  const visibleNow = count().length
  const aliveNow = alive(all)
  check(visibleNow <= 2, '视觉上只剩当前那一格', `可见 ${visibleNow} 个`)
  check(aliveNow >= peak - 1, '其余格子只是先藏起来（句柄还在，切回去不用重开）', `句柄存活 ${aliveNow} 个`)

  console.log('等 1 分钟看它会不会真的关掉…')
  await sleep(70000)
  const aliveLater = alive(all)
  check(aliveLater <= 2, '闲置到点：多余的分格窗口已被真正关掉（句柄消失）', `句柄存活 ${aliveLater} 个`)
  const cleanupLog = /\[pane\] 已清理/.test(log)
  check(cleanupLog, '主进程有清理日志')

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  cdp.close()
  cleanupRun(child.pid)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('脚本自身出错：', e)
  process.exit(2)
})
