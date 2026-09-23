/**
 * 让还活着的预览实例把设置窗口重新开出来（并提到前台）。
 *
 * 上一轮那个预览实例（pid 25928）还在跑，面板窗口也在，只是设置窗口被关掉了。
 * 这里不重启实例，走和"用户点菜单"同一条路：面板页里调 window.aiquad.openSettings()。
 */
const path = require('node:path')
const ROOT = path.join(__dirname, '..')
const PORT = Number(process.env.AIQUAD_TEST_PORT || 9719)
const { CdpSession, listTargets } = require(path.join(ROOT, 'dist', 'main', 'cdp'))
const koffi = require(path.join(ROOT, 'node_modules', 'koffi'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const user32 = koffi.load('user32.dll')
const FindWindowW = user32.func('void *FindWindowW(const char16_t *cls, const char16_t *title)')
const IsWindowVisible = user32.func('bool IsWindowVisible(void *hwnd)')
const GetWindowRect = user32.func('bool GetWindowRect(void *hwnd, _Out_ int *r)')
const SetForegroundWindow = user32.func('bool SetForegroundWindow(void *hwnd)')
const ShowWindow = user32.func('bool ShowWindow(void *hwnd, int cmd)')
const SetWindowPos = user32.func('bool SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, unsigned int flags)')

async function main() {
  const targets = await listTargets(PORT, 1)
  console.log('[目标]', targets.map((t) => `${t.type} ${t.url.slice(-28)}`).join(' | '))

  const panel = targets.find((t) => /main\.html/.test(t.url))
  if (!panel) throw new Error('预览实例的面板目标没找到（实例可能已退出）')

  let set = targets.find((t) => /settings\.html/.test(t.url))
  if (!set) {
    const p = new CdpSession(panel.webSocketDebuggerUrl)
    await p.connect()
    const r = await p.send('Runtime.evaluate', { expression: 'window.aiquad && window.aiquad.openSettings()', returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) console.log('[提示] 面板里调 openSettings 抛错：', r.exceptionDetails.exception?.description)
    p.close()
    for (let i = 0; i < 30 && !set; i++) {
      await sleep(400)
      set = (await listTargets(PORT, 1)).find((t) => /settings\.html/.test(t.url))
    }
  } else {
    console.log('[窗口] 设置页目标已存在，直接热重载')
  }
  if (!set) throw new Error('设置窗口没起来')

  const s = new CdpSession(set.webSocketDebuggerUrl)
  await s.connect()
  await s.send('Page.reload', { ignoreCache: true })
  await sleep(1600)
  const ev = async (expr) => {
    const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '页面内异常')
    return r?.result?.value
  }
  const geo = await ev(`(() => {
    const cards = [...document.querySelectorAll('.st-card')]
    const pick = (n) => cards.find(c => (c.querySelector('h2')?.textContent || '').includes(n))
    const rowsOf = (n) => {
      const c = pick(n)
      if (!c) return null
      const out = {}
      for (const r of c.querySelectorAll('.st-row')) {
        const t = (r.querySelector('.st-row-label')?.textContent || '').trim().split('\\n')[0]
        const ctl = r.querySelector('.st-row-ctl')
        const tops = [...new Set([...ctl.children].map(k => Math.round(k.getBoundingClientRect().top)))]
        out[t] = tops.length + '行 h' + Math.round(r.getBoundingClientRect().height)
      }
      return out
    }
    return {
      视口: [innerWidth, innerHeight],
      两卡高: ['代理设置', '浏览器内核'].map(n => Math.round((pick(n)?.getBoundingClientRect().height) || 0)),
      代理设置: rowsOf('代理设置'),
      浏览器内核: rowsOf('浏览器内核'),
    }
  })()`)
  s.close()

  console.log('[页面] 视口 ' + geo.视口.join('x') + '｜两卡高 ' + geo.两卡高.join(' / '))
  for (const k of Object.keys(geo.代理设置 || {})) console.log('  代理设置 | ' + k.padEnd(6) + ' ' + geo.代理设置[k])
  for (const k of Object.keys(geo.浏览器内核 || {})) console.log('  浏览器内核 | ' + k.padEnd(6) + ' ' + geo.浏览器内核[k])

  // 提到前台
  let hwnd = 0
  for (const t of ['设置 · AIQuad', 'AIQuad · 设置', 'AIQuad']) {
    if (t === 'AIQuad') continue
    const h = FindWindowW(null, t)
    if (h) { hwnd = Number(h); break }
  }
  if (hwnd) {
    ShowWindow(hwnd, 9)
    SetWindowPos(hwnd, 0n, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
    SetForegroundWindow(hwnd)
    await sleep(400)
    const buf = Buffer.alloc(16)
    GetWindowRect(hwnd, buf)
    console.log(`[窗口] 可见=${!!IsWindowVisible(hwnd)} 矩形 ${buf.readInt32LE(0)},${buf.readInt32LE(4)} → ${buf.readInt32LE(8)},${buf.readInt32LE(12)}`)
  } else {
    console.log('[窗口] 按标题找不到 hwnd（不影响，窗口已经在屏幕上）')
  }
  console.log('[就绪] 设置窗口已经在屏幕上，请大王过目')
}

main().catch((e) => { console.log('失败：', String(e?.message || e)); process.exitCode = 1 })
