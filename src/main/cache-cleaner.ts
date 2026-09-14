import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 浏览器档案缓存清理。
 *
 * 背景：每个分格是一份独立的 Chrome 档案（--user-data-dir），
 * 里面除了登录态（Cookies / Local Storage / IndexedDB）之外，
 * 绝大部分体积是**随时能被浏览器重新生成的缓存**：Default/Cache、Default/Code Cache 之类。
 * 实测本机一份用了几天的档案里，Cache 66MB + Code Cache 150MB，占 Default 的 99%；
 * 九份档案加在一起 700 多 MB，其中近 500MB 是缓存。长期挂着不管，它会一直涨。
 *
 * 设计上的三条硬约束：
 *
 * 1. **白名单**。只删下面这张表里的路径，而且只删 `${profilesRoot}/<档案名>/...` 之下的东西。
 *    表外的一律不碰——宁可少删一点，也不能把登录态清掉让所有 AI 重新扫码。
 * 2. **不递归猜测**。路径必须是表里的精确名字，`Default/Local Storage` 这种前缀相似的邻居
 *    不会被误伤（按整段路径匹配，不做模糊包含）。
 * 3. **不阻塞主进程**。全量 stat 一遍七八百 MB 的小文件要几百毫秒到几秒，
 *    在主进程里同步走会让面板明显卡顿，所以扫描与清理一律用异步 fs，并发还要限住。
 *
 * ⚠️ 任何时候都不要给这张表加 profiles 之外的路径，也不要改成"文件名含 cache 就删"。
 */

/** 档案根目录下的可删目录（相对 `$profile/`） */
const ROOT_CACHE_NAMES = [
  'GrShaderCache',
  'ShaderCache',
  'GraphiteDawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUPersistentCache',
  'BrowserMetrics',
  'BrowserMetrics-spare',
] as const

/** `$profile/<Profile>/` 下的可删目录名（<Profile> 一般是 Default） */
const PROFILE_CACHE_NAMES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'Media Cache',
  'Video Decode Stats',
] as const

/** 需要下钻一层的两级路径 */
const PROFILE_CACHE_SUBPATHS = [
  'Service Worker/CacheStorage',
  'Service Worker/ScriptCache',
] as const

export interface CacheEntry {
  /** 相对档案根目录的路径，用于展示 */
  rel: string
  bytes: number
}

export interface ProfileCacheStat {
  name: string
  totalBytes: number
  cacheBytes: number
  entries: CacheEntry[]
}

export interface CacheStat {
  root: string
  profileCount: number
  totalBytes: number
  cacheBytes: number
  profiles: ProfileCacheStat[]
  /** 体积被打满 cap 提前收尾时为 true（真实值可能更大） */
  truncated: boolean
}

export interface CacheCleanResult {
  removedBytes: number
  removedItems: number
  skipped: { rel: string; reason: string }[]
}

/** 防止把别处的目录当成档案根目录传进来 */
function assertInside(root: string, abs: string) {
  const rel = path.relative(root, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`拒绝操作档案目录之外的路径：${abs}`)
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const items = await fsp.readdir(dir, { withFileTypes: true })
    return items.filter((i) => i.isDirectory() && !i.isSymbolicLink()).map((i) => i.name)
  }
  catch {
    return []
  }
}

/** 展开某个档案的所有白名单缓存路径 */
async function cacheTargets(profileDir: string): Promise<{ abs: string; rel: string }[]> {
  const out: { abs: string; rel: string }[] = []
  const add = (rel: string) => out.push({ abs: path.join(profileDir, ...rel.split('/')), rel })
  for (const n of ROOT_CACHE_NAMES) add(n)
  // --user-data-dir 下面通常是 Default，也可能是 Profile 1 / System Profile
  for (const c of await listDirs(profileDir)) {
    for (const n of PROFILE_CACHE_NAMES) add(`${c}/${n}`)
    for (const n of PROFILE_CACHE_SUBPATHS) add(`${c}/${n}`)
  }
  return out
}

/**
 * 递归统计目录大小。
 *
 * cap 用来控制开销：只想知道"有没有超过阈值"时传一个小值，数到就停。
 * 并发限在 8：一份 Code Cache 里有上万个文件，全放开会把磁盘打满队列，
 * 全排队又太慢（几万次串行 await 要好几秒）。
 */
async function dirSize(dir: string, budget: { bytes: number; truncated: boolean }, cap = Number.MAX_SAFE_INTEGER): Promise<void> {
  if (budget.bytes >= cap) {
    budget.truncated = true
    return
  }
  let items
  try {
    items = await fsp.readdir(dir, { withFileTypes: true })
  }
  catch {
    return
  }
  const queue: Promise<void>[] = []
  for (const it of items) {
    if (budget.bytes >= cap) {
      budget.truncated = true
      return
    }
    const abs = path.join(dir, it.name)
    if (it.isDirectory()) {
      queue.push(dirSize(abs, budget, cap))
    }
    else if (it.isFile()) {
      queue.push(fsp.stat(abs).then((st) => {
        budget.bytes += st.size
      }).catch(() => { /* 正在被写的文件会失败，跳过 */ }))
    }
    if (queue.length >= 8) {
      await Promise.all(queue)
      queue.length = 0
    }
  }
  await Promise.all(queue)
}

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * 扫描所有档案：总体积 + 可清理缓存体积。异步执行，不卡主进程。
 */
