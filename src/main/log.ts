import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'

/**
 * 极简的主进程日志落盘（2026-10-12）。
 *
 * 为什么需要它：**打包后的安装版没有控制台**，主进程的 console.* 哪都不去。
 * 于是"链接拦截器没装上"这类只写 console.warn 的降级路径完全不可见 ——
 * 2026-10-12 排查"分格内点链接仍在本格跳转"时，最大的障碍就是现场一条日志都没有，
 * 只能靠在线探针反推（连"钩子到底装上没有"都得现写脚本去页面里读）。
 *
 * 只做两件事：把 console.log / warn / error 复制一份到 <userData>/logs/main.log；
 * 文件超过上限就轮转一次（main.log → main.1.log）。写日志失败一律静默，
 * 绝不因为它影响主流程。
 */

const MAX_BYTES = 2 * 1024 * 1024

let stream: fs.WriteStream | null = null
/** 防止 console.* 被包两层（例如测试里重复调用） */
let installed = false

function fmt(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack || String(a)
  return util.inspect(a, { depth: 3, breakLength: 160 })
}

export function installFileLog(userDataDir: string): string | null {
  if (installed) return null
  try {
    const dir = path.join(userDataDir, 'logs')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'main.log')
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, path.join(dir, 'main.1.log'))
    }
    catch {}
    stream = fs.createWriteStream(file, { flags: 'a' })
    stream.on('error', () => { stream = null })
    for (const level of ['log', 'warn', 'error'] as const) {
      const orig = console[level].bind(console)
      console[level] = (...args: unknown[]) => {
        orig(...args)
        try {
          stream?.write(`${new Date().toISOString()} [${level}] ${args.map(fmt).join(' ')}
`)
        }
        catch {}
      }
    }
    installed = true
    return file
  }
  catch {
    return null
  }
}
