/**
 * 验证"链接交给系统浏览器"这个拦截器（2026-10-08）。
 *
 * 分两部分：
 *   ① **静态**：把注入脚本拿真的 AI 页面跑一遍，看它挂不挂得上、判据对不对；
 *   ② **真点**：合成一次真实的鼠标点击，验证
 *      `preventDefault` 生效（页面 URL **不变**）+ URL 被 `console.log` 报出来
 *      —— 这一条才是"链接不再把分格换掉"的真凭据。
 *
 * ⚠️ **不真的打开浏览器**：URL 只是从 console 事件里取出来打印，
 *    绝不调shell.openExternal，免得大王桌面上凭空蹦出浏览器窗口。
 *
 * 走**分格**浏览器的 CDP 端口（面板不开调试端口）。
 *
 * 用法：node scripts/verify-external-link.js [分格端口] [要点的链接文字]
 */
const { CdpSession, listPageTargets } = require('../dist/main/cdp')

const PORT = Number(process.argv[2] || 60727)
const WANT = process.argv[3] || ''

/** 挑一个真实存在的 <a href>，返回它的选择器与坐标 */
const PICK = `(() => {
  const as = [...document.querySelectorAll('a[href]')].filter((a) => {
    const r = a.getBoundingClientRect()
    const s = getComputedStyle(a)
    return r.width > 20 && r.height > 10 && r.bottom > 0 && r.top < innerHeight
      && s.visibility !== 'hidden' && s.display !== 'none' && !a.hasAttribute('download')
      && !a.getAttribute('href').startsWith('#')
  })
  return as.map((a, i) => {
    const r = a.getBoundingClientRect()
    return {
      i,
      text: (a.textContent || '').trim().slice(0, 40),
      href: a.getAttribute('href'),
      target: a.getAttribute('target'),
      proto: new URL(a.href, document.baseURI).protocol,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    }
  })
})()`

async function main() {
  const targets = await listPageTargets(PORT)
  const page = targets.find(t => t.type === 'page' && /chatgpt|claude|gemini|github|copilot/i.test(t.url || ''))
    || targets.find(t => t.type === 'page' && !/devtools/.test(t.url || ''))
  if (!page?.webSocketDebuggerUrl) {
    console.log(`端口 ${PORT} 上没有可用页面。`)
    process.exit(2)
  }
  console.log(`目标：${page.url}\n`)

  const cdp = new CdpSession(page.webSocketDebuggerUrl)
  await cdp.connect()

  // URL 由 installExternalLinkHook 的 onUrl 回调收集（它会重装监听，
// 外面另挂的那个会被顶掉，见下面①的注释）。这里只留一个空数组。
// ⚠️ `Runtime.enable` 由 installExternalLinkHook 内部开启 ——
//    CDP 默认不转发页面 console，不开的话 consoleAPICalled 永远不来。
const got = []

  const before = (await cdp.send('Runtime.evaluate', {
    expression: 'location.href',
    returnByValue: true,
  }))?.result?.value

  console.log('【①】安装拦截器')
  /**
   * ⚠️ `installExternalLinkHook` 内部会 `off('Runtime.consoleAPICalled')`
   *    再重装它自己的监听 —— 所以外面这个 `cdp.on` 会被**顶掉**。
   *    也就是说 URL 只能通过 `onUrl` 回调拿，不能在外面另挂监听。
   *    早先版本就是在这儿传了空回调 `() => {}`，URL 全被吞掉、
   *    误判成"拦截器没生效"，而其实拦截器一直是好的
   *    （页面那侧 `defaultPrevented: true` 已经证明它拦下了）。
   */
  const ok = await cdp.installExternalLinkHook((url) => got.push(url))
  console.log(`  installExternalLinkHook → ${ok ? '成功' : '失败'}`)
  const hooked = (await cdp.send('Runtime.evaluate', {
    expression: 'window.__aiquadLinkHooked === true',
    returnByValue: true,
  }))?.result?.value
  console.log(`  页面里 __aiquadLinkHooked = ${hooked}`)

  console.log('\n【②】页面上可点的链接：')
  const links = (await cdp.send('Runtime.evaluate', { expression: PICK, returnByValue: true }))?.result?.value || []
  if (!links.length) {
    console.log('  （这个页面上没有可点的链接）')
  }
  for (const l of links) {
    console.log(`  [${l.i}] "${l.text}" ${l.proto} target=${l.target ?? '(无)'} @${l.x},${l.y}`)
    console.log(`      ${String(l.href).slice(0, 80)}`)
  }

  // 挑一个：优先外部 http(s) 且有文字的，其次第一个
  const cand = links.find(l => l.proto === 'https:' && l.text && !/chatgpt\.com\/?$/.test(l.href))
    || links.find(l => l.proto === 'https:' && l.text)
    || links[0]
  if (!cand) {
    console.log('\n没有可点的链接，跳过真点验证。')
    cdp.close()
    return
  }

  console.log(`\n【③】真点一个： "${cand.text}"（${cand.target ? `target=${cand.target}` : '无 target'}）`)
  console.log(`  点之前 location.href = ${before}`)

  // 用真实鼠标事件（比 element.click() 可靠：它会走完整的命中测试与捕获链）
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: cand.x, y: cand.y, button: 'left', buttons: 1, clickCount: 1,
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: cand.x, y: cand.y, button: 'left', buttons: 0, clickCount: 1,
  })

  await new Promise(r => setTimeout(r, 1200))

  const after = (await cdp.send('Runtime.evaluate', {
    expression: 'location.href',
    returnByValue: true,
  }))?.result?.value

  console.log(`  点之后 location.href = ${after}`)
  console.log(`\n  拦截器收到的 URL：`)
  if (got.length) for (const u of got) console.log(`    ✓ ${u}`)
  else console.log('    （没收到 —— 拦截器没生效）')

  console.log('\n' + '='.repeat(68))
  const noNav = before === after
  const gotUrl = got.length > 0
  if (noNav && gotUrl) {
    console.log('★ 通过：页面没跳转（分格不会被换掉）+ URL 已交给主进程')
    console.log('  → 主进程会用系统默认浏览器打开它（此脚本刻意不真的打开）')
  }
  else if (!noNav) {
    console.log('✘ 失败：页面仍然跳转了 —— 拦截器没拦住。')
    console.log(`  ${before}\n  → ${after}`)
  }
  else {
    console.log('✘ 失败：页面没跳，但 URL 没报回来 —— 主进程收不到，无从转交。')
  }
  console.log('='.repeat(68))

  cdp.close()
  process.exit(noNav && gotUrl ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})