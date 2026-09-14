/**
 * 对照：跑源码版（node_modules/electron），只带 --remote-debugging-port，
 * 用来判断"GPU 进程崩溃"是打包引入的，还是本机环境本来就有的。
 * 用法：node scripts/log-dev.js [seconds] [gpu]
 */
const path = require('node:path')
const { spawn } = require('node:child_process')

const seconds = Number(process.argv[2] || 18)
const keepGpu = process.argv[3] === 'gpu'
const projectRoot = path.join(__dirname, '..')
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')

const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
if (!keepGpu) { env.AIQUAD_DISABLE_GPU = '1'; env.AIQUAD_NO_SANDBOX = '1' }
// 第四个参数传 "force"：强制重新尝试 GPU 路径（验证粘性能被解除）
if (process.argv[4] === 'force') env.AIQUAD_FORCE_GPU = '1'
delete env.ELECTRON_RUN_AS_NODE

console.log(`启动源码版 ${seconds}s（keepGpu=${keepGpu}）…`)
const child = spawn(electronExe, ['--remote-debugging-port=9224', projectRoot], {
  cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (d) => { out += d.toString() })
child.stderr.on('data', (d) => { out += d.toString() })
child.on('exit', (code) => { out += `\n[退出 code=${code}]\n` })

setTimeout(async () => {
  const gpuCrashes = (out.match(/GPU process has crashed/g) || []).length
  const fatal = /GPU process isn't usable/.test(out)
  console.log(`GPU 崩溃次数=${gpuCrashes} FATAL=${fatal}`)
  console.log(`存活性：${fatal ? '❌ 已崩溃退出' : '✅ 正常存活'}`)
  try {
    const list = await (await fetch('http://127.0.0.1:9224/json/list')).json()
    console.log('CDP targets:', list.map((t) => `${t.type} ${t.url}`).join(' | '))
  } catch (e) { console.log('CDP 不可达:', e.message) }
  try { process.kill(child.pid) } catch {}
  setTimeout(() => process.exit(0), 1200)
}, seconds * 1000)
