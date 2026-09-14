/**
 * 设置页端到端验证：启动真实应用 → 打开设置窗口 → 在**真实页面**里跑
 * `collect()` / `save()` → 回读磁盘上的 config.json。
 *
 * 为什么必须这么做：设置页曾经"改了没反应"——`settings.js` 读了一个 HTML 里
 * 不存在的 `#opt-shared`，`null.checked` 抛 TypeError 把 `collect()` 打断，
 * 于是**保存时任何一项都不生效**，界面上还一点报错都没有。
 * 只看代码看不出来，必须真的点一次保存。
 *
 * 覆盖：
 *   1) settings.js 引用的每个 id 在 HTML 里都存在（防止再次出现缺元素）
 *   2) collect() 不抛异常
 *   3) 调整"面板宽度"后 save() 报告成功，且 config.json 里真的变了
 *   4) 开关"登录态共享"能写进配置
 *   5) 保存过程中没有未捕获异常
 *
 * 用法：node scripts/verify-settings.js
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { cleanupRun } = require('./lib/process-cleanup')

const ROOT = path.join(__dirname, '..')
const CONFIG = path.join(process.env.APPDATA || '', 'aiquad', 'config.json')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9231

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(ok, label, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✅ ${label}${detail ? `  ${detail}` : ''}`)
  }
  else {
    fail++
    console.log(`  ❌ ${label}${detail ? `  ${detail}` : ''}`)
  }
}

/** settings.js 里引用的所有 id（从源码提取，保证与实际代码同步） */
function referencedIds() {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.js'), 'utf8')
  return [...new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))]
}

async function cdpTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return r.json()
}

async function main() {
  console.log('=== 设置页保存链路 验证 ===\n')

  const original = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : null
  if (!original) {
    console.log(`找不到配置文件 ${CONFIG}，请先运行一次应用`)
    process.exit(1)
  }
  const origCfg = JSON.parse(original)
  // 挑一个一定和原值不同的目标比例
  const origPct = Math.round((origCfg.windowWidthRatio || 0.3) * 100)
  const targetPct = origPct >= 45 ? 35 : 45

  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`, ROOT], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d.toString() })
  child.stderr.on('data', (d) => { log += d.toString() })
  child.on('exit', (c) => { log += `\n[退出 code=${c}]\n` })

  let cdp = null
  try {
    console.log(`启动应用（${PORT}），等待主窗口…`)
    let mainTarget = null
    for (let i = 0; i < 40 && !mainTarget; i++) {
      await sleep(700)
      try {
        mainTarget = (await cdpTargets()).find((t) => /main\.html/.test(t.url))
      }
      catch {}
    }
    if (!mainTarget) throw new Error('主窗口没起来')

    const { CdpSession } = require('../dist/main/cdp')

    // 通过主窗口暴露的 API 打开设置窗口（与用户点"设置"按钮同一条链路）
    const mainConn = new CdpSession(mainTarget.webSocketDebuggerUrl)
    await mainConn.connect()
    await mainConn.send('Runtime.evaluate', { expression: 'window.aiquad.openSettings()' })
    mainConn.close()

    console.log('等待设置窗口…')
    let setTarget = null
    for (let i = 0; i < 30 && !setTarget; i++) {
      await sleep(500)
      try {
        setTarget = (await cdpTargets()).find((t) => /settings\.html/.test(t.url))
      }
      catch {}
    }
    if (!setTarget) throw new Error('设置窗口没起来')

    cdp = new CdpSession(setTarget.webSocketDebuggerUrl)
    await cdp.connect()
    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '页面内异常')
      return r?.result?.value
    }

    /* ---------- 1. 元素完整性 ---------- */
    console.log('\n[元素完整性]')
    const ids = referencedIds()
    const missing = await evaluate(
      `(${JSON.stringify(ids)}).filter(id => !document.getElementById(id))`,
    )
    check(Array.isArray(missing) && missing.length === 0,
      `settings.js 引用的 ${ids.length} 个 id 在 HTML 里全部存在`,
      missing && missing.length ? `缺失：${missing.join(', ')}` : '')
    const radioOk = await evaluate(`!!document.querySelector('input[name="position"]:checked')`)
    check(radioOk === true, '停靠位置有选中项')

    /* ---------- 2. collect() 不抛异常 ---------- */
    console.log('\n[collect() 健壮性]')
    const collectOk = await evaluate(`(() => { try { const c = collect(); return { ok: true, ratio: c.windowWidthRatio, shared: c.sharedSession } } catch (e) { return { ok: false, err: String(e) } } })()`)
    check(collectOk?.ok === true, 'collect() 不抛异常', collectOk?.ok ? `ratio=${collectOk.ratio} shared=${collectOk.shared}` : `错误：${collectOk?.err}`)

    /* ---------- 3. 改"面板宽度"并保存 ---------- */
    console.log(`\n[保存面板宽度] ${origPct}% → ${targetPct}%`)
    await evaluate(`(() => { const r = document.getElementById('ratio'); r.value = ${targetPct}; r.dispatchEvent(new Event('input')); return r.value })()`)
    const labelText = await evaluate(`document.getElementById('ratio-val').textContent`)
    check(labelText === `${targetPct}%`, '滑块数字标签跟随更新', `label=${labelText}`)

    const saved = await evaluate(`(async () => { try { await save(true); return { ok: true, msg: document.getElementById('save-result').textContent } } catch (e) { return { ok: false, err: String(e) } } })()`)
    check(saved?.ok === true, 'save() 未抛异常', saved?.msg ? `提示="${saved.msg}"` : `错误：${saved?.err}`)
    check(saved?.msg === '已保存并应用', '界面给出"已保存并应用"', `实际="${saved?.msg}"`)

    await sleep(600)
    const after = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
    check(Math.round(after.windowWidthRatio * 100) === targetPct,
      'config.json 里 windowWidthRatio 真的变了',
      `磁盘值=${after.windowWidthRatio} 期望=${targetPct / 100}`)

    /* ---------- 4. 登录态共享开关 ---------- */
    console.log('\n[登录态共享开关]')
    const flipped = !(after.sharedSession !== false)
    await evaluate(`(() => { const c = document.getElementById('opt-shared'); c.checked = ${flipped}; save(false); return c.checked })()`)
    await sleep(900)
    const after2 = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
    check(after2.sharedSession === flipped, 'sharedSession 写入成功', `磁盘值=${after2.sharedSession} 期望=${flipped}`)

    /* ---------- 5. 主进程有没有崩 ---------- */
    if (/uncaught|A JavaScript error occurred/i.test(log)) {
      check(false, '主进程日志里没有未捕获异常', log.slice(-400))
    }
    else {
      check(true, '主进程日志里没有未捕获异常')
    }
  }
  catch (e) {
    check(false, '测试执行', String(e?.message || e))
  }
  finally {
    try { cdp?.close() } catch {}
    // ⚠️ 必须杀进程树：留一个宿主进程活着就会占住单实例锁，
    // 之后所有启动都会 `requestSingleInstanceLock()===false` → 静默退出、连窗口都没有
    cleanupRun(child.pid)
    await sleep(1200)
    // 还原用户原本的配置
    try {
      fs.writeFileSync(CONFIG, original, 'utf8')
      console.log('\n（已还原原始配置）')
    }
    catch {}
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
