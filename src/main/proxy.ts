import { execFile } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
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
  const s = resolveProxyServer(proxy)
  if (!s) return null
  return normalizeServer(s.type, s.host, s.port)
}

/**
 * Windows 的系统代理可能写成多方案串：
 * `http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891`
 * 早期只按最后一个冒号切一刀，这种串会被切成 `socks=127.0.0.1` + `7890`，
 * 拼出来一个根本不存在的代理地址（代理"配了却不通"经常是这么来的）。
 */
function pickFromServerList(raw: string, want: 'http' | 'https' | 'socks5'): { host: string; port: string; type: string } {
  const rawTrimmed = String(raw || '').trim()
  if (!rawTrimmed) return { host: '', port: '', type: want }
  if (rawTrimmed.includes('=')) {
    const map = new Map<string, string>()
    for (const part of rawTrimmed.split(/[;,\n]/)) {
      const idx = part.indexOf('=')
      if (idx <= 0) continue
      map.set(part.slice(0, idx).trim().toLowerCase(), part.slice(idx + 1).trim())
    }
    const chosen = map.get(want === 'socks5' ? 'socks' : want)
      ?? map.get('http')
      ?? map.get('https')
      ?? map.get('socks')
    if (chosen) {
      const [h, p] = splitServer(chosen)
      const type = /^socks5?:\/\//i.test(chosen) ? 'socks5' : /^https:\/\//i.test(chosen) ? 'https' : 'http'
      return { host: h, port: p, type }
    }
  }
  const [h, p] = splitServer(rawTrimmed)
  return { host: h, port: p, type: /^socks5?:\/\//i.test(rawTrimmed) ? 'socks5' : /^https:\/\//i.test(rawTrimmed) ? 'https' : 'http' }
}

function splitServer(server: string): [string, string] {
  const cleaned = server.replace(/^https?:\/\//i, '').replace(/^socks5?:\/\//i, '')
  // IPv6：[::1]:8080 要按方括号处理，不能直接 lastIndexOf(':')
  const bracket = cleaned.lastIndexOf(']')
  const idx = bracket >= 0 ? cleaned.indexOf(':', bracket) : cleaned.lastIndexOf(':')
  if (idx === -1) return [cleaned, '']
  return [cleaned.slice(0, idx), cleaned.slice(idx + 1)]
}

/** 把任意形态的代理配置解析成 { host, port, type } */
export function resolveProxyServer(proxy: ProxyConfig | null | undefined): { host: string; port: string; type: 'http' | 'https' | 'socks5' } | null {
  if (!proxy || proxy.mode === 'none') return null
  if (proxy.mode === 'system') {
    if (!proxy.systemServer) return null
    const picked = pickFromServerList(proxy.systemServer, proxy.systemType || 'http')
    if (!picked.host) return null
    return { host: picked.host, port: picked.port, type: picked.type as 'http' | 'https' | 'socks5' }
  }
  const host = String(proxy.host || '').trim()
  if (!host) return null
  return { host, port: String(proxy.port ?? '').trim(), type: (proxy.type || 'http') as 'http' | 'https' | 'socks5' }
}

export function buildBypassArg(proxy: ProxyConfig): string {
  const base = '<-loopback>;localhost;127.0.0.1'
  const extra = (proxy.bypassList || '')
    .split(/[;\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return [base, ...extra].join(';')
}

export interface ProxyTestResult {
  ok: boolean
  ms: number
  error?: string
  /** 代理返回的原始状态行，便于排查"通了但被拒"的情况 */
  detail?: string
  via?: string
}

/** 单次连通性测试的硬上限 */
const TEST_TIMEOUT_MS = 10000

class TimeoutError extends Error {
  constructor(msg = '超时') {
    super(msg)
    this.name = 'TimeoutError'
  }
}

/**
 * 整体截止时限。
 *
 * ⚠️ 原来只给请求挂了 `timeout: 8000`，那只是"**socket 空闲**超时"：
 * DNS 迟迟不返回、代理连上了但不回话、Socket 还没分配时它都管不着，
 * 于是 Promise 既没有 resolve 也没有 error —— 界面就永远停在"测试中…"。
 * 这里改成外层再套一道死定时器，**到点一定抛**，保证任何路径都能给结论。
 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

function describeError(err: any): string {
  if (err instanceof TimeoutError) return `超时（${TEST_TIMEOUT_MS / 1000} 秒无响应）`
  const code = String(err?.code || '')
  const msg = String(err?.message || err || '')
  switch (code) {
    case 'ECONNREFUSED': return '连接被拒绝：代理没开，或者端口不对'
    case 'ENOTFOUND':
    case 'EAI_AGAIN': return '地址无法解析：主机名写错了？'
    case 'ETIMEDOUT': return '连接超时'
    case 'ECONNRESET': return '连接被代理重置'
    case 'EHOSTUNREACH':
    case 'ENETUNREACH': return '网络不可达'
    case 'EPIPE': return '管道已关闭'
    case 'ERR_TLS_CERT_ALTNAME_INVALID': return 'TLS 证书与域名不符'
    case 'CERT_HAS_EXPIRED': return 'TLS 证书已过期'
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE': return 'TLS 证书无法校验证书链（代理在做中间人？）'
    case 'SELF_SIGNED_CERT_IN_CHAIN': return '代理返回了自签证书'
    default: break
  }
  if (/socket hang up/i.test(msg)) return '连接被提前断开（socket hang up）'
  if (/\btimeout\b/i.test(msg)) return '超时'
  return msg || '未知错误'
}

function connectTo(host: string, port: number, budget: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = net.connect({ host, port })
    const finish = (err: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners('connect')
      socket.removeAllListeners('timeout')
      socket.removeAllListeners('error')
      if (err) { socket.destroy(); reject(err) }
      else resolve(socket)
    }
    const timer = setTimeout(() => finish(new TimeoutError('连接超时')), budget)
    socket.setTimeout(budget)
    socket.once('connect', () => finish(null))
    socket.once('timeout', () => finish(new TimeoutError('连接超时')))
    socket.once('error', (e: Error) => finish(e))
  })
}

function upgradeTls(raw: net.Socket, servername: string, budget: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err: Error | null, sock?: tls.TLSSocket) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) { raw.destroy(); reject(err) }
      else resolve(sock as tls.TLSSocket)
    }
    const timer = setTimeout(() => done(new TimeoutError('TLS 握手超时')), budget)
    const secure = tls.connect({ socket: raw, servername, rejectUnauthorized: true }, () => done(null, secure))
    secure.once('error', (e: Error) => done(e))
    raw.once('error', (e: Error) => done(e))
  })
}

/** 收数据直到满足条件；中途断开 / 出错 / 到点，一律 reject，不留悬挂的 Promise */
function collectUntil(sock: net.Socket | tls.TLSSocket, budget: number, ready: (buf: Buffer) => boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const cleanup = () => {
      clearTimeout(timer)
      sock.off('data', onData)
      sock.off('error', onErr)
      sock.off('close', onClose)
      sock.off('end', onClose)
    }
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d])
      if (ready(buf)) { cleanup(); resolve(buf) }
    }
    const onErr = (e: Error) => { cleanup(); reject(e) }
    const onClose = () => { cleanup(); reject(new Error('连接被提前关闭')) }
    const timer = setTimeout(() => { cleanup(); reject(new TimeoutError('等待响应超时')) }, budget)
    sock.on('data', onData)
    sock.on('error', onErr)
    sock.on('close', onClose)
    sock.on('end', onClose)
  })
}

