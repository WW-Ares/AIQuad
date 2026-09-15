#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 抽出发布说明，拼上固定尾巴（docs/release-boilerplate.md），
 * 写成文件交给 `gh release create --notes-file`。
 *
 *   node scripts/release-notes.js                    # 版本号取 package.json
 *   node scripts/release-notes.js 0.4.10
 *   node scripts/release-notes.js 0.4.10 --out build/notes.md
 *
 *   node scripts/release-notes.js --since auto       # 累计取材：上一个 tag → 当前版本
 *   node scripts/release-notes.js 0.4.11 --since 0.4.9
 *
 * 为什么要有它：发布说明只该有一个源头。CHANGELOG.md 是源头，发布页上的说明是它的派生物；
 * 两边各写一份，早晚会对不上（0.4.2 ~ 0.4.9 那几版就是手写的，没法自动核对）。
 * **抽不到这一版的段落就退出码 1** —— 版本没写进 CHANGELOG 就发版，在这里被拦住。
 *
 * `--since` 是**取材模式**，不写发布说明：它把"上一个发版之后到本版为止"的所有版本段落
 * 原样倒出来（`build/release-draft-<版本>.md`），交给人和 AI 合并成一篇累计说明，
 * 再写回 CHANGELOG.md 该版本的段落。规则见 docs/release-notes.md。
 *
 * 产物默认落在 build/（electron-builder 的输出目录，已在 .gitignore 里），
 * 不会污染仓库、也不会混进 .tmp/ 那边的浏览器档案。
 */
const { execFileSync } = require('child_process')
const { mkdirSync, readFileSync, writeFileSync } = require('fs')
const { dirname, join } = require('path')

const {
  changelogRange,
  changelogSection,
  changelogVersions,
  firstContentLine,
  latestBelow,
  releaseHeading,
  sectionBody,
} = require('./lib/changelog-section')
const { windowsPath } = require('./lib/paths')

const root = join(__dirname, '..')

const USAGE = `用法：node scripts/release-notes.js [版本号] [--out 文件] [--since 版本|auto]

  版本号省略时取 package.json 的 version。
  默认输出到 build/release-notes-<版本号>.md。

  说明正文来自 CHANGELOG.md 的对应段落，固定尾巴来自 docs/release-boilerplate.md，
  两处都是唯一源头，脚本只负责拼接，不改写措辞。

  --since <版本|auto>  累计取材模式（不生成发布说明）：
                       把 (since, 本版] 区间里所有版本的段落倒到 build/release-draft-<版本>.md，
                       人工/AI 合并成一篇累计说明写回 CHANGELOG，再正经跑一次本脚本。
                       auto = 取比本版小的最大 git tag（上一个已发布版本）。
                       规则见 docs/release-notes.md。`

const argv = process.argv.slice(2)
let outArg = null
let version = null
let sinceArg = undefined

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
  if (arg === '--since') {
    sinceArg = argv[++i]
    if (!sinceArg) {
      console.error(`--since 后面要跟一个版本号或 auto\n\n${USAGE}`)
      process.exit(2)
    }
    continue
  }
  if (arg === '--since-auto') {
    sinceArg = 'auto'
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
const changelogText = readFileSync(changelogPath, 'utf8')

/** `--since auto`：拿本地 git tag 里比本版小的最大那个当起点 */
function resolveSince() {
  if (sinceArg !== 'auto') return sinceArg
  let tags = []
  try {
    tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch (err) {
    console.error(`--since auto 需要 git（读 tag 失败）：${err.message}`)
    process.exit(1)
  }
  const found = latestBelow(tags, version)
  if (!found) {
    console.error(`本地 tag 里找不到比 ${version} 小的版本，--since auto 认不出起点。`)
    console.error(`本地 tag：${tags.join(' ') || '(空)'}`)
    console.error('先 git fetch --tags，或者直接写 --since <版本号>。')
    process.exit(1)
  }
  return found
}

/* ---------------- 累计取材模式 ---------------- */

if (sinceArg !== undefined) {
  const since = resolveSince()
  const range = changelogRange(changelogText, { since, until: version })

  if (!range.length) {
    console.error(`CHANGELOG.md 里 ${since ? `${since} 之后、` : ''}${version} 之前没有可取材的版本段。`)
    process.exit(1)
  }

  const draftPath = join(root, 'build', `release-draft-${version}.md`)
  const allVersions = changelogVersions(changelogText)
  const inRange = allVersions.filter((v) => range.some((item) => item.version === v))

  const parts = [
    `# 累计发版说明取材：v${version}`,
    '',
    `区间：**${since ? `(${since} 之后` : '最早'} → ${version}】**，共 ${range.length} 个版本段：${inRange.join(' / ')}`,
    '',
    '下面每一节都原样来自 `CHANGELOG.md`，**没有改写**。要做的只有一件事：',
    `把它们合并成**一篇**说明（同名功能的后续修复并进原文，不要逐版罗列），`,
    `然后写回 \`CHANGELOG.md\` 的 \`## [${version}]\` 段落，再跑一次`,
    `\`node scripts/release-notes.js ${version}\` 生成发布页说明。规则见 \`docs/release-notes.md\`。`,
    '',
    '⚠️ 合并后覆盖的是**本版段落**；被并进来的旧版本段落本身留着不动（那是开发侧的完整履历）。',
    '',
  ]

  for (const item of range) {
    parts.push(`<!-- ===== 取自 CHANGELOG ## [${item.version}] ===== -->`, '', sectionBody(item.section), '', '---', '')
  }

  const draft = parts.join('\n')
  mkdirSync(dirname(draftPath), { recursive: true })
  writeFileSync(draftPath, draft, 'utf8')

  console.log(`已写入 ${draftPath}（${draft.length} 字，${range.length} 个版本段）`)
  console.log(`区间：${since ? `${since} 之后` : '最早'} → ${version}  ⇒  ${inRange.join(' / ')}`)
  console.log('下一步：把它合并成一篇累计说明，写回 CHANGELOG.md 的本版段落，然后')
  console.log(`  node scripts/release-notes.js ${version}`)
  process.exit(0)
}

/* ---------------- 默认：生成发布说明 ---------------- */

const section = changelogSection(changelogText, version)

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
