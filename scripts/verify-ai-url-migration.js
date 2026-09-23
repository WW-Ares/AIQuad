/**
 * 验证 AI 网址迁移（CONFIG_VERSION 5 → 6）。
 *
 * 要验证的核心事实：`normalize()` 合并配置时是 `{...base, ...a}`，**用户值覆盖默认值**，
 * 所以光改 DEFAULT_AI 修不了老配置。必须靠迁移表把"仍是历史默认值"的那条订正过来。
 *
 *   ① 老配置仍是历史默认值  → 应被订正为 qianwen.com / 千问，并把版本写回 6
 *   ② 用户自己改过网址/名称  → 必须原样保留（不能强改）
 *   ③ 全新安装（无配置）    → 默认值就该是新网址
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ConfigStore } = require(path.join(__dirname, '..', 'dist', 'main', 'config.js'))

let fail = 0
function assert(cond, msg) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!cond) fail++
}

function seed(patch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiquad-cfg-'))
  const legacy = {
    version: 5,
    layout: '1',
    aiList: [
      { id: 'qwen', name: '通义千问', url: 'https://chat.qwen.ai/', category: 'cn', logo: 'qwen.png', proxyMode: 'direct', builtin: true },
      { id: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', category: 'cn', logo: 'deepseek.png', proxyMode: 'direct', builtin: true },
    ],
    panes: [{ id: 'p1', aiId: 'qwen' }, { id: 'p2', aiId: 'deepseek' }],
  }
  if (patch) Object.assign(legacy.aiList[0], patch)
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(legacy))
  return dir
}

function readQwen(dir) {
  const store = new ConfigStore(dir)
  const mem = store.get().aiList.find((a) => a.id === 'qwen')
  const diskRaw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
  const disk = diskRaw.aiList.find((a) => a.id === 'qwen')
  return { mem, disk, diskVersion: diskRaw.version }
}

/* ① 老配置（仍是历史默认值） */
console.log('\n[① 老配置，qwen 仍是历史默认值]')
{
  const dir = seed()
  const { mem, disk, diskVersion } = readQwen(dir)
  console.log(`  内存 url=${mem.url}  name=${mem.name}`)
  console.log(`  落盘 url=${disk.url}  version=${diskVersion}`)
  assert(mem.url === 'https://www.qianwen.com/', '内存中 url 订正为 qianwen.com')
  assert(mem.name === '千问', '内存中 name 订正为「千问」')
  assert(disk.url === 'https://www.qianwen.com/', '订正结果已写回磁盘')
  assert(diskVersion === 6, '版本号已写回 6（迁移只跑一次）')
  fs.rmSync(dir, { recursive: true, force: true })
}

/* ② 用户自己改过 —— 必须原样保留 */
console.log('\n[② 用户自定义过 url/name]')
{
  const dir = seed({ url: 'https://my-own-qwen.example/', name: '我的千问' })
  const { mem } = readQwen(dir)
  console.log(`  内存 url=${mem.url}  name=${mem.name}`)
  assert(mem.url === 'https://my-own-qwen.example/', '自定义 url 保持原样')
  assert(mem.name === '我的千问', '自定义 name 保持原样')
  fs.rmSync(dir, { recursive: true, force: true })
}

/* ③ 全新安装 */
console.log('\n[③ 全新安装，无 config.json]')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiquad-cfg-new-'))
  const qwen = new ConfigStore(dir).get().aiList.find((a) => a.id === 'qwen')
  console.log(`  默认 url=${qwen.url}  name=${qwen.name}`)
  assert(qwen.url === 'https://www.qianwen.com/', '默认值即 qianwen.com')
  assert(qwen.name === '千问', '默认名称即「千问」')
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(fail === 0 ? '\n全部通过 ✅' : `\n有 ${fail} 项失败 ❌`)
process.exit(fail === 0 ? 0 : 1)