const hasHead = (buf: Buffer) => buf.toString('latin1').includes('\r\n\r\n')

function firstLine(buf: Buffer): string {
  return (buf.toString('latin1').split(/\r?\n/)[0] || '').trim()
}

function statusOf(buf: Buffer): number {
  const m = firstLine(buf).match(/^HTTP\/[\d.]+ (\d{3})/)
  return m ? Number(m[1]) : 0
}

/** 直连：TCP（必要时 TLS），然后发一个 HEAD，拿到任意 HTTP 状态行就算通 */
async function directReach(target: URL, budget: number): Promise<ProxyTestResult> {
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80)
  let sock: net.Socket | tls.TLSSocket = await connectTo(target.hostname, port, budget)
  try {
    if (target.protocol === 'https:') sock = await upgradeTls(sock as net.Socket, target.hostname, budget)
    sock.write(`HEAD ${target.pathname || '/'}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\nUser-Agent: AIQuad\r\n\r\n`)
    const buf = await collectUntil(sock, budget, hasHead)
    const status = statusOf(buf)
    return { ok: true, ms: 0, via: '直连', detail: `HTTP ${status || firstLine(buf)}` }
  }
  finally {
    sock.destroy()
  }
}

/** HTTP / HTTPS 代理：https 目标走 CONNECT 隧道，http 目标走绝对形式的 GET */
async function viaHttpProxy(server: { host: string; port: string; type: string }, target: URL, budget: number): Promise<ProxyTestResult> {
  const port = Number(server.port)
  const targetHost = target.hostname
  const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80)
  const via = `${server.type}://${server.host}:${port}`

  let raw = await connectTo(server.host, port, budget)
  let sock: net.Socket | tls.TLSSocket = raw
  try {
    if (server.type === 'https') sock = await upgradeTls(raw, server.host, budget)

    if (target.protocol === 'https:') {
      sock.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        `Proxy-Connection: keep-alive\r\n\r\n`,
      )
      const buf = await collectUntil(sock, budget, hasHead)
      const status = statusOf(buf)
      const line = firstLine(buf)
      if (status >= 200 && status < 300) return { ok: true, ms: 0, via, detail: line }
      // 隧道建立失败：把代理的回答如实说出来，最常见的是 407
      const reason = status === 407 ? '代理要求认证（407）'
        : status === 403 ? '代理拒绝了这次连接（403）'
          : `代理返回 ${status || line}`
      return { ok: false, ms: 0, error: reason, detail: line, via }
    }

    sock.write(
      `GET ${target.href} HTTP/1.1\r\nHost: ${target.host}\r\n` +
      `Proxy-Connection: close\r\nConnection: close\r\nUser-Agent: AIQuad\r\n\r\n`,
    )
    const buf = await collectUntil(sock, budget, (b) => hasHead(b) || b.length > 0)
    const status = statusOf(buf)
    if (status >= 200 && status < 400) return { ok: true, ms: 0, via, detail: `HTTP ${status}` }
    return { ok: false, ms: 0, error: `代理返回 HTTP ${status || firstLine(buf)}`, detail: firstLine(buf), via }
  }
  finally {
    sock.destroy()
  }
}

