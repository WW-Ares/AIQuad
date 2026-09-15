/**
 * CHANGELOG.md 是发布说明的唯一源头，别的产物（GitHub Release 页面、发版自检）都从它派生。
 * 解析逻辑集中在这里，免得两处正则各自漂移。
 *
 * 仓库里用标准写法 `## [0.4.9] - 2026-09-15`；发布页上那行标题由 `releaseHeading()` 生成成
 * `## AIQuad v0.4.9` —— 沿用 0.4.2 ~ 0.4.9 四份既有 Release 的样式，发布页看上去和以前一样。
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

module.exports = { changelogSection, sectionBody, firstContentLine, releaseHeading }
