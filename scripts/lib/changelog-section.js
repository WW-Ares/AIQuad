/**
 * CHANGELOG.md 是发布说明的唯一源头，别的产物（GitHub Release 页面、发版自检）都从它派生。
 * 解析逻辑集中在这里，免得两处正则各自漂移。
 *
 * 仓库里用标准写法 `## [0.4.9] - 2026-09-15`；发布页上那行标题由 `releaseHeading()` 生成成
 * `## AIQuad v0.4.9` —— 沿用 0.4.2 ~ 0.4.9 四份既有 Release 的样式，发布页看上去和以前一样。
 *
 * 另外提供**区间**取材（`changelogRange()` 等）：发布页上的说明是"累计"的 ——
 * 上一个发版之后的所有版本合并成一篇，规则见 `docs/release-notes.md`。
 */

/** 把版本号里的正则元字符转义（版本号里只有点和数字，但是别指望以后不会出现别的字符） */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 取出某个版本的段落（**含标题行**），找不到返回 null。
 *
 * 认得的标题写法：`## [0.4.9] - 2026-09-15`、`## [0.4.9]`、`## 0.4.9`、`## AIQuad v0.4.9`。
 * 段落结束于下一个 `## ` 标题；尾部的 `---` 分隔线会去掉。
 *
 * @param {string} changelogText CHANGELOG.md 的全文
 * @param {string} version 形如 '0.4.9'
 * @returns {string|null} 命中时以换行结尾
 */
function changelogSection(changelogText, version) {
  const lines = String(changelogText).split(/\r?\n/)
  const v = escapeRegExp(version)
  const heading = new RegExp(`^##\\s+(?:AIQuad\\s+v?|\\[|v)?${v}\\]?(?:\\s|$)`)

  const start = lines.findIndex((line) => heading.test(line.trim()))
  if (start === -1) return null

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) {
      end = i
      break
    }
  }

  const body = lines
    .slice(start, end)
    .join('\n')
    .trimEnd()
    .replace(/\n+-{3,}\s*$/, '')
    .trimEnd()

  return body ? `${body}\n` : null
}

/**
 * 去掉段落的第一行标题（发布页的标题另由 `releaseHeading()` 生成），拿正文。
 *
 * @param {string} section `changelogSection()` 的返回值
 * @returns {string}
 */
function sectionBody(section) {
  const lines = String(section ?? '').split(/\r?\n/)
  if (lines.length && /^#{1,3}\s/.test(lines[0].trim())) lines.shift()
  return lines.join('\n').trim()
}

/**
 * 段落里第一行"有内容的话"，用来粗判两份文案是不是同一个东西
 * （发版自检拿它比对发布页的说明）。跳过标题行、空行、`###` 小标题。
 *
 * @param {string} section
 * @returns {string|null}
 */
function firstContentLine(section) {
  for (const raw of String(section ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    return line
  }
  return null
}

/** 发布页上那一行标题。样式沿用 0.4.2 ~ 0.4.9 的既有 Release。 */
function releaseHeading(version) {
  return `## AIQuad v${version}`
}

/** 版本标题的识别正则（和 `changelogSection()` 用的是同一套写法，别各写一份） */
function versionHeading(version) {
  return new RegExp(`^##\\s+(?:AIQuad\\s+v?|\\[|v)?${escapeRegExp(version)}\\]?(?:\\s|$)`)
}

/**
 * 把版本号拆成数字数组，用来比大小（`0.4.10` 要大于 `0.4.9`，按字符串比会反过来）。
 *
 * @param {string} version
 * @returns {number[]}
 */
function versionParts(version) {
  return String(version)
    .replace(/^v/, '')
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10) || 0)
}

/**
 * 版本号比较：a < b 返回负数，相等 0，a > b 正数。段数不同时缺的位当 0。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersions(a, b) {
  const pa = versionParts(a)
  const pb = versionParts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * 按出现顺序列出 CHANGELOG 里的所有版本号（**新版本在前**，和文件里的写法一致）。
 *
 * @param {string} changelogText
 * @returns {string[]}
 */
function changelogVersions(changelogText) {
  const out = []
  for (const raw of String(changelogText).split(/\r?\n/)) {
    const m = /^##\s+(?:AIQuad\s+v?|\[|v)?(\d+(?:\.\d+)*)\]?(?:\s|$)/.exec(raw.trim())
    if (m) out.push(m[1])
  }
  return out
}

/**
 * 取"上一个发版之后、到 `until` 为止"的全部版本段落 —— 累计发版说明的取材口。
 *
 * 累计发版说明的规则见 `docs/release-notes.md`：发布页不逐版罗列，而是把
 * `(since, until]` 区间里所有版本的改动合并成一篇（同名功能的后续修复并进原文）。
 * 这个函数只负责**照着区间把材料取出来**，合并不在脚本里做。
 *
 * @param {string} changelogText
 * @param {{ since?: string|null, until: string }} range `since` 不含、`until` 含；`since` 为空则取到文件末尾
 * @returns {{ version: string, section: string }[]} 按版本从新到旧
 */
function changelogRange(changelogText, { since = null, until }) {
  if (!until) throw new Error('changelogRange 需要 until（本次要发的版本号）')
  return changelogVersions(changelogText)
    .filter((v) => compareVersions(v, until) <= 0)
    .filter((v) => (since ? compareVersions(v, since) > 0 : true))
    .map((version) => ({ version, section: changelogSection(changelogText, version) }))
    .filter((item) => item.section)
}

/**
 * 找出比 `version` 小的最大版本号 —— `--since auto` 用它认"上一个已发布版本"。
 * 传的是 tag 名（可能带 `v` 前缀）也没关系。
 *
 * @param {string[]} versions 候选版本号（比如 `git tag --list 'v*'` 的结果）
 * @param {string} version
 * @returns {string|null}
 */
function latestBelow(versions, version) {
  let best = null
  for (const candidate of versions) {
    const bare = String(candidate).replace(/^v/, '')
    if (!/^\d+(?:\.\d+)*$/.test(bare)) continue
    if (compareVersions(bare, version) >= 0) continue
    if (!best || compareVersions(bare, best) > 0) best = bare
  }
  return best
}

module.exports = {
  changelogSection,
  sectionBody,
  firstContentLine,
  releaseHeading,
  versionHeading,
  compareVersions,
  changelogVersions,
  changelogRange,
  latestBelow,
}
