/**
 * 打包版日志采集：启动 build/win-unpacked/AIQuad.exe，把主进程 stdout/stderr 全量打印出来。
 * 用法：node scripts/log-packaged.js [seconds]
 */
const path = require('node:path')
const { spawn } = require('node:child_process')

const seconds = Number(process.argv[2] || 25)
const projectRoot = path.join(__dirname, '..')
const packagedExe = path.join(projectRoot, 'build', 'win-unpacked', 'AIQuad.exe')

// 第二个参数传 "gpu" 表示不做任何降级，用真实 GPU 路径跑（用于判断 GPU 崩溃是否稳定复现）
const keepGpu = process.argv[3] === 'gpu'
const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
if (!keepGpu) { env.AIQUAD_DISABLE_GPU = '1'; env.AIQUAD_NO_SANDBOX = '1' }
delete env.ELECTRON_RUN_AS_NODE

console.log(`启动打包版 ${seconds}s，采集日志…`)
const child = spawn(packagedExe, ['--remote-debugging-port=9229', '--enable-logging'], {
  cwd: path.dirname(packagedExe), env, stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (d) => { out += d.toString() })
child.stderr.on('data', (d) => { out += d.toString() })
child.on('exit', (code) => { out += `\n[主进程退出 code=${code}]\n` })

setTimeout(async () => {
  console.log('--- 日志 ---')
  console.log(out.slice(-10000) || '(无输出)')
  try {
    const list = await (await fetch('http://127.0.0.1:9229/json/list')).json()
    console.log('--- CDP targets ---')
    console.log(list.map((t) => `${t.type} ${t.url}`).join('\n'))
  } catch (e) {
    console.log('CDP 不可达:', e.message)
  }
  try { process.kill(child.pid) } catch {}
  setTimeout(() => process.exit(0), 1200)
}, seconds * 1000)
