/**
 * 只读诊断：量 GPT 输入栏的**实际位置**，看它会不会落进 `.ai-selector` 胶囊那条带。
 *
 * 大王的现象（2026-10-08）：新会话输入栏在**中间** → 能拖入附件；
 * 对话后输入栏在**底部** → 拖不进去。
 * 面板的穿透判定里 `.ai-selector`（悬浮 AI 切换器，`position:absolute; bottom:…`
 * 贴底边定位，styles.css:271）被**显式排除**：
 *
 *     const widget = !!(hit && hit.closest('.ai-selector, .ai-menu'))
 *     const through = !!(pane && pane.classList.contains('ready') && !widget)
 *
 * 所以只要输入栏落进胶囊那条带，面板就"不穿透"，指针与 OLE 拖放全被面板吃掉。
 * 本脚本从**网页侧**量输入栏位置 + 从**面板侧**量胶囊位置，换算到同一套物理坐标比对。
 *
 * 走分格浏览器的 CDP 端口（面板本身不开调试端口，正式版没有）。
 *
 * 用法：node scripts/diag-gpt-inputbar.js [分格端口]
 */
const { CdpSession, listPageTargets } = require('../dist/main/cdp')

const PORT = Number(process.argv[2] || 60727)

/** 在网页里找输入栏，并把它的位置换算成**物理屏幕坐标** */
const PROBE = `(() => {
  // ChatGPT 的输入栏是一个 textarea / contenteditable / 带 contenteditable 的 div
  const cands = [
    ...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable="plaintext-only"]'),
  ].filter((el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 120 || r.height < 24) return false
    if (r.bottom < 0 || r.top > innerHeight) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'
  })
  if (!cands.length) return { found: false, url: location.href }
  // 取面积最大的那个（输入栏本体，而不是隐藏的搜索框之类）
  let best = cands[0], bestArea = 0
  for (const el of cands) {
    const r = el.getBoundingClientRect()
    const a = r.width * r.height
    if (a > bestArea) { best = el; bestArea = a }
  }
  const r = best.getBoundingClientRect()
  return {
    found: true,
    url: location.href,
    title: document.title,
    viewport: { w: innerWidth, h: innerHeight },
    inputbar: { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 },
  }
})()`

async function main() {
  const targets = await listPageTargets(PORT)
  const page = targets.find(t => /chatgpt|openai/i.test(t.url || ''))
  if (!page?.webSocketDebuggerUrl) {
    console.log(`分格端口 ${PORT} 上没找到 ChatGPT 页面。当前各 target：`)
    for (const t of targets) console.log(`  - ${t.type}  ${t.url}`)
    process.exit(2)
  }
  console.log(`目标：${page.url}\n`)

  const cdp = new CdpSession(page.webSocketDebuggerUrl)
  await cdp.connect()
  const r = (await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true }))?.result?.value
  if (!r?.found) {
    console.log('页面上没找到可见的输入栏')
    cdp.close()
    process.exit(2)
  }

  console.log(`页面：${r.title}`)
  console.log(`视口：${r.viewport.w}x${r.viewport.h}`)
  console.log(`\n输入栏（页面坐标）：x=${r.inputbar.x} y=${r.inputbar.y} ${r.inputbar.w}x${r.inputbar.h}`)
  console.log(`输入栏中心（页面坐标）：${Math.round(r.inputbar.cx)},${Math.round(r.inputbar.cy)}`)

  /**
   * ⚠️ 这里**不**去反查浏览器窗口矩形：那是 `listBrowserWindows()` 的活，
   * 而它要求窗口里有 `Chrome_RenderWidgetHostHWND`——分格窗口有，但要把
   * CDP 的 target 映射回 hwnd 再换算物理坐标，牵扯太多且容易错。
   * 本脚本的职责就一件：**量出输入栏在页面内的位置与尺寸**，
   * 剩下的比对交给页面侧 + 面板侧两个数字（见下面的提示）。
   */
  cdp.close()

  console.log('\n' + '='.repeat(70))
  console.log('结论提示：把上面的"输入栏中心"和面板侧 `.ai-selector` 的矩形一比，')
  console.log('若输入栏落在胶囊那条带里 → 面板不穿透 → OLE 拖放被面板吃掉（就是本 bug）。')
  console.log('面板侧坐标用：node scripts/diag-drop-target.js <面板端口>')
  console.log('='.repeat(70))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})