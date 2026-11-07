/**
 * 开机启动门的状态机自检（纯 Node，不需要 Electron、不启动任何实例）。
 *
 * 用法：npm run build && node scripts/assert-startup-gate.js
 *
 * 覆盖：开关关闭 / 空目标 / 首轮就绪 / 多轮重试后才就绪 / 一直不通超时降级 /
 * 用户手动启动打断 / 系统代理重读失败仍继续 / 代理判据（共享 / 直连 / 自定义）。
 * 时钟、睡眠、探测、退避全部注入，整套跑完不到一秒。
 */
const path = require('node:path')
const assert = require('node:assert/strict')

const ROOT = path.join(__dirname, '..')
let gate
let proxy
try {
  gate = require(path.join(ROOT, 'dist', 'main', 'startup-gate'))
  proxy = require(path.join(ROOT, 'dist', 'main', 'proxy'))
}
catch (e) {
  console.error('需要先编译：npm run build')
  throw e
}

const { waitForNetworkReady } = gate
const { proxyForAi } = proxy

const GLOBAL_PROXY = {
  mode: 'system', type: 'http', host: '', port: '', bypassList: '',
  systemServer: '127.0.0.1:7890', systemType: 'http',
}

const baseCfg = (patch = {}) => ({
  startupWaitNetwork: true,
  startupWaitMaxSec: 0.3,
  startupDelaySec: 0,
  sharedSession: true,
  proxy: { ...GLOBAL_PROXY },
  ...patch,
})

const target = (url, proxyMode = 'global', custom = undefined) => ({
  url,
  ai: { proxyMode, proxy: custom },
})

const fastSleep = () => new Promise((r) => setTimeout(r, 1))
const fastBackoff = [0, 1, 1, 1]
const quiet = () => {}

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`PASS  ${name}`)
  }
  catch (e) {
    results.push(`FAIL  ${name}: ${e.message}`)
    process.exitCode = 1
  }
}