const SOCKS_REPLY: Record<number, string> = {
  1: 'SOCKS 服务器故障',
  2: '规则不允许连接',
  3: '网络不可达',
  4: '主机不可达',
  5: '连接被拒绝',
  6: 'TTL 过期',
  7: '不支持的命令',
  8: '不支持的地址类型',
}

/** SOCKS5：走一次完整的握手（协商 → CONNECT），握手成功即认为代理可用 */
async function viaSocks5(server: { host: string; port: string; type: string }, target: URL, budget: number): Promise<ProxyTestResult> {
  const port = Number(server.port)
  const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80)
  const via = `socks5://${server.host}:${port}`
  let sock: net.Socket | tls.TLSSocket = await connectTo(server.host, port, budget)
  try {
    sock.write(Buffer.from([0x05, 0x01, 0x00]))
    const greet = await collectUntil(sock, budget, (b) => b.length >= 2)
    if (greet[0] !== 0x05) {
      return { ok: false, ms: 0, error: '对方不是 SOCKS5 代理', via }
    }
    if (greet[1] === 0x02) {
      return { ok: false, ms: 0, error: 'SOCKS5 需要用户名密码认证（本程序未支持）', via }
    }
    if (greet[1] !== 0x00) {
      return { ok: false, ms: 0, error: `SOCKS5 协商失败（方法码 ${greet[1]}）`, via }
    }

    const domain = Buffer.from(target.hostname, 'utf8')
    const req = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, Math.min(255, domain.length)]),
      domain.subarray(0, 255),
      Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
    ])
    sock.write(req)
    const reply = await collectUntil(sock, budget, (b) => {
      if (b.length < 5) return false
      const atyp = b[3]
      const need = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : 5 + b[4] + 2
      return b.length >= need
    })
    if (reply[1] === 0x00) return { ok: true, ms: 0, via, detail: `SOCKS5 握手成功（目标 ${target.hostname}:${targetPort}）` }
    return { ok: false, ms: 0, error: SOCKS_REPLY[reply[1]] || `SOCKS5 连接失败（回复码 ${reply[1]}）`, via }
  }
  finally {
    sock.destroy()
  }
}

/**
 * 连通性测试：对目标 URL 按当前代理设置发一次真实请求。
 *
 * 返回值一定带 ok / ms / error 之一，**任何情况下都会 settle**——
 * 之前卡在"测试中…"就是因为某些路径既不 resolve 也不 reject。
 */
export async function testProxy(proxy: ProxyConfig | null, url: string): Promise<ProxyTestResult> {
  const started = Date.now()
  // ms 必须放最后：各个探测函数为了省事都返回 `ms: 0` 占位，
  // 写在前面就会被那边的 0 覆盖掉，界面上只能看到"0ms"
  const done = (r: Omit<ProxyTestResult, 'ms'>): ProxyTestResult => ({ ...r, ms: Date.now() - started })

  let target: URL
  try {
    target = new URL(String(url || '').trim())
  }
  catch {
    return done({ ok: false, error: '测试地址不合法（要以 http:// 或 https:// 开头）' })
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return done({ ok: false, error: '只支持 http / https 目标' })
  }

  const budget = Math.max(1500, TEST_TIMEOUT_MS - (Date.now() - started))
  try {
    const server = resolveProxyServer(proxy)
    if (server && !server.port) {
      return done({ ok: false, error: '代理没有填端口' })
    }
    const run = server
      ? (server.type === 'socks5' ? viaSocks5(server, target, budget) : viaHttpProxy(server, target, budget))
      : directReach(target, budget)
    return done(await withDeadline(run, budget))
  }
  catch (err: any) {
    return done({ ok: false, error: describeError(err) })
  }
}

export const profilesRoot = (userData: string) => path.join(userData, 'profiles')

export function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}
