#!/usr/bin/env node
/**
 * 发版后自检：确认这次发布"真的落地了"，而不是只看每条命令有没有报错。
 *
 *   node scripts/post-release-check.js          # 检查 package.json 的 version
 *   node scripts/post-release-check.js 0.4.10
 *
 * 查七件事：
 *   1. 工作区干净（发版完不该还有没提交的改动）
 *   2. 本地 HEAD 与远端默认分支一致（推上去了、也没落后）
 *   3. 远端最后一条提交说明只有那两个词之一
 *   4. 标签 v<版本> 存在，且指向 HEAD（annotated tag 记得解引用 git/tags）
 *   5. Release 附件齐全：AIQuad-Setup / AIQuad-Portable / latest.yml 三样一个都不能少
 *   6. Release 说明非空，且正文来自 CHANGELOG.md 的对应段落
 *   7. 本地 latest.yml 与本地产物对得上（版本号一致、sha512 与 size 逐字节一致）
 *
 * 有 ❌ 退出码 1 —— 可以直接接在发布流程末尾当守门员。
 *
 * 第 5 条和第 7 条是配套的：5 只看得见"传没传"，7 才看得见"传对没对"。
 * latest.yml 漏传或传成上一版的，在线更新会 404 / 更新到错版本，而且都不报错。
 *
 * 环境变量：
 *   GH_PATH              指定 gh.exe 路径
 *   AIQUAD_RELEASE_DIR   产物目录（默认依次找 build/ 与 released/）
 */
const { execFileSync } = require('child_process')
const { createHash } = require('crypto')
const { closeSync, existsSync, openSync, readSync, readFileSync, statSync } = require('fs')
const { join } = require('path')

const { changelogSection, firstContentLine } = require('./lib/changelog-section')
const { windowsPath } = require('./lib/paths')

const root = join(__dirname, '..')
const ALLOWED_MESSAGES = new Set(['Initial commit', 'Update'])
const version =
  process.argv[2] ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

/** Release 上必须有的附件；安装包两个 + latest.yml */
const requiredAssets = [
  `AIQuad-Setup-${version}.exe`,
  `AIQuad-Portable-${version}.exe`,
  'latest.yml',
]

const checks = []
const add = (level, label, detail = '') => checks.push({ level, label, detail })

function tryRun(cmd, args, options = {}) {
  try {
    const out = execFileSync(cmd, args, {
      cwd: options.cwd ?? root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true, out: String(out).trim(), err: '' }
  }
  catch (error) {
    return {
      ok: false,
      out: String(error.stdout ?? '').trim(),
      err: String(`${error.stderr ?? ''}${error.message ?? ''}`).trim(),
    }
  }
}

function findGh() {
  const candidates = [
    process.env.GH_PATH,
    'gh',
    'C:/Program Files/GitHub CLI/gh.exe',
    'C:\\Program Files\\GitHub CLI\\gh.exe',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (tryRun(candidate, ['--version']).ok) return candidate
  }
  return null
}

/** gh api；404 返回 null，其它错误抛出来给人看 */
function ghApi(path) {
  const res = tryRun(gh, ['api', path])
  if (res.ok) return JSON.parse(res.out)
  if (/Not Found|HTTP 404/i.test(res.err)) return null
  throw new Error(`gh api ${path} 失败：${res.err.split('\n')[0]}`)
}

/** 从任意 remote 解析 GitHub 仓库 slug（origin 优先，其次 ssh 那条备用通道） */
function repoSlug() {
  const remotes = tryRun('git', ['remote'])
  const names = remotes.ok ? remotes.out.split('\n').map((s) => s.trim()).filter(Boolean) : []
  const ordered = ['origin', ...names.filter((n) => n !== 'origin')]
  for (const name of ordered) {
    const url = tryRun('git', ['remote', 'get-url', name])
    const match = url.ok ? url.out.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/) : null
    if (match) return `${match[1]}/${match[2]}`
  }
  return null
}

/** 流式算 sha512(base64)，别把 100MB 的安装包整个读进内存 */
function sha512Base64(file) {
  const hash = createHash('sha512')
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024)
    let read = readSync(fd, buf, 0, buf.length, null)
    while (read > 0) {
      hash.update(buf.subarray(0, read))
      read = readSync(fd, buf, 0, buf.length, null)
    }
  }
  finally {
    closeSync(fd)
  }
  return hash.digest('base64')
}