async function main() {
  await check('开关关闭 → disabled，一次都不探测', async () => {
    let probes = 0
    const r = await waitForNetworkReady({
      cfg: baseCfg({ startupWaitNetwork: false }),
      targets: [target('https://chatgpt.com/')],
      refreshGlobalProxy: async () => GLOBAL_PROXY,
      probe: async () => { probes += 1; return { ok: true } },
      backoffMs: fastBackoff, sleep: fastSleep, log: quiet,
    })
    assert.equal(r.reason, 'disabled')
    assert.equal(r.rounds, 0)
    assert.equal(probes, 0)
  })

  await check('没有可见分格 → no-target，不空转', async () => {
    const r = await waitForNetworkReady({
      cfg: baseCfg(), targets: [], refreshGlobalProxy: async () => GLOBAL_PROXY,
      backoffMs: fastBackoff, sleep: fastSleep, log: quiet,
    })
    assert.equal(r.reason, 'no-target')
    assert.equal(r.rounds, 0)
  })

  await check('首轮全通 → ready，且只读一次系统代理', async () => {
    let refreshed = 0
    let probes = 0
    const r = await waitForNetworkReady({
      cfg: baseCfg(),
      targets: [target('https://chatgpt.com/'), target('https://www.qianwen.com/')],
      refreshGlobalProxy: async () => { refreshed += 1; return GLOBAL_PROXY },
      probe: async () => { probes += 1; return { ok: true } },
      backoffMs: fastBackoff, sleep: fastSleep, log: quiet,
    })
    assert.equal(r.reason, 'ready')
    assert.equal(r.rounds, 1)
    assert.equal(probes, 2)
    assert.equal(refreshed, 1)
    assert.deepEqual(r.lastErrors, [])
  })

  await check('前两轮不通、第三轮通 → ready；系统代理每轮重读', async () => {
    let probes = 0
    let refreshed = 0
    const snapshots = []
    const r = await waitForNetworkReady({
      cfg: baseCfg(),
      targets: [target('https://chatgpt.com/')],
      refreshGlobalProxy: async () => {
        refreshed += 1
        const p = { ...GLOBAL_PROXY, systemServer: `127.0.0.1:${7890 + refreshed}` }
        snapshots.push(p.systemServer)
        return p
      },
      probe: async (_proxy, _url) => {
        probes += 1
        return probes >= 3 ? { ok: true } : { ok: false, error: '代理没开' }
      },
      backoffMs: fastBackoff, sleep: fastSleep, log: quiet,
    })
    assert.equal(r.reason, 'ready')
    assert.equal(r.rounds, 3)
    assert.equal(refreshed, 3)
    assert.deepEqual(snapshots, ['127.0.0.1:7891', '127.0.0.1:7892', '127.0.0.1:7893'])
  })

  await check('一直不通 → 到上限 timeout，绝不把启动卡死', async () => {
    const started = Date.now()
    const r = await waitForNetworkReady({
      cfg: baseCfg({ startupWaitMaxSec: 0.06 }),
      targets: [target('https://chatgpt.com/')],
      refreshGlobalProxy: async () => GLOBAL_PROXY,
      probe: async () => ({ ok: false, error: 'ECONNREFUSED' }),
      backoffMs: fastBackoff, sleep: fastSleep, log: quiet,
    })
    assert.equal(r.reason, 'timeout')
    assert.ok(r.rounds >= 1)
    assert.ok(Date.now() - started < 800, `实际耗时 ${Date.now() - started}ms，超出预期`)
    assert.ok(r.lastErrors.some((s) => s.includes('chatgpt.com')))
  })

  await check('用户手动启动打断 → interrupted', async () => {
    let probes = 0
    const r = await waitForNetworkReady({
      cfg: baseCfg(),
      targets: [target('https://chatgpt.com/')],
      refreshGlobalProxy: async () => GLOBAL_PROXY,
      probe: async () => { probes += 1; return { ok: false, error: '还没好' } },
      interrupted: () => probes >= 1,
      backoffMs: fastBackoff, sleep: fastSleep, log: quiet,
    })
    assert.equal(r.reason, 'interrupted')
    assert.equal(r.rounds, 1)
  })

  await check('重读系统代理抛错 → 沿用现有配置，仍能放行', async () => {
    const r = await waitForNetworkReady({
      cfg: baseCfg(),
      targets: [target('https://chatgpt.com/')],
      refreshGlobalProxy: async () => { throw new Error('注册表读不到') },
      probe: async () => ({ ok: true }),
      backoffMs: fastBackoff, sleep: fastSleep, log: quiet,
    })
    assert.equal(r.reason, 'ready')
  })

  await check('共享会话：分格代理模式不生效，一律用全局', () => {
    const p = proxyForAi(target('https://x.com/', 'direct').ai, GLOBAL_PROXY, true)
    assert.equal(p, GLOBAL_PROXY)
  })

  await check('独立会话：direct → mode none；custom → 自定义；global → 全局', () => {
    const custom = { ...GLOBAL_PROXY, mode: 'custom', host: '10.0.0.1', port: '1080' }
    assert.equal(proxyForAi(target('https://x.com/', 'direct').ai, GLOBAL_PROXY, false).mode, 'none')
    assert.equal(proxyForAi(target('https://x.com/', 'custom', custom).ai, GLOBAL_PROXY, false).host, '10.0.0.1')
    assert.equal(proxyForAi(target('https://x.com/', 'global').ai, GLOBAL_PROXY, false).mode, 'system')
  })

  await check('探测收到的代理与启动参数共用同一份判据', async () => {
    const seen = []
    await waitForNetworkReady({
      cfg: baseCfg({ sharedSession: false }),
      targets: [
        target('https://chatgpt.com/', 'global'),
        target('https://www.qianwen.com/', 'direct'),
      ],
      refreshGlobalProxy: async () => GLOBAL_PROXY,
      probe: async (p, url) => { seen.push(`${new URL(url).hostname}=${p.mode}`); return { ok: true } },
      backoffMs: fastBackoff, sleep: fastSleep, log: quiet,
    })
    assert.deepEqual(seen.sort(), ['chatgpt.com=system', 'www.qianwen.com=none'])
  })

  await check('设置页新增控件 id 与 HTML 对得上', () => {
    const fs = require('node:fs')
    const js = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.js'), 'utf8')
    const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.html'), 'utf8')
    const ids = [...new Set([...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]))]
    const missing = ids.filter((id) => !html.includes(`id="${id}"`))
    assert.deepEqual(missing, [])
    for (const id of ['startup-delay-sec', 'startup-wait-sec', 'opt-startup-wait']) {
      assert.ok(html.includes(`id="${id}"`), `缺 id=${id}`)
    }
  })

  await check('老配置（version 6、无新字段）升级后补默认值，用户值不被改', () => {
    const fs = require('node:fs')
    const os = require('node:os')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiquad-cfg-'))
    try {
      const old = {
        version: 6,
        autoStart: true,
        panes: [{ id: 'p1', aiId: 'deepseek' }],
        aiList: [{ id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', category: 'cn', proxyMode: 'direct' }],
        proxy: { mode: 'system', type: 'http', host: '', port: '', bypassList: '' },
      }
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(old))
      const { ConfigStore } = require(path.join(ROOT, 'dist', 'main', 'config'))
      const c = new ConfigStore(dir).get()
      assert.equal(c.version, 7)
      assert.equal(c.startupWaitNetwork, true)
      assert.equal(c.startupWaitMaxSec, 60)
      assert.equal(c.startupDelaySec, 10)
      assert.equal(c.autoStart, true)
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).version, 7)
    }
    finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  console.log(results.join('\n'))
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} 项通过`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