export async function scanProfileCache(root: string, cap = Number.MAX_SAFE_INTEGER): Promise<CacheStat> {
  const stat: CacheStat = { root, profileCount: 0, totalBytes: 0, cacheBytes: 0, profiles: [], truncated: false }
  for (const name of await listDirs(root)) {
    const profileDir = path.join(root, name)
    const totalBudget = { bytes: 0, truncated: false }
    await dirSize(profileDir, totalBudget, cap)

    const entries: CacheEntry[] = []
    let cacheBytes = 0
    const targets = await cacheTargets(profileDir)
    // 逐项测量，但整体并发：一个档案里通常也就命中七八条白名单路径
    await Promise.all(targets.map(async (t) => {
      try {
        await fsp.stat(t.abs)
      }
      catch {
        return
      }
      const b = { bytes: 0, truncated: false }
      await dirSize(t.abs, b)
      if (b.bytes > 0) entries.push({ rel: t.rel, bytes: b.bytes })
    }))
    // Promise.all 的结果顺序不稳定，按体积排一遍保证展示稳定
    entries.sort((a, b2) => b2.bytes - a.bytes)
    cacheBytes = entries.reduce((s, e) => s + e.bytes, 0)

    stat.profileCount += 1
    stat.totalBytes += totalBudget.bytes
    stat.cacheBytes += cacheBytes
    stat.truncated = stat.truncated || totalBudget.truncated
    stat.profiles.push({ name, totalBytes: totalBudget.bytes, cacheBytes, entries })
  }
  stat.profiles.sort((a, b2) => b2.cacheBytes - a.cacheBytes)
  return stat
}

/**
 * 清理所有档案里白名单上的缓存。
 *
 * 浏览器正在跑的时候，部分缓存文件被占着删不掉（Windows 上表现为 EBUSY / EPERM）。
 * 这种不报错，记进 skipped 并返回——浏览器会继续用它的内存映射，
 * 等下次实例重启（或下次清理）再删。
 */
export async function clearProfileCache(root: string): Promise<CacheCleanResult> {
  const result: CacheCleanResult = { removedBytes: 0, removedItems: 0, skipped: [] }
  for (const name of await listDirs(root)) {
    const profileDir = path.join(root, name)
    await Promise.all((await cacheTargets(profileDir)).map(async (t) => {
      let exists = true
      try {
        await fsp.stat(t.abs)
      }
      catch {
        exists = false
      }
      if (!exists) return
      const b = { bytes: 0, truncated: false }
      await dirSize(t.abs, b)
      try {
        assertInside(root, t.abs)
        await fsp.rm(t.abs, { recursive: true, force: true, maxRetries: 2, retryDelay: 60 })
        result.removedBytes += b.bytes
        result.removedItems += 1
      }
      catch (e: any) {
        result.skipped.push({ rel: `${name}/${t.rel}`, reason: String(e?.message || e) })
      }
    }))
  }
  return result
}

/**
 * 退出时的同步版本：不测量（早就知道要删什么），直接按白名单删。
 *
 * `will-quit` 里没法 await 异步结果，进程说走就走；而这个时候浏览器进程已经被 killAll
 * 掉，占着文件的麻烦也少了很多。
 */
export function clearProfileCacheSync(root: string, onItem?: (rel: string, bytes: number) => void): CacheCleanResult {
  const result: CacheCleanResult = { removedBytes: 0, removedItems: 0, skipped: [] }
  let names: string[] = []
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((i) => i.isDirectory() && !i.isSymbolicLink())
      .map((i) => i.name)
  }
  catch {
    return result
  }
  for (const name of names) {
    const profileDir = path.join(root, name)
    let children: string[] = []
    try {
      children = fs.readdirSync(profileDir, { withFileTypes: true })
        .filter((i) => i.isDirectory() && !i.isSymbolicLink())
        .map((i) => i.name)
    }
    catch { /* 档案还没生成过 */ }
    const rels: string[] = [...ROOT_CACHE_NAMES]
    for (const c of children) {
      for (const n of PROFILE_CACHE_NAMES) rels.push(`${c}/${n}`)
      for (const n of PROFILE_CACHE_SUBPATHS) rels.push(`${c}/${n}`)
    }
    for (const rel of rels) {
      const abs = path.join(profileDir, ...rel.split('/'))
      if (!fs.existsSync(abs)) continue
      const size = sizeSync(abs)
      try {
        assertInside(root, abs)
        fs.rmSync(abs, { recursive: true, force: true, maxRetries: 1, retryDelay: 30 })
        result.removedBytes += size
        result.removedItems += 1
        onItem?.(`${name}/${rel}`, size)
      }
      catch (e: any) {
        result.skipped.push({ rel: `${name}/${rel}`, reason: String(e?.message || e) })
      }
    }
  }
  return result
}

function sizeSync(p: string): number {
  let total = 0
  const stack = [p]
  while (stack.length) {
    const cur = stack.pop() as string
    let items
    try {
      items = fs.readdirSync(cur, { withFileTypes: true })
    }
    catch {
      continue
    }
    for (const it of items) {
      const abs = path.join(cur, it.name)
      try {
        if (it.isDirectory()) stack.push(abs)
        else if (it.isFile()) total += fs.statSync(abs).size
      }
      catch { /* 忽略 */ }
    }
  }
  return total
}
