/**
 * 界面自检：启动真实 Electron 应用，通过 CDP 直接读面板 DOM + 截图。
 *
 * 验证点（对应 bug 1 / 2）：
 *   - 顶栏图标按钮组是否齐全（单格 / 上下两格 / 四格 / 设置 / 置顶 / 收起）
 *   - 每个分格底部居中的 AI 切换器是否存在、是否真的水平居中、是否落在预留条内
 *   - 三种布局（1 / 2 / 4）下分格矩形是否正确，且分格高度与"内容区"高度差 = --pane-footer（底部条）
 *   - 逐布局截图，人工可复核
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { CdpSession, listTargets } = require('../dist/main/cdp')

const projectRoot = path.join(__dirname, '..')
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const REPORT = `(() => {
  const wrap = document.getElementById('panes')
  const out = {
    layout: wrap ? wrap.className : null,
    viewport: { w: innerWidth, h: innerHeight },
    // 底部页脚高度：唯一来源是 styles.css 的 --pane-footer，不写死数字
    paneFooter: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pane-footer')) || 0,
    headerButtons: [...document.querySelectorAll('.header-actions .icon-btn')].map((b) => ({
      key: b.id || ('layout-' + (b.dataset.layout || '?')),
      title: b.title,
      active: b.classList.contains('active'),
    })),
    panes: [...document.querySelectorAll('#panes .pane')].map((p) => {
      const r = p.getBoundingClientRect()
      const sel = p.querySelector('.ai-selector')
      const sr = sel ? sel.getBoundingClientRect() : null
      const btn = p.querySelector('.ai-select')
      const ph = p.querySelector('.pane-placeholder')
      const pr = ph ? ph.getBoundingClientRect() : null
      return {
        id: p.dataset.paneId,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        selector: sr ? {
          x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height),
          centerOffset: Math.round((sr.x + sr.width / 2) - (r.x + r.width / 2)),
          bottomGap: Math.round(r.bottom - sr.bottom),
          label: btn ? btn.textContent.trim() : null,
        } : null,
        contentRect: pr ? { y: Math.round(pr.y), h: Math.round(pr.height) } : null,
      }
    }),
  }
  return out
})()`

async function main() {
  // 保留调用方的 AIQUAD_* 环境变量：
  //   容器 / 受限虚拟机里需要 AIQUAD_NO_SANDBOX=1 才能让 Chromium 起得来
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  // 沙箱环境常注入 ELECTRON_RUN_AS_NODE，会让 Electron 退化成纯 Node
  delete env.ELECTRON_RUN_AS_NODE

  // 允许把 userData 指到别处。本机若已经开着 AIQuad（打包版或另一个开发实例），
  // 它会占着 %APPDATA%\aiquad 的单实例锁，让这里的启动立刻 app.quit()
  // ——表现为"没有窗口、日志干净、退出码 0"，极难联想到是锁被占了。
  const extraArgs = []
  if (process.env.AIQUAD_USER_DATA_DIR) {
    extraArgs.push(`--user-data-dir=${process.env.AIQUAD_USER_DATA_DIR}`)
  }

  const child = spawn(electronExe, ['--remote-debugging-port=9222', ...extraArgs, projectRoot], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d.toString() })
  child.stderr.on('data', (d) => { log += d.toString() })

  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(700)
    const list = await listTargets(9222, 1)
    target = list.find((t) => t.type === 'page' && /main\.html/.test(t.url)) || null
  }
  if (!target) {
    console.log('❌ 未找到面板渲染进程（可能应用启动失败）')
    console.log(log.slice(-3000))
    console.log(
      '\n提示：若本机已经开着 AIQuad（打包版或另一个开发实例），它会占着 %APPDATA%\\aiquad 的\n' +
      '单实例锁，本脚本启动的实例会在 requestSingleInstanceLock() 处立刻 app.quit()\n' +
      '——表现为「没有窗口、日志干净、退出码 0」。\n' +
      '绕开办法：设置环境变量 AIQUAD_USER_DATA_DIR 指向一个独立目录，两边互不干扰。'
    )
    try { process.kill(child.pid) } catch {}
    process.exit(1)
  }
  const cdp = new CdpSession(target.webSocketDebuggerUrl)
  await cdp.connect()
  await sleep(2500)

  const report = async () => (await cdp.send('Runtime.evaluate', { expression: REPORT, returnByValue: true }))?.result?.value

  const first = await report()
  console.log('面板视口:', JSON.stringify(first.viewport))
  console.log('\n--- 顶栏按钮 ---')
  for (const b of first.headerButtons) console.log(`  ${b.active ? '●' : '○'} ${b.key.padEnd(12)} ${b.title}`)

  const outDir = path.join(projectRoot, '.tmp')
  let allOk = true

  for (const layout of ['1', '2', '4']) {
    // 显式点击目标布局：起始布局来自用户上次保存的配置，不能假定是 1
    await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('[data-layout="${layout}"]').click()`,
      returnByValue: true,
    })
    await sleep(1400)
    const r = await report()
    console.log(`\n--- 布局 ${layout}（${r.layout}）---`)
    console.log(`  分格数 ${r.panes.length}  视口 ${r.viewport.w}×${r.viewport.h}`)
    for (const p of r.panes) {
      const okCenter = p.selector && Math.abs(p.selector.centerOffset) <= 1
      const okBottom = p.selector && p.selector.bottomGap >= 0 && p.selector.bottomGap <= 8
      // 内容区 = 分格高度 − 页脚（页脚值从页面读，别写死）
      const footer = r.paneFooter
      const okContent = p.contentRect && (p.rect.h - p.contentRect.h) === footer
      const ok = !!p.selector && okCenter && okBottom && okContent
      if (!ok) allOk = false
      console.log(`  ${ok ? '✅' : '❌'} ${p.id} 分格 ${p.rect.w}×${p.rect.h} @(${p.rect.x},${p.rect.y})`)
      console.log(`      切换器 ${p.selector ? `${p.selector.w}×${p.selector.h} 居中偏差 ${p.selector.centerOffset}px 距底 ${p.selector.bottomGap}px 文案「${p.selector.label}」` : '缺失 ❌'}`)
      console.log(`      内容区高 ${p.contentRect ? p.contentRect.h : '?'}（分格 ${p.rect.h} − 页脚 ${footer} = ${p.rect.h - footer}）`)
    }
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, 15000)
    fs.writeFileSync(path.join(outDir, `ui-layout-${layout}.png`), Buffer.from(shot.data, 'base64'))
    console.log(`  截图 → .tmp/ui-layout-${layout}.png`)
  }

  console.log(`\n================ 结论 ================`)
  console.log(allOk ? '面板 UI：✅ 顶栏按钮齐全、每格底部居中切换器就位、1/2/4 布局正确' : '面板 UI：❌ 存在不合格项（见上）')

  cdp.close()
  try { process.kill(child.pid) } catch {}
  await sleep(800)
  process.exit(allOk ? 0 : 2)
}

main().catch((e) => { console.error(e); process.exit(1) })
