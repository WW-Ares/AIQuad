/**
 * 验证链接拦截器对**下载类链接**的处理（2026-10-08）。
 *
 * 为什么单独一个脚本：下载是最容易被这个拦截器误伤的地方。
 * `download` 属性一旦被拦下，跨域资源会**静默丢掉下载**——点了没反应，
 * 用户根本不会想到是AIQuad干的。
 *
 * 期望（这张表就是设计意图，改代码后拿它对照）：
 *   | 形态                    | 被拦 | 谁处理 |
 *   |-------------------------|------|--------|
 *   | `<a download>` 跨域      | 否   | 分格浏览器下载 |
 *   | `blob:` + download      | 否   | 分格浏览器下载 |
 *   | 普通链接（无 download）  | 是   | 系统浏览器打开 |
 *   | `target=_blank`         | 是   | 系统浏览器打开 |
 *   | 纯锚点 `#foo`| 否   | 页内定位 |
 *   | `mailto:` / `tel:`      | 否   | 交给页面（唤起外部程序）|
 *
 * ⚠️ **必须在真实 https 页面上测，不能用 `data:` URL** ——
 *    `data:` 页面的 `document.baseURI` 就是 `data:`，
 *    `new URL(href, base)` 走的是另一套解析，结果全都不一样
 *    （这个坑让本脚本的前身白跑一轮，报出"全都不拦"的假象）。
 * ⚠️ **也不要用 AI 站点本身测**（GPT/Claude…）—— 它们有自己的事件处理，
 *    合成事件会被吞掉、`elementFromPoint` 也未必落在链接上，
 *    报出来的结果与真实行为无关（这个坑又让本脚本白跑一轮）。
 *    用 `https://example.com` 这种干净页面，站内/外部靠**构造 URL** 来对照。
 *
 * ⚠️ 只在**分格浏览器**里新开一个临时标签页，绝不碰大王正在用的分格；
 *    测完立刻 `/json/close` 关掉，不留残页。
 *
 * 用法：node scripts/verify-external-link-dl.js [分格端口]
 */
const fs = require('node:fs')
const path = require('node:path')
const { CdpSession, listPageTargets, buildExternalLinkScript, EXTERNAL_LINK_TAG, siteHostsFromUrls } = require('../dist/main/cdp')

const PORT = Number(process.argv[2] || 0)

