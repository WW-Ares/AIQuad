/**
 * 设置页「新功能」回归：面板宽度预设 / AI 隐藏 / 缓存统计 / 代理测试不卡住。
 *
 * 为什么不并进 verify-settings.js：那边的 CDP 长连在跑完「改宽度保存」之后，
 * 再发带 awaitPromise 的 evaluate 会偶发 "CDP closed"（本机多次复现，Windows
 * 事件日志里**没有**对应的进程崩溃记录）。同一串操作用这里的一次性连接方式
 * 跑就稳定，所以把这几项拆出来单独跑。
 *
 * 覆盖的一个真 bug：save() 结尾会把 cfg 整个换成 IPC 回来的新对象，而旧写法里
 * AI 行的 handler 闭包捕获了旧对象 —— 于是"先存一次宽度，再点隐藏"改的是孤儿对象，
 * 永远不落盘。这里的顺序特意安排成「先改宽度，紧接着点隐藏」，就是为了盯住它。
 *
 * 用法：node scripts/verify-settings-extra.js
 */
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const CONFIG = path.join(process.env.APPDATA || '', 'aiquad', 'config.json')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = Number(process.env.AIQUAD_TEST_PORT || 9471)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const disk = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'))

let pass = 0
let fail = 0
function check(ok, label, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${label}${detail ? `  ${detail}` : ''}`) }
  else { fail++; console.log(`  ❌ ${label}${detail ? `  ${detail}` : ''}`) }
}

/** 轮询磁盘直到条件满足。给定长 await 的 IPC 不好指望，盯着落盘结果才准 */
async function waitDisk(pred, ms = 15000, step = 200) {
  for (let t = 0; t <= ms; t += step) {
    try { if (pred(disk())) return { ok: true, waited: t, cfg: disk() } } catch {}
    await sleep(step)
  }
  return { ok: false, waited: ms, cfg: disk() }
}

async function main() {
  if (!fs.existsSync(CONFIG)) { console.log('找不到配置文件，先手动启动一次应用'); return }
  const backup = fs.readFileSync(CONFIG, 'utf8')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`, ROOT], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d.toString() })
  child.stderr.on('data', (d) => { log += d.toString() })

  const { CdpSession, listTargets } = require(path.join(ROOT, 'dist', 'main', 'cdp'))
  const evalIn = async (c, expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed')
    return r.result.value
  }

  console.log(`=== 设置页新功能回归（${PORT}）===\n`)

  let panel
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try { panel = (await listTargets(PORT, 1)).find((t) => t.type === 'page' && /main\.html/.test(t.url)); if (panel) break } catch {}
  }
  if (!panel) { console.log('面板没起来，放弃'); child.kill(); cleanup(); return }

  const cdp = new CdpSession(panel.webSocketDebuggerUrl)
  await cdp.connect()
  await evalIn(cdp, `window.aiquad.openSettings()`)

  let setting
  for (let i = 0; i < 30; i++) {
    await sleep(400)
    try { setting = (await listTargets(PORT, 1)).find((t) => t.type === 'page' && /settings\.html/.test(t.url)); if (setting) break } catch {}
  }
  if (!setting) { console.log('设置窗口没起来，放弃'); cdp.close(); child.kill(); cleanup(); return }

  const s = new CdpSession(setting.webSocketDebuggerUrl)
  await s.connect()
  const ev = (expr) => evalIn(s, expr)

  /* ---------- 代理测试不能卡住 ---------- */
  console.log('\n[代理连通性测试不会一直"测试中"]')
  await ev(`(async () => {
    document.getElementById('proxy-mode').value = 'custom'
    document.getElementById('proxy-type').value = 'http'
    document.getElementById('proxy-host').value = '127.0.0.1'
    document.getElementById('proxy-port').value = '1'
    document.getElementById('btn-test-proxy').click()
    return 1
  })()`)
  let resultText = '测试中…'
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    resultText = await ev(`document.getElementById('proxy-result')?.textContent`)
    if (resultText && resultText !== '测试中…') break
  }
  check(resultText !== '测试中…', '一定会出结论', `${resultText}`)
  check(/失败|通过/.test(resultText || ''), '给出明确结论而非空白')
  const btnDisabled = await ev(`document.getElementById('btn-test-proxy')?.disabled`)
  check(btnDisabled === false, '按钮恢复可用')

  /* ---------- 面板宽度预设 ---------- */
  console.log('[面板宽度预设]')
  const presetUi = await ev(`(() => {
    const btn = document.querySelector('#ratio-presets button[data-ratio="40"]')
    if (!btn) return { err: 'HTML 里没有预设按钮' }
    btn.click()
    return {
      label: document.getElementById('ratio-val').textContent,
      px: document.getElementById('ratio-px').textContent,
      active: btn.classList.contains('active'),
    }
  })()`)
  check(presetUi?.label === '40%', '点预设后界面立刻变 40%', `label=${presetUi?.label}`)
  check(/约 \d+ px/.test(presetUi?.px || ''), '给出实际像素估算', presetUi?.px)
  check(presetUi?.active === true, '按钮呈选中态')
  const r1 = await waitDisk((c) => Math.round((c.windowWidthRatio || 0) * 100) === 40)
  check(r1.ok, '写进 config.json', `耗时 ${r1.waited}ms`)

  /* ---------- AI 隐藏：紧跟在一次保存之后（盯的正是那个闭包 bug）---------- */
  console.log('\n[AI 隐藏 / 显示]')
  await ev(`(() => { document.querySelector('#ai-rows tr td.ops button')?.click(); return 1 })()`)
  const r2 = await waitDisk((c) => c.aiList?.some((a) => a.hidden))
  check(r2.ok, '刚存完宽度，紧接着点隐藏也能落盘', `耗时 ${r2.waited}ms`)
  check(r2.cfg?.aiList?.filter((a) => a.hidden).length === 1, '只隐藏了这一个')
  check(r2.cfg?.aiList?.length === disk().aiList.length, '不丢条目')
  const flipped = await ev(`document.querySelector('#ai-rows tr td.ops button')?.textContent`)
  check(flipped === '显示', '按钮文案翻成"显示"', `实际=${flipped}`)
  const rowClass = await ev(`document.querySelector('#ai-rows tr')?.className`)
  check(rowClass === 'ai-hidden', '隐藏行有压暗标记', `class=${rowClass}`)

  await ev(`(() => { document.querySelector('#ai-rows tr td.ops button')?.click(); return 1 })()`)
  const r3 = await waitDisk((c) => !c.aiList?.some((a) => a.hidden))
  check(r3.ok, '再点一次恢复可见', `耗时 ${r3.waited}ms`)

  /* ---------- 缓存统计 ---------- */
  console.log('\n[浏览器档案缓存统计]')
  const cache = await ev(`(async () => {
    await loadCacheStats()
    const s = await window.aiquad.getCacheStats()
    return {
      p: s.profileCount, cache: s.cacheBytes, total: s.totalBytes,
      text: document.getElementById('cache-stat')?.textContent,
      mode: document.getElementById('cache-mode')?.value,
    }
  })()`)
  check(Number.isFinite(cache?.cache), '拿到可清理体积', `${cache?.cache} 字节`)
  check((cache?.p ?? 0) >= 1, '扫到至少一份档案', `共 ${cache?.p} 份，合计 ${cache?.total}`)
  check(/可清理缓存/.test(cache?.text || ''), '界面显示可读文案', cache?.text)
  check(!!cache?.mode, '清理模式下拉有值', cache?.mode)

  /* ---------- 收尾 ---------- */
  console.log('\n[收尾]')
  check(!/uncaught|UnhandledPromiseRejection/i.test(log), '主进程日志没有未捕获异常')

  fs.writeFileSync(CONFIG, backup, 'utf8')
  console.log('原始配置已还原')
  s.close(); cdp.close()
  child.kill()
  // 故意不调 killTree：它的 taskkill /F /T 在受限环境里会挂住不返回。
  // 这里已经 child.kill()，浏览器进程由 Electron 主进程退出时自行回收。
  await sleep(400)

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
  if (fail) process.exitCode = 1
}

main().catch((e) => { console.log('脚本异常:', String(e?.message || e)); process.exitCode = 1 })
