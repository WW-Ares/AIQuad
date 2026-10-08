/**
 * 只读诊断：拖放落点上到底是"谁"在挡。
 *
 * 大王的现象（2026-10-08）：GPT **新会话**时输入栏在**中间**，能拖入附件；
 * 对话之后输入栏跑到**底部**，就拖不进去了。
 * → 那问题不在穿透开关本身，而在**那块屏幕位置被面板上的某个元素挡住了**。
 *
 * 头号嫌疑：`.ai-selector`（悬浮 AI 切换器）就是 `position: absolute; bottom: …`
 * 贴底边定位的（见 styles.css:271），而"穿透判定"里它和下拉菜单一样被显式排除：
 *
 *     const widget = !!(hit && hit.closest('.ai-selector, .ai-menu'))
 *     const through = !!(pane && pane.classList.contains('ready') && !widget)
 *
 * 也就是**输入栏一旦落进胶囊那条带，面板就"不穿透"** → 指针与 OLE 拖放全被面板收走，
 * 底下的 Chrome 收不到 → "附件拖不进去"。
 *
 * 本脚本用 CDP 在渲染层里问 `document.elementFromPoint()`：**面板自己的 DOM**，
 * 不动任何窗口、不发任何穿透指令。
 *
 * 用法：node scripts/diag-drop-target.js [面板调试端口]
 */
const { CdpSession, listPageTargets } = require('../dist/main/cdp')

const PANEL_PORT = process.argv[2] || process.env.AIQUAD_TEST_PORT || 0

/** 取面板渲染层当前的穿透判定结果 + 一条纵向扫描 */
const PROBE = `(() => {
  const sel = document.querySelector('.ai-selector')
  const selRect = sel ? sel.getBoundingClientRect() : null
  const panes = [...document.querySelectorAll('.pane')].map((p) => {
    const r = p.getBoundingClientRect()
    return {
      id: p.dataset.paneId || p.className,
      ready: p.classList.contains('ready'),
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    }
  })
  return {
    win: { w: innerWidth, h: innerHeight },
    selector: selRect ? { x: selRect.left, y: selRect.top, w: selRect.width, h: selRect.height } : null,
    menuOpen: !!document.querySelector('.ai-menu'),
    panes,
  }
})()`

/** 在给定屏幕坐标上问 elementFromPoint 命中了什么 */
const HIT = `((x, y) => {
  const el = document.elementFromPoint(x, y)
  if (!el) return { hit: null }
  const pane = el.closest('.pane')
  const widget = el.closest('.ai-selector, .ai-menu')
  return {
    tag: el.tagName,
    cls: String(el.className || ''),
    paneId: pane ? (pane.dataset.paneId || '') : '',
    paneReady: pane ? pane.classList.contains('ready') : false,
    inWidget: !!widget,
    through: !!(pane && pane.classList.contains('ready') && !widget),
  }
})`

async function main() {
  if (!PANEL_PORT) {
    console.error('用法：node scripts/diag-drop-target.js <面板调试端口>')
    console.error('（面板没开调试端口时先设 AIQUAD_TEST_PORT，或直接手工填）')
    process.exit(2)
  }
  const targets = await listPageTargets(Number(PANEL_PORT))
  const page = targets.find(t => /main\.html/i.test(t.url || '')) || targets[0]
  if (!page?.webSocketDebuggerUrl) {
    console.error(`端口 ${PANEL_PORT} 上没找到页面 target`)
    process.exit(2)
  }
  console.log(`目标：${page.url}\n`)

  const cdp = new CdpSession(page.webSocketDebuggerUrl)
  await cdp.connect()
  const info = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true })
  const r = info?.result?.value
  if (!r) {
    console.error('拿不到面板布局信息')
    cdp.close()
    process.exit(2)
  }

  console.log(`面板视口：${r.win.w}x${r.win.h}`)
  console.log(`下拉菜单展开：${r.menuOpen ? '是（⚠️ 这会让整块面板不穿透）' : '否'}`)
  console.log(`\n分格（面板内坐标，与 getBoundingClientRect 同一套）：`)
  for (const p of r.panes) {
    console.log(`  ${p.id} ${p.ready ? '[ready]' : '[未就位]'}  x=${p.rect.x} y=${p.rect.y} ${p.rect.w}x${p.rect.h}  下沿=${p.rect.y + p.rect.h}`)
  }
  if (r.selector) {
    const s = r.selector
    console.log(`\n.ai-selector 胶囊：x=${s.x} y=${s.y} ${s.w}x${s.h}  下沿=${s.y + s.h}`)
    console.log(`  → 它是**贴底边绝对定位**的（styles.css:271），所以网页底部的输入栏很容易落进这条带。`)
  }
  else {
    console.log('\n.ai-selector：当前不存在（AI 切换器可能还没渲染）')
  }

  // 纵向扫描：从分格中部往下每 40px 问一次命中
  if (!r.panes.length) {
    cdp.close()
    return
  }
  const p0 = r.panes[0]
  const x = Math.round(p0.rect.x + p0.rect.w / 2)
  console.log(`\n纵向扫描（x=${x}，分格中央，从上到下每 40px）：`)
  console.log('   y  | 命中元素            | 在分格 | 在胶囊/菜单 | 判定穿透')
  console.log('  ----+---------------------+--------+-------------+---------')
  for (let y = Math.round(p0.rect.y + 20); y < Math.round(p0.rect.y + p0.rect.h); y += 40) {
    const hit = await cdp.send('Runtime.evaluate', {
      expression: `${HIT}(${x}, ${y})`,
      returnByValue: true,
    })
    const h = hit?.result?.value
    if (!h) continue
    const label = `${h.tag}.${String(h.cls).split(' ').slice(0, 2).join('.')}`.slice(0, 20).padEnd(20)
    console.log(`  ${String(y).padStart(4)} | ${label} | ${(h.paneId ? '是' : '否').padEnd(6)} | ${(h.inWidget ? '★是' : '否').padEnd(11)} | ${h.through ? '✔ 穿透' : '✘ 不穿透 ← 拖放会被吃掉'}`)
  }
  cdp.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})