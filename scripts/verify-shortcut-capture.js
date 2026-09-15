/**
 * 快捷键「抓取」控件 端到端验证。
 *
 * 覆盖：
 *   1) 四个快捷键输入框都是 readonly，并已被抓取控件接管（有 dataset.acc）
 *   2) 聚焦后进入录制态（value 变成提示文案、带 recording 类）
 *   3) 按下 Ctrl+Alt+K → 自动抓取并规范化
 *   4) 顺序乱的组合（Alt+Ctrl+7）→ 规范化成 Ctrl+Alt+7
 *   5) Esc → 取消，保留原值
 *   6) 裸字母（无修饰键）→ 拒绝，并给出原因
 *   7) Backspace → 清除（空值 = 禁用）
 *   8) 抓取后自动保存，config.json 里真的变了
 *   9) 查重：两项设成同一个组合 → 报错且不通过校验
 *  10) 探测"是否被占用"：不能把**本应用自己**注册的键误报为被占用
 *  11) 占用路径确实能报出来（用系统保留组合）
 *  12) 主进程没有未捕获异常
 *
 * 按键用的是 CDP `Input.dispatchKeyEvent`——真正的输入事件，
 * 走的是页面里真实的 keydown 监听器，不是直接改 value 的假测试。
 *
 * 用法：node scripts/verify-shortcut-capture.js
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { cleanupRun } = require('./lib/process-cleanup')

const ROOT = path.join(__dirname, '..')
const CONFIG = path.join(process.env.APPDATA || '', 'aiquad', 'config.json')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT = 9233

// CDP modifiers 位掩码：Alt=1 Ctrl=2 Meta=4 Shift=8
const CTRL = 2
const ALT = 1

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

async function cdpTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return r.json()
}

const KEYS = {
  K: { code: 'KeyK', key: 'k', vk: 75 },
  N7: { code: 'Digit7', key: '7', vk: 55 },
  A: { code: 'KeyA', key: 'a', vk: 65 },
  F9: { code: 'F9', key: 'F9', vk: 120 },
  ESC: { code: 'Escape', key: 'Escape', vk: 27 },
  BACKSPACE: { code: 'Backspace', key: 'Backspace', vk: 8 },
}

async function main() {
  console.log('=== 快捷键抓取控件 验证 ===\n')

  const original = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : null
  if (!original) {
    console.log(`找不到配置文件 ${CONFIG}，请先运行一次应用`)
    process.exit(1)
  }
  const origCfg = JSON.parse(original)
  console.log('原始快捷键：', JSON.stringify(origCfg.shortcuts))

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
  let shotTaken = false
  try {
    console.log(`启动应用（${PORT}），等待主窗口…`)
    let mainTarget = null
    // 这台机器上没有可用 GPU，应用走软件渲染降级，冷启动明显更慢——
    // 窗口预算给到 ~72s，别用短超时误判成"应用起不来"
    for (let i = 0; i < 90 && !mainTarget; i++) {
      await sleep(800)
      try {
        mainTarget = (await cdpTargets()).find((t) => /main\.html/.test(t.url))
      }
      catch {}
    }
    if (!mainTarget) {
      console.log('--- 应用日志尾部 ---')
      console.log(log.split('\n').slice(-30).join('\n'))
      throw new Error('主窗口没起来')
    }

    const { CdpSession } = require('../dist/main/cdp')
    const mainConn = new CdpSession(mainTarget.webSocketDebuggerUrl)
    await mainConn.connect()
    await mainConn.send('Runtime.evaluate', { expression: 'window.aiquad.openSettings()' })
    mainConn.close()

    console.log('等待设置窗口…')
    let setTarget = null
    for (let i = 0; i < 60 && !setTarget; i++) {
      await sleep(500)
      try {
        setTarget = (await cdpTargets()).find((t) => /settings\.html/.test(t.url))
      }
      catch {}
    }
    if (!setTarget) {
      console.log('--- 应用日志尾部 ---')
      console.log(log.split('\n').slice(-30).join('\n'))
      throw new Error('设置窗口没起来')
    }

    cdp = new CdpSession(setTarget.webSocketDebuggerUrl)
    await cdp.connect()
    // 必须先把窗口置前并打开"焦点模拟"：窗口没有 OS 焦点时 `el.focus()` 只改
    // `document.activeElement`，**不派发 focus 事件**（录制态就起不来），
    // 要等到真的有输入进来才补发。真实用户点一下输入框时窗口本来就获得了焦点，
    // 所以这是自动化环境要补的一步，不是被测代码的问题。
    try { await cdp.send('Page.bringToFront') } catch {}
    try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }) } catch {}
    await sleep(300)
    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '页面内异常')
      return r?.result?.value
    }

    /** 注入一次真实按键（修饰键状态放在事件上） */
    const press = async (spec, mods = 0) => {
      const base = {
        code: spec.code,
        key: spec.key,
        windowsVirtualKeyCode: spec.vk,
        nativeVirtualKeyCode: spec.vk,
        modifiers: mods,
      }
      await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' })
      await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
      await sleep(140)
    }
    /** 聚焦到某个快捷键输入框（触发录制态） */
    const focusField = async (id) => {
      await evaluate(`document.getElementById(${JSON.stringify(id)}).focus()`)
      await sleep(120)
    }
    const readField = (id) => evaluate(`(() => {
      const el = document.getElementById(${JSON.stringify(id)})
      return { value: el.value, acc: el.dataset.acc || '', recording: el.classList.contains('recording'), cls: el.className, focused: document.activeElement === el }
    })()`)

    /** 稳定的录制态断言：窗口焦点有时会延迟一拍，重试几次再判定 */
    const expectRecording = async (id, tries = 12) => {
      for (let i = 0; i < tries; i++) {
        const st = await readField(id)
        if (st.recording) return st
        await evaluate(`document.getElementById(${JSON.stringify(id)}).focus()`)
        await sleep(180)
      }
      return readField(id)
    }

    /* ---------- 1. 控件接管情况 ---------- */
    console.log('\n[控件接管]')
    const widgetInfo = await evaluate(`(() => {
      const list = [...document.querySelectorAll('.sc-input')]
      return {
        hasApi: !!window.ShortcutCapture,
        count: list.length,
        ids: list.map(e => e.id),
        readonly: list.every(e => e.readOnly),
        attached: list.every(e => typeof e.dataset.acc === 'string'),
      }
    })()`)
    check(widgetInfo?.hasApi === true, 'ShortcutCapture 已加载')
    check(widgetInfo?.count === 4 && widgetInfo?.readonly === true,
      '4 个快捷键输入框都是 readonly（禁止手打）', `id=${(widgetInfo?.ids || []).join(',')}`)
    check(widgetInfo?.attached === true, '全部已被抓取控件接管')

    // 字段清单一致性：settings.js 的 SC_FIELDS ↔ HTML ↔ 主进程配置键
    const fieldAudit = await evaluate(`(() => {
      const inHtml = new Set([...document.querySelectorAll('.sc-input')].map(e => e.id))
      const missing = SC_FIELDS.filter(f => !inHtml.has(f.id)).map(f => f.id)
      const extra = [...inHtml].filter(id => !SC_FIELDS.some(f => f.id === id))
      return { missing, extra, keys: SC_FIELDS.map(f => f.key).sort().join(',') }
    })()`)
    check(fieldAudit?.missing.length === 0 && fieldAudit?.extra.length === 0,
      'SC_FIELDS 与 HTML 里的 .sc-input 完全对应',
      `missing=${JSON.stringify(fieldAudit?.missing)} extra=${JSON.stringify(fieldAudit?.extra)}`)
    const { normalizeAccelerator } = require('../dist/main/accelerator')
    const expectedKeys = ['layout1', 'layout2', 'layout4', 'toggleFloat']
    check(fieldAudit?.keys === expectedKeys.join(','),
      'SC_FIELDS 的 key 与 AppConfig.shortcuts 一致', fieldAudit?.keys)

    /* ---------- 2. 录制态 ---------- */
    console.log('\n[录制态]')
    const rec = await expectRecording('sc-1')
    check(rec.recording === true, '聚焦后进入录制态', `focused=${rec.focused}`)
    check(rec.value === '按下快捷键…', '输入框显示提示文案', `value="${rec.value}"`)
    const recStatus = await evaluate(`document.getElementById('sc-status').className`)
    check(/warn/.test(recStatus), '状态行提示"录制中…"', `class=${recStatus}`)

    /* ---------- 3. 抓取 Ctrl+Alt+K ---------- */
    console.log('\n[抓取组合键]')
    await press(KEYS.K, CTRL | ALT)
    const afterK = await readField('sc-1')
    check(afterK.acc === 'Ctrl+Alt+K', 'Ctrl+Alt+K 被抓取', `dataset.acc="${afterK.acc}"`)
    check(afterK.recording === false, '抓取后退出录制态')
    check(afterK.value === 'Ctrl+Alt+K', '输入框显示抓取结果', `value="${afterK.value}"`)

    await sleep(1500) // 等自动保存落盘
    const cfgAfterK = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
    check(cfgAfterK.shortcuts.layout1 === 'Ctrl+Alt+K',
      '抓取后自动保存到 config.json', `磁盘值="${cfgAfterK.shortcuts.layout1}"`)

    /* ---------- 4. 规范化顺序 ---------- */
    console.log('\n[规范化]')
    await focusField('sc-2')
    await press(KEYS.N7, ALT | CTRL)
    const after7 = await readField('sc-2')
    check(after7.acc === 'Ctrl+Alt+7', '乱序组合被规范化成 Ctrl+Alt+7', `dataset.acc="${after7.acc}"`)

    /* ---------- 5. Esc 取消 ---------- */
    console.log('\n[取消与拒绝]')
    const beforeEsc = (await readField('sc-2')).acc
    await focusField('sc-2')
    await press(KEYS.ESC, 0)
    const afterEsc = await readField('sc-2')
    check(afterEsc.acc === beforeEsc && afterEsc.recording === false,
      'Esc 取消录制并保留原值', `acc="${afterEsc.acc}"`)

    // 用户报的现场：Esc 取消之后"录制中…"还一直挂在页面上。
    // 录制控件只在 rec / bad 两种状态写状态行，idle 时也必须收掉，
    // 否则那条提示就变成永不过期的东西（见 shortcut-capture.js 的 onState）。
    await sleep(150)
    const escStatus = await evaluate(`(() => {
      const s = document.getElementById('sc-status')
      return { text: s.textContent, cls: s.className }
    })()`)
    check(!/录制中/.test(escStatus.text) && !/warn/.test(escStatus.cls),
      'Esc 之后"录制中"提示已收掉（不再永久挂在页面上）', JSON.stringify(escStatus))

    // 失焦取消也是同一条路径
    await focusField('sc-4')
    await evaluate(`document.getElementById('sc-4').blur()`)
    await sleep(150)
    const blurStatus = await evaluate(`(() => {
      const s = document.getElementById('sc-status')
      const f = document.getElementById('sc-4')
      return { text: s.textContent, cls: s.className, recording: !!f.classList.contains('recording') }
    })()`)
    check(!blurStatus.recording && !/录制中/.test(blurStatus.text),
      '失焦之后同样收掉提示并退出录制态', JSON.stringify(blurStatus))

    /* ---------- 6. 裸字母被拒 ---------- */
    const beforeBare = (await readField('sc-4')).acc
    await expectRecording('sc-4')
    await press(KEYS.A, 0)
    const afterBare = await readField('sc-4')
    check(afterBare.acc === beforeBare, '裸字母（无修饰键）不被抓取', `acc="${afterBare.acc}"`)
    const bareStatus = await evaluate(`document.getElementById('sc-status').textContent`)
    const bareCls = await evaluate(`document.getElementById('sc-status').className`)
    check(/err/.test(bareCls) && /Ctrl/.test(bareStatus),
      '状态行说明拒绝原因', `"${bareStatus}"`)

    /* ---------- 7. F9 可单独使用 ---------- */
    await focusField('sc-4')
    await press(KEYS.F9, 0)
    const afterF9 = await readField('sc-4')
    check(afterF9.acc === 'F9', 'F9 可以不带修饰键使用', `acc="${afterF9.acc}"`)
    await sleep(1200)

    /* ---------- 8. Backspace 清除 = 禁用 ---------- */
    await focusField('sc-4')
    await press(KEYS.BACKSPACE, 0)
    const afterClear = await readField('sc-4')
    check(afterClear.acc === '', 'Backspace 清空（= 禁用该项）', `acc="${afterClear.acc}"`)
    await sleep(1200)
    const cfgCleared = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
    check(cfgCleared.shortcuts.layout4 === '',
      '空值真的写进了配置（不再被静默还原成默认值）', `磁盘值="${cfgCleared.shortcuts.layout4}"`)

    /* ---------- 9. 查重 ---------- */
    console.log('\n[查重]')
    await evaluate(`(() => { ShortcutCapture.set(document.getElementById('sc-4'), 'Ctrl+Alt+K'); return 1 })()`)
    const dupOk = await evaluate(`(async () => {
      const ok = await validateShortcuts()
      const bad = [...document.querySelectorAll('.sc-input.bad')].map(e => e.id)
      return { ok, bad, status: document.getElementById('sc-status').textContent }
    })()`)
    check(dupOk?.ok === false, '两项设成同一组合时校验不通过')
    check((dupOk?.bad || []).includes('sc-1') && (dupOk?.bad || []).includes('sc-4'),
      '冲突的两个输入框都被标红', `bad=${JSON.stringify(dupOk?.bad)}`)
    check(/重复|都设成了/.test(dupOk?.status || ''), '状态行指出冲突', `"${dupOk?.status}"`)

    // 还原 sc-4 为空，避免影响后续
    await evaluate(`(() => { ShortcutCapture.set(document.getElementById('sc-4'), ''); return 1 })()`)

    /* ---------- 10. 探测占用：不能误报自己的键 ---------- */
    console.log('\n[占用探测]')
    const probeSelf = await evaluate(`(async () => {
      const cfg = await api.getConfig()
      const acc = cfg.shortcuts.toggleFloat
      const r = await api.probeShortcut(acc)
      return { acc, r }
    })()`)
    check(probeSelf?.r?.ok === true,
      '本应用自己注册的组合不会被误报为"被占用"', `${probeSelf?.acc} → ${JSON.stringify(probeSelf?.r)}`)

    const probeInvalid = await evaluate(`(async () => await api.probeShortcut('不是快捷键'))()`)
    check(probeInvalid?.ok === false && probeInvalid?.reason === 'invalid',
      '非法写法被识别为 invalid', JSON.stringify(probeInvalid))

    // 系统保留组合：应报 taken（挑一个真的注册不上的）
    const reserved = await evaluate(`(async () => {
      const out = []
      for (const acc of ['Super+L', 'Ctrl+Alt+Delete', 'Ctrl+Alt+Delete']) {
        out.push({ acc, r: await api.probeShortcut(acc) })
      }
      return out
    })()`)
    const takenHit = (reserved || []).find((x) => x.r && x.r.ok === false && x.r.reason === 'taken')
    check(!!takenHit,
      '被系统/其它程序占用的组合能报出 taken',
      takenHit ? `${takenHit.acc} → taken` : `实测结果 ${JSON.stringify(reserved)}`)

    /* ---------- 11. 恢复后自检仍然通过 ---------- */
    const finalCheck = await evaluate(`(async () => {
      await save(false)
      return { issues: window.__lastIssues === undefined ? null : window.__lastIssues }
    })()`)
    const finalCfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
    check(finalCfg.shortcuts.layout1 === 'Ctrl+Alt+K',
      '再次保存后配置稳定', `layout1="${finalCfg.shortcuts.layout1}"`)

    /* ---------- 12. 主进程异常 ---------- */
    if (/uncaught|A JavaScript error occurred|Uncaught Exception/i.test(log)) {
      check(false, '主进程日志里没有未捕获异常', log.slice(-400))
    }
    else {
      check(true, '主进程日志里没有未捕获异常')
    }

    /* ---------- 截图留档：录制态 ---------- */
    try {
      await focusField('sc-toggle')
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const out = path.join(ROOT, '.tmp', 'shortcut-capture-recording.png')
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
      shotTaken = true
      console.log(`\n（录制态截图：${out}）`)
    }
    catch (e) {
      console.log(`\n（截图失败：${e?.message || e}）`)
    }
    if (!shotTaken) check(false, '录制态截图')
  }
  catch (e) {
    check(false, '测试执行', String(e?.message || e))
  }
  finally {
    try { cdp?.close() } catch {}
    // ⚠️ 必须杀进程树：留一个宿主进程活着就会占住单实例锁
    cleanupRun(child.pid)
    await sleep(1200)
    try {
      fs.writeFileSync(CONFIG, original, 'utf8')
      console.log('（已还原原始配置）')
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
