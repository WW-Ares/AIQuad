/**
 * 真机截图 + 合成拖动测试：设置页 AI 服务表（拖柄 / 分组分块 / 拖动排序）。
 *
 * 用 --user-data-dir 起隔离实例（大王自己的 AIQuad 开着也不会被单实例锁顶掉）。
 * 三件事：
 *   1. 截图 AI 服务那张卡的**真实渲染**（不是模拟图）；
 *   2. 断言列序契约：名称/网址的字体会不会因为加了拖柄列而错位；
 *   3. 用合成 DragEvent 真拖一次：国外 AI 组的第一条 → 国内 AI 组里，
 *      断言落点蓝线出现、目标组点亮、松手后分组确实改了、隔离配置里数组顺序确实变了。
 *
 * 用法：AIQUAD_TEST_PORT=9801 node scripts/shot-ai-table.js
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const Q = path.join(ROOT, '.tmp', 'appdata', 'q-ai')
const PORT = Number(process.env.AIQUAD_TEST_PORT || 9801)
const OUT = path.join(ROOT, '.tmp', 'ai-table-real.png')
const OUT_DRAG = path.join(ROOT, '.tmp', 'ai-table-dragging.png')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const { CdpSession, listTargets } = require(path.join(ROOT, 'dist', 'main', 'cdp'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const FAILS = []
const check = (name, ok, extra) => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra === undefined ? '' : `  —— ${extra}`}`)
  if (!ok) FAILS.push(name)
}

async function main() {
  const real = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'aiquad', 'config.json'), 'utf8'))
  real.panes = []
  real.cacheCleanup = 'off'
  real.autoStart = false
  fs.mkdirSync(Q, { recursive: true })
  fs.writeFileSync(path.join(Q, 'config.json'), JSON.stringify(real, null, 2))

  const env = { ...process.env, AIQUAD_DISABLE_GPU: '1', AIQUAD_NO_SANDBOX: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(ELECTRON,
    ['--in-process-gpu', '--disable-gpu', `--user-data-dir=${Q}`, `--remote-debugging-port=${PORT}`, ROOT],
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
  await sleep(1800)
  const s = new CdpSession(set.webSocketDebuggerUrl)
  await s.connect()
  await s.send('Page.enable')
  const ev = async (expr) => {
    const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '页面内异常')
    return r?.result?.value
  }

  console.log(`AIQuad 设置页 AI 服务表 · 实机核对（端口 ${PORT}）\n`)

  /* ---------- 1. 契约断言 ---------- */
  const f = await ev(`(() => {
    const tbody = document.getElementById('ai-rows')
    const rows = [...tbody.querySelectorAll('tr.ai-row')]
    const heads = [...tbody.querySelectorAll('tr.st-group')]
    const grips = [...tbody.querySelectorAll('td.c-grip .st-grip[draggable="true"]')]
    const nameIn = rows[0]?.querySelector('td.c-name input')
    const urlIn = rows[0]?.querySelector('td.c-url input')
    const gripTd = rows[0]?.querySelector('td.c-grip')
    // 第一格必须是拖柄格，不是名称格 —— 加列后最容易错的就是这个
    const firstIsGrip = rows.every(r => r.firstElementChild.classList.contains('c-grip'))
    return {
      分组标题: heads.map(h => h.textContent),
      行数: rows.length,
      拖柄数: grips.length,
      空网址的行: rows.filter(r => !r.querySelector('td.c-url input')?.value).length,
      第一格是拖柄: firstIsGrip,
      拖柄列宽: gripTd ? Math.round(gripTd.getBoundingClientRect().width) : null,
      名称字体: nameIn ? getComputedStyle(nameIn).fontFamily.split(',')[0] : null,
      名称字重: nameIn ? getComputedStyle(nameIn).fontWeight : null,
      网址字体: urlIn ? getComputedStyle(urlIn).fontFamily.split(',')[0] : null,
      网址字号: urlIn ? getComputedStyle(urlIn).fontSize : null,
      表头: [...tbody.parentElement.querySelectorAll('thead th')].map(t => t.textContent).join('|'),
      每行格数: [...new Set(rows.map(r => r.children.length))].join(','),
      横向溢出: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      表格横向溢出: (() => { const w = document.querySelector('.st-aiwrap'); return w ? w.scrollWidth > w.clientWidth + 1 : null })(),
      代理子行跨列: (() => { const r = [...tbody.querySelectorAll('td[colspan]')].find(t => t.colSpan === 5 && !t.closest('tr.st-group')); return r ? 5 : '无' })(),
    }
  })()`)
  console.log(JSON.stringify(f, null, 2), '\n')

  check('每个分组都画出了标题', f.分组标题.length >= 2, f.分组标题.join(' / '))
  check('每行都有拖柄且 draggable', f.拖柄数 === f.行数, `${f.拖柄数}/${f.行数}`)
  check('第一格是拖柄格（列序契约）', f.第一格是拖柄 === true)
  check('拖柄列宽 26px（压缩后）', f.拖柄列宽 >= 24 && f.拖柄列宽 <= 28, `${f.拖柄列宽}px`)
  check('名称仍是正文体（没被套上等宽小字）', !/mono|Consolas/i.test(f.名称字体), `${f.名称字体} / ${f.名称字重}`)
  check('网址仍是等宽小字（没被套上名称字重）', /mono|Consolas/i.test(f.网址字体) && f.网址字号 === '11px', `${f.网址字体} / ${f.网址字号}`)
  check('表头列数 = 5 且无「分组」列', f.表头.split('|').length === 5 && !f.表头.includes('分组'), f.表头)
  check('每行都是 5 格', f.每行格数 === '5', f.每行格数)
  check('无横向溢出', !f.横向溢出 && !f.表格横向溢出)

  /* ---------- 2. 拖动：先摆出「拖动中」的样子截图，再真松手落库 ---------- */
  const drag = await ev(`(async () => {
    const tbody = document.getElementById('ai-rows')
    const rows = [...tbody.querySelectorAll('tr.ai-row')]
    const src = rows.find(r => r.dataset.gi === '0')
    if (!src) return { err: '没有「国外 AI」组的条目可拖' }
    const dstHead = [...tbody.querySelectorAll('tr.st-group')].find(h => h.dataset.gi === '1')
    const dstFirst = rows.find(r => r.dataset.gi === '1')
    const movedId = src.dataset.aiId
    const before = rows.map(r => r.dataset.aiId + '@' + r.dataset.gi)
    const dt = new DataTransfer()
    src.querySelector('.st-grip').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    // 半透明态是 setTimeout(0) 加的：等一个宏任务再断言，别在 dragstart 同一个 tick 里读
    await new Promise(r => setTimeout(r, 60))
    const dragging = src.classList.contains('st-dragging')
    const y = (dstFirst || dstHead).getBoundingClientRect().top + 2
    tbody.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: y }))
    const lineShown = !!document.getElementById('ai-drop-ph')
    const overGroup = (tbody.querySelector('tr.st-group.over') || {}).textContent || null
    // 停在这里 —— 外面截图，再回来松手
    window.__dragDt = dt
    window.__dragY = y
    window.__dragId = movedId
    return { movedId, before, lineShown, overGroup, dragging }
  })()`)
  console.log('拖动（悬停中）：', JSON.stringify(drag, null, 2), '\n')
  check('拖动时出现落点蓝线', drag.lineShown === true)
  check('目标组标题被点亮', drag.overGroup !== null, String(drag.overGroup))
  check('被拖行进入半透明态', drag.dragging === true)

  /* ---------- 3. 「拖动中」的真实截图 ---------- */
  await ev(`(() => {
    const card = [...document.querySelectorAll('.st-card')].find(c => c.querySelector('h2')?.textContent.trim() === 'AI 服务')
    card.scrollIntoView({ block: 'start' })
    return true
  })()`)
  await sleep(400)
  const rect = await ev(`(() => {
    const card = [...document.querySelectorAll('.st-card')].find(c => c.querySelector('h2')?.textContent.trim() === 'AI 服务')
    const r = card.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height, vh: window.innerHeight }
  })()`)
  const clipOf = () => ({
    x: Math.max(0, Math.round(rect.x) - 6),
    y: Math.max(0, Math.round(rect.y) - 6),
    width: Math.round(rect.width) + 12,
    height: Math.min(Math.round(rect.height) + 12, rect.vh - Math.max(0, Math.round(rect.y)) - 6),
    scale: 2,
  })
  const draggingShot = await s.send('Page.captureScreenshot', { format: 'png', clip: clipOf() })
  fs.writeFileSync(OUT_DRAG, Buffer.from(draggingShot.data, 'base64'))
  console.log(`拖动中截图：${path.relative(ROOT, OUT_DRAG)}（${fs.statSync(OUT_DRAG).size} 字节）`)

  /* ---------- 4. 真松手，核对落库 ---------- */
  const after2 = await ev(`(async () => {
    const tbody = document.getElementById('ai-rows')
    const id = window.__dragId
    tbody.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: window.__dragDt, clientY: window.__dragY }))
    await new Promise(r => setTimeout(r, 900))
    const movedRow = [...tbody.querySelectorAll('tr.ai-row')].find(r => r.dataset.aiId === id)
    return {
      after: [...tbody.querySelectorAll('tr.ai-row')].map(r => r.dataset.aiId + '@' + r.dataset.gi),
      lineGone: !document.getElementById('ai-drop-ph'),
      stillDragging: !!tbody.querySelector('tr.st-dragging'),
      movedNowInGroup: movedRow ? movedRow.dataset.gi : null,
    }
  })()`)
  console.log('\n拖动（已松手）：', JSON.stringify(after2, null, 2), '\n')
  check('松手后蓝线撤掉', after2.lineGone === true)
  check('松手后半透明态撤掉', after2.stillDragging === false)
  check('被拖条已挪到「国内 AI」组', after2.movedNowInGroup === '1', `gi=${after2.movedNowInGroup}`)

  const saved = JSON.parse(fs.readFileSync(path.join(Q, 'config.json'), 'utf8'))
  const idx = saved.aiList.findIndex((a) => a.id === drag.movedId)
  const next = saved.aiList[idx + 1]
  check('该条自己的 category 已写成 cn', saved.aiList[idx]?.category === 'cn', String(saved.aiList[idx]?.category))
  // 落点在国际组首条之前 ⇒ 它的**后一条**才是同组的第一条（不是前一条）
  check('它在数组里正好顶在「国内 AI」区块的最前面',
    idx >= 0 && (next?.category || 'cn') === 'cn',
    `第 ${idx + 1} 位，后一条=${next?.id}/${next?.category}`)

  /* ---------- 5. 常态截图 ---------- */
  await sleep(300)
  const normalShot = await s.send('Page.captureScreenshot', { format: 'png', clip: clipOf() })
  fs.writeFileSync(OUT, Buffer.from(normalShot.data, 'base64'))
  console.log(`常态截图：${path.relative(ROOT, OUT)}（${fs.statSync(OUT).size} 字节，${Math.round(rect.width)}×~${Math.round(rect.height)} CSS px @2x）`)

  s.close(); p.close()
  try { require('../scripts/lib/process-cleanup').cleanupRun(child.pid) } catch {}
  await sleep(400)

  console.log(`\n【结论】${FAILS.length ? `❌ ${FAILS.length} 项不成立：${FAILS.join('、')}` : '✅ 全部通过'}`)
  process.exitCode = FAILS.length ? 3 : 0
}

main().catch((e) => { console.log('失败：', String(e?.message || e)); process.exitCode = 1; setTimeout(() => process.exit(1), 300) })