const gh = findGh()
const short = (sha) => (sha ? sha.slice(0, 7) : '(未知)')

console.log(`AIQuad v${version} 发版自检\n`)

// --- 1. 工作区 ---------------------------------------------------------------
const status = tryRun('git', ['status', '--porcelain'])
if (!status.ok) {
  add('fail', '工作区状态', `git status 失败：${status.err.split('\n')[0]}`)
}
else if (status.out) {
  const files = status.out.split('\n')
  add('fail', '工作区干净', `还有 ${files.length} 项未提交：${files.slice(0, 3).join(' / ')}${files.length > 3 ? ' …' : ''}`)
}
else {
  add('ok', '工作区干净')
}

// --- 2 ~ 7. 远端侧与产物 ------------------------------------------------------
const headSha = tryRun('git', ['rev-parse', 'HEAD']).out
const slug = repoSlug()

if (!gh) {
  add('warn', '远端状态', '找不到 gh 命令，设置 GH_PATH 或安装 GitHub CLI 后重跑')
}
else if (!slug) {
  add('fail', '远端仓库', '从 origin / ssh 两个 remote 里都解析不出 GitHub 仓库地址')
}
else {
  // 2. 本地 HEAD vs 远端默认分支
  const commit = ghApi(`repos/${slug}/commits/main`)
  if (!commit) {
    add('fail', '远端 main', `gh api repos/${slug}/commits/main 返回 404`)
  }
  else {
    const remoteSha = commit.sha ?? ''
    if (headSha && remoteSha === headSha) add('ok', '本地与远端 main 一致', short(headSha))
    else add('fail', '本地与远端 main 一致', `本地 ${short(headSha)} ≠ 远端 ${short(remoteSha)}`)

    // 3. 远端最后一条提交说明
    const message = String(commit.commit?.message ?? '').split(/\r?\n/)[0].trim()
    if (ALLOWED_MESSAGES.has(message)) add('ok', '远端最后一条提交说明合规', `"${message}"`)
    else add('fail', '远端最后一条提交说明合规', `是 "${message}"，只允许 Initial commit / Update`)
  }

  // 4. 标签指向 HEAD
  const tagRef = ghApi(`repos/${slug}/git/ref/tags/v${version}`)
  if (!tagRef) {
    add('fail', `标签 v${version} 存在`, '远端没有这个标签 —— 还没打标签，或者没推上去')
  }
  else {
    let target = tagRef.object?.sha ?? ''
    if (tagRef.object?.type === 'tag') {
      target = ghApi(`repos/${slug}/git/tags/${target}`)?.object?.sha ?? ''
    }
    if (target && headSha && target === headSha) add('ok', `标签 v${version} 指向 HEAD`, short(target))
    else add('fail', `标签 v${version} 指向 HEAD`, `标签指向 ${short(target)}，HEAD 是 ${short(headSha)}`)
  }

  // 5 ~ 6. Release、附件、说明是否同源
  const release = ghApi(`repos/${slug}/releases/tags/v${version}`)
  if (!release) {
    add('fail', `Release v${version} 存在`, '远端没有对应 Release —— 还没发，或者发失败了')
  }
  else {
    const names = (release.assets ?? []).map((asset) => asset.name)
    const missing = requiredAssets.filter((name) => !names.includes(name))
    if (missing.length === 0) {
      add('ok', 'Release 附件齐全', requiredAssets.join(' / '))
    }
    else {
      const hint = missing.includes('latest.yml')
        ? '（latest.yml 漏传，在线更新会 404）'
        : ''
      add('fail', 'Release 附件齐全', `缺少 ${missing.join(' / ')}${hint}，现有：${names.join(' / ') || '(空)'}`)
    }

    const body = String(release.body ?? '').trim()
    if (!body) {
      add('warn', 'Release 说明非空', '说明是空的，别让发布页只剩一个标题')
    }
    else {
      const section = changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version)
      const probe = section ? firstContentLine(section) : null
      if (!section) {
        add('warn', 'Release 说明与 CHANGELOG 一致', `CHANGELOG.md 里没有 ${version} 的段落`)
      }
      else if (probe && body.includes(probe)) {
        add('ok', 'Release 说明与 CHANGELOG 一致', '说明正文来自 CHANGELOG 该版本段落')
      }
      else {
        add('warn', 'Release 说明与 CHANGELOG 一致', '说明不像从 CHANGELOG 抽的，两处可能各写了一份')
      }
    }
  }
}

