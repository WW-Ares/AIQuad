import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ProxyConfig } from './types'

const execFileAsync = promisify(execFile)

/**
 * 代理相关工具：
 * 1. 读取 Windows 系统代理设置（注册表）
 * 2. 把应用内代理配置翻译成 Chrome / Edge 启动参数
 */

export interface SystemProxy {
  enabled: boolean
  server: string
  bypass: string
}

const IE_REG = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

export async function getSystemProxy(): Promise<SystemProxy> {
  try {
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `$p = Get-ItemProperty -Path '${IE_REG}' -ErrorAction SilentlyContinue; ` +
        `if ($null -eq $p) { Write-Output '0||'; exit 0 }; ` +
        `$e = if ($p.ProxyEnable) { $p.ProxyEnable } else { 0 }; ` +
        `$s = if ($p.ProxyServer) { $p.ProxyServer } else { '' }; ` +
        `$b = if ($p.ProxyOverride) { $p.ProxyOverride } else { '' }; ` +
        `Write-Output "$e|$s|$b"`,
    ], { windowsHide: true, timeout: 10000 })

    const line = String(stdout).trim().split(/\r?\n/).pop() ?? ''
    const [enabledRaw, server = '', bypass = ''] = line.split('|')
    return { enabled: enabledRaw === '1', server: server.trim(), bypass: bypass.trim() }
  }
  catch {
    return { enabled: false, server: '', bypass: '' }
  }
}

export function normalizeServer(type: string, host: string, port: number | string): string {
  const h = String(host).trim().replace(/^https?:\/\//i, '').replace(/^socks5?:\/\//i, '').replace(/\/+$/, '')
  const p = String(port).trim()
  if (!h) return ''
  const prefix = type === 'socks5' ? 'socks5://' : type === 'https' ? 'https://' : 'http://'
  return p ? `${prefix}${h}:${p}` : `${prefix}${h}`
}

/** 生成 --proxy-server 参数值，返回 null 表示不使用代理 */
export function buildProxyServerArg(proxy: ProxyConfig): string | null {
  if (proxy.mode === 'none') return null
  if (proxy.mode === 'system') {
    return proxy.systemServer ? normalizeServer(proxy.systemType || 'http', ...splitServer(proxy.systemServer)) : null
  }
  if (!proxy.host) return null
  return normalizeServer(proxy.type || 'http', proxy.host, proxy.port ?? '')
}

function splitServer(server: string): [string, string] {
  const cleaned = server.replace(/^https?:\/\//i, '').replace(/^socks5?:\/\//i, '')
  const idx = cleaned.lastIndexOf(':')
  if (idx === -1) return [cleaned, '']
  return [cleaned.slice(0, idx), cleaned.slice(idx + 1)]
}

export function buildBypassArg(proxy: ProxyConfig): string {
  const base = '<-loopback>;localhost;127.0.0.1'
  const extra = (proxy.bypassList || '')
    .split(/[;\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return [base, ...extra].join(';')
}

/** 连通性测试：对目标 URL 走代理发一次请求 */
export async function testProxy(proxy: ProxyConfig | null, url: string): Promise<{ ok: boolean; ms: number; error?: string }> {
  const started = Date.now()
  try {
    const target = new URL(url)
    const https = await import('node:https')
    const http = await import('node:http')

    if (!proxy || proxy.mode === 'none') {
      await new Promise<void>((resolve, reject) => {
        const req = (target.protocol === 'https:' ? https : http).request(
          { host: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: '/', method: 'HEAD', timeout: 8000 },
          (res) => { res.resume(); resolve() },
        )
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(new Error('timeout')) })
        req.end()
      })
      return { ok: true, ms: Date.now() - started }
    }

    const server = buildProxyServerArg(proxy)
    if (!server) return { ok: false, ms: 0, error: '代理地址为空' }
    const u = new URL(server.includes('://') ? server : `http://${server}`)
    const isHttpsTarget = target.protocol === 'https:'

    if (proxy.type === 'socks5') {
      return { ok: false, ms: 0, error: 'socks5 连通性测试请在浏览器实例中验证' }
    }

    await new Promise<void>((resolve, reject) => {
      const req = (u.protocol === 'https:' ? https : http).request(
        {
          host: u.hostname,
          port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
          method: isHttpsTarget ? 'CONNECT' : 'GET',
          path: isHttpsTarget ? `${target.hostname}:443` : target.toString(),
          timeout: 8000,
        },
        (res) => { res.resume(); resolve() },
      )
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(new Error('timeout')) })
      req.end()
    })
    return { ok: true, ms: Date.now() - started }
  }
  catch (err: any) {
    return { ok: false, ms: Date.now() - started, error: String(err?.message || err) }
  }
}

export const profilesRoot = (userData: string) => path.join(userData, 'profiles')

export function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}
