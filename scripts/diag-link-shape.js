/**
 * 只读诊断：量 GPT（及一般 AI 网站）**回答里链接**的真实形态。
 *
 * 大王的需求（2026-10-08）：面板里点 GPT 给的链接，**不要**在分格里直接跳转
 * （那会把 AI 对话窗口整个换掉），要用电脑的默认浏览器另开。
 *
 * 能不能做、怎么做，**完全取决于链接的 DOM 形态**。三种情况差别极大：
 *   ① `target="_blank"` → 浏览器会开**新标签**，分格不会被换掉（但仍在分格里）；
 *   ② 无 target / `_self` → **同窗口导航**，分格直接被换掉（大王遇到的就是这种）；
 *   ③ 委托事件 / SPA 路由（点的是 `div` 而不是 `<a>`）→ 连 `href` 都没有。
 *
 * 所以先量：这些链接到底是什么、有多少、`target` 是什么。
 *
 * 走**分格**浏览器的 CDP 端口（面板不开调试端口，正式版如此）。
 *
 * 用法：node scripts/diag-link-shape.js [分格端口]
 */
const { CdpSession, listPageTargets } = require('../dist/main/cdp')

const PORT = Number(process.argv[2] || 60727)

const PROBE = `(() => {
  const as = [...document.querySelectorAll('a[href]')].filter((a) => {
    const r = a.getBoundingClientRect()
    const s = getComputedStyle(a)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  })
  const shape = { total: as.length, blank: 0, self: 0, other: 0, noTarget: 0, schemes: {}, samples: [] }
  for (const a of as) {
    const t = (a.getAttribute('target') || '').toLowerCase()
    if (!t) shape.noTarget++
    else if (t === '_blank') shape.blank++
    else if (t === '_self') shape.self++
    else shape.other++
    let scheme = 'relative'
    try { scheme = new URL(a.href, location.href).protocol.replace(':', '') } catch {}
    shape.schemes[scheme] = (shape.schemes[scheme] || 0) + 1
    if (shape.samples.length < 8) {
      shape.samples.push({
        text: (a.textContent || '').trim().slice(0, 34),
        href: (a.href || '').slice(0, 90),
        target: a.getAttribute('target'),
        rel: a.getAttribute('rel'),
      })
    }
  }
  // 另外看看有没有"看起来像链接但不是 <a>"的元素（AI 网站常见的卡片式链接）
  const suspicious = [...document.querySelectorAll('[role="link"], [data-testid*="link"]')]
    .filter((e) => !e.closest('a[href]') && e.getBoundingClientRect().width > 40).length
  return {
    url: location.href,
    title: document.title,
    shape,
    suspicious,
    // 页面有没有"新建对话"这类会重置页面的迹象
    isNewChat: /chatgpt\\.com\\/?$/.test(location.pathname) || location.pathname === '/',
  }
})()`

async function main() {
  const targets = await listPageTargets(PORT)
  const page = targets.find(t => t.type === 'page' && !/devtools|chrome-extension/.test(t.url || ''))
  if (!page?.webSocketDebuggerUrl) {
    console.log(`端口 ${PORT} 上没有可用页面。各 target：`)
    for (const t of targets) console.log(`  - ${t.type} ${t.url}`)
    process.exit(2)
  }
  console.log(`目标：${page.url}\n`)

  const cdp = new CdpSession(page.webSocketDebuggerUrl)
  await cdp.connect()
  const r = (await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true }))?.result?.value
  cdp.close()
  if (!r) {
    console.log('拿不到结果')
    process.exit(2)
  }

  const s = r.shape
  console.log(`页面：${r.title}`)
  console.log(`URL：${r.url}`)
  console.log(`是"新会话"页：${r.isNewChat ? '是' : '否'}\n`)
  console.log(`可见 <a href> 共 ${s.total} 个：`)
  console.log(`  无 target     ：${s.noTarget}   ← **同窗口跳转，会把分格换掉**`)
  console.log(`  target=_blank ：${s.blank}   ← 开新标签，分格不变`)
  console.log(`  target=_self  ：${s.self}`)
  console.log(`  其它 target   ：${s.other}`)
  console.log(`\n协议分布：${JSON.stringify(s.schemes)}`)
  console.log(`形似链接但不是 <a> 的元素：${r.suspicious} 个（点了不会走 href，要单独处理）`)
  console.log('\n样本：')
  for (const x of s.samples) {
    console.log(`  "${x.text}"`)
    console.log(`    href=${x.href}`)
    console.log(`    target=${x.target ?? '(无)'}  rel=${x.rel ?? '(无)'}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})