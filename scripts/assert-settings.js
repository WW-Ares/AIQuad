/**
 * 隔离实例下的设置页契约自检（替代被单实例锁挡住的官方 verify-settings.js）。
 *
 * 官方三个 verify-settings 脚本启动的是"真实配置 + 未隔离 userData"的开发实例，
 * 大王自己那份 AIQuad 一在跑，它就会被单实例锁顶掉 → 报"主窗口没起来"。
 * 这里用 --user-data-dir 起隔离实例，把页面契约在原样环境下重跑一遍。
 *
 * 用法：AIQUAD_TEST_PORT=9791 node scripts/assert-settings.js
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const Q = path.join(ROOT, '.tmp', 'appdata', 'q2')
const PORT = Number(process.env.AIQUAD_TEST_PORT || 9791)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const { CdpSession, listTargets } = require(path.join(ROOT, 'dist', 'main', 'cdp'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const real = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'aiquad', 'config.json'), 'utf8'))
  real.panes = []
  real.cacheCleanup = 'off'
  real.autoStart = false
  fs.mkdirSync(Q, { recursive: true })
  fs.writeFileSync(path.join(Q, 'config.json'), JSON.stringify(real, null, 2))

  const env = { ...process.env, AIQUAD_DISABLE_GPU: '1', AIQUAD_NO_SANDBOX: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(ELECTRON, ['--in-process-gpu', '--disable-gpu', `--user-data-dir=${Q}`, `--remote-debugging-port=${PORT}`, ROOT],
    { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  child.stderr.on('data', (d) => { err += d.toString() })

  let panel = null
  for (let i = 0; i < 60 && !panel; i++) {
    await sleep(700)
    try { panel = (await listTargets(PORT, 1)).find((t) => /main\.html/.test(t.url)) } catch {}
  }
  if (!panel) throw new Error('面板没起来\n' + err.slice(-600))
  const p = new CdpSession(panel.webSocketDebuggerUrl)
  await p.connect()
  await p.send('Runtime.evaluate', { expression: 'window.aiquad.openSettings()', returnByValue: true, awaitPromise: true })

  let set = null
  for (let i = 0; i < 40 && !set; i++) {
    await sleep(500)
    try { set = (await listTargets(PORT, 1)).find((t) => /settings\.html/.test(t.url)) } catch {}
  }
  if (!set) throw new Error('设置窗口没起来')
  await sleep(1500)
  const s = new CdpSession(set.webSocketDebuggerUrl)
  await s.connect()
  const ev = async (expr) => {
    const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '页面内异常')
    return r?.result?.value
  }

  // settings.js 里 $('id') 引用的所有 id
  const js = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.js'), 'utf8')
  const ids = [...new Set([...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]))]
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.html'), 'utf8')
  const missing = ids.filter((id) => !new RegExp(`id="${id}"`).test(html))

  const facts = await ev(`(() => {
    const head = document.querySelector('.st-head')
    const cs = getComputedStyle(head)
    const inputs = [...document.querySelectorAll('.sc-input')]
    return {
      页面id数: ${ids.length},
      缺失id: ${JSON.stringify(missing)},
      sc输入框: inputs.length,
      全只读: inputs.every(i => i.readOnly),
      宽度档按钮: document.querySelectorAll('#ratio-presets button[data-ratio]').length,
      百分比读数: (document.getElementById('ratio-val') || {}).textContent,
      标题栏高: cs.height,
      标题栏下框线: cs.borderBottomWidth + ' ' + cs.borderBottomColor,
      横向溢出: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      说明图标: document.querySelectorAll('.st-hint, [title]').length,
      卡片数: document.querySelectorAll('.st-card').length,
      每张卡头都完整: [...document.querySelectorAll('.st-card-head')].every(h => h.scrollWidth <= h.clientWidth + 1),
    }
  })()`)
  console.log(JSON.stringify(facts, null, 2))

  const ok = facts.缺失id.length === 0 && facts.sc输入框 === 4 && facts.全只读
    && facts.宽度档按钮 === 4 && /^\d+%$/.test(facts.百分比读数)
    && parseFloat(facts.标题栏下框线) > 0 && !facts.横向溢出 && facts.每张卡头都完整
  console.log(`\n【自检】${ok ? '✅ 全部通过' : '❌ 有断言不成立'}`)

  s.close(); p.close()
  try { require('../scripts/lib/process-cleanup').cleanupRun(child.pid) } catch {}
  await sleep(400)
  process.exitCode = ok ? 0 : 3
}

main().catch((e) => { console.log('失败：', String(e?.message || e)); process.exitCode = 1; setTimeout(() => process.exit(1), 300) })
