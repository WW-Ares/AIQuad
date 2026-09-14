import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface BrowserInfo {
  id: 'chrome' | 'edge'
  name: string
  exePath: string
  version?: string
}

interface Candidate {
  id: 'chrome' | 'edge'
  name: string
  /** 可执行文件名，例如 chrome.exe / msedge.exe */
  exeName: string
  /** 候选的 Application 目录（按优先级排列） */
  appDirs: string[]
  /** 注册表 App Paths 键（升级后依然可靠） */
  regKeys: string[]
}

function expand(p: string): string {
  return p.replace(/%([^%]+)%/g, (_, key: string) => process.env[key] ?? '')
}

function candidates(): Candidate[] {
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const local = process.env['LOCALAPPDATA'] ?? ''
  const appPaths = (exe: string) => [
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
  ]
  return [
    {
      id: 'chrome',
      name: 'Google Chrome',
      exeName: 'chrome.exe',
      appDirs: [
        path.join(local, 'Google', 'Chrome', 'Application'),
        path.join(pf, 'Google', 'Chrome', 'Application'),
        path.join(pf86, 'Google', 'Chrome', 'Application'),
      ],
      regKeys: appPaths('chrome.exe'),
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      exeName: 'msedge.exe',
      appDirs: [
        path.join(pf86, 'Microsoft', 'Edge', 'Application'),
        path.join(pf, 'Microsoft', 'Edge', 'Application'),
        path.join(local, 'Microsoft', 'Edge', 'Application'),
      ],
      regKeys: appPaths('msedge.exe'),
    },
  ]
}

/**
 * 从注册表 `App Paths` 读浏览器真实路径。
 *
 * 为什么不能只靠固定路径：Chrome 升级会把安装从**用户级**（%LOCALAPPDATA%）
 * 迁到**系统级**（%ProgramFiles%），原路径直接被删掉。
 * 注册表是安装器自己维护的，最不容易过期。
 */
async function regAppPath(key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', key, '/ve'], { windowsHide: true, timeout: 3000 })
    // 形如：    (默认)    REG_SZ    C:\Program Files\Google\Chrome\Application\chrome.exe
    const m = String(stdout).match(/REG_SZ\s+(.+?)\s*$/m)
    const p = m?.[1]?.trim().replace(/^"|"$/g, '')
    return p && fs.existsSync(p) ? p : null
  }
  catch {
    return null
  }
}

/** 版本号目录名（例如 150.0.7871.125）按数值排序取最大 */
function pickHighestVersionDir(appDir: string, exeName: string): { exe: string, version: string } | null {
  let best: { exe: string, version: string, key: number[] } | null = null
  try {
    for (const entry of fs.readdirSync(appDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const ver = entry.name
      if (!/^\d+(\.\d+)+$/.test(ver)) continue
      const exe = path.join(appDir, ver, exeName)
      if (!fs.existsSync(exe)) continue
      const key = ver.split('.').map(Number)
      if (!best || compareVersions(key, best.key) > 0) best = { exe, version: ver, key }
    }
  }
  catch {}
  return best ? { exe: best.exe, version: best.version } : null
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** Application 目录下版本子目录名即版本号，不用调外部命令 */
function versionFromAppDir(appDir: string): string | undefined {
  try {
    const vers = fs.readdirSync(appDir).filter((n) => /^\d+(\.\d+)+$/.test(n))
    vers.sort((a, b) => compareVersions(a.split('.').map(Number), b.split('.').map(Number)))
    return vers[vers.length - 1]
  }
  catch {
    return undefined
  }
}

/**
 * 把某个浏览器的候选位置逐个验真，返回第一个**真实存在**的 exe。
 *
 * 顺序刻意是"先文件系统、后注册表"：
 * 文件系统判断是同步且零成本的，注册表要起一个 `reg.exe` 子进程
 * （受限环境里它可能被安全策略拦掉，或被拖慢），所以只在前两条都没命中时才用。
 */
async function resolveCandidate(c: Candidate): Promise<BrowserInfo | null> {
  // 1. 标准位置：Application\<exe>
  for (const dir of c.appDirs) {
    if (!dir) continue
    const exe = path.join(dir, c.exeName)
    if (fs.existsSync(exe)) return { id: c.id, name: c.name, exePath: exe, version: versionFromAppDir(dir) }
  }
  // 2. 兜底：只剩版本目录的畸形安装
  for (const dir of c.appDirs) {
    if (!dir) continue
    const found = pickHighestVersionDir(dir, c.exeName)
    if (found) return { id: c.id, name: c.name, exePath: found.exe, version: found.version }
  }
  // 3. 非常规安装位置：注册表 App Paths
  for (const key of c.regKeys) {
    const hit = await regAppPath(key)
    if (hit) return { id: c.id, name: c.name, exePath: hit, version: versionFromAppDir(path.dirname(hit)) }
  }
  return null
}

export async function detectBrowsers(): Promise<BrowserInfo[]> {
  const list: BrowserInfo[] = []
  for (const c of candidates()) {
    const hit = await resolveCandidate(c)
    if (hit) list.push(hit)
  }
  return list
}

/**
 * 解析出一个可用的浏览器。
 *
 * 每次调用都重新验真，所以**可以在 spawn 失败后直接拿它重新探测**
 * （浏览器升级/迁移会让上次解析出来的路径失效）。
 */
export async function pickBrowser(preference: 'chrome' | 'edge' | 'auto', customPath?: string): Promise<BrowserInfo | null> {
  if (customPath) {
    const p = expand(customPath.trim())
    if (p && fs.existsSync(p)) return { id: 'chrome', name: path.basename(p), exePath: p }
  }
  const list = await detectBrowsers()
  if (!list.length) return null
  if (preference !== 'auto') {
    const hit = list.find((b) => b.id === preference)
    if (hit) return hit
  }
  return list.find((b) => b.id === 'chrome') ?? list[0]
}
