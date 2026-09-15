#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 抽出某个版本的正文，拼上固定尾巴（docs/release-boilerplate.md），
 * 写成文件交给 `gh release create --notes-file`。
 *
 *   node scripts/release-notes.js                    # 版本号取 package.json
 *   node scripts/release-notes.js 0.4.10
 *   node scripts/release-notes.js 0.4.10 --out build/notes.md
 *
 * 为什么要有它：发布说明只该有一个源头。CHANGELOG.md 是源头，发布页上的说明是它的派生物；
 * 两边各写一份，早晚会对不上（0.4.2 ~ 0.4.9 那几版就是手写的，没法自动核对）。
 * **抽不到这一版的段落就退出码 1** —— 版本没写进 CHANGELOG 就发版，在这里被拦住。
 *
 * 产物默认落在 build/（electron-builder 的输出目录，已在 .gitignore 里），
 * 不会污染仓库、也不会混进 .tmp/ 那边的浏览器档案。
 */
const { mkdirSync, readFileSync, writeFileSync } = require('fs')
const { dirname, join } = require('path')

const { changelogSection, firstContentLine, releaseHeading, sectionBody } = require('./lib/changelog-section')
const { windowsPath } = require('./lib/paths')

const root = join(__dirname, '..')

const USAGE = `用法：node scripts/release-notes.js [版本号] [--out 文件]

  版本号省略时取 package.json 的 version。
  默认输出到 build/release-notes-<版本号>.md。

  说明正文来自 CHANGELOG.md 的对应段落，固定尾巴来自 docs/release-boilerplate.md，
  两处都是唯一源头，脚本只负责拼接，不改写措辞。`

const argv = process.argv.slice(2)
let outArg = null
let version = null

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '-h' || arg === '--help') {
    console.log(USAGE)
    process.exit(0)
  }
  if (arg === '--out') {
    outArg = argv[++i]
    if (!outArg) {
      console.error(`--out 后面要跟一个文件路径\n\n${USAGE}`)
      process.exit(2)
    }
    continue
  }
  if (arg.startsWith('-')) {
    console.error(`不认识的参数：${arg}\n\n${USAGE}`)
    process.exit(2)
  }
  version ??= arg
}

if (!version) {
  version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
}

const out = outArg
  ? (/^([A-Za-z]:[\\/]|\/)/.test(outArg) ? windowsPath(outArg) : join(root, outArg))
  : join(root, 'build', `release-notes-${version}.md`)

const changelogPath = join(root, 'CHANGELOG.md')
const section = changelogSection(readFileSync(changelogPath, 'utf8'), version)

if (!section) {
  console.error(`CHANGELOG.md 里找不到 ${version} 的段落。`)
  console.error('先把这一版写进 CHANGELOG.md（写法：## [' + version + '] - YYYY-MM-DD），再发版。')
  console.error('发布页上的说明是它的派生物，跳过这一步就等于把更新记录断在发布页上。')
  process.exit(1)
}

/** 固定尾巴：取 docs/release-boilerplate.md 里第一条 `---` 之后的正文 */
function boilerplateBody(text) {
  const lines = String(text).split(/\r?\n/)
  const start = lines.findIndex((line) => /^-{3,}\s*$/.test(line.trim()))
  const body = start === -1 ? lines : lines.slice(start + 1)
  return body.join('\n').replace(/\{\{version\}\}/g, version).trim()
}

const boilerplatePath = join(root, 'docs', 'release-boilerplate.md')
const tail = boilerplateBody(readFileSync(boilerplatePath, 'utf8'))

if (!tail) {
  console.error(`docs/release-boilerplate.md 里没有找到正文（分隔线 --- 以下的部分）。`)
  process.exit(1)
}

const notes = `${releaseHeading(version)}\n\n${sectionBody(section)}\n\n${tail}\n`
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, notes, 'utf8')

console.log(`已写入 ${out}（${notes.length} 字）`)
console.log(`--- v${version} 说明开头 ---`)
console.log(notes.split(/\r?\n/).slice(0, 4).join('\n'))
console.log('---')
console.log(
  `下一步：gh release create v${version} build/AIQuad-Setup-${version}.exe `
    + `build/AIQuad-Portable-${version}.exe build/latest.yml `
    + `--title "AIQuad v${version}" --notes-file "${out}"`,
)
console.log(`发完自检：node scripts/post-release-check.js ${version}`)

// 首行有内容的句子顺手回显一下，便于人工核对"发布页说明 == CHANGELOG"
const probe = firstContentLine(section)
if (probe) console.log(`\n自检会拿这句比对发布页：${probe.slice(0, 40)}…`)