// --- 7. latest.yml 与本地产物 --------------------------------------------------
/** 极简 YAML 读取：只认 electron-builder 写出来的那几个键，够用且零依赖 */
function parseLatestYml(text) {
  const result = { version: null, path: null, files: [] }
  let current = null
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    if (/^[A-Za-z]/.test(line)) current = null // 回到顶层的键，条目结束
    let m
    if ((m = line.match(/^version:\s*(.+)$/))) result.version = m[1].trim().replace(/^['"]|['"]$/g, '')
    else if ((m = line.match(/^path:\s*(.+)$/))) result.path = m[1].trim()
    else if ((m = line.match(/^\s{2,}-\s*url:\s*(.+)$/))) {
      current = { url: m[1].trim(), sha512: null, size: null }
      result.files.push(current)
    }
    else if (current && (m = line.match(/^\s{2,}sha512:\s*(.+)$/))) current.sha512 = m[1].trim()
    else if (current && (m = line.match(/^\s{2,}size:\s*(\d+)$/))) current.size = Number(m[1])
  }
  return result
}

const dirs = [
  process.env.AIQUAD_RELEASE_DIR ? windowsPath(process.env.AIQUAD_RELEASE_DIR) : null,
  join(root, 'build'),
  join(root, 'released'),
].filter(Boolean)

const ymlDir = dirs.find((dir) => existsSync(join(dir, 'latest.yml')))
if (!ymlDir) {
  add('warn', 'latest.yml 可核对', `本地找不到 latest.yml（找过 ${dirs.join(' / ')}），跳过产物比对`)
}
else {
  const yml = parseLatestYml(readFileSync(join(ymlDir, 'latest.yml'), 'utf8'))
  if (yml.version !== version) {
    add(
      'fail',
      'latest.yml 版本号一致',
      `latest.yml 写的是 ${yml.version ?? '(没读到)'}，package.json 是 ${version} —— 这是上一版的产物`,
    )
  }
  else {
    add('ok', 'latest.yml 版本号一致', yml.version)
  }

  const pending = [] // 本地缺产物 → 只能警告，不能判失败
  for (const entry of yml.files) {
    const name = String(entry.url).split('/').pop()
    const file = dirs.map((dir) => join(dir, name)).find((candidate) => existsSync(candidate))
    if (!file) {
      pending.push(`${name}（本地没有这个文件）`)
      continue
    }
    const size = statSync(file).size
    if (entry.size !== null && entry.size !== size) {
      add('fail', `latest.yml 与产物一致：${name}`, `size 不符：latest.yml ${entry.size} ≠ 本地 ${size}`)
      continue
    }
    const digest = sha512Base64(file)
    if (entry.sha512 && entry.sha512 !== digest) {
      add('fail', `latest.yml 与产物一致：${name}`, 'sha512 不符 —— latest.yml 和安装包不是同一次构建')
      continue
    }
    add('ok', `latest.yml 与产物一致：${name}`, `${size} 字节，sha512 相符`)
  }
  for (const item of pending) add('warn', 'latest.yml 与产物一致', item)
}

// --- 输出 --------------------------------------------------------------------
const ICON = { ok: '✅', warn: '⚠️ ', fail: '❌' }
for (const check of checks) {
  console.log(`  ${ICON[check.level]} ${check.label}${check.detail ? `  —— ${check.detail}` : ''}`)
}

const failed = checks.filter((c) => c.level === 'fail').length
const warned = checks.filter((c) => c.level === 'warn').length
const passed = checks.length - failed - warned
console.log('')
console.log(
  failed
    ? `结论：${passed} 项通过，${failed} 项失败${warned ? `，${warned} 项警告` : ''}`
    : `结论：全部通过${warned ? `（${warned} 项警告）` : ''}`,
)

process.exit(failed ? 1 : 0)