async function main() {
  if (!PORT) {
    console.error('用法：node scripts/verify-external-link-dl.js <分格浏览器端口>')
    console.error('端口在 <userData>/profiles/shared/DevToolsActivePort 的第一行')
    process.exit(2)
  }

  // 新开一个临时标签页，绝不动大王正在用的分格
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  const page = await res.json()
  const cdp = new CdpSession(page.webSocketDebuggerUrl)
  await cdp.connect()
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  const cleanup = async () => {
    try { await fetch(`http://127.0.0.1:${PORT}/json/close/${page.id}`) } catch {}
    try { cdp.close() } catch {}
  }

  try {
    // 真实 https 页面 —— 判据要靠它，见文件头的警告
    await cdp.send('Page.navigate', { url: 'https://example.com/' })
    await new Promise(r => setTimeout(r, 2500))
    const base = (await cdp.send('Runtime.evaluate', { returnByValue: true, expression: 'document.baseURI' }))?.result?.value
    if (!/^https?:/.test(base || '')) {
      console.error(`baseURI 不正常（${base}）—— 这个脚本必须在 https 页面���测，否则判据失真`)
      await cleanup()
      process.exit(2)
    }
    console.log(`测试页：${base}\n`)

    /**
     * 站点清单从**真实配置**算，别写死。
     * ⚠️ 写成 `['example.com']` 的话，"站内"用例解析出来也是 example.com，
     * 全部落进清单里被放行、外部用例反而判错 —— 期望值整个反过来。
     */
    let siteHosts = []
    try {
      const cfgPath = path.join(process.env.APPDATA || '', 'aiquad', 'config.json')
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      siteHosts = siteHostsFromUrls((cfg.aiList || []).map(a => a.url))
    }
    catch (e) {
      console.warn(`读不到配置里的站点清单（${e.message}），站内用例将无法覆盖`)
    }
    console.log(`站点清单（站内链接放行）：${siteHosts.join(', ') || '(空)'}`)
    const hooked = (await cdp.send('Runtime.evaluate', { returnByValue: true, expression: buildExternalLinkScript(siteHosts) }))?.result?.value
    console.log(`拦截器安装：${hooked}\n`)

    const tags = []
    cdp.on('Runtime.consoleAPICalled', (p) => {
      for (const a of (p?.args || [])) {
        if (typeof a?.value === 'string' && a.value.startsWith(EXTERNAL_LINK_TAG)) {
          tags.push(a.value.slice(EXTERNAL_LINK_TAG.length))
        }
      }
    })

    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const mk = (h) => { const d = document.createElement('div'); d.innerHTML = h; document.body.appendChild(d) };
        mk('<a id=a1 href="/README.md" download="x.md">1</a>');
        mk('<a id=a2 href="/some-page">3</a>');
        mk('<a id=a3 href="/" download="b.txt">2</a>');
        mk('<a id=a4 href="https://example.org/" target="_blank">4</a>');
        mk('<a id=a5 href="#x">5</a>');
        mk('<a id=a6 href="mailto:x@y.z">6</a>');
        mk('<a id=a7 href="/c/6ac6fa1c-5870-83ee-8926-c359ceadba1a">7</a>');
        mk('<a id=a8 href="/projects">8</a>');
        const b = new Blob(['hi'], { type: 'text/plain' });
        document.getElementById('a3').href = URL.createObjectURL(b);
      })()`,
      returnByValue: true,
    })
    await new Promise(r => setTimeout(r, 400))

    // [元素 id, 形态, 期望是否被拦]
    const cases = [
      ['a1', '带 download 跨域', false],
      ['a3', 'blob: + download', false],
      ['a2', '普通链接（无 download）', true],
      ['a4', 'target=_blank', true],
      ['a5', '纯锚点 #foo', false],
      ['a6', 'mailto:', false],
      // ⚠️ 0.4.13 大王实测踩的坑：只看协议不看域名 → 站内导航（切换历史会话、
      // 侧栏栏位）全被转交到系统浏览器，整个 AI 站点被踢出分格。这两条是回归护栏。
      // ⚠️ 必须用**绝对 URL**：本页是 example.com，写相对路径解析出来还是
      // example.com，不在站点清单里，期望值就反了（这个坑让本脚本白跑过一轮）。
      ['a7', '站内 /c/…（历史会话）', false, 'https://chatgpt.com/c/6ac6fa1c-abc'],
      ['a8', '站内 /projects（侧栏）', false, 'https://chatgpt.com/projects'],
    ]

    console.log('  形态                    | 实际被拦 | 期望       | 交给谁')
    console.log('  -----------------------+----------+------------+--------------------------')
    let bad = 0
    for (const [id, label, expectBlock, absHref] of cases) {
      tags.length = 0
      const r = (await cdp.send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          const a = document.getElementById('${id}');
          if (!a) return 'noel';
          ${absHref ? `a.setAttribute('href', ${JSON.stringify(absHref)});` : ''}
          const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
          a.dispatchEvent(ev);
          return ev.defaultPrevented ? 'yes' : 'no';
        })()`,
      }))?.result?.value
      await new Promise(x => setTimeout(x, 320))
      const blocked = r === 'yes'
      const ok = blocked === expectBlock
      if (!ok) bad++
      console.log(`  ${label.padEnd(23)}| ${String(blocked).padEnd(8)} | ${String(expectBlock).padEnd(10)} | ${tags.length ? '系统浏览器' : '页面自己处理'}${ok ? '' : '   ← 不符！'}`)
    }

    console.log('\n' + '='.repeat(64))
    if (bad === 0) {
      console.log(`★ ${cases.length} 项全部符合设计：`)
      console.log('  ·下载类（download / blob:）→ 不拦，分格自己下载')
      console.log('  · 站内导航（历史会话 / 侧栏栏位）→ 不拦，原地发生')
      console.log('  · 外部网站链接 → 转交系统浏览器')
    }
    else {
      console.log(`✘ ${bad} 项不符 —— 下载可能被误伤，必须修。`)
    }
    console.log('='.repeat(64))
    await cleanup()
    process.exit(bad === 0 ? 0 : 1)
  }
  catch (e) {
    await cleanup()
    console.error(e)
    process.exit(1)
  }
}

main()