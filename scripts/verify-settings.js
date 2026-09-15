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
// 端口必须可配：写死时若上一个实例还没退干净，新实例绑不上端口，
// 脚本就会连到半死的那个目标上，报出"设置窗口没起来"这种假故障。
const PORT = Number(process.env.AIQUAD_TEST_PORT || 9231)

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

/**
 * 轮询磁盘上的 config.json 直到满足条件。
 *
 * 为什么不能简单睡几百毫秒：保存链路里带着 `await syncInstances()`，
 * 而前面的用例刚翻过"登录态共享"，那会先把浏览器实例全杀掉再重启，
 * 几百毫秒根本排不上队。盯着真实落盘的结果才靠谱。
 */
/**
 * 上限给到 20 秒：前面翻过"登录态共享"会先杀掉浏览器实例再重启，
 * 后一次 save-config 会排在这条重启链后面，几秒钟不一定轮得上。
 * 宁可多等一会儿也不要误报"功能坏了"。
 */
async function waitConfig(predicate, ms = 20000, step = 200) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < ms) {
    try {
      last = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
      if (predicate(last)) return { ok: true, cfg: last, waited: Date.now() - t0 }
    }
    catch {}
    await sleep(step)
  }
  return { ok: false, cfg: last, waited: Date.now() - t0 }
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

  /**
   * "AI 隐藏"这一组用例的前提是**起跑时没有隐藏项**。
   *
   * 上一轮跑失败时配置里可能留下 `hidden`，于是"只隐藏了这一个"必然不成立，
   * 而"再点一次恢复可见"会去点第一行（那行并没有被隐藏），永远等不到"没有隐藏项"，
   * 失败就这么一轮一轮传染下去 —— 连收尾还原都会把那个残留再写回去。
   * 所以起跑前清一次，并且**以清过的这份作为还原基线**。
   */
  let baseline = original
  if (origCfg.aiList?.some((a) => a.hidden)) {
    const clean = { ...origCfg, aiList: origCfg.aiList.map((a) => ({ ...a, hidden: false })) }
    baseline = JSON.stringify(clean, null, 2)
    fs.writeFileSync(CONFIG, baseline, 'utf8')
    console.log('（起跑前清掉了遗留的 hidden 标记，收尾也按这份还原）')
  }

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
    const evaluate = async (expression, timeoutMs = 30000) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs)
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

    /* ---------- 4. 面板宽度预设 / AI 隐藏 / 缓存统计 / 代理测试 ---------- */

    console.log('\n[面板宽度预设]')
    // 这里**只做 DOM**，不在 evaluate 里 await 任何 IPC。
    // 刚刚那次 save 会连带 syncInstances，IPC 一旦排队，awaitPromise 会一直悬着，
    // CDP 侧超时表现为 "CDP closed" —— 看起来像进程崩了，其实没有。
    // 配置有没有写进去交给下面的 waitConfig 盯磁盘，那才是准的。
    const preset = await evaluate(`(async () => {
      const btn = document.querySelector('#ratio-presets button[data-ratio="40"]')
      if (!btn) return { err: 'HTML 里找不到预设按钮' }
      btn.click()
      // 只等一帧：界面必须**立刻**反映点击，不能等 IPC 回来
      await new Promise((r) => setTimeout(r, 60))
      return {
        label: document.getElementById('ratio-val').textContent,
        active: btn.classList.contains('active'),
      }
    })()`)
    check(preset?.label === '40%', '点预设后界面立刻显示 40%', `label=${preset?.label}`)
    check(preset?.active === true, '预设按钮立刻呈选中态')
    const presetDisk = await waitConfig((c) => Math.round((c.windowWidthRatio || 0) * 100) === 40)
    check(presetDisk.ok, '预设写进 config.json', `耗时 ${presetDisk.waited}ms，磁盘值=${presetDisk.cfg?.windowWidthRatio}`)

    console.log('\n[AI 隐藏 / 显示]')
    await evaluate(`(() => {
      document.querySelector('#ai-rows tr td.ops button')?.click()
      return true
    })()`)
    const hiddenDisk = await waitConfig((c) => c.aiList?.some((a) => a.hidden))
    check(hiddenDisk.ok, '点"隐藏"后配置里出现 hidden 项', `耗时 ${hiddenDisk.waited}ms`)
    check(hiddenDisk.cfg?.aiList?.filter((a) => a.hidden).length === 1, '只隐藏了这一个')
    const btnText = await evaluate(`document.querySelector('#ai-rows tr td.ops button')?.textContent`)
    check(btnText === '显示', '按钮文案翻成"显示"', `实际=${btnText}`)
    const dimmed = await evaluate(`document.querySelector('#ai-rows tr')?.className`)
    check(dimmed === 'ai-hidden', '隐藏的行被压暗标记', `class=${dimmed}`)

    // 再点一次还原。轮询到这里才准，因为这一趟也要压过实例重启
    await evaluate(`(() => { document.querySelector('#ai-rows tr td.ops button')?.click(); return true })()`)
    const restoreDisk = await waitConfig((c) => !c.aiList?.some((a) => a.hidden))
    check(restoreDisk.ok, '再点一次恢复可见', `耗时 ${restoreDisk.waited}ms`)
    check(restoreDisk.cfg?.aiList?.length === hiddenDisk.cfg?.aiList?.length, '隐藏/显示都不丢条目')

    console.log('\n[缓存统计]')
    const cache = await evaluate(`(async () => {
      await loadCacheStats()
      const s = await window.aiquad.getCacheStats()
      return {
        text: document.getElementById('cache-stat').textContent,
        detail: document.getElementById('cache-detail').textContent.slice(0, 80),
        profiles: s.profileCount,
        cacheBytes: s.cacheBytes,
        totalBytes: s.totalBytes,
        mode: document.getElementById('cache-mode').value,
      }
    })()`)
    check(typeof cache?.cacheBytes === 'number' && cache.cacheBytes >= 0, '拿到缓存体积', `可清理 ${cache?.cacheBytes}`)
    check(cache?.profiles >= 1, '扫到至少一份浏览器档案', `共 ${cache?.profiles} 份，合计 ${cache?.totalBytes}`)
    check(/可清理缓存/.test(cache?.text || ''), '界面显示可读的体积文案', cache?.text)
    check(!!cache?.detail, '显示分档案明细', cache?.detail)
    check(!!cache?.mode, '自动清理下拉有值', cache?.mode)

    console.log('\n[代理连通性测试不会卡住]')
    const pt = await evaluate(`(async () => {
      document.getElementById('proxy-mode').value = 'custom'
      document.getElementById('proxy-host').value = '127.0.0.1'
      document.getElementById('proxy-port').value = '65531'
      document.getElementById('proxy-test-url').value = 'https://www.google.com'
      const t0 = Date.now()
      document.getElementById('btn-test-proxy').click()
      const el = document.getElementById('proxy-result')
      let waited = 0
      while (waited < 14000 && /测试中/.test(el.textContent)) {
        await new Promise((r) => setTimeout(r, 200)); waited = Date.now() - t0
      }
      return { waited, text: el.textContent, cls: el.className, disabled: document.getElementById('btn-test-proxy').disabled }
    })()`)
    check(!/测试中/.test(pt?.text || ''), '测试一定有结论（不再停在"测试中…"）', `${pt?.waited}ms 后="${pt?.text}"`)
    check(/失败|出错/.test(pt?.text || '') && pt?.cls === 'result err', '端口不通时给出失败原因', pt?.text)
    check(pt?.disabled === false, '测试结束后按钮恢复可用')

    /* ---------- 5. 登录态共享开关 ----------
     *
     * 放最后：改它会先把浏览器实例全杀掉再重启，后面的存盘请求统统要排队，
     * 插在别的用例前面会让它们集体超时，看着像一堆功能坏了。
     */
    console.log('\n[登录态共享开关]')
    const flipped = !(origCfg.sharedSession !== false)
    await evaluate(`(() => { const c = document.getElementById('opt-shared'); c.checked = ${flipped}; save(false); return c.checked })()`)
    const sharedDisk = await waitConfig((c) => (c.sharedSession !== false) === flipped)
    check(sharedDisk.ok, 'sharedSession 写入成功', `磁盘值=${sharedDisk.cfg?.sharedSession} 期望=${flipped}`)

    if (/uncaught|A JavaScript error occurred/i.test(log)) {
      check(false, '主进程日志里没有未捕获异常', log.slice(-400))
    }
    else {
      check(true, '主进程日志里没有未捕获异常')
    }
  }
  catch (e) {
    check(false, '测试执行', String(e?.message || e))
    // 断连 / 崩溃时把主进程最后的输出打出来，否则只能看到一个没有解释的 CDP closed
    console.log('--- 主进程日志尾部 ---')
    console.log(log.split('\n').slice(-25).join('\n'))
  }
  finally {
    try { cdp?.close() } catch {}
    // ⚠️ 必须杀进程树：留一个宿主进程活着就会占住单实例锁，
    // 之后所有启动都会 `requestSingleInstanceLock()===false` → 静默退出、连窗口都没有
    cleanupRun(child.pid)
    await sleep(1200)
    // 还原用户原本的配置
    try {
      fs.writeFileSync(CONFIG, baseline, 'utf8')
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
