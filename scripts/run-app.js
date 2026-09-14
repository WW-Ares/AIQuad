/**
 * 集成试跑：启动 Electron 应用若干秒，收集输出后结束进程。
 * 用法：node scripts/run-app.js [seconds]
 */
const { spawn } = require('child_process')
const path = require('path')

const seconds = Number(process.argv[2] || 25)
const projectRoot = path.join(__dirname, '..')
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const node = process.execPath

console.log(`启动 Electron ${seconds}s ...`)
const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1', AIQUAD_DISABLE_GPU: '1' }
// 沙箱环境可能注入 ELECTRON_RUN_AS_NODE，会让 Electron 退化成纯 Node
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electronExe, ['--in-process-gpu', '--disable-gpu', projectRoot, '--enable-logging'], {
  cwd: projectRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let out = ''
child.stdout.on('data', (d) => { out += d.toString() })
child.stderr.on('data', (d) => { out += d.toString() })

setTimeout(() => {
  console.log('--- 输出 ---')
  console.log(out.slice(-8000))
  console.log('--- 结束进程 ---')
  try { process.kill(child.pid) } catch {}
  setTimeout(() => process.exit(0), 1500)
}, seconds * 1000)
