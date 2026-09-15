/**
 * 路径口径：Git Bash 里 `$(pwd)`、`$(cygpath ...)` 拿到的都是 `/d/Users/...` 这种 MSYS 写法，
 * Node 跑在 Windows 上**认不出来** —— `fs.existsSync('/d/...')` 恒为 false，
 * 表现成"我明明指定了目录，脚本却说找不到文件"。
 *
 * 这个函数把 `/<盘符>/...` 转成 `D:/Users/...`；不是这个形状的路径原样返回
 * （`/tmp/x` 这种 MSYS 虚拟路径没法可靠映射，交给调用方自己写 Windows 路径）。
 */

/** @param {string} p @returns {string} */
function windowsPath(p) {
  const text = String(p ?? '')
  if (process.platform !== 'win32') return text
  const match = text.match(/^\/([A-Za-z])(\/.*)?$/)
  return match ? `${match[1].toUpperCase()}:${match[2] ?? '/'}` : text
}

module.exports = { windowsPath }
